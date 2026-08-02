import { API_ROUTES, apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { secretsMatch } from '../src/http/authentication.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_API_TOKEN,
  TEST_INGESTION_TOKEN,
} from './helpers.js';

const ADMIN_ROUTE = '/test/admin';
const INGESTION_ROUTE = '/test/ingestion';

describe('scoped bearer token guards', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    app.get(
      ADMIN_ROUTE,
      { onRequest: app.requireAdministrationToken },
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

  const request = (route: string, authorization?: string) =>
    app.inject({
      method: 'GET',
      url: route,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

  it('accepts each credential only for its configured scope', async () => {
    expect(
      (await request(ADMIN_ROUTE, `Bearer ${TEST_API_TOKEN}`)).statusCode,
    ).toBe(200);
    expect(
      (await request(INGESTION_ROUTE, `Bearer ${TEST_INGESTION_TOKEN}`))
        .statusCode,
    ).toBe(200);
    expect(
      (await request(ADMIN_ROUTE, `Bearer ${TEST_INGESTION_TOKEN}`)).statusCode,
    ).toBe(401);
    expect(
      (await request(INGESTION_ROUTE, `Bearer ${TEST_API_TOKEN}`)).statusCode,
    ).toBe(401);
  });

  it('accepts a lowercase scheme', async () => {
    expect(
      (await request(ADMIN_ROUTE, `bearer ${TEST_API_TOKEN}`)).statusCode,
    ).toBe(200);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty bearer token', 'Bearer '],
    ['a scheme without a token', 'Bearer'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a wrong token', 'Bearer wrong-token-0123456789abcdef0123456789'],
    ['a token prefix', `Bearer ${TEST_API_TOKEN.slice(0, -1)}`],
    ['a token with extra characters', `Bearer ${TEST_API_TOKEN}x`],
  ])('rejects %s', async (_label, authorization) => {
    const response = await request(ADMIN_ROUTE, authorization);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');

    const body = apiErrorBodySchema.parse(response.json());

    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).not.toContain(TEST_API_TOKEN);
  });

  it('never echoes either expected token', async () => {
    const response = await request(ADMIN_ROUTE, 'Bearer nope');

    expect(response.body).not.toContain(TEST_API_TOKEN);
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

  it('accepts previous credentials only in their original scope', async () => {
    const previousAdmin = 'previous-admin-token-0123456789abcdef012345';
    const previousIngestion = 'previous-ingestion-token-0123456789abcdef0123';
    const app = await createApp(
      createTestConfig(dataDirectory, {
        administrationTokens: [TEST_API_TOKEN, previousAdmin],
        ingestionTokens: [TEST_INGESTION_TOKEN, previousIngestion],
      }),
    );
    app.get(
      ADMIN_ROUTE,
      { onRequest: app.requireAdministrationToken },
      async () => ({ ok: true }),
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
            url: ADMIN_ROUTE,
            headers: { authorization: `Bearer ${previousAdmin}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: INGESTION_ROUTE,
            headers: { authorization: `Bearer ${previousIngestion}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: ADMIN_ROUTE,
            headers: { authorization: `Bearer ${previousIngestion}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('allows administration credentials on ingestion only when opted in', async () => {
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
        headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
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
      { onRequest: app.requireAdministrationToken },
      async () => ({ ok: true }),
    );

    try {
      const invalidRequest = () =>
        app.inject({
          method: 'GET',
          url: ADMIN_ROUTE,
          headers: { authorization: 'Bearer definitely-wrong' },
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
            headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
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
