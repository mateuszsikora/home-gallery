import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

export type DatabaseConnection = Database.Database;

/** File name of the SQLite database inside the configured data directory. */
export const DATABASE_FILENAME = 'home-gallery.db';

/**
 * Opens the metadata database with the pragmas the service relies on:
 * WAL for concurrent readers during uploads, enforced foreign keys, and a busy
 * timeout so a concurrent writer retries instead of failing a request.
 */
export const openDatabase = (filePath: string): DatabaseConnection => {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }

  const database = new Database(filePath);

  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  return database;
};
