import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES, playlistResponseSchema } from '@home-gallery/shared-types';
import { createApp } from '../src/app.js';
import { normalizeImage } from '../src/media/image-normalizer.js';
import {
  createDisplayVariant,
  displayVariantFilename,
  displayVariantSizes,
} from '../src/media/display-variants.js';
import { startDisplayVariantWorker } from '../src/media/display-variant-worker.js';
import {
  adminMutationHeaders,
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestMedia,
} from './helpers.js';

describe('display variants', () => {
  let directory: string;
  let app: FastifyInstance;
  beforeEach(async () => {
    directory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(directory));
    await app.displayVariantWorker.finished;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await removeTemporaryDataDirectory(directory);
  });
  const storePhoto = async (width = 3000, height = 2000) => {
    const { record } = await storeTestMedia(app, { width, height });
    await sharp({
      create: { width, height, channels: 3, background: '#5284a2' },
    })
      .webp()
      .toFile(app.mediaStorage.resolveMediaPath(record.storedFilename));
    return record;
  };
  const readPlaylist = async () =>
    playlistResponseSchema.parse(
      (await app.inject(API_ROUTES.playlist)).json(),
    );
  const startWorker = () =>
    startDisplayVariantWorker({
      mediaRepository: app.mediaRepository,
      mediaStorage: app.mediaStorage,
      log: app.log,
    });

  it('backfills three bounded sizes, preserves full-size dimensions and does not regenerate', async () => {
    const record = await storePhoto(3001, 2001);
    const original = await readFile(
      app.mediaStorage.resolveMediaPath(record.storedFilename),
    );
    await startWorker().finished;
    const item = (await readPlaylist()).items[0]!;
    expect(item).toMatchObject({
      width: 3001,
      height: 2001,
      contentUrl: `/media/${record.id}`,
    });
    expect(item.variants).toHaveLength(3);
    for (const variant of item.variants!) {
      const response = await app.inject(variant.contentUrl);
      expect(await sharp(response.rawPayload).metadata()).toMatchObject({
        width: variant.width,
        height: variant.height,
        format: 'webp',
      });
    }
    const temporary = vi.spyOn(app.mediaStorage, 'createTemporaryFile');
    await startWorker().finished;
    expect(temporary).not.toHaveBeenCalled();
    expect(
      await readFile(app.mediaStorage.resolveMediaPath(record.storedFilename)),
    ).toEqual(original);
  });

  it('normalizes EXIF orientation before deriving portrait images', async () => {
    const record = await storePhoto(2000, 3000);
    const input = `${directory}/oriented.jpg`;
    await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#a05232' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(input);
    const dimensions = await normalizeImage(
      input,
      app.mediaStorage.resolveMediaPath(record.storedFilename),
    );
    expect(dimensions).toMatchObject({ width: 2000, height: 3000 });
    await startWorker().finished;
    const item = (await readPlaylist()).items[0]!;
    expect(item.variants![0]).toMatchObject({ width: 853, height: 1280 });
    const response = await app.inject(item.variants![0]!.contentUrl);
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({
      width: 853,
      height: 1280,
    });
  });

  it('never upscales or creates redundant variants for small images', async () => {
    const record = await storePhoto(640, 480);
    await startWorker().finished;
    expect((await readPlaylist()).items[0]!.variants).toBeUndefined();
    expect(displayVariantSizes(record)).toEqual([]);
    const output = `${directory}/small.webp`;
    await createDisplayVariant(
      app.mediaStorage.resolveMediaPath(record.storedFilename),
      output,
      1280,
    );
    expect(await sharp(output).metadata()).toMatchObject({
      width: 640,
      height: 480,
    });
  });

  it('falls back without caching missing derivatives and changes validators once generated', async () => {
    const record = await storePhoto();
    const url = API_ROUTES.mediaDisplayVariantById(record.id, 1280);
    const fallback = await app.inject(url);
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers['cache-control']).toBe('no-store');
    expect(await sharp(fallback.rawPayload).metadata()).toMatchObject({
      width: 3000,
    });
    await startWorker().finished;
    const derivative = await app.inject({
      url,
      headers: { 'if-none-match': fallback.headers.etag! },
    });
    expect(derivative.statusCode).toBe(200);
    expect(derivative.headers.etag).not.toBe(fallback.headers.etag);
    expect(derivative.headers['cache-control']).toContain('immutable');
    expect(Number(derivative.headers['content-length'])).toBe(
      derivative.rawPayload.length,
    );
    expect(
      (
        await app.inject({
          url,
          headers: { 'if-none-match': `W/${derivative.headers.etag}` },
        })
      ).statusCode,
    ).toBe(304);
    const head = await app.inject({ method: 'HEAD', url });
    expect(head.headers['content-length']).toBe(
      derivative.headers['content-length'],
    );
    expect(head.body).toBe('');
    await app.mediaStorage.remove(
      displayVariantFilename(record.storedFilename, 1280),
    );
    expect(
      (
        await app.inject({
          url,
          headers: { 'if-none-match': derivative.headers.etag! },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('preserves visibility rules and rejects arbitrary dimensions', async () => {
    const record = await storePhoto();
    await startWorker().finished;
    for (const edge of ['1281', '01280', '999999', '-1']) {
      expect(
        (await app.inject(`/media/${record.id}/display/v1/${edge}`)).statusCode,
      ).toBe(404);
    }
    app.mediaRepository.update(record.id, { enabled: false });
    const hidden = await app.inject(
      API_ROUTES.mediaDisplayVariantById(record.id, 1280),
    );
    const unknown = await app.inject(
      '/media/00000000-0000-4000-8000-000000000000/display/v1/1280',
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(unknown.json());
    expect((await readPlaylist()).items).toEqual([]);
  });

  it('keeps playback available on encoding, temporary-file and read failures', async () => {
    const bad = await storeTestMedia(app, { width: 3000, height: 2000 });
    const good = await storePhoto();
    await startWorker().finished;
    expect(
      (await readPlaylist()).items.find(({ id }) => id === good.id)!.variants,
    ).toHaveLength(3);
    expect(
      (await app.inject(API_ROUTES.mediaContentById(bad.record.id))).statusCode,
    ).toBe(200);
    await app.mediaStorage.remove(
      displayVariantFilename(good.storedFilename, 1280),
    );
    vi.spyOn(app.mediaStorage, 'createTemporaryFile').mockRejectedValue(
      new Error('disk full'),
    );
    await startWorker().finished;
    expect(
      (await app.inject(API_ROUTES.mediaDisplayVariantById(good.id, 1280)))
        .statusCode,
    ).toBe(200);
    const read = app.mediaStorage.openForRead.bind(app.mediaStorage);
    vi.spyOn(app.mediaStorage, 'openForRead').mockImplementation((filename) =>
      filename.includes('.display-')
        ? Promise.reject(new Error('EACCES'))
        : read(filename),
    );
    expect(
      (await app.inject(API_ROUTES.mediaDisplayVariantById(good.id, 1920)))
        .headers['cache-control'],
    ).toBe('no-store');
    expect(await app.mediaStorage.pruneTemporaryFiles()).toBe(0);
  });

  it('stops after ten consecutive failures without accepting more work', async () => {
    for (let index = 0; index < 12; index++) await storeTestMedia(app);
    const log = vi.spyOn(app.log, 'warn');
    const worker = startWorker();
    await worker.finished;
    expect(log).toHaveBeenCalledTimes(10);
    worker.enqueue(await storePhoto());
    await worker.finished;
    expect(log).toHaveBeenCalledTimes(10);
  });

  it(
    'deletes all variants with the parent and does not recreate them in flight',
    { timeout: 15000 },
    async () => {
      const record = await storePhoto();
      await startWorker().finished;
      const remove = await app.inject({
        method: 'DELETE',
        url: API_ROUTES.mediaById(record.id),
        headers: adminMutationHeaders(await createTestAdminSession(app)),
      });
      expect(remove.statusCode).toBe(204);
      for (const { edge } of displayVariantSizes(record))
        expect(
          await app.mediaStorage.exists(
            displayVariantFilename(record.storedFilename, edge),
          ),
        ).toBe(false);
      const next = await storePhoto();
      const commit = app.mediaStorage.createTemporaryFile.bind(
        app.mediaStorage,
      );
      vi.spyOn(app.mediaStorage, 'createTemporaryFile').mockImplementation(
        async () => {
          const temporary = await commit();
          return {
            ...temporary,
            commit: async (filename) => {
              app.mediaRepository.delete(next.id);
              return temporary.commit(filename);
            },
          };
        },
      );
      await startWorker().finished;
      for (const { edge } of displayVariantSizes(next))
        expect(
          await app.mediaStorage.exists(
            displayVariantFilename(next.storedFilename, edge),
          ),
        ).toBe(false);
    },
  );

  it(
    'starts on restart and accepts newly uploaded records on its single queue',
    { timeout: 15000 },
    async () => {
      const existing = await storePhoto();
      await app.close();
      app = await createApp(createTestConfig(directory));
      await app.displayVariantWorker.finished;
      expect(
        await app.mediaStorage.exists(
          displayVariantFilename(existing.storedFilename, 1280),
        ),
      ).toBe(true);
      const uploaded = await storePhoto();
      app.displayVariantWorker.enqueue(uploaded);
      await app.displayVariantWorker.finished;
      expect(
        await app.mediaStorage.exists(
          displayVariantFilename(uploaded.storedFilename, 1280),
        ),
      ).toBe(true);
    },
  );

  it('cancels queued work on stop and bounds a hung storage operation', async () => {
    const record = await storePhoto();
    const worker = startWorker();
    await worker.stop();
    await worker.finished;
    expect(
      await app.mediaStorage.exists(
        displayVariantFilename(record.storedFilename, 1280),
      ),
    ).toBe(false);
    vi.spyOn(app.mediaStorage, 'exists').mockImplementation(
      () => new Promise(() => {}),
    );
    const hung = startWorker();
    vi.useFakeTimers();
    try {
      const stopped = hung.stop();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
