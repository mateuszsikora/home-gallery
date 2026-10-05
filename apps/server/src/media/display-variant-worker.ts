import type { MediaRecord } from '@home-gallery/shared-types';
import type { FastifyBaseLogger } from 'fastify';

import type { MediaRepository } from '../database/media-repository.js';
import type { MediaStorage } from '../storage/media-storage.js';
import {
  createDisplayVariant,
  displayVariantFilename,
  displayVariantSizes,
} from './display-variants.js';

export interface DisplayVariantWorker {
  /** Settles when the current queue is drained, including uploads added to it. */
  readonly finished: Promise<void>;
  enqueue(record: MediaRecord): void;
  stop(): Promise<void>;
}

/** One encoder, one attempt per missing size per start/upload, no request-time work. */
export const startDisplayVariantWorker = ({
  mediaRepository,
  mediaStorage,
  log,
}: {
  mediaRepository: MediaRepository;
  mediaStorage: MediaStorage;
  log: FastifyBaseLogger;
}): DisplayVariantWorker => {
  // Snapshot before any awaits: concurrent reorders cannot skip records.
  const queue = new Map<string, MediaRecord>();
  let cursor: string | undefined;
  do {
    const page = mediaRepository.list({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const record of page.items) queue.set(record.id, record);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  let stopped = false;
  let consecutiveFailures = 0;
  let running: Promise<void> | undefined;

  const processRecord = async (record: MediaRecord): Promise<void> => {
    for (const { edge } of displayVariantSizes(record)) {
      if (stopped) return;
      const filename = displayVariantFilename(record.storedFilename, edge);
      if (await mediaStorage.exists(filename)) continue;
      if (stopped || mediaRepository.findById(record.id) === undefined) return;
      const temporary = await mediaStorage.createTemporaryFile();
      try {
        await createDisplayVariant(
          mediaStorage.resolveMediaPath(record.storedFilename),
          temporary.path,
          edge,
        );
        // Shutdown or concurrent deletion must not publish an orphan, even if
        // encoding outlived the shutdown grace period and the DB is closed.
        if (stopped || mediaRepository.findById(record.id) === undefined)
          return;
        await temporary.commit(filename);
      } finally {
        await temporary.discard();
        if (stopped || mediaRepository.findById(record.id) === undefined) {
          await mediaStorage.remove(filename);
        }
      }
    }
  };

  const drain = async (): Promise<void> => {
    for (const [id, record] of queue) {
      if (stopped) break;
      queue.delete(id);
      try {
        await processRecord(record);
        consecutiveFailures = 0;
      } catch (error) {
        log.warn(
          { err: error, mediaId: id },
          'Could not generate display variants; using full-size media',
        );
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          stopped = true;
          log.error(
            'Display variant generation stopped after ten consecutive failures; retry on restart',
          );
        }
      }
    }
    if (stopped) queue.clear();
  };
  const kick = (): void => {
    if (running === undefined && !stopped && queue.size > 0) {
      running = drain().finally(() => {
        running = undefined;
        // An upload may enqueue between drain resolving and this callback.
        kick();
      });
    }
  };
  kick();
  return {
    get finished() {
      return running ?? Promise.resolve();
    },
    enqueue: (record) => {
      if (stopped) return;
      queue.set(record.id, record);
      kick();
    },
    stop: async () => {
      stopped = true;
      queue.clear();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
        void (running ?? Promise.resolve()).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
};
