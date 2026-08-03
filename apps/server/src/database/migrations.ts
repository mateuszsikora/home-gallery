import {
  DEFAULT_GALLERY_SETTINGS,
  IMAGE_FIT_MODES,
  MEDIA_TYPES,
  NORMALIZED_MEDIA_MIME_TYPES,
  PLAYBACK_MODES,
  TELEGRAM_CONTRIBUTOR_STATUSES,
  UPLOAD_SOURCES,
} from '@home-gallery/shared-types';

import type { DatabaseConnection } from './connection.js';

interface Migration {
  version: number;
  name: string;
  apply: (database: DatabaseConnection) => void;
}

const quotedList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * Ordered, append-only list of schema changes. A migration is applied at most
 * once; editing an applied migration has no effect, so corrections must be
 * added as a new version.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_media',
    apply: (database) => {
      database.exec(`
        CREATE TABLE media (
          id TEXT PRIMARY KEY,
          stored_filename TEXT NOT NULL UNIQUE,
          original_filename TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN (${quotedList(MEDIA_TYPES)})),
          mime_type TEXT NOT NULL CHECK (mime_type IN (${quotedList(NORMALIZED_MEDIA_MIME_TYPES)})),
          uploaded_at TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN (${quotedList(UPLOAD_SOURCES)})),
          source_id TEXT,
          author_name TEXT,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
          width INTEGER NOT NULL CHECK (width > 0),
          height INTEGER NOT NULL CHECK (height > 0)
        ) STRICT;

        CREATE INDEX media_order_idx ON media (sort_order, id);
        CREATE INDEX media_enabled_order_idx ON media (enabled, sort_order, id);
      `);
    },
  },
  {
    version: 2,
    name: 'create_gallery_settings',
    apply: (database) => {
      database.exec(`
        CREATE TABLE gallery_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          slide_duration_ms INTEGER NOT NULL,
          fade_duration_ms INTEGER NOT NULL,
          playback_mode TEXT NOT NULL CHECK (playback_mode IN (${quotedList(PLAYBACK_MODES)}))
        ) STRICT;
      `);

      database
        .prepare(
          `INSERT INTO gallery_settings (id, slide_duration_ms, fade_duration_ms, playback_mode)
           VALUES (1, ?, ?, ?)`,
        )
        .run(
          DEFAULT_GALLERY_SETTINGS.slideDurationMs,
          DEFAULT_GALLERY_SETTINGS.fadeDurationMs,
          DEFAULT_GALLERY_SETTINGS.playbackMode,
        );
    },
  },
  {
    version: 3,
    name: 'create_telegram_contributors',
    apply: (database) => {
      database.exec(`
        CREATE TABLE telegram_contributors (
          telegram_user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN (${quotedList(TELEGRAM_CONTRIBUTOR_STATUSES)})),
          first_name TEXT,
          last_name TEXT,
          username TEXT,
          requested_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX telegram_contributors_status_idx
          ON telegram_contributors (status, requested_at);
      `);
    },
  },
  {
    version: 4,
    name: 'add_gallery_settings_image_fit',
    apply: (database) => {
      // The column default also backfills the existing settings row, so a
      // gallery that was installed before this migration adopts the same
      // screen-filling behavior as a fresh one.
      database.exec(`
        ALTER TABLE gallery_settings
          ADD COLUMN image_fit TEXT NOT NULL
            DEFAULT '${DEFAULT_GALLERY_SETTINGS.imageFit}'
            CHECK (image_fit IN (${quotedList(IMAGE_FIT_MODES)}));
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
);

interface AppliedMigrationRow {
  version: number;
}

const ensureMigrationTable = (database: DatabaseConnection): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
};

/**
 * Applies every migration that has not run yet and returns the versions that
 * were applied. Running it again on the same database is a no-op, so startup
 * and tests can call it unconditionally.
 */
export const migrate = (
  database: DatabaseConnection,
  now: () => Date = () => new Date(),
): number[] => {
  ensureMigrationTable(database);

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as AppliedMigrationRow).version),
  );

  const record = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const pending = MIGRATIONS.filter(
    (migration) => !applied.has(migration.version),
  );

  const runPending = database.transaction(
    (migrations: readonly Migration[]) => {
      for (const migration of migrations) {
        migration.apply(database);
        record.run(migration.version, migration.name, now().toISOString());
      }
    },
  );

  runPending(pending);

  return pending.map((migration) => migration.version);
};
