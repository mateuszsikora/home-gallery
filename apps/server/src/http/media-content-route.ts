import {
  API_ROUTES,
  mediaIdSchema,
  type MediaRecord,
} from '@home-gallery/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  PRIVATE_REVALIDATE_CACHE_CONTROL,
} from './cache.js';
import { ApiError } from './errors.js';
import { thumbnailFilename } from '../media/thumbnails.js';
import type { OpenMediaFile } from '../storage/media-storage.js';

/** Fastify parameter form of `API_ROUTES.mediaContentById`. */
const MEDIA_CONTENT_ROUTE = '/media/:id';

/** Fastify parameter form of `API_ROUTES.adminMediaContentById`. */
const ADMIN_MEDIA_CONTENT_ROUTE = `${API_ROUTES.media}/:id/content`;

/** Fastify parameter form of `API_ROUTES.adminMediaThumbnailById`. */
const ADMIN_MEDIA_THUMBNAIL_ROUTE = `${API_ROUTES.media}/:id/thumbnail`;

/**
 * Every route here reports every failure the same way, so no caller can tell an
 * unknown identifier from a hidden photo, an unreadable file, or a missing
 * administration session.
 */
const unavailable = (): ApiError =>
  new ApiError('not_found', 'The requested media is not available');

type ContentRequest = FastifyRequest<{ Params: { id: string } }>;

/**
 * Resolves the record a request asks for. `allowDisabled` is the only difference
 * between the public and the administrative route: the administration app
 * manages hidden photos, so it must be able to look at them.
 */
const requireRecord = (
  app: FastifyInstance,
  request: ContentRequest,
  allowDisabled: boolean,
): MediaRecord => {
  const parsedId = mediaIdSchema.safeParse(request.params.id);
  const record = parsedId.success
    ? app.mediaRepository.findById(parsedId.data)
    : undefined;

  if (record === undefined || (!record.enabled && !allowDisabled)) {
    throw unavailable();
  }

  return record;
};

/** Opens the normalized image, which every record is required to have. */
const openStoredImage = async (
  app: FastifyInstance,
  request: ContentRequest,
  record: MediaRecord,
): Promise<OpenMediaFile> => {
  const file = await app.mediaStorage.openForRead(record.storedFilename);

  if (file === undefined) {
    request.log.error(
      { mediaId: record.id, storedFilename: record.storedFilename },
      'Stored media file is missing',
    );
    throw unavailable();
  }

  return file;
};

/**
 * Accepts every form a client may legitimately send a validator back in: a list
 * of them, a weak one, and `*` for "whatever you have". A literal comparison
 * against the one we issued would answer full bytes to all three.
 */
const revalidates = (request: ContentRequest, etag: string): boolean => {
  const header = request.headers['if-none-match'];

  if (header === undefined) {
    return false;
  }

  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === '*' || candidate.replace(/^W\//u, '') === etag,
    );
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
      const record = requireRecord(app, request, false);
      const file = await openStoredImage(app, request, record);

      // The identifier is enough to validate a cached copy because normalized
      // bytes never change once they are stored.
      const etag = `"${record.id}"`;
      reply
        .header('cache-control', IMMUTABLE_CACHE_CONTROL)
        .header('etag', etag);

      if (revalidates(request, etag)) {
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

      const record = requireRecord(app, request, true);
      const file = await openStoredImage(app, request, record);

      return reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .header('content-length', file.size)
        .type(record.mimeType)
        .send(file.stream);
    },
  );
};

/**
 * The administration preview route. It answers with the small derivative stored
 * next to the normalized image, so listing a whole library transfers bytes
 * proportional to what a card can show rather than to the camera's resolution.
 *
 * The derivative is written after the upload and backfilled at startup, so it
 * can legitimately be absent; the full image is served in its place instead of
 * failing the card. Authentication and visibility behave exactly like the
 * administrative content route.
 *
 * Unlike that route this one revalidates instead of refusing to be stored. Both
 * answers are identical for a hidden and a visible photo, so no part of the
 * response depends on the mutable state that made `no-store` necessary there,
 * and `no-cache` still forces an authenticated round trip before a stored copy
 * is used. That turns a reload of a whole library into conditional requests
 * rather than the whole library again.
 *
 * The validator names which file answered and how large it is, so it changes
 * both when the backfill replaces the fallback with a derivative and when an
 * operator regenerates derivatives that a browser already holds.
 */
export const registerAdminMediaThumbnailRoute = (
  app: FastifyInstance,
): void => {
  app.get<{ Params: { id: string } }>(
    ADMIN_MEDIA_THUMBNAIL_ROUTE,
    async (request, reply) => {
      if (!app.hasAdministrationAuthentication(request)) {
        throw unavailable();
      }

      const record = requireRecord(app, request, true);
      const derivative = await app.mediaStorage.openForRead(
        thumbnailFilename(record.storedFilename),
      );
      const file = derivative ?? (await openStoredImage(app, request, record));
      const source = derivative === undefined ? 'full' : 'thumb';
      const etag = `"${record.id}-${source}-${file.size}"`;

      reply
        .header('cache-control', PRIVATE_REVALIDATE_CACHE_CONTROL)
        // The response depends on the session cookie. `private` already keeps a
        // shared cache out of it; this says so to a proxy an operator adds.
        .header('vary', 'cookie')
        .header('etag', etag);

      if (revalidates(request, etag)) {
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
