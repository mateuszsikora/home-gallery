import { readFile } from 'node:fs/promises';

import { API_ROUTES } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('leaves no temporary files behind', async () => {
    await storeTestImage(app);
    await storeTestMedia(app);

    await backfill().finished;

    expect(await app.mediaStorage.pruneTemporaryFiles()).toBe(0);
  });

  it('stops before finishing the library when shutdown asks it to', async () => {
    const first = await storeTestImage(app);
    const second = await storeTestImage(app);

    const pass = backfill();
    pass.stop();

    // The record already in flight is finished, so no half-written derivative
    // is left for the next pass to trust.
    await expect(pass.finished).resolves.toEqual({
      created: 1,
      failed: 0,
      stopped: true,
    });
    await expect(
      app.mediaStorage.exists(thumbnailFilename(first.record.storedFilename)),
    ).resolves.toBe(true);
    await expect(
      app.mediaStorage.exists(thumbnailFilename(second.record.storedFilename)),
    ).resolves.toBe(false);
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
