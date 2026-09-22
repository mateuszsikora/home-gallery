import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
  apiErrorBodySchema,
  telegramContributorListResponseSchema,
  telegramContributorSchema,
} from '@home-gallery/shared-types';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  adminMutationHeaders,
  createTemporaryDataDirectory,
  createTestAdminSession,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_INGESTION_TOKEN,
} from './helpers.js';

describe('telegram contributor routes', () => {
  let dataDirectory: string;
  let app: FastifyInstance;
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

  /** A `null` token sends no `Authorization` header at all. */
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    token: string | null,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = {
      method,
      url,
      ...(token === null
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
      ...(payload === undefined ? {} : { payload }),
    };

    return app.inject(options);
  };

  const register = (
    payload: Record<string, unknown>,
    token: string | null = TEST_INGESTION_TOKEN,
  ): Promise<LightMyRequestResponse> =>
    call('POST', API_ROUTES.telegramContributors, token, payload);

  /** A `null` cookie sends no administration session at all. */
  const administrate = (
    method: 'GET' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
    cookie: string | null = sessionCookie,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = {
      method,
      url,
      ...(cookie === null ? {} : { headers: adminMutationHeaders(cookie) }),
      ...(payload === undefined ? {} : { payload }),
    };

    return app.inject(options);
  };

  describe('POST /api/telegram/contributors', () => {
    it('records first contact as a pending access request', async () => {
      const response = await register({
        telegramUserId: '123',
        firstName: 'Ada',
        username: 'ada',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(telegramContributorSchema.parse(response.json())).toMatchObject({
        telegramUserId: '123',
        status: 'pending',
        firstName: 'Ada',
        username: 'ada',
      });
    });

    it('answers a repeated contact with the current decision', async () => {
      await register({ telegramUserId: '123', firstName: 'Ada' });
      app.telegramContributorRepository.decide('123', 'approved');

      const response = await register({
        telegramUserId: '123',
        firstName: 'Ada',
      });

      expect(response.statusCode).toBe(200);
      expect(telegramContributorSchema.parse(response.json()).status).toBe(
        'approved',
      );
      expect(app.telegramContributorRepository.list()).toHaveLength(1);
    });

    it.each([
      ['a malformed user ID', { telegramUserId: 'ada' }],
      ['a negative user ID', { telegramUserId: '-7' }],
      ['an unknown field', { telegramUserId: '123', status: 'approved' }],
    ])('rejects %s', async (_case, payload) => {
      const response = await register(payload);

      expect(response.statusCode).toBe(422);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'validation_failed',
      );
      expect(app.telegramContributorRepository.list()).toEqual([]);
    });

    it('refuses registration with no credential', async () => {
      const response = await register({ telegramUserId: '123' }, null);

      expect(response.statusCode).toBe(401);
      expect(app.telegramContributorRepository.list()).toEqual([]);
    });

    it('refuses registration from an administration session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: API_ROUTES.telegramContributors,
        headers: adminMutationHeaders(sessionCookie),
        payload: { telegramUserId: '123' },
      });

      // 403, not `unauthorized`: the session itself is still valid, and 401 is
      // what tells the administration app that one has expired. The code is the
      // one the shared ingestion guard raises, and it has to stay true here as
      // well as on the upload route, so it names ingestion rather than uploads.
      expect(response.statusCode).toBe(403);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'administration_ingestion_disabled',
      );
      expect(app.telegramContributorRepository.list()).toEqual([]);
    });
  });

  describe('GET /api/telegram/contributors', () => {
    it('lists contributors for an administrator', async () => {
      await register({ telegramUserId: '123', firstName: 'Ada' });

      const response = await administrate(
        'GET',
        API_ROUTES.telegramContributors,
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = telegramContributorListResponseSchema.parse(response.json());
      expect(body.items.map((item) => item.telegramUserId)).toEqual(['123']);
    });

    it.each([
      ['no credential', null],
      ['the ingestion credential', TEST_INGESTION_TOKEN],
    ])('refuses the list with %s', async (_case, token) => {
      const response = await call(
        'GET',
        API_ROUTES.telegramContributors,
        token,
      );

      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/telegram/contributors/{telegramUserId}', () => {
    const decide = (
      telegramUserId: string,
      status: string,
      cookie: string | null = sessionCookie,
    ): Promise<LightMyRequestResponse> =>
      administrate(
        'PATCH',
        API_ROUTES.telegramContributorById(telegramUserId),
        { status },
        cookie,
      );

    it('approves and rejects a contributor', async () => {
      await register({ telegramUserId: '123', firstName: 'Ada' });

      const approved = await decide('123', 'approved');
      expect(approved.statusCode).toBe(200);
      expect(telegramContributorSchema.parse(approved.json()).status).toBe(
        'approved',
      );

      const rejected = await decide('123', 'rejected');
      expect(telegramContributorSchema.parse(rejected.json()).status).toBe(
        'rejected',
      );
    });

    it.each([
      ['pending', 'pending'],
      ['an unknown status', 'banned'],
    ])('rejects %s as a decision', async (_case, status) => {
      await register({ telegramUserId: '123' });

      const response = await decide('123', status);

      expect(response.statusCode).toBe(422);
      expect(
        app.telegramContributorRepository.findByTelegramUserId('123'),
      ).toMatchObject({ status: 'pending' });
    });

    it.each([
      ['an unknown contributor', '999'],
      ['a malformed identifier', 'ada'],
    ])('reports %s as not found', async (_case, telegramUserId) => {
      const response = await decide(telegramUserId, 'approved');

      expect(response.statusCode).toBe(404);
      expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
        'not_found',
      );
    });

    it('refuses a decision made with no credential', async () => {
      await register({ telegramUserId: '123' });

      const response = await decide('123', 'approved', null);

      expect(response.statusCode).toBe(401);
      expect(
        app.telegramContributorRepository.findByTelegramUserId('123')?.status,
      ).toBe('pending');
    });

    it('refuses a decision made with the ingestion credential', async () => {
      await register({ telegramUserId: '123' });

      const response = await call(
        'PATCH',
        API_ROUTES.telegramContributorById('123'),
        TEST_INGESTION_TOKEN,
        { status: 'approved' },
      );

      expect(response.statusCode).toBe(401);
      expect(
        app.telegramContributorRepository.findByTelegramUserId('123')?.status,
      ).toBe('pending');
    });

    it('requires CSRF for a session decision', async () => {
      await register({ telegramUserId: '123' });

      const listed = await app.inject({
        method: 'GET',
        url: API_ROUTES.telegramContributors,
        headers: { cookie: sessionCookie },
      });
      const withoutCsrf = await app.inject({
        method: 'PATCH',
        url: API_ROUTES.telegramContributorById('123'),
        headers: { cookie: sessionCookie },
        payload: { status: 'approved' },
      });
      const withCsrf = await app.inject({
        method: 'PATCH',
        url: API_ROUTES.telegramContributorById('123'),
        headers: {
          cookie: sessionCookie,
          [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE,
        },
        payload: { status: 'approved' },
      });

      expect(listed.statusCode).toBe(200);
      expect(withoutCsrf.statusCode).toBe(403);
      expect(apiErrorBodySchema.parse(withoutCsrf.json()).error.code).toBe(
        'forbidden',
      );
      expect(withCsrf.statusCode).toBe(200);
      expect(telegramContributorSchema.parse(withCsrf.json()).status).toBe(
        'approved',
      );
    });
  });

  it('keeps approval state across a restart', async () => {
    await register({ telegramUserId: '123', firstName: 'Ada' });
    app.telegramContributorRepository.decide('123', 'approved');

    await app.close();
    app = await createApp(createTestConfig(dataDirectory));

    const response = await administrate(
      'GET',
      API_ROUTES.telegramContributors,
      undefined,
      await createTestAdminSession(app),
    );
    const body = telegramContributorListResponseSchema.parse(response.json());

    expect(body.items).toMatchObject([
      { telegramUserId: '123', status: 'approved', firstName: 'Ada' },
    ]);
  });
});
