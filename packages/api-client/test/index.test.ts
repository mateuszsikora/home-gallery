import { describe, expect, it } from 'vitest';

import {
  HomeGalleryApiError,
  HomeGalleryResponseError,
  createHomeGalleryClient,
} from '../src/index.js';

const mediaId = '70f16fba-e1c2-40c6-a8c8-9f1acbe4155d';
const mediaRecord = {
  id: mediaId,
  storedFilename: `${mediaId}.webp`,
  originalFilename: 'summer.jpg',
  mediaType: 'image',
  mimeType: 'image/webp',
  uploadedAt: '2026-07-31T10:15:30.000Z',
  source: 'telegram',
  sourceId: '123456',
  authorName: 'Gallery contributor',
  enabled: true,
  sortOrder: 4,
  width: 1920,
  height: 1080,
} as const;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createHomeGalleryClient', () => {
  it('normalizes a base path and serializes list query parameters', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      return jsonResponse({ items: [mediaRecord], nextCursor: 'next-page' });
    };
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test/home-gallery/',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    await expect(
      client.listMedia({ cursor: 'current-page', limit: 25 }),
    ).resolves.toEqual({ items: [mediaRecord], nextCursor: 'next-page' });

    const request = requests[0];
    expect(request).toBeDefined();
    expect(String(request?.input)).toBe(
      'https://gallery.example.test/home-gallery/api/media?cursor=current-page&limit=25',
    );
    expect(new Headers(request?.init?.headers).get('authorization')).toBe(
      'Bearer secret-token',
    );
    expect(String(request?.input)).not.toContain('secret-token');
  });

  it('does not send credentials to public endpoints', async () => {
    let authorization: string | null = 'not-called';
    const fetchImplementation: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return jsonResponse({
        items: [],
        settings: {
          slideDurationMs: 8_000,
          fadeDurationMs: 1_000,
          playbackMode: 'sequential',
        },
      });
    };
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    await client.getPlaylist();

    expect(authorization).toBeNull();
  });

  it('serializes upload metadata as multipart form data', async () => {
    let requestBody: BodyInit | null | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requestBody = init?.body;
      return jsonResponse(mediaRecord, 201);
    };
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    await client.uploadMedia({
      file: new Blob(['image bytes'], { type: 'image/jpeg' }),
      originalFilename: 'summer.jpg',
      source: 'telegram',
      sourceId: '123456',
      authorName: 'Gallery contributor',
    });

    expect(requestBody).toBeInstanceOf(FormData);
    const formData = requestBody as FormData;
    expect(formData.get('originalFilename')).toBe('summer.jpg');
    expect(formData.get('source')).toBe('telegram');
    expect(formData.get('sourceId')).toBe('123456');
    expect(formData.get('authorName')).toBe('Gallery contributor');
    expect(formData.get('file')).toBeInstanceOf(Blob);
  });

  it('handles a successful empty delete response', async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(null, { status: 204 });
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    await expect(client.deleteMedia(mediaId)).resolves.toBeUndefined();
  });

  it('turns structured non-2xx responses into a typed error', async () => {
    const fetchImplementation: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: 'unauthorized',
            message: 'Invalid bearer token',
          },
        },
        401,
      );
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    const error = await client.getSettings().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HomeGalleryApiError);
    expect(error).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'Invalid bearer token',
    });
    expect(String(error)).not.toContain('secret-token');
  });

  it('rejects response payloads that violate the contract', async () => {
    const fetchImplementation: typeof fetch = async () =>
      jsonResponse({ items: 'not-an-array', nextCursor: null });
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    await expect(client.listMedia()).rejects.toBeInstanceOf(
      HomeGalleryResponseError,
    );
  });

  it('validates mutation inputs before making a request', async () => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = async () => {
      requestCount += 1;
      return jsonResponse(mediaRecord);
    };
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test',
      token: 'secret-token',
      fetch: fetchImplementation,
    });

    expect(() => client.updateMedia(mediaId, {})).toThrow(
      'At least one media field must be provided',
    );
    expect(requestCount).toBe(0);
  });

  it('builds a validated public content URL', () => {
    const client = createHomeGalleryClient({
      baseUrl: 'https://gallery.example.test/root/',
    });

    expect(client.getMediaContentUrl(mediaId)).toBe(
      `https://gallery.example.test/root/media/${mediaId}`,
    );
  });

  it('rejects unsafe base URLs and empty tokens', () => {
    expect(() =>
      createHomeGalleryClient({
        baseUrl: 'https://user:password@gallery.example.test',
      }),
    ).toThrow('must not contain credentials');
    expect(() =>
      createHomeGalleryClient({
        baseUrl: 'https://gallery.example.test',
        token: '   ',
      }),
    ).toThrow('must not be empty');
  });
});
