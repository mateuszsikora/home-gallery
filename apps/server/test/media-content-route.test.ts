import { writeFile } from 'node:fs/promises';

import { API_ROUTES, apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { CreateMediaInput } from '../src/database/media-repository.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/http/admin-session-routes.js';
import { thumbnailFilename } from '../src/media/thumbnails.js';
import {
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestImage,
  storeTestMedia,
} from './helpers.js';

const UNKNOWN_ID = '3f0f2c6c-2b1a-4a4f-9f2c-8f5a1d1c0f9b';

describe('GET /media/{id}', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const expectUnavailable = (statusCode: number, body: unknown) => {
    expect(statusCode).toBe(404);
    expect(apiErrorBodySchema.parse(body).error).toEqual({
      code: 'not_found',
      message: 'The requested media is not available',
    });
  };

  it('streams enabled media without a bearer token', async () => {
    const { record, bytes } = await storeTestMedia(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(record.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-length']).toBe(String(bytes.byteLength));
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it('marks normalized files as immutable and revalidates with an ETag', async () => {
    const { record } = await storeTestMedia(app);

    const first = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(record.id),
    });

    expect(first.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(first.headers.etag).toBe(`"${record.id}"`);

    const revalidated = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(record.id),
      headers: { 'if-none-match': `"${record.id}"` },
    });

    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload).toHaveLength(0);
  });

  it('hides disabled media from the public route', async () => {
    const { record } = await storeTestMedia(app, { enabled: false });

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(record.id),
    });

    expectUnavailable(response.statusCode, response.json());
  });

  it('reports a record whose file disappeared as unavailable', async () => {
    const { record } = await storeTestMedia(app);
    await app.mediaStorage.remove(record.storedFilename);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(record.id),
    });

    expectUnavailable(response.statusCode, response.json());
  });

  it('answers unknown and malformed identifiers identically', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById(UNKNOWN_ID),
    });
    const malformed = await app.inject({
      method: 'GET',
      url: API_ROUTES.mediaContentById('not-a-uuid'),
    });

    expectUnavailable(unknown.statusCode, unknown.json());
    expectUnavailable(malformed.statusCode, malformed.json());
  });

  it('does not let a traversal attempt escape the media directory', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/media/..%2F..%2Fhome-gallery.db',
    });

    expectUnavailable(response.statusCode, response.json());
  });
});

describe('GET /api/media/{id}/content', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const expectUnavailable = (statusCode: number, body: unknown) => {
    expect(statusCode).toBe(404);
    expect(apiErrorBodySchema.parse(body).error).toEqual({
      code: 'not_found',
      message: 'The requested media is not available',
    });
  };

  it('streams hidden media to a browser session and forbids storing it', async () => {
    const { record, bytes } = await storeTestMedia(app, { enabled: false });

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-length']).toBe(String(bytes.byteLength));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it('streams visible media to the same session as well', async () => {
    const { record, bytes } = await storeTestMedia(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it('answers an unauthenticated caller exactly like an unknown identifier', async () => {
    const { record } = await storeTestMedia(app, { enabled: false });

    const anonymous = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
    });
    const unknown = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(UNKNOWN_ID),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expectUnavailable(anonymous.statusCode, anonymous.json());
    expectUnavailable(unknown.statusCode, unknown.json());
  });

  it('rejects an invalid session cookie', async () => {
    const { record } = await storeTestMedia(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=not-a-session` },
    });

    expectUnavailable(response.statusCode, response.json());
  });

  it('reports a record whose file disappeared as unavailable', async () => {
    const { record } = await storeTestMedia(app);
    await app.mediaStorage.remove(record.storedFilename);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expectUnavailable(response.statusCode, response.json());
  });
});

describe('GET /api/media/{id}/thumbnail', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    await app.thumbnailBackfill.finished;
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const expectUnavailable = (statusCode: number, body: unknown) => {
    expect(statusCode).toBe(404);
    expect(apiErrorBodySchema.parse(body).error).toEqual({
      code: 'not_found',
      message: 'The requested media is not available',
    });
  };

  /** The state a completed upload leaves behind: an image and its derivative. */
  const storeWithThumbnail = async (
    overrides: Partial<CreateMediaInput> = {},
  ) => {
    const stored = await storeTestImage(app, overrides);
    const thumbnail = Buffer.from(
      `thumbnail-of-${stored.record.storedFilename}`,
    );
    await writeFile(
      app.mediaStorage.resolveMediaPath(
        thumbnailFilename(stored.record.storedFilename),
      ),
      thumbnail,
    );

    return { ...stored, thumbnail };
  };

  it('serves the derivative instead of the full image', async () => {
    const { record, thumbnail } = await storeWithThumbnail();

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-length']).toBe(
      String(thumbnail.byteLength),
    );
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers.etag).toBe(`"${record.id}-thumb"`);
    expect(response.rawPayload.equals(thumbnail)).toBe(true);
  });

  it('revalidates a stored preview instead of sending it again', async () => {
    const { record } = await storeWithThumbnail();
    const cookie = await createTestAdminSession(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie, 'if-none-match': `"${record.id}-thumb"` },
    });

    expect(response.statusCode).toBe(304);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.rawPayload).toHaveLength(0);
  });

  it('refuses to revalidate a preview for a caller without a session', async () => {
    const { record } = await storeWithThumbnail();

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { 'if-none-match': `"${record.id}-thumb"` },
    });

    expectUnavailable(response.statusCode, response.json());
  });

  it('previews a hidden photo the same way', async () => {
    const { record, thumbnail } = await storeWithThumbnail({ enabled: false });

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.rawPayload.equals(thumbnail)).toBe(true);
  });

  it('falls back to the full image while the derivative is missing', async () => {
    const { record, bytes } = await storeTestImage(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers.etag).toBe(`"${record.id}-full"`);
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it('stops honouring a fallback validator once the derivative exists', async () => {
    const { record } = await storeTestImage(app);
    const cookie = await createTestAdminSession(app);
    const fallbackEtag = `"${record.id}-full"`;

    await writeFile(
      app.mediaStorage.resolveMediaPath(
        thumbnailFilename(record.storedFilename),
      ),
      'thumbnail bytes',
    );

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie, 'if-none-match': fallbackEtag },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(`"${record.id}-thumb"`);
    expect(response.body).toBe('thumbnail bytes');
  });

  it('answers an unauthenticated caller exactly like an unknown identifier', async () => {
    const { record } = await storeWithThumbnail({ enabled: false });

    const anonymous = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
    });
    const unknown = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(UNKNOWN_ID),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expectUnavailable(anonymous.statusCode, anonymous.json());
    expectUnavailable(unknown.statusCode, unknown.json());
  });

  it('rejects an invalid session cookie', async () => {
    const { record } = await storeWithThumbnail();

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=not-a-session` },
    });

    expectUnavailable(response.statusCode, response.json());
  });

  it('reports a record without either file as unavailable', async () => {
    const { record } = await storeTestImage(app);
    await app.mediaStorage.remove(record.storedFilename);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaThumbnailById(record.id),
      headers: { cookie: await createTestAdminSession(app) },
    });

    expectUnavailable(response.statusCode, response.json());
  });
});
