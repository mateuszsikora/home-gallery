import { DEFAULT_GALLERY_SETTINGS } from '@home-gallery/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseConnection } from '../src/database/connection.js';
import {
  createSettingsRepository,
  MissingSettingsError,
  type SettingsRepository,
} from '../src/database/settings-repository.js';
import { createMigratedDatabase } from './helpers.js';

describe('settings repository', () => {
  let database: DatabaseConnection;
  let repository: SettingsRepository;

  beforeEach(() => {
    database = createMigratedDatabase();
    repository = createSettingsRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it('starts from the shared defaults', () => {
    expect(repository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('applies a partial update and keeps the other fields', () => {
    const updated = repository.update({ playbackMode: 'shuffle' });

    expect(updated).toEqual({
      ...DEFAULT_GALLERY_SETTINGS,
      playbackMode: 'shuffle',
    });
    expect(repository.read()).toEqual(updated);
  });

  it('ignores fields explicitly set to undefined', () => {
    repository.update({ slideDurationMs: 20_000 });

    expect(repository.update({ fadeDurationMs: 250 })).toEqual({
      ...DEFAULT_GALLERY_SETTINGS,
      slideDurationMs: 20_000,
      fadeDurationMs: 250,
    });
  });

  it('rejects values outside the documented ranges', () => {
    expect(() => repository.update({ slideDurationMs: 10 })).toThrow();
    expect(() => repository.update({ fadeDurationMs: 100_000 })).toThrow();
    expect(repository.read()).toEqual(DEFAULT_GALLERY_SETTINGS);
  });

  it('reports a missing settings row instead of inventing defaults', () => {
    database.prepare('DELETE FROM gallery_settings').run();

    expect(() => repository.read()).toThrow(MissingSettingsError);
  });
});
