import {
  API_ROUTES,
  mediaIdSchema,
  type MediaRecord,
} from '@home-gallery/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { IMMUTABLE_CACHE_CONTROL, NO_STORE_CACHE_CONTROL } from './cache.js';
import { ApiError } from './errors.js';
import type { OpenMediaFile } from '../storage/media-storage.js';

/** Fastify parameter form of `API_ROUTES.mediaContentById`. */
const MEDIA_CONTENT_ROUTE = '/media/:id';

/** Fastify parameter form of `API_ROUTES.adminMediaContentById`. */
const ADMIN_MEDIA_CONTENT_ROUTE = `${API_ROUTES.media}/:id/content`;

/**
 * Both content routes report every failure the same way, so no caller can tell
 * an unknown identifier from a hidden photo, an unreadable file, or a missing
 * administration session.
 */
const unavailable = (): ApiError =>
  new ApiError('not_found', 'The requested media is not available');

type ContentRequest = FastifyRequest<{ Params: { id: string } }>;

/**
 * Resolves the record and its bytes. `allowDisabled` is the only difference
 * between the public and the administrative route: the administration app
 * manages hidden photos, so it must be able to look at them.
 */
const openMedia = async (
  app: FastifyInstance,
  request: ContentRequest,
  allowDisabled: boolean,
): Promise<{ record: MediaRecord; file: OpenMediaFile }> => {
  const parsedId = mediaIdSchema.safeParse(request.params.id);
  const record = parsedId.success
    ? app.mediaRepository.findById(parsedId.data)
    : undefined;

  if (record === undefined || (!record.enabled && !allowDisabled)) {
    throw unavailable();
  }

  const file = await app.mediaStorage.openForRead(record.storedFilename);

  if (file === undefined) {
    request.log.error(
      { mediaId: record.id, storedFilename: record.storedFilename },
      'Stored media file is missing',
    );
    throw unavailable();
  }

  return { record, file };
};

/**
 * The public content route. Unknown, disabled, and unreadable media all produce
 * the same `not_found` response so an unauthenticated caller cannot probe which
 * identifiers exist or which photos are merely hidden.
 */
export const registerMediaContentRoute = (app: FastifyInstance): void => {
  app.get<{ Params: { id: string } }>(
    MEDIA_CONTENT_ROUTE,
    async (request, reply) => {
      const { record, file } = await openMedia(app, request, false);

      // The identifier is enough to validate a cached copy because normalized
      // bytes never change once they are stored.
      const etag = `"${record.id}"`;
      reply
        .header('cache-control', IMMUTABLE_CACHE_CONTROL)
        .header('etag', etag);

      if (request.headers['if-none-match'] === etag) {
        file.stream.destroy();
        return reply.status(304).send();
      }

      return reply
        .header('content-length', file.size)
        .type(record.mimeType)
        .send(file.stream);
    },
  );
};

/**
 * The administrative content route. It serves hidden photos as well, so the
 * administration app can preview what it manages, and it authenticates through
 * the session cookie so a plain `<img src>` reaches it.
 *
 * Visibility is mutable, so the response must never be answered from a stored
 * copy: a cached preview is exactly what made a hidden photo look fine until
 * the browser evicted it.
 */
export const registerAdminMediaContentRoute = (app: FastifyInstance): void => {
  app.get<{ Params: { id: string } }>(
    ADMIN_MEDIA_CONTENT_ROUTE,
    async (request, reply) => {
      if (!app.hasAdministrationAuthentication(request)) {
        throw unavailable();
      }

      const { record, file } = await openMedia(app, request, true);

      return reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .header('content-length', file.size)
        .type(record.mimeType)
        .send(file.stream);
    },
  );
};
