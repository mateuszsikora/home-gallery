import {
  API_ROUTES,
  DEFAULT_GALLERY_SETTINGS,
  playlistResponseSchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  storeTestMedia,
} from './helpers.js';

describe('GET /api/playlist', () => {
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

  const readPlaylist = async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.playlist,
    });

    expect(response.statusCode).toBe(200);
    return {
      response,
      playlist: playlistResponseSchema.parse(response.json()),
    };
  };

  it('serves an empty playlist with the current settings', async () => {
    const { playlist } = await readPlaylist();

    expect(playlist.items).toEqual([]);
    expect(playlist.settings).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('exposes only enabled media, in playlist order', async () => {
    const first = await storeTestMedia(app);
    await storeTestMedia(app, { enabled: false });
    const third = await storeTestMedia(app);

    const { playlist } = await readPlaylist();

    expect(playlist.items.map((item) => item.id)).toEqual([
      first.record.id,
      third.record.id,
    ]);
  });

  it('follows a reorder', async () => {
    const first = await storeTestMedia(app);
    const second = await storeTestMedia(app);

    app.mediaRepository.update(second.record.id, { sortOrder: 0 });

    const { playlist } = await readPlaylist();

    expect(playlist.items.map((item) => item.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
  });

  it('omits contributor and storage metadata', async () => {
    const { record } = await storeTestMedia(app, {
      sourceId: '123456',
      authorName: 'Gallery contributor',
    });

    const { playlist } = await readPlaylist();

    expect(playlist.items[0]).toEqual({
      id: record.id,
      contentUrl: API_ROUTES.mediaContentById(record.id),
      mimeType: 'image/webp',
      width: record.width,
      height: record.height,
    });
  });

  it('reports the updated settings and is never cached', async () => {
    app.settingsRepository.update({ playbackMode: 'shuffle' });

    const { response, playlist } = await readPlaylist();

    expect(playlist.settings.playbackMode).toBe('shuffle');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('is public', async () => {
    await storeTestMedia(app);

    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.playlist,
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(response.statusCode).toBe(200);
  });
});
