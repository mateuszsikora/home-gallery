import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
  apiErrorBodySchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyAdminPassword } from '../src/auth/admin-password.js';
import type * as AdminPasswordModule from '../src/auth/admin-password.js';
import { createApp } from '../src/app.js';
import {
  adminMutationHeaders,
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_ADMIN_PASSWORD,
} from './helpers.js';

// Counting real derivations is the only way to prove the limiter runs first:
// the response code alone looks the same whether or not the work was done.
vi.mock('../src/auth/admin-password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AdminPasswordModule>();

  return { ...actual, verifyAdminPassword: vi.fn(actual.verifyAdminPassword) };
});

describe('administration password rate limiting', () => {
  let app: FastifyInstance;
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(
      createTestConfig(dataDirectory, {
        authenticationRateLimit: { max: 2, windowMs: 60_000 },
      }),
    );

    const cookie = await createTestAdminSession(app);
    await app.inject({
      method: 'PUT',
      url: API_ROUTES.adminPassword,
      headers: adminMutationHeaders(cookie),
      payload: { newPassword: TEST_ADMIN_PASSWORD },
    });
    vi.mocked(verifyAdminPassword).mockClear();
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const attemptSession = () =>
    app.inject({
      method: 'POST',
      url: API_ROUTES.adminSession,
      headers: { [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE },
      payload: { password: 'not-the-password' },
    });

  it('stops deriving a hash once the client is over its limit', async () => {
    expect((await attemptSession()).statusCode).toBe(401);
    expect((await attemptSession()).statusCode).toBe(401);
    expect(vi.mocked(verifyAdminPassword)).toHaveBeenCalledTimes(2);

    const limited = await attemptSession();

    expect(limited.statusCode).toBe(429);
    expect(apiErrorBodySchema.parse(limited.json()).error.code).toBe(
      'rate_limited',
    );
    // The rejected attempt did no scrypt work, so a request loop cannot make
    // the server derive hashes indefinitely.
    expect(vi.mocked(verifyAdminPassword)).toHaveBeenCalledTimes(2);

    expect((await attemptSession()).statusCode).toBe(429);
    expect(vi.mocked(verifyAdminPassword)).toHaveBeenCalledTimes(2);
  });

  it('stops deriving a hash for password changes over the limit', async () => {
    const cookie = await createTestAdminSession(app, TEST_ADMIN_PASSWORD);
    vi.mocked(verifyAdminPassword).mockClear();

    const change = () =>
      app.inject({
        method: 'PUT',
        url: API_ROUTES.adminPassword,
        headers: adminMutationHeaders(cookie),
        payload: {
          currentPassword: 'not-the-password',
          newPassword: 'another-good-password',
        },
      });

    expect((await change()).statusCode).toBe(403);
    expect((await change()).statusCode).toBe(403);
    expect(vi.mocked(verifyAdminPassword)).toHaveBeenCalledTimes(2);

    expect((await change()).statusCode).toBe(429);
    expect(vi.mocked(verifyAdminPassword)).toHaveBeenCalledTimes(2);
  });
});
