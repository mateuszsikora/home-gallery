import type { MediaRecord } from '@home-gallery/shared-types';
import type { FastifyBaseLogger } from 'fastify';

import type { MediaRepository } from '../database/media-repository.js';
import type { MediaStorage } from '../storage/media-storage.js';
import { createThumbnail, thumbnailFilename } from './thumbnails.js';

/** One page at a time keeps memory flat on a library of any size. */
const BACKFILL_PAGE_SIZE = 100;

export interface ThumbnailBackfillResult {
  created: number;
  failed: number;
  /**
   * True when the pass did not reach the end of the library, because shutdown
   * interrupted it or storage failed outright. The next start resumes it.
   */
  stopped: boolean;
}

export interface ThumbnailBackfill {
  /** Resolves once every record was visited or the pass was stopped. */
  readonly finished: Promise<ThumbnailBackfillResult>;
  stop(): void;
}

export interface ThumbnailBackfillOptions {
  log: FastifyBaseLogger;
  mediaRepository: MediaRepository;
  mediaStorage: MediaStorage;
}

type RecordOutcome = 'created' | 'skipped' | 'failed';

/**
 * Generates the administration thumbnails an older installation never wrote.
 *
 * This runs in the background rather than inside startup: a library at the
 * default file limit would otherwise keep the health endpoint unanswered for
 * minutes. Records are visited one at a time so the pass does not crowd request
 * handling out of the image encoder, and a record whose thumbnail cannot be
 * written is only logged — the administration route falls back to the full
 * image, which is what it served before thumbnails existed.
 */
export const startThumbnailBackfill = (
  options: ThumbnailBackfillOptions,
): ThumbnailBackfill => {
  const { log, mediaRepository, mediaStorage } = options;
  let stopRequested = false;
  let created = 0;
  let failed = 0;

  const ensureThumbnail = async (
    record: MediaRecord,
  ): Promise<RecordOutcome> => {
    const filename = thumbnailFilename(record.storedFilename);

    if (await mediaStorage.exists(filename)) {
      return 'skipped';
    }

    const temporary = await mediaStorage.createTemporaryFile();

    try {
      await createThumbnail(
        mediaStorage.resolveMediaPath(record.storedFilename),
        temporary.path,
      );
      await temporary.commit(filename);
    } catch (error) {
      log.warn(
        { err: error, mediaId: record.id },
        'Could not generate an administration thumbnail',
      );
      return 'failed';
    } finally {
      await temporary.discard();
    }

    // A photo deleted while its thumbnail was being written would otherwise
    // leave a derivative behind that nothing points at and nothing cleans.
    if (mediaRepository.findById(record.id) === undefined) {
      await mediaStorage.remove(filename);
      return 'skipped';
    }

    return 'created';
  };

  const run = async (): Promise<boolean> => {
    let cursor: string | undefined;

    do {
      const page = mediaRepository.list({
        limit: BACKFILL_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const record of page.items) {
        if (stopRequested) {
          return true;
        }

        const outcome = await ensureThumbnail(record);

        if (outcome === 'created') {
          created += 1;
        } else if (outcome === 'failed') {
          failed += 1;
        }
      }

      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return false;
  };

  const finished = run()
    .catch((error: unknown) => {
      // Only a defect or a storage-wide failure reaches this; a single
      // unwritable thumbnail is handled per record above.
      log.error({ err: error }, 'The administration thumbnail backfill failed');
      return true;
    })
    .then((stopped) => ({ created, failed, stopped }));

  return {
    finished,
    stop: () => {
      stopRequested = true;
    },
  };
};
