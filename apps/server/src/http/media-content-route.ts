import { mediaIdSchema } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import { IMMUTABLE_CACHE_CONTROL } from './cache.js';
import { ApiError } from './errors.js';

/** Fastify parameter form of `API_ROUTES.mediaContentById`. */
const MEDIA_CONTENT_ROUTE = '/media/:id';

/**
 * The public content route. Unknown, disabled, and unreadable media all produce
 * the same `not_found` response so an unauthenticated caller cannot probe which
 * identifiers exist or which photos are merely hidden.
 */
export const registerMediaContentRoute = (app: FastifyInstance): void => {
  app.get<{ Params: { id: string } }>(
    MEDIA_CONTENT_ROUTE,
    async (request, reply) => {
      const unavailable = new ApiError(
        'not_found',
        'The requested media is not available',
      );
      const parsedId = mediaIdSchema.safeParse(request.params.id);
      const record = parsedId.success
        ? app.mediaRepository.findById(parsedId.data)
        : undefined;

      if (record === undefined || !record.enabled) {
        throw unavailable;
      }

      const file = await app.mediaStorage.openForRead(record.storedFilename);

      if (file === undefined) {
        request.log.error(
          { mediaId: record.id, storedFilename: record.storedFilename },
          'Stored media file is missing',
        );
        throw unavailable;
      }

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
