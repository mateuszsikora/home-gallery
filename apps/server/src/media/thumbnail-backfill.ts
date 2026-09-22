import type { MediaId } from '@home-gallery/shared-types';
import type { FastifyBaseLogger } from 'fastify';

import type { MediaRepository } from '../database/media-repository.js';
import type { MediaStorage } from '../storage/media-storage.js';
import { createThumbnail, thumbnailFilename } from './thumbnails.js';

/** Matches the list route's maximum, so the snapshot takes the fewest reads. */
const BACKFILL_PAGE_SIZE = 100;

/**
 * How long `stop` waits for the record in flight to wind down. A downscale
 * cannot be cancelled, and the whole shutdown budget is ten seconds, so the pass
 * is abandoned rather than allowed to spend it. Its temporary file is then left
 * for the startup cleanup that already removes interrupted uploads.
 */
const STOP_GRACE_PERIOD_MS = 2_000;

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
  /**
   * Asks the pass to stop and resolves once it has wound down, or once a short
   * grace period expires. The pass reads no database after this is called, so
   * the caller may close the connection as soon as this resolves even if the
   * record in flight is still encoding.
   */
  stop(): Promise<void>;
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

    // Re-checked after that await: an encode started now could not finish before
    // the grace period, and reading the record is what `stop` promises not to do.
    if (stopRequested || mediaRepository.findById(target.id) === undefined) {
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
    // leave a derivative behind that nothing points at and nothing cleans. The
    // encode above is the one step that can outlast the grace period, so this
    // read is skipped once stopped: nothing deletes a photo while the server is
    // closing, and the connection may already be gone.
    if (!stopRequested && mediaRepository.findById(target.id) === undefined) {
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

      // Any outcome that is not a failure breaks the run, skips included: after
      // the first pass every healthy record is a skip, so counting only
      // creations would turn the threshold into "ten bad files in the whole
      // library, however far apart" and abandon it at the same point forever.
      if (outcome !== 'failed') {
        if (outcome === 'created') {
          created += 1;
        }

        consecutiveFailures = 0;
        continue;
      }

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

    stop: async () => {
      stopRequested = true;

      await new Promise<void>((resolve) => {
        const grace = setTimeout(() => {
          resolve();
        }, STOP_GRACE_PERIOD_MS);
        // A pass that has already finished must not hold the process open for
        // the rest of the grace period.
        grace.unref();

        void finished.then(() => {
          clearTimeout(grace);
          resolve();
        });
      });
    },
  };
};
