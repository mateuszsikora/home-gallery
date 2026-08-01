import { tmpdir } from 'node:os';

import {
  API_ROUTES,
  healthResponseSchema,
  apiErrorBodySchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
} from './helpers.js';

describe('health route', () => {
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

  it('keeps test data out of the repository', () => {
    expect(dataDirectory.startsWith(tmpdir())).toBe(true);
  });

  it('reports the configured version and a non-negative uptime', async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.health,
    });

    expect(response.statusCode).toBe(200);

    const body = healthResponseSchema.parse(response.json());

    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not require authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.health,
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('reports degraded when the database is unusable', async () => {
    app.database.close();

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.health,
    });

    expect(response.statusCode).toBe(503);
    expect(healthResponseSchema.parse(response.json()).status).toBe('degraded');
  });

  it('returns the structured error body for an unknown route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'not_found',
    );
  });
});
