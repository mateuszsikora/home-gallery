import { API_ROUTES, apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
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
