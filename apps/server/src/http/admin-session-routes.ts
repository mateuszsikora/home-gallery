import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
  API_ROUTES,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import type { AdminSessionStore } from './admin-session-store.js';
import { ApiError } from './errors.js';

export const ADMIN_SESSION_COOKIE_NAME = 'home_gallery_admin_session';

const toResponse = (expiresAt: number) => ({
  expiresAt: new Date(expiresAt).toISOString(),
});

export const registerAdminSessionRoutes = (
  app: FastifyInstance,
  options: {
    secureCookie: boolean;
    sessionStore: AdminSessionStore;
  },
): void => {
  const cookieOptions = {
    httpOnly: true,
    path: '/',
    sameSite: 'strict' as const,
    secure: options.secureCookie,
  };

  app.post(
    API_ROUTES.adminSession,
    { onRequest: app.requireAdministrationBearerToken },
    async (_request, reply) => {
      const session = options.sessionStore.create();
      return reply
        .status(201)
        .setCookie(ADMIN_SESSION_COOKIE_NAME, session.token, cookieOptions)
        .send(toResponse(session.expiresAt));
    },
  );

  app.get(
    API_ROUTES.adminSession,
    { onRequest: app.requireAdministrationSession },
    async (request) =>
      toResponse(request.administrationSessionExpiresAt as number),
  );

  app.delete(API_ROUTES.adminSession, async (request, reply) => {
    if (
      request.headers[ADMIN_SESSION_CSRF_HEADER] !== ADMIN_SESSION_CSRF_VALUE
    ) {
      throw new ApiError(
        'forbidden',
        `Session logout requires ${ADMIN_SESSION_CSRF_HEADER}`,
      );
    }

    options.sessionStore.delete(request.cookies[ADMIN_SESSION_COOKIE_NAME]);
    return reply
      .clearCookie(ADMIN_SESSION_COOKIE_NAME, cookieOptions)
      .status(204)
      .send();
  });
};
