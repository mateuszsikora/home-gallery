import type { MediaId } from '@home-gallery/shared-types';
import type { FastifyBaseLogger } from 'fastify';

import type { MediaRepository } from '../database/media-repository.js';
import type { MediaStorage } from '../storage/media-storage.js';
import { createThumbnail, thumbnailFilename } from './thumbnails.js';

/** Matches the list route's maximum, so the snapshot takes the fewest reads. */
const BACKFILL_PAGE_SIZE = 100;

/**
 * A full volume or an unwritable media directory fails every record, so the pass
 * gives up instead of logging a line per photograph. A genuinely unreadable
 * image is rare enough that this many in a row means the storage, not the file.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

export interface ThumbnailBackfillResult {
  created: number;
  failed: number;
  /**
   * True when the pass did not reach the end of the library, because shutdown
   * interrupted it or storage failed for record after record. The next start
   * resumes it.
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

/** Everything the pass needs about a record, held while it works through one. */
interface BackfillTarget {
  id: MediaId;
  storedFilename: string;
}

/**
 * Generates the administration thumbnails an older installation never wrote.
 *
 * This runs in the background rather than inside startup: a library at the
 * default file limit would otherwise keep the health endpoint unanswered for
 * minutes. Records are visited one at a time so the pass does not crowd request
 * handling out of the image encoder, and a record whose thumbnail cannot be
 * written is only logged — the administration route falls back to the full
 * image, which is what it served before thumbnails existed. Failure after
 * failure means the storage rather than the files, so the pass gives up.
 */
export const startThumbnailBackfill = (
  options: ThumbnailBackfillOptions,
): ThumbnailBackfill => {
  const { log, mediaRepository, mediaStorage } = options;
  let stopRequested = false;
  let created = 0;
  let failed = 0;

  const ensureThumbnail = async (
    target: BackfillTarget,
  ): Promise<RecordOutcome> => {
    const filename = thumbnailFilename(target.storedFilename);

    if (await mediaStorage.exists(filename)) {
      return 'skipped';
    }

    if (mediaRepository.findById(target.id) === undefined) {
      return 'skipped';
    }

    const temporary = await mediaStorage.createTemporaryFile();

    try {
      await createThumbnail(
        mediaStorage.resolveMediaPath(target.storedFilename),
        temporary.path,
      );
      await temporary.commit(filename);
    } catch (error) {
      log.warn(
        { err: error, mediaId: target.id },
        'Could not generate an administration thumbnail',
      );

      // `commit` renames before it makes the rename durable, so a failing
      // directory sync still leaves the derivative in place. Count what is on
      // disk rather than what threw.
      return (await mediaStorage.exists(filename)) ? 'created' : 'failed';
    } finally {
      await temporary.discard();
    }

    // A photo deleted while its thumbnail was being written would otherwise
    // leave a derivative behind that nothing points at and nothing cleans.
    if (mediaRepository.findById(target.id) === undefined) {
      await mediaStorage.remove(filename);
      return 'skipped';
    }

    return 'created';
  };

  /**
   * Snapshots the library before encoding anything. The list cursor orders by
   * `sortOrder`, which is exactly what the administration panel mutates, so
   * paging lazily across a pass that takes minutes would let a reorder shift a
   * record behind the cursor and skip it. These reads are synchronous, so the
   * snapshot cannot interleave with a request handler.
   */
  const collectTargets = (): BackfillTarget[] => {
    const targets: BackfillTarget[] = [];
    let cursor: string | undefined;

    do {
      const page = mediaRepository.list({
        limit: BACKFILL_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const record of page.items) {
        targets.push({ id: record.id, storedFilename: record.storedFilename });
      }

      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    return targets;
  };

  const run = async (): Promise<boolean> => {
    let consecutiveFailures = 0;

    for (const target of collectTargets()) {
      if (stopRequested) {
        return true;
      }

      const outcome = await ensureThumbnail(target);

      if (outcome === 'created') {
        created += 1;
        consecutiveFailures = 0;
      } else if (outcome === 'failed') {
        failed += 1;
        consecutiveFailures += 1;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(
            { failed },
            'Giving up on administration thumbnails after repeated failures',
          );
          return true;
        }
      }
    }

    return false;
  };

  const finished = run()
    .catch((error: unknown) => {
      // Only a defect or a failure to read the library itself reaches this; an
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
