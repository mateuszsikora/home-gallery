import { apiErrorBodySchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { secretsMatch } from '../src/http/authentication.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_API_TOKEN,
} from './helpers.js';

const PROTECTED_ROUTE = '/test/protected';

describe('bearer token guard', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    app.get(
      PROTECTED_ROUTE,
      { onRequest: app.requireBearerToken },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const request = (authorization?: string) =>
    app.inject({
      method: 'GET',
      url: PROTECTED_ROUTE,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

  it('accepts the configured token', async () => {
    const response = await request(`Bearer ${TEST_API_TOKEN}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('accepts a lowercase scheme', async () => {
    expect((await request(`bearer ${TEST_API_TOKEN}`)).statusCode).toBe(200);
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
    const response = await request(authorization);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');

    const body = apiErrorBodySchema.parse(response.json());

    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).not.toContain(TEST_API_TOKEN);
  });

  it('never echoes the expected token', async () => {
    const response = await request('Bearer nope');

    expect(response.body).not.toContain(TEST_API_TOKEN);
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
