import { DEFAULT_GALLERY_SETTINGS } from '@home-gallery/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/database/connection.js';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/database/migrations.js';
import { createSettingsRepository } from '../src/database/settings-repository.js';

describe('migrations', () => {
  let database: DatabaseConnection;

  beforeEach(() => {
    database = openDatabase(':memory:');
  });

  afterEach(() => {
    database.close();
  });

  it('applies every migration on a fresh database', () => {
    expect(migrate(database)).toEqual([1, 2, 3]);
    expect(LATEST_SCHEMA_VERSION).toBe(3);
  });

  it('is repeatable', () => {
    migrate(database);

    expect(migrate(database)).toEqual([]);
    expect(migrate(database)).toEqual([]);

    const rows = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];

    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it('seeds deterministic default gallery settings', () => {
    migrate(database);

    expect(createSettingsRepository(database).read()).toEqual(
      DEFAULT_GALLERY_SETTINGS,
    );
  });

  it('does not reseed settings that an administrator changed', () => {
    migrate(database);
    createSettingsRepository(database).update({ slideDurationMs: 12_000 });

    migrate(database);

    expect(createSettingsRepository(database).read().slideDurationMs).toBe(
      12_000,
    );
  });

  it('rejects Telegram contributor rows with an unknown status', () => {
    migrate(database);

    expect(() =>
      database
        .prepare(
          `INSERT INTO telegram_contributors (
             telegram_user_id, status, first_name, last_name, username,
             requested_at, updated_at
           ) VALUES ('123', 'allowed', NULL, NULL, NULL,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('rejects media rows that violate the schema constraints', () => {
    migrate(database);

    expect(() =>
      database
        .prepare(
          `INSERT INTO media (
             id, stored_filename, original_filename, media_type, mime_type,
             uploaded_at, source, source_id, author_name, enabled, sort_order,
             width, height
           ) VALUES ('id', 'a.webp', 'a.jpg', 'image', 'image/webp',
             '2026-01-01T00:00:00.000Z', 'telegram', NULL, NULL, 1, 0, 0, 10)`,
        )
        .run(),
    ).toThrow();
  });
});
