import { API_ROUTES, apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { secretsMatch } from '../src/http/authentication.js';
import {
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_INGESTION_TOKEN,
} from './helpers.js';

const ADMIN_ROUTE = '/test/admin';
const INGESTION_ROUTE = '/test/ingestion';

describe('scoped credential guards', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    app.get(
      ADMIN_ROUTE,
      { onRequest: app.requireAdministrationSession },
      async () => ({ ok: true }),
    );
    app.get(
      INGESTION_ROUTE,
      { onRequest: app.requireIngestionToken },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  it('accepts each credential only for its configured scope', async () => {
    const sessionCookie = await createTestAdminSession(app);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_ROUTE,
          headers: { cookie: sessionCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: INGESTION_ROUTE,
          headers: { authorization: `Bearer ${TEST_INGESTION_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: ADMIN_ROUTE,
          headers: { authorization: `Bearer ${TEST_INGESTION_TOKEN}` },
        })
      ).statusCode,
    ).toBe(401);
    // A session on an ingestion route is refused as well, but with `forbidden`
    // rather than `unauthorized`, because the session itself is still good.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: INGESTION_ROUTE,
          headers: { cookie: sessionCookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('accepts a lowercase ingestion scheme', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: INGESTION_ROUTE,
          headers: { authorization: `bearer ${TEST_INGESTION_TOKEN}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty bearer token', 'Bearer '],
    ['a scheme without a token', 'Bearer'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a wrong token', 'Bearer wrong-token-0123456789abcdef0123456789'],
    ['a token prefix', `Bearer ${TEST_INGESTION_TOKEN.slice(0, -1)}`],
    ['a token with extra characters', `Bearer ${TEST_INGESTION_TOKEN}x`],
  ])('rejects ingestion with %s', async (_label, authorization) => {
    const response = await app.inject({
      method: 'GET',
      url: INGESTION_ROUTE,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');

    const body = apiErrorBodySchema.parse(response.json());

    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).not.toContain(TEST_INGESTION_TOKEN);
  });

  it('rejects an unknown session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ADMIN_ROUTE,
      headers: { cookie: 'home_gallery_admin_session=not-a-real-session' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('never echoes the expected ingestion token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: INGESTION_ROUTE,
      headers: { authorization: 'Bearer nope' },
    });

    expect(response.body).not.toContain(TEST_INGESTION_TOKEN);
  });
});

describe('credential rotation and rate limiting', () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(dataDirectory);
  });

  it('accepts a previous ingestion token', async () => {
    const previousIngestion = 'previous-ingestion-token-0123456789abcdef0123';
    const app = await createApp(
      createTestConfig(dataDirectory, {
        ingestionTokens: [TEST_INGESTION_TOKEN, previousIngestion],
      }),
    );
    app.get(
      INGESTION_ROUTE,
      { onRequest: app.requireIngestionToken },
      async () => ({ ok: true }),
    );

    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: INGESTION_ROUTE,
            headers: { authorization: `Bearer ${previousIngestion}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('allows an administration session on ingestion only when opted in', async () => {
    const app = await createApp(
      createTestConfig(dataDirectory, { allowAdministrationUploads: true }),
    );
    app.get(
      INGESTION_ROUTE,
      { onRequest: app.requireIngestionToken },
      async () => ({ ok: true }),
    );

    try {
      const response = await app.inject({
        method: 'GET',
        url: INGESTION_ROUTE,
        headers: { cookie: await createTestAdminSession(app) },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('refuses a disabled administration upload without spending the sign-in limit', async () => {
    const app = await createApp(
      createTestConfig(dataDirectory, {
        authenticationRateLimit: { max: 2, windowMs: 60_000 },
      }),
    );
    app.get(
      INGESTION_ROUTE,
      { onRequest: app.requireIngestionToken },
      async () => ({ ok: true }),
    );

    try {
      const sessionCookie = await createTestAdminSession(app);
      const disabledUpload = () =>
        app.inject({
          method: 'GET',
          url: INGESTION_ROUTE,
          headers: { cookie: sessionCookie },
        });

      const refused = await disabledUpload();

      // 403, so the administration app cannot read it as the expired session
      // that 401 means there, and no rate limit is consumed, so repeating it
      // cannot lock the administrator out of signing in again.
      expect(refused.statusCode).toBe(403);
      expect(apiErrorBodySchema.parse(refused.json()).error.code).toBe(
        'forbidden',
      );
      expect((await disabledUpload()).statusCode).toBe(403);
      expect((await disabledUpload()).statusCode).toBe(403);
      expect(await createTestAdminSession(app)).toContain('=');
    } finally {
      await app.close();
    }
  });

  it('bounds invalid attempts while leaving public and valid requests available', async () => {
    const app = await createApp(
      createTestConfig(dataDirectory, {
        authenticationRateLimit: { max: 2, windowMs: 60_000 },
      }),
    );
    app.get(
      ADMIN_ROUTE,
      { onRequest: app.requireAdministrationSession },
      async () => ({ ok: true }),
    );

    try {
      const sessionCookie = await createTestAdminSession(app);
      const invalidRequest = () =>
        app.inject({
          method: 'GET',
          url: ADMIN_ROUTE,
          headers: { cookie: 'home_gallery_admin_session=definitely-wrong' },
        });

      expect((await invalidRequest()).statusCode).toBe(401);
      expect((await invalidRequest()).statusCode).toBe(401);

      const limited = await invalidRequest();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
      expect(apiErrorBodySchema.parse(limited.json()).error.code).toBe(
        'rate_limited',
      );

      expect(
        (
          await app.inject({
            method: 'GET',
            url: ADMIN_ROUTE,
            headers: { cookie: sessionCookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: API_ROUTES.playlist }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('secretsMatch', () => {
  it('compares equal secrets as equal', () => {
    expect(secretsMatch('same-secret', 'same-secret')).toBe(true);
  });

  it('rejects different secrets of different lengths', () => {
    expect(secretsMatch('short', 'a-much-longer-secret')).toBe(false);
  });

  it('rejects secrets that differ only in the last character', () => {
    expect(secretsMatch('secret-a', 'secret-b')).toBe(false);
  });
});
