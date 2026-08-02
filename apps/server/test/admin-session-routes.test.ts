import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
  adminSessionSchema,
  apiErrorBodySchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/http/admin-session-routes.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_API_TOKEN,
  TEST_INGESTION_TOKEN,
} from './helpers.js';

const MUTATION_ROUTE = '/test/session-mutation';
const INGESTION_ROUTE = '/test/session-ingestion';

const cookieHeader = (setCookie: string | string[] | undefined): string => {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = value?.split(';', 1)[0];

  if (cookie === undefined) {
    throw new Error('Expected a session cookie');
  }

  return cookie;
};

describe('administration session routes', () => {
  let app: FastifyInstance;
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
    app.patch(
      MUTATION_ROUTE,
      { onRequest: app.requireAdministrationToken },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const createSession = async (token = TEST_API_TOKEN) =>
    app.inject({
      method: 'POST',
      url: API_ROUTES.adminSession,
      headers: { authorization: `Bearer ${token}` },
    });

  it('creates an opaque HttpOnly strict session only from an admin bearer', async () => {
    expect((await createSession(TEST_INGESTION_TOKEN)).statusCode).toBe(401);

    const response = await createSession();

    expect(response.statusCode).toBe(201);
    expect(adminSessionSchema.parse(response.json()).expiresAt).toMatch(/Z$/u);
    expect(response.body).not.toContain(TEST_API_TOKEN);
    expect(response.headers['set-cookie']).toContain(
      `${ADMIN_SESSION_COOKIE_NAME}=`,
    );
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.headers['set-cookie']).toContain('Path=/');
    expect(response.headers['set-cookie']).not.toContain('Secure');
  });

  it('sets Secure in the TLS profile', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, {
        adminSession: { max: 64, secure: true, ttlMs: 28_800_000 },
      }),
    );

    expect((await createSession()).headers['set-cookie']).toContain('Secure');
  });

  it('restores a valid session and accepts bearer clients independently', async () => {
    const created = await createSession();
    const cookie = cookieHeader(created.headers['set-cookie']);

    const restored = await app.inject({
      method: 'GET',
      url: API_ROUTES.adminSession,
      headers: { cookie },
    });
    const bearerRequest = await app.inject({
      method: 'PATCH',
      url: MUTATION_ROUTE,
      headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
    });

    expect(restored.statusCode).toBe(200);
    expect(adminSessionSchema.parse(restored.json())).toEqual(created.json());
    expect(bearerRequest.statusCode).toBe(200);
  });

  it('requires the explicit CSRF header for cookie mutations', async () => {
    const cookie = cookieHeader((await createSession()).headers['set-cookie']);
    const withoutCsrf = await app.inject({
      method: 'PATCH',
      url: MUTATION_ROUTE,
      headers: { cookie },
    });
    const withCsrf = await app.inject({
      method: 'PATCH',
      url: MUTATION_ROUTE,
      headers: {
        cookie,
        [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE,
      },
    });

    expect(withoutCsrf.statusCode).toBe(403);
    expect(apiErrorBodySchema.parse(withoutCsrf.json()).error.code).toBe(
      'forbidden',
    );
    expect(withCsrf.statusCode).toBe(200);
  });

  it('allows a CSRF-protected browser upload only when admin uploads are enabled', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, { allowAdministrationUploads: true }),
    );
    app.post(
      INGESTION_ROUTE,
      { onRequest: app.requireIngestionToken },
      async () => ({ ok: true }),
    );
    const cookie = cookieHeader((await createSession()).headers['set-cookie']);

    const response = await app.inject({
      method: 'POST',
      url: INGESTION_ROUTE,
      headers: {
        cookie,
        [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('invalidates the server session and clears the cookie on logout', async () => {
    const cookie = cookieHeader((await createSession()).headers['set-cookie']);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: API_ROUTES.adminSession,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);

    const loggedOut = await app.inject({
      method: 'DELETE',
      url: API_ROUTES.adminSession,
      headers: {
        cookie,
        [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE,
      },
    });

    expect(loggedOut.statusCode).toBe(204);
    expect(loggedOut.headers['set-cookie']).toContain(
      `${ADMIN_SESSION_COOKIE_NAME}=;`,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: API_ROUTES.adminSession,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
  });
});
