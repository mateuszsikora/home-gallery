import {
  API_ROUTES,
  gallerySettingsUpdateInputSchema,
  toApiErrorIssues,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import { NO_STORE_CACHE_CONTROL } from './cache.js';
import { ApiError } from './errors.js';

/**
 * Gallery settings are administrative: the slideshow reads them from the public
 * playlist response instead of from these routes.
 */
export const registerSettingsRoutes = (app: FastifyInstance): void => {
  const protectedRoute = { onRequest: app.requireAdministrationToken };

  app.get(API_ROUTES.settings, protectedRoute, async (request, reply) =>
    reply
      .header('cache-control', NO_STORE_CACHE_CONTROL)
      .send(app.settingsRepository.read()),
  );

  app.patch(API_ROUTES.settings, protectedRoute, async (request, reply) => {
    const parsed = gallerySettingsUpdateInputSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new ApiError(
        'validation_failed',
        'Invalid gallery settings',
        toApiErrorIssues(parsed.error),
      );
    }

    return reply
      .header('cache-control', NO_STORE_CACHE_CONTROL)
      .send(app.settingsRepository.update(parsed.data));
  });
};
