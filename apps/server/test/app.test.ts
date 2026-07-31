import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES } from '@home-gallery/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { DATABASE_FILENAME } from '../src/database/connection.js';
import { createMediaStorage } from '../src/storage/media-storage.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
} from './helpers.js';

describe('server application', () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(dataDirectory);
  });

  it('prepares the data directory and migrates the database', async () => {
    const app = await createApp(createTestConfig(dataDirectory));

    try {
      expect(
        (await stat(join(dataDirectory, DATABASE_FILENAME))).isFile(),
      ).toBe(true);
      expect(app.mediaRepository.count()).toBe(0);
      expect(app.settingsRepository.read().playbackMode).toBe('sequential');
    } finally {
      await app.close();
    }
  });

  it('clears interrupted uploads on startup', async () => {
    const storage = createMediaStorage(dataDirectory);
    await storage.initialize();
    await writeFile(join(storage.temporaryDirectory, 'stale.part'), 'partial');

    const app = await createApp(createTestConfig(dataDirectory));

    try {
      expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('keeps stored media across restarts', async () => {
    const first = await createApp(createTestConfig(dataDirectory));
    const created = first.mediaRepository.create({
      storedFilename: 'kept.webp',
      originalFilename: 'kept.jpg',
      mediaType: 'image',
      mimeType: 'image/webp',
      source: 'telegram',
      width: 800,
      height: 600,
    });
    await first.close();

    const second = await createApp(createTestConfig(dataDirectory));

    try {
      expect(second.mediaRepository.findById(created.id)).toEqual(created);
    } finally {
      await second.close();
    }
  });

  it('closes the database when the server shuts down', async () => {
    const app = await createApp(createTestConfig(dataDirectory));

    expect(app.database.open).toBe(true);

    await app.close();

    expect(app.database.open).toBe(false);
  });

  describe('CORS policy', () => {
    const requestWithOrigin = async (
      allowedOrigins: readonly string[],
      origin: string,
    ) => {
      const app = await createApp(
        createTestConfig(dataDirectory, { allowedOrigins }),
      );

      try {
        return await app.inject({
          method: 'GET',
          url: API_ROUTES.health,
          headers: { origin },
        });
      } finally {
        await app.close();
      }
    };

    it('rejects every origin by default', async () => {
      const response = await requestWithOrigin([], 'http://gallery.local');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows a configured origin', async () => {
      const response = await requestWithOrigin(
        ['http://gallery.local:3010'],
        'http://gallery.local:3010',
      );

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://gallery.local:3010',
      );
    });

    it('does not allow an origin that is not configured', async () => {
      const response = await requestWithOrigin(
        ['http://gallery.local:3010'],
        'http://attacker.local',
      );

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows every origin when explicitly configured to', async () => {
      const response = await requestWithOrigin(['*'], 'http://anywhere.local');

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });
});
