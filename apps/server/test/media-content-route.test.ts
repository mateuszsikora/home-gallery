import { API_ROUTES, apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/http/admin-session-routes.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestMedia,
  TEST_API_TOKEN,
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

  /** The cookie an administration browser session sends with every preview. */
  const createSessionCookie = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: API_ROUTES.adminSession,
      headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
      ';',
      1,
    )[0];

    if (cookie === undefined) {
      throw new Error('Expected a session cookie');
    }

    return cookie;
  };

  it('streams hidden media to a browser session and forbids storing it', async () => {
    const { record, bytes } = await storeTestMedia(app, { enabled: false });

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { cookie: await createSessionCookie() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-length']).toBe(String(bytes.byteLength));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.equals(bytes)).toBe(true);
  });

  it('streams visible media to a bearer token as well', async () => {
    const { record, bytes } = await storeTestMedia(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminMediaContentById(record.id),
      headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
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
      headers: { cookie: await createSessionCookie() },
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
      headers: { cookie: await createSessionCookie() },
    });

    expectUnavailable(response.statusCode, response.json());
  });
});
