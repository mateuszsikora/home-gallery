import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from '@home-gallery/config';
import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
} from '@home-gallery/shared-types';
import type { MediaRecord } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import {
  openDatabase,
  type DatabaseConnection,
} from '../src/database/connection.js';
import { ADMIN_SESSION_COOKIE_NAME } from '../src/http/admin-session-routes.js';
import { migrate } from '../src/database/migrations.js';
import type { CreateMediaInput } from '../src/database/media-repository.js';

export const TEST_INGESTION_TOKEN =
  'ingestion-token-0123456789abcdef0123456789';
export const TEST_ADMIN_PASSWORD = 'test-administration-password';

/**
 * Opens an administration session the way the browser does and returns the
 * cookie header that authenticates the rest of a test.
 */
export const createTestAdminSession = async (
  app: FastifyInstance,
  password?: string,
): Promise<string> => {
  const response = await app.inject({
    method: 'POST',
    url: API_ROUTES.adminSession,
    headers: { [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE },
    payload: password === undefined ? {} : { password },
  });

  if (response.statusCode !== 201) {
    throw new Error(
      `Administration session was refused with ${response.statusCode}: ${response.body}`,
    );
  }

  const cookie = response.cookies.find(
    ({ name }) => name === ADMIN_SESSION_COOKIE_NAME,
  );

  if (cookie === undefined) {
    throw new Error('Administration session response carried no cookie');
  }

  return `${cookie.name}=${cookie.value}`;
};

/** Headers that authenticate a state-changing administration request. */
export const adminMutationHeaders = (
  sessionCookie: string,
): Record<string, string> => ({
  cookie: sessionCookie,
  [ADMIN_SESSION_CSRF_HEADER]: ADMIN_SESSION_CSRF_VALUE,
});

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

/**
 * Adds a media record whose stored file is a real normalized image, which the
 * thumbnail tests need because they decode what they find on disk.
 */
export const storeTestImage = async (
  app: FastifyInstance,
  overrides: Partial<CreateMediaInput> = {},
): Promise<StoredTestMedia> => {
  const id = overrides.id ?? randomUUID();
  const storedFilename = overrides.storedFilename ?? `${id}.webp`;
  // Noise instead of a flat colour, so a downscaled copy is measurably smaller
  // than the original the way a photograph is.
  const bytes = await sharp({
    create: {
      width: 1_200,
      height: 900,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  })
    .webp()
    .toBuffer();

  await writeFile(app.mediaStorage.resolveMediaPath(storedFilename), bytes);

  const record = app.mediaRepository.create({
    mediaType: 'image',
    mimeType: 'image/webp',
    source: 'telegram',
    originalFilename: 'photo.jpg',
    width: 1_200,
    height: 900,
    ...overrides,
    id,
    storedFilename,
  });

  return { record, bytes };
};

/** Puts a Telegram contributor into the state that allows ingestion. */
export const approveTestContributor = (
  app: FastifyInstance,
  telegramUserId: string,
): void => {
  app.telegramContributorRepository.register({ telegramUserId });
  app.telegramContributorRepository.decide(telegramUserId, 'approved');
};

/** An in-memory database with the current schema, for repository tests. */
export const createMigratedDatabase = (): DatabaseConnection => {
  const database = openDatabase(':memory:');
  migrate(database);
  return database;
};
