import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from '@home-gallery/config';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/database/connection.js';
import { migrate } from '../src/database/migrations.js';

export const TEST_API_TOKEN = 'test-token-0123456789abcdef0123456789ab';

/**
 * Every test runs against a fresh directory under the OS temporary directory so
 * no test can write into the repository or into a real deployment.
 */
export const createTemporaryDataDirectory = (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'home-gallery-test-'));

export const removeTemporaryDataDirectory = (
  directory: string,
): Promise<void> => rm(directory, { recursive: true, force: true });

export const createTestConfig = (
  dataDirectory: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  apiToken: TEST_API_TOKEN,
  dataDirectory,
  maxUploadBytes: 1024 * 1024,
  maxStoredFiles: 100,
  allowedOrigins: [],
  logLevel: 'silent',
  version: '1.2.3',
  ...overrides,
});

/** An in-memory database with the current schema, for repository tests. */
export const createMigratedDatabase = (): DatabaseConnection => {
  const database = openDatabase(':memory:');
  migrate(database);
  return database;
};
