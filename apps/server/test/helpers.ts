import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from '@home-gallery/config';
import type { MediaRecord } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/database/connection.js';
import { migrate } from '../src/database/migrations.js';
import type { CreateMediaInput } from '../src/database/media-repository.js';

export const TEST_API_TOKEN = 'test-token-0123456789abcdef0123456789ab';
export const TEST_INGESTION_TOKEN =
  'ingestion-token-0123456789abcdef0123456789';

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
  administrationTokens: [TEST_API_TOKEN],
  ingestionTokens: [TEST_INGESTION_TOKEN],
  allowAdministrationUploads: false,
  adminSession: { max: 64, secure: false, ttlMs: 8 * 60 * 60 * 1_000 },
  authenticationRateLimit: { max: 10, windowMs: 60_000 },
  uploadRateLimit: { max: 30, windowMs: 60_000 },
  trustedProxies: [],
  dataDirectory,
  maxUploadBytes: 1024 * 1024,
  maxStoredFiles: 100,
  allowedOrigins: [],
  logLevel: 'silent',
  version: '1.2.3',
  ...overrides,
});

export interface StoredTestMedia {
  record: MediaRecord;
  bytes: Buffer;
}

/**
 * Adds a media record together with the file it points at, which is the state
 * a completed upload leaves behind. Route tests use it instead of uploading so
 * they exercise one behavior at a time.
 */
export const storeTestMedia = async (
  app: FastifyInstance,
  overrides: Partial<CreateMediaInput> = {},
): Promise<StoredTestMedia> => {
  const id = overrides.id ?? randomUUID();
  const storedFilename = overrides.storedFilename ?? `${id}.webp`;
  const bytes = Buffer.from(`normalized-media-${id}`);

  await writeFile(app.mediaStorage.resolveMediaPath(storedFilename), bytes);

  const record = app.mediaRepository.create({
    mediaType: 'image',
    mimeType: 'image/webp',
    source: 'telegram',
    originalFilename: 'photo.jpg',
    width: 1920,
    height: 1080,
    ...overrides,
    id,
    storedFilename,
  });

  return { record, bytes };
};

/** An in-memory database with the current schema, for repository tests. */
export const createMigratedDatabase = (): DatabaseConnection => {
  const database = openDatabase(':memory:');
  migrate(database);
  return database;
};
