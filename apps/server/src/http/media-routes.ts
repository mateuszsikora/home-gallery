import {
  API_ROUTES,
  mediaIdSchema,
  mediaListQuerySchema,
  mediaUpdateInputSchema,
  toApiErrorIssues,
  type MediaListQuery,
  type MediaListResponse,
  type MediaRecord,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import { InvalidCursorError } from '../database/media-repository.js';
import { NO_STORE_CACHE_CONTROL } from './cache.js';
import { ApiError } from './errors.js';

/** Fastify parameter form of `API_ROUTES.mediaById`. */
const MEDIA_BY_ID_ROUTE = `${API_ROUTES.media}/:id`;

interface MediaIdParams {
  id: string;
}

/**
 * An unknown identifier and a malformed one are reported the same way: both
 * mean the caller asked for a record that does not exist.
 */
const requireMedia = (app: FastifyInstance, id: string): MediaRecord => {
  const parsedId = mediaIdSchema.safeParse(id);
  const record = parsedId.success
    ? app.mediaRepository.findById(parsedId.data)
    : undefined;

  if (record === undefined) {
    throw new ApiError('not_found', 'The requested media does not exist');
  }

  return record;
};

/** Query values arrive as strings, so `limit` is converted before validation. */
const parseListQuery = (query: Record<string, unknown>): MediaListQuery => {
  const rawLimit = query.limit;

  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'string' || !/^\d+$/u.test(rawLimit))
  ) {
    throw new ApiError('validation_failed', 'Invalid media list query', [
      { path: 'limit', message: 'Must be a positive integer' },
    ]);
  }

  const parsed = mediaListQuerySchema.safeParse({
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
  });

  if (!parsed.success) {
    throw new ApiError(
      'validation_failed',
      'Invalid media list query',
      toApiErrorIssues(parsed.error),
    );
  }

  return parsed.data;
};

const listMedia = (
  app: FastifyInstance,
  query: MediaListQuery,
): MediaListResponse => {
  try {
    return app.mediaRepository.list(query);
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new ApiError('validation_failed', 'Invalid media list query', [
        { path: 'cursor', message: error.message },
      ]);
    }

    throw error;
  }
};

/**
 * Administrative media routes. Every one of them requires the bearer token and
 * exposes the full record, including contributor and storage metadata that the
 * public playlist deliberately omits.
 */
export const registerMediaRoutes = (app: FastifyInstance): void => {
  const protectedRoute = { onRequest: app.requireBearerToken };

  app.get<{ Querystring: Record<string, unknown> }>(
    API_ROUTES.media,
    protectedRoute,
    async (request, reply) => {
      const page = listMedia(app, parseListQuery(request.query));

      return reply.header('cache-control', NO_STORE_CACHE_CONTROL).send(page);
    },
  );

  app.get<{ Params: MediaIdParams }>(
    MEDIA_BY_ID_ROUTE,
    protectedRoute,
    async (request, reply) =>
      reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .send(requireMedia(app, request.params.id)),
  );

  app.patch<{ Params: MediaIdParams }>(
    MEDIA_BY_ID_ROUTE,
    protectedRoute,
    async (request, reply) => {
      const record = requireMedia(app, request.params.id);
      const parsed = mediaUpdateInputSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new ApiError(
          'validation_failed',
          'Invalid media update',
          toApiErrorIssues(parsed.error),
        );
      }

      const updated = app.mediaRepository.update(record.id, parsed.data);

      if (updated === undefined) {
        throw new ApiError('not_found', 'The requested media does not exist');
      }

      return reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .send(updated);
    },
  );

  app.delete<{ Params: MediaIdParams }>(
    MEDIA_BY_ID_ROUTE,
    protectedRoute,
    async (request, reply) => {
      const record = requireMedia(app, request.params.id);

      // Hide the bytes with an atomic rename, then restore them if the database
      // write fails. Once the row is gone, failure to purge the staged file is
      // only a temporary orphan and startup cleanup removes it safely.
      const stagedRemoval = await app.mediaStorage.stageRemoval(
        record.storedFilename,
      );

      try {
        app.mediaRepository.delete(record.id);
      } catch (error) {
        await stagedRemoval?.restore();
        throw error;
      }

      try {
        await stagedRemoval?.commit();
      } catch (error) {
        request.log.warn(
          { err: error, mediaId: record.id },
          'Deleted media left a temporary file for startup cleanup',
        );
      }

      return reply
        .status(204)
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .send();
    },
  );
};
