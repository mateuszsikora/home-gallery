import {
  API_ROUTES,
  adminPasswordRemovalInputSchema,
  adminPasswordUpdateInputSchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AdminCredentials } from '../auth/admin-credentials.js';
import { ADMIN_SESSION_COOKIE_NAME } from './admin-session-routes.js';
import type { AdminSessionStore } from './admin-session-store.js';
import { ApiError } from './errors.js';
import { parseRequestBody } from './validation.js';

/**
 * Manages the password that protects the administration app. Both routes need
 * an established session, so a stolen browser tab is the only way in; proving
 * the current password on top of that stops a tab left unlocked from being
 * turned into permanent access.
 */
export const registerAdminPasswordRoutes = (
  app: FastifyInstance,
  options: {
    credentials: AdminCredentials;
    sessionStore: AdminSessionStore;
  },
): void => {
  const protectedRoute = { onRequest: app.requireAdministrationSession };

  const requireCurrentPassword = async (
    request: FastifyRequest,
    reply: FastifyReply,
    currentPassword: string | undefined,
  ): Promise<void> => {
    app.guardAdministrationAttempt(request, reply);

    if (!(await options.credentials.accepts(currentPassword))) {
      app.rejectAdministrationAttempt(
        request,
        reply,
        'The current administration password is incorrect',
        'invalid_password',
      );
    }
  };

  app.put(API_ROUTES.adminPassword, protectedRoute, async (request, reply) => {
    const { currentPassword, newPassword } = parseRequestBody(
      adminPasswordUpdateInputSchema,
      request.body,
      'Invalid administration password',
    );

    await requireCurrentPassword(request, reply, currentPassword);
    await options.credentials.setPassword(newPassword);
    options.sessionStore.deleteOthers(
      request.cookies[ADMIN_SESSION_COOKIE_NAME],
    );

    request.log.info('Administration password was changed');
    return reply.status(204).send();
  });

  app.delete(
    API_ROUTES.adminPassword,
    protectedRoute,
    async (request, reply) => {
      const { currentPassword } = parseRequestBody(
        adminPasswordRemovalInputSchema,
        request.body,
        'Invalid administration password',
      );

      // Without this an unprotected installation would answer `204` after
      // accepting a password it never checked, and the app would report a
      // removal that did not happen.
      if (!options.credentials.isPasswordConfigured()) {
        throw new ApiError(
          'conflict',
          'This gallery has no administration password to remove',
        );
      }

      await requireCurrentPassword(request, reply, currentPassword);
      options.credentials.clearPassword();
      options.sessionStore.deleteOthers(
        request.cookies[ADMIN_SESSION_COOKIE_NAME],
      );

      request.log.warn(
        'Administration password was removed; the studio is now unprotected',
      );
      return reply.status(204).send();
    },
  );
};
