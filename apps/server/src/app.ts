import { join } from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ALLOW_ALL_ORIGINS, type ServerConfig } from '@home-gallery/config';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  DATABASE_FILENAME,
  openDatabase,
  type DatabaseConnection,
} from './database/connection.js';
import { createAdminCredentials } from './auth/admin-credentials.js';
import { createAdminCredentialRepository } from './database/admin-credential-repository.js';
import { migrate } from './database/migrations.js';
import {
  createMediaRepository,
  type MediaRepository,
} from './database/media-repository.js';
import {
  createSettingsRepository,
  type SettingsRepository,
} from './database/settings-repository.js';
import {
  createTelegramContributorRepository,
  type TelegramContributorRepository,
} from './database/telegram-contributor-repository.js';
import { registerAdminPasswordRoutes } from './http/admin-password-routes.js';
import { AdminSessionStore } from './http/admin-session-store.js';
import { registerAdminSessionRoutes } from './http/admin-session-routes.js';
import { registerAuthentication } from './http/authentication.js';
import { registerErrorHandling } from './http/errors.js';
import { registerHealthRoute } from './http/health-route.js';
import {
  registerAdminMediaContentRoute,
  registerAdminMediaThumbnailRoute,
  registerMediaContentRoute,
} from './http/media-content-route.js';
import { registerMediaRoutes } from './http/media-routes.js';
import { registerMediaUploadRoute } from './http/media-upload-route.js';
import { registerPlaylistRoute } from './http/playlist-route.js';
import { FixedWindowRateLimiter } from './http/rate-limit.js';
import { registerSettingsRoutes } from './http/settings-routes.js';
import { registerTelegramContributorRoutes } from './http/telegram-contributor-routes.js';
import {
  startThumbnailBackfill,
  type ThumbnailBackfill,
} from './media/thumbnail-backfill.js';
import {
  createMediaStorage,
  type MediaStorage,
} from './storage/media-storage.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
    database: DatabaseConnection;
    mediaRepository: MediaRepository;
    settingsRepository: SettingsRepository;
    telegramContributorRepository: TelegramContributorRepository;
    mediaStorage: MediaStorage;
    /** The background pass that gives older media its preview derivative. */
    thumbnailBackfill: ThumbnailBackfill;
  }
}

const CORS_ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'x-home-gallery-csrf',
];
const CORS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=()';

/**
 * An empty allowlist keeps the API same-origin only, which is the safe default
 * for a bearer-protected service on a home network.
 */
const toCorsOrigin = (
  allowedOrigins: readonly string[],
): typeof ALLOW_ALL_ORIGINS | string[] | false => {
  if (allowedOrigins.includes(ALLOW_ALL_ORIGINS)) {
    return ALLOW_ALL_ORIGINS;
  }

  return allowedOrigins.length > 0 ? [...allowedOrigins] : false;
};

/**
 * Builds a ready-to-listen server. Every dependency is derived from the passed
 * configuration, so tests create an app against an isolated temporary data
 * directory and never touch the deployment's data directory.
 */
export const createApp = async (
  config: ServerConfig,
): Promise<FastifyInstance> => {
  const startedAt = Date.now();

  const storage = createMediaStorage(config.dataDirectory);
  await storage.initialize();
  const prunedTemporaryFiles = await storage.pruneTemporaryFiles();

  const database = openDatabase(join(config.dataDirectory, DATABASE_FILENAME));

  try {
    const appliedMigrations = migrate(database);

    const app = Fastify({
      trustProxy:
        config.trustedProxies.length > 0 ? [...config.trustedProxies] : false,
      logger: {
        level: config.logLevel,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[redacted]',
        },
      },
    });

    app.decorate('config', config);
    app.decorate('database', database);
    app.decorate('mediaRepository', createMediaRepository(database));
    app.decorate('settingsRepository', createSettingsRepository(database));
    app.decorate(
      'telegramContributorRepository',
      createTelegramContributorRepository(database),
    );
    app.decorate('mediaStorage', storage);

    app.addHook('onSend', async (_request, reply, payload) => {
      reply
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('x-frame-options', 'DENY')
        .header('permissions-policy', PERMISSIONS_POLICY);
      return payload;
    });

    registerErrorHandling(app);
    await app.register(cookie);

    const adminCredentials = createAdminCredentials(
      createAdminCredentialRepository(database),
    );
    const adminSessionStore = new AdminSessionStore(config.adminSession);
    registerAuthentication(app, {
      ingestionTokens: config.ingestionTokens,
      allowAdministrationUploads: config.allowAdministrationUploads,
      failureLimiter: new FixedWindowRateLimiter(
        config.authenticationRateLimit,
      ),
      sessionStore: adminSessionStore,
    });

    await app.register(multipart, {
      limits: {
        fieldNameSize: 64,
        fieldSize: 1_024,
        fields: 4,
        fileSize: config.maxUploadBytes,
        files: 1,
        parts: 5,
      },
      throwFileSizeLimit: true,
    });

    await app.register(cors, {
      origin: toCorsOrigin(config.allowedOrigins),
      methods: CORS_METHODS,
      allowedHeaders: CORS_ALLOWED_HEADERS,
      credentials:
        config.allowedOrigins.length > 0 &&
        !config.allowedOrigins.includes(ALLOW_ALL_ORIGINS),
      maxAge: 600,
    });

    registerHealthRoute(app, {
      database,
      version: config.version,
      startedAt,
    });
    registerAdminSessionRoutes(app, {
      allowAdministrationUploads: config.allowAdministrationUploads,
      credentials: adminCredentials,
      secureCookie: config.adminSession.secure,
      sessionStore: adminSessionStore,
    });
    registerAdminPasswordRoutes(app, {
      credentials: adminCredentials,
      sessionStore: adminSessionStore,
    });
    registerMediaUploadRoute(app);
    registerMediaRoutes(app);
    registerMediaContentRoute(app);
    registerAdminMediaContentRoute(app);
    registerAdminMediaThumbnailRoute(app);
    registerPlaylistRoute(app);
    registerSettingsRoutes(app);
    registerTelegramContributorRoutes(app);

    app.log.info(
      {
        dataDirectory: config.dataDirectory,
        appliedMigrations,
        prunedTemporaryFiles,
        maxUploadBytes: config.maxUploadBytes,
        maxStoredFiles: config.maxStoredFiles,
        allowedOrigins: config.allowedOrigins,
        trustedProxies: config.trustedProxies,
        authenticationRateLimit: config.authenticationRateLimit,
        uploadRateLimit: config.uploadRateLimit,
        allowAdministrationUploads: config.allowAdministrationUploads,
        administrationPasswordConfigured:
          adminCredentials.isPasswordConfigured(),
        adminSession: {
          max: config.adminSession.max,
          secure: config.adminSession.secure,
          ttlMs: config.adminSession.ttlMs,
        },
      },
      'Home Gallery server initialized',
    );

    if (!adminCredentials.isPasswordConfigured()) {
      app.log.warn(
        'No administration password is set; anyone who can reach this server can administer the gallery',
      );
    }

    // Started last, after everything that can still throw: a pass running while
    // `createApp` fails would read a database its own caller is about to close.
    const thumbnailBackfill = startThumbnailBackfill({
      log: app.log,
      mediaRepository: app.mediaRepository,
      mediaStorage: storage,
    });
    app.decorate('thumbnailBackfill', thumbnailBackfill);

    // The backfill reads the database, so it has to stop before the connection
    // closes; that is why closing the connection lives in this hook. `stop`
    // bounds its own wait, so a downscale in flight cannot spend the shutdown
    // budget — it promises to read nothing once it resolves, finished or not.
    app.addHook('onClose', async () => {
      await thumbnailBackfill.stop();
      database.close();
    });

    void thumbnailBackfill.finished.then((result) => {
      if (result.created > 0 || result.failed > 0 || result.stopped) {
        app.log.info(result, 'Administration thumbnail backfill finished');
      }
    });

    return app;
  } catch (error) {
    database.close();
    throw error;
  }
};
