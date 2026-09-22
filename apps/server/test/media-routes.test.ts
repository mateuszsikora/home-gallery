import { readdir, writeFile } from 'node:fs/promises';

import {
  API_ROUTES,
  apiErrorBodySchema,
  mediaListResponseSchema,
  mediaRecordSchema,
} from '@home-gallery/shared-types';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { thumbnailFilename } from '../src/media/thumbnails.js';
import {
  adminMutationHeaders,
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestMedia,
} from './helpers.js';

const UNKNOWN_ID = '3f0f2c6c-2b1a-4a4f-9f2c-8f5a1d1c0f9b';

describe('media management routes', () => {
  let dataDirectory: string;
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    sessionCookie = await createTestAdminSession(app);
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  /** A `null` cookie sends no administration session at all. */
  const authenticated = (
    method: 'GET' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    cookie: string | null = sessionCookie,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = {
      method,
      url,
      ...(cookie === null ? {} : { headers: adminMutationHeaders(cookie) }),
      ...(payload === undefined ? {} : { payload }),
    };

    return app.inject(options);
  };

  describe('GET /api/media', () => {
    it('returns the library in playlist order', async () => {
      const first = await storeTestMedia(app);
      const second = await storeTestMedia(app);

      const response = await authenticated('GET', API_ROUTES.media);

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = mediaListResponseSchema.parse(response.json());
      expect(body.items.map((item) => item.id)).toEqual([
        first.record.id,
        second.record.id,
      ]);
      expect(body.nextCursor).toBeNull();
    });

    it('pages through the library with an opaque cursor', async () => {
      const first = await storeTestMedia(app);
      const second = await storeTestMedia(app);

      const firstPage = mediaListResponseSchema.parse(
        (await authenticated('GET', `${API_ROUTES.media}?limit=1`)).json(),
      );

      expect(firstPage.items.map((item) => item.id)).toEqual([first.record.id]);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = mediaListResponseSchema.parse(
        (
          await authenticated(
            'GET',
            `${API_ROUTES.media}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
          )
        ).json(),
      );

      expect(secondPage.items.map((item) => item.id)).toEqual([
        second.record.id,
      ]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it('rejects an out-of-range limit', async () => {
      const response = await authenticated(
        'GET',
        `${API_ROUTES.media}?limit=101`,
      );

      expect(response.statusCode).toBe(422);
      expect(apiErrorBodySchema.parse(response.json()).error).toMatchObject({
        code: 'validation_failed',
        issues: [{ path: 'limit' }],
      });
    });

    it('rejects a limit that is not a number', async () => {
      const response = await authenticated(
        'GET',
        `${API_ROUTES.media}?limit=many`,
      );

      expect(response.statusCode).toBe(422);
      expect(apiErrorBodySchema.parse(response.json()).error.issues).toEqual([
        { path: 'limit', message: 'Must be a positive integer' },
      ]);
    });

    it('rejects a cursor the server did not issue', async () => {
      const response = await authenticated(
        'GET',
        `${API_ROUTES.media}?cursor=tampered`,
      );

      expect(response.statusCode).toBe(422);
      expect(apiErrorBodySchema.parse(response.json()).error).toMatchObject({
        code: 'validation_failed',
        issues: [{ path: 'cursor' }],
      });
    });

    it('requires an administration session', async () => {
      await storeTestMedia(app);

      const response = await authenticated(
        'GET',
        API_ROUTES.media,
        undefined,
        null,
      );

      expect(response.statusCode).toBe(401);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'unauthorized',
      );
    });
  });

  describe('GET /api/media/{id}', () => {
    it('returns the administrative record', async () => {
      const { record } = await storeTestMedia(app, {
        sourceId: '123456',
        authorName: 'Gallery contributor',
      });

      const response = await authenticated(
        'GET',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(200);
      expect(mediaRecordSchema.parse(response.json())).toEqual(record);
    });

    it('reports an unknown identifier as missing', async () => {
      const response = await authenticated(
        'GET',
        API_ROUTES.mediaById(UNKNOWN_ID),
      );

      expect(response.statusCode).toBe(404);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'not_found',
      );
    });

    it('reports a malformed identifier as missing', async () => {
      const response = await authenticated(
        'GET',
        API_ROUTES.mediaById('not-a-uuid'),
      );

      expect(response.statusCode).toBe(404);
    });

    it('requires an administration session', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'GET',
        API_ROUTES.mediaById(record.id),
        undefined,
        null,
      );

      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/media/{id}', () => {
    it('disables and re-enables a record', async () => {
      const { record } = await storeTestMedia(app);

      const disabled = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        { enabled: false },
      );

      expect(disabled.statusCode).toBe(200);
      expect(mediaRecordSchema.parse(disabled.json()).enabled).toBe(false);
      expect(app.mediaRepository.findById(record.id)?.enabled).toBe(false);

      const enabled = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        { enabled: true },
      );

      expect(mediaRecordSchema.parse(enabled.json()).enabled).toBe(true);
    });

    it('reorders the library and keeps positions contiguous', async () => {
      const first = await storeTestMedia(app);
      const second = await storeTestMedia(app);
      const third = await storeTestMedia(app);

      const response = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(third.record.id),
        { sortOrder: 0 },
      );

      expect(response.statusCode).toBe(200);
      expect(mediaRecordSchema.parse(response.json()).sortOrder).toBe(0);
      expect(
        app.mediaRepository
          .list()
          .items.map((item) => [item.id, item.sortOrder]),
      ).toEqual([
        [third.record.id, 0],
        [first.record.id, 1],
        [second.record.id, 2],
      ]);
    });

    it('rejects an empty update', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        {},
      );

      expect(response.statusCode).toBe(422);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'validation_failed',
      );
    });

    it('rejects fields that are not mutable', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        { storedFilename: '../escape.webp' },
      );

      expect(response.statusCode).toBe(422);
      expect(app.mediaRepository.findById(record.id)).toEqual(record);
    });

    it('rejects a negative sort order', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        { sortOrder: -1 },
      );

      expect(response.statusCode).toBe(422);
    });

    it('requires an administration session', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'PATCH',
        API_ROUTES.mediaById(record.id),
        { enabled: false },
        null,
      );

      expect(response.statusCode).toBe(401);
      expect(app.mediaRepository.findById(record.id)?.enabled).toBe(true);
    });
  });

  describe('DELETE /api/media/{id}', () => {
    it('removes the record and its file', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(app.mediaRepository.findById(record.id)).toBeUndefined();
      expect(await readdir(app.mediaStorage.mediaDirectory)).toEqual([]);
    });

    it('removes the preview derivative along with the image', async () => {
      const { record } = await storeTestMedia(app);
      const thumbnail = thumbnailFilename(record.storedFilename);
      await writeFile(
        app.mediaStorage.resolveMediaPath(thumbnail),
        'thumbnail bytes',
      );

      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(204);
      expect(await readdir(app.mediaStorage.mediaDirectory)).toEqual([]);
    });

    it('is reported as missing on a second attempt', async () => {
      const { record } = await storeTestMedia(app);

      await authenticated('DELETE', API_ROUTES.mediaById(record.id));
      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(404);
    });

    it('still removes the record when the file is already gone', async () => {
      const { record } = await storeTestMedia(app);
      await app.mediaStorage.remove(record.storedFilename);

      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(204);
      expect(app.mediaRepository.findById(record.id)).toBeUndefined();
    });

    it('restores the file when the database delete fails', async () => {
      const { record } = await storeTestMedia(app);
      vi.spyOn(app.mediaRepository, 'delete').mockImplementation(() => {
        throw new Error('simulated database failure');
      });

      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
      );

      expect(response.statusCode).toBe(500);
      expect(app.mediaRepository.findById(record.id)).toEqual(record);
      expect(await app.mediaStorage.exists(record.storedFilename)).toBe(true);
      expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
    });

    it('requires an administration session', async () => {
      const { record } = await storeTestMedia(app);

      const response = await authenticated(
        'DELETE',
        API_ROUTES.mediaById(record.id),
        undefined,
        null,
      );

      expect(response.statusCode).toBe(401);
      expect(app.mediaRepository.findById(record.id)).toEqual(record);
      expect(await app.mediaStorage.exists(record.storedFilename)).toBe(true);
    });
  });
});
