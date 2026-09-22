import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
  MIN_ADMIN_PASSWORD_LENGTH,
  adminAuthStatusSchema,
  apiErrorBodySchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  adminMutationHeaders,
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_ADMIN_PASSWORD,
} from './helpers.js';

const NEXT_PASSWORD = 'the-second-administration-password';

describe('administration password routes', () => {
  let app: FastifyInstance;
  let dataDirectory: string;
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

  const setPassword = (
    payload: Record<string, unknown>,
    cookie: string | null = sessionCookie,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'PUT',
      url: API_ROUTES.adminPassword,
      ...(cookie === null ? {} : { headers: adminMutationHeaders(cookie) }),
      payload,
    });

  const removePassword = (
    payload: Record<string, unknown>,
    cookie: string | null = sessionCookie,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'DELETE',
      url: API_ROUTES.adminPassword,
      ...(cookie === null ? {} : { headers: adminMutationHeaders(cookie) }),
      payload,
    });

  const passwordConfigured = async (): Promise<boolean> =>
    adminAuthStatusSchema.parse(
      (await app.inject({ method: 'GET', url: API_ROUTES.adminAuth })).json(),
    ).passwordConfigured;

  it('sets the first password without asking for a current one', async () => {
    const response = await setPassword({ newPassword: TEST_ADMIN_PASSWORD });

    expect(response.statusCode).toBe(204);
    expect(await passwordConfigured()).toBe(true);
  });

  it('keeps the calling session and locks out the others', async () => {
    const otherCookie = await createTestAdminSession(app);

    expect(
      (await setPassword({ newPassword: TEST_ADMIN_PASSWORD })).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: API_ROUTES.adminSession,
          headers: { cookie: sessionCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: API_ROUTES.adminSession,
          headers: { cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('demands the current password to change a configured one', async () => {
    await setPassword({ newPassword: TEST_ADMIN_PASSWORD });

    const missing = await setPassword({ newPassword: NEXT_PASSWORD });
    const wrong = await setPassword({
      currentPassword: 'not-the-current-password',
      newPassword: NEXT_PASSWORD,
    });
    const correct = await setPassword({
      currentPassword: TEST_ADMIN_PASSWORD,
      newPassword: NEXT_PASSWORD,
    });

    // The code names the rejected password, so the administration app does not
    // have to infer that cause from a 403 the route's other guards also use.
    expect(missing.statusCode).toBe(403);
    expect(apiErrorBodySchema.parse(missing.json()).error.code).toBe(
      'invalid_password',
    );
    expect(wrong.statusCode).toBe(403);
    expect(apiErrorBodySchema.parse(wrong.json()).error.code).toBe(
      'invalid_password',
    );
    expect(wrong.body).not.toContain(TEST_ADMIN_PASSWORD);
    expect(correct.statusCode).toBe(204);
  });

  it('removes the password and reopens the studio', async () => {
    await setPassword({ newPassword: TEST_ADMIN_PASSWORD });

    const wrong = await removePassword({ currentPassword: NEXT_PASSWORD });

    expect(wrong.statusCode).toBe(403);
    expect(apiErrorBodySchema.parse(wrong.json()).error.code).toBe(
      'invalid_password',
    );
    expect(await passwordConfigured()).toBe(true);

    const removed = await removePassword({
      currentPassword: TEST_ADMIN_PASSWORD,
    });

    expect(removed.statusCode).toBe(204);
    expect(await passwordConfigured()).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: API_ROUTES.adminSession,
          headers: { [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE },
          payload: {},
        })
      ).statusCode,
    ).toBe(201);
  });

  it.each([
    [
      'too short a password',
      { newPassword: 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1) },
    ],
    [
      'a password with a control character',
      { newPassword: 'control\u0007char' },
    ],
    ['a missing password', {}],
    ['an unknown field', { newPassword: TEST_ADMIN_PASSWORD, hint: 'pets' }],
  ])('rejects %s', async (_label, payload) => {
    const response = await setPassword(payload);

    expect(response.statusCode).toBe(422);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'validation_failed',
    );
    expect(await passwordConfigured()).toBe(false);
  });

  it('refuses to remove a password that was never set', async () => {
    const response = await removePassword({
      currentPassword: TEST_ADMIN_PASSWORD,
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'conflict',
    );
    expect(await passwordConfigured()).toBe(false);
  });

  it('requires an administration session', async () => {
    expect(
      (await setPassword({ newPassword: TEST_ADMIN_PASSWORD }, null))
        .statusCode,
    ).toBe(401);
    expect(
      (await removePassword({ currentPassword: TEST_ADMIN_PASSWORD }, null))
        .statusCode,
    ).toBe(401);
    expect(await passwordConfigured()).toBe(false);
  });

  it('requires the CSRF header even with a valid session', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: API_ROUTES.adminPassword,
      headers: { cookie: sessionCookie },
      payload: { newPassword: TEST_ADMIN_PASSWORD },
    });

    // The same 403 as a rejected password, with a different code: a client that
    // told the two apart by status would blame the administrator's typing for a
    // header its own request failed to send.
    expect(response.statusCode).toBe(403);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'csrf_required',
    );
    expect(await passwordConfigured()).toBe(false);
  });

  it('keeps the password across a restart', async () => {
    await setPassword({ newPassword: TEST_ADMIN_PASSWORD });
    await app.close();
    app = await createApp(createTestConfig(dataDirectory));

    expect(await passwordConfigured()).toBe(true);
    await expect(
      createTestAdminSession(app, TEST_ADMIN_PASSWORD),
    ).resolves.toContain('home_gallery_admin_session=');
  });

  it('counts wrong current passwords against the authentication limit', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, {
        authenticationRateLimit: { max: 2, windowMs: 60_000 },
      }),
    );
    sessionCookie = await createTestAdminSession(app);
    await setPassword({ newPassword: TEST_ADMIN_PASSWORD });

    const wrongAttempt = () =>
      setPassword({
        currentPassword: 'still-not-the-password',
        newPassword: NEXT_PASSWORD,
      });

    expect((await wrongAttempt()).statusCode).toBe(403);
    expect((await wrongAttempt()).statusCode).toBe(403);

    const limited = await wrongAttempt();

    expect(limited.statusCode).toBe(429);
    expect(apiErrorBodySchema.parse(limited.json()).error.code).toBe(
      'rate_limited',
    );
  });
});
