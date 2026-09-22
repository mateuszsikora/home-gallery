import { readFile, writeFile } from 'node:fs/promises';

import { API_ROUTES } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { startThumbnailBackfill } from '../src/media/thumbnail-backfill.js';
import {
  THUMBNAIL_MAX_EDGE,
  thumbnailFilename,
} from '../src/media/thumbnails.js';
import {
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestImage,
  storeTestMedia,
} from './helpers.js';

describe('administration thumbnail backfill', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    // The pass started by this instance saw an empty library, so each test
    // drives its own against the records it stores.
    await app.thumbnailBackfill.finished;
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const backfill = () =>
    startThumbnailBackfill({
      log: app.log,
      mediaRepository: app.mediaRepository,
      mediaStorage: app.mediaStorage,
    });

  const readThumbnail = (storedFilename: string): Promise<Buffer> =>
    readFile(
      app.mediaStorage.resolveMediaPath(thumbnailFilename(storedFilename)),
    );

  it('writes a bounded thumbnail for media stored before the derivative existed', async () => {
    const { record } = await storeTestImage(app);

    await expect(backfill().finished).resolves.toEqual({
      created: 1,
      failed: 0,
      stopped: false,
    });

    const metadata = await sharp(
      await readThumbnail(record.storedFilename),
    ).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(THUMBNAIL_MAX_EDGE);
    expect(metadata.height).toBe(360);
  });

  it('leaves an existing thumbnail untouched on a later pass', async () => {
    const { record } = await storeTestImage(app);

    await backfill().finished;
    const first = await readThumbnail(record.storedFilename);

    await expect(backfill().finished).resolves.toEqual({
      created: 0,
      failed: 0,
      stopped: false,
    });
    expect((await readThumbnail(record.storedFilename)).equals(first)).toBe(
      true,
    );
  });

  it('reports a record whose image cannot be read without failing the pass', async () => {
    // Stored bytes that are not a valid image stand in for a truncated or
    // unreadable file, which is the only per-record failure worth logging.
    await storeTestMedia(app);
    const readable = await storeTestImage(app);

    await expect(backfill().finished).resolves.toEqual({
      created: 1,
      failed: 1,
      stopped: false,
    });
    await expect(
      readThumbnail(readable.record.storedFilename),
    ).resolves.toBeDefined();
  });

  it('gives up instead of logging a line per photograph when storage fails', async () => {
    // A full volume or an unwritable media directory fails every record, which
    // unreadable stored bytes reproduce without touching the filesystem.
    for (let index = 0; index < 12; index += 1) {
      await storeTestMedia(app);
    }

    await expect(backfill().finished).resolves.toEqual({
      created: 0,
      failed: 10,
      stopped: true,
    });
  });

  it('keeps going when bad files are spread through a healthy library', async () => {
    // Skips are the steady state once the first pass has run, so a threshold
    // that only reset on a creation would read eleven failures however far apart
    // as a broken volume and abandon the library at the same record on every
    // restart. No two failures here are adjacent.
    for (let index = 0; index < 11; index += 1) {
      await storeTestMedia(app);
      const settled = await storeTestMedia(app);
      await writeFile(
        app.mediaStorage.resolveMediaPath(
          thumbnailFilename(settled.record.storedFilename),
        ),
        'an existing derivative',
      );
    }

    const tail = await storeTestImage(app);

    await expect(backfill().finished).resolves.toEqual({
      created: 1,
      failed: 11,
      stopped: false,
    });
    await expect(
      app.mediaStorage.exists(thumbnailFilename(tail.record.storedFilename)),
    ).resolves.toBe(true);
  });

  it('skips a record deleted after the pass listed the library', async () => {
    const { record } = await storeTestImage(app);
    const survivor = await storeTestImage(app);

    const pass = backfill();
    app.mediaRepository.delete(record.id);

    await expect(pass.finished).resolves.toMatchObject({ stopped: false });
    await expect(
      app.mediaStorage.exists(
        thumbnailFilename(survivor.record.storedFilename),
      ),
    ).resolves.toBe(true);
    // Whichever side of the deletion the pass was on, it leaves no derivative
    // that nothing points at.
    await expect(
      app.mediaStorage.exists(thumbnailFilename(record.storedFilename)),
    ).resolves.toBe(false);
  });

  it('leaves no temporary files behind', async () => {
    await storeTestImage(app);
    await storeTestMedia(app);

    await backfill().finished;

    expect(await app.mediaStorage.pruneTemporaryFiles()).toBe(0);
  });

  it('starts no further work once shutdown asks it to stop', async () => {
    const first = await storeTestImage(app);
    const second = await storeTestImage(app);

    const pass = backfill();
    await pass.stop();

    // Not one downscale was started. A record whose turn had come but had not
    // begun encoding is abandoned rather than allowed to run into the shutdown
    // budget, and the next start picks it up.
    await expect(pass.finished).resolves.toEqual({
      created: 0,
      failed: 0,
      stopped: true,
    });
    for (const { record } of [first, second]) {
      await expect(
        app.mediaStorage.exists(thumbnailFilename(record.storedFilename)),
      ).resolves.toBe(false);
    }
    expect(await app.mediaStorage.pruneTemporaryFiles()).toBe(0);
  });

  it('resolves stop on its own deadline when a record will not finish', async () => {
    await storeTestMedia(app);
    // A downscale cannot be cancelled, so shutdown must not be held by one. A
    // storage call that never settles stands in for one that outlasts the grace
    // period.
    const hangingStorage = {
      ...app.mediaStorage,
      exists: () => new Promise<boolean>(() => undefined),
    };
    const pass = startThumbnailBackfill({
      log: app.log,
      mediaRepository: app.mediaRepository,
      mediaStorage: hangingStorage,
    });

    vi.useFakeTimers();

    try {
      const stopped = pass.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the derivative it created after a restart', async () => {
    const { record, bytes } = await storeTestImage(app);

    await app.close();
    app = await createApp(createTestConfig(dataDirectory));
    await app.thumbnailBackfill.finished;

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBeLessThan(bytes.byteLength);
    expect((await sharp(response.rawPayload).metadata()).width).toBe(
      THUMBNAIL_MAX_EDGE,
    );
  });
});
