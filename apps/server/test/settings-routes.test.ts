import {
  API_ROUTES,
  apiErrorBodySchema,
  DEFAULT_GALLERY_SETTINGS,
  gallerySettingsSchema,
  MAX_SLIDE_DURATION_MS,
  MIN_SLIDE_DURATION_MS,
} from '@home-gallery/shared-types';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_API_TOKEN,
} from './helpers.js';

describe('gallery settings routes', () => {
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

  /** A `null` token sends no `Authorization` header at all. */
  const patchSettings = (
    payload: Record<string, unknown>,
    token: string | null = TEST_API_TOKEN,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = {
      method: 'PATCH',
      url: API_ROUTES.settings,
      ...(token === null
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
      payload,
    };

    return app.inject(options);
  };

  it('returns the seeded defaults', async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.settings,
      headers: { authorization: `Bearer ${TEST_API_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(gallerySettingsSchema.parse(response.json())).toEqual(
      DEFAULT_GALLERY_SETTINGS,
    );
  });

  it('applies a partial update and leaves the other settings alone', async () => {
    const response = await patchSettings({ slideDurationMs: 12_000 });

    expect(response.statusCode).toBe(200);
    expect(gallerySettingsSchema.parse(response.json())).toEqual({
      ...DEFAULT_GALLERY_SETTINGS,
      slideDurationMs: 12_000,
    });
    expect(app.settingsRepository.read().fadeDurationMs).toBe(
      DEFAULT_GALLERY_SETTINGS.fadeDurationMs,
    );
  });

  it('accepts the documented boundary values', async () => {
    expect(
      (await patchSettings({ slideDurationMs: MIN_SLIDE_DURATION_MS }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await patchSettings({
          slideDurationMs: MAX_SLIDE_DURATION_MS,
          fadeDurationMs: 0,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rejects a slide duration below the documented minimum', async () => {
    const response = await patchSettings({
      slideDurationMs: MIN_SLIDE_DURATION_MS - 1,
    });

    expect(response.statusCode).toBe(422);
    expect(apiErrorBodySchema.parse(response.json()).error).toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'slideDurationMs' }],
    });
    expect(app.settingsRepository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('rejects an unknown playback mode', async () => {
    const response = await patchSettings({ playbackMode: 'random' });

    expect(response.statusCode).toBe(422);
    expect(app.settingsRepository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('rejects an empty update', async () => {
    expect((await patchSettings({})).statusCode).toBe(422);
  });

  it('rejects unknown settings fields', async () => {
    const response = await patchSettings({ transition: 'wipe' });

    expect(response.statusCode).toBe(422);
    expect(app.settingsRepository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('requires a bearer token to read the settings', async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.settings,
    });

    expect(response.statusCode).toBe(401);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'unauthorized',
    );
  });

  it('requires a bearer token to update the settings', async () => {
    const response = await patchSettings({ playbackMode: 'shuffle' }, null);

    expect(response.statusCode).toBe(401);
    expect(app.settingsRepository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });
});
