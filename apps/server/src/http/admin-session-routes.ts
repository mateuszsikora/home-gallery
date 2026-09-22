import {
  ADMIN_SESSION_CSRF_HEADER,
  API_ROUTES,
  adminSessionRequestSchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import type { AdminCredentials } from '../auth/admin-credentials.js';
import type { AdminSessionStore } from './admin-session-store.js';
import { hasValidCsrfHeader } from './authentication.js';
import { ApiError } from './errors.js';
import { parseRequestBody } from './validation.js';

export const ADMIN_SESSION_COOKIE_NAME = 'home_gallery_admin_session';

const toResponse = (expiresAt: number) => ({
  expiresAt: new Date(expiresAt).toISOString(),
});

export const registerAdminSessionRoutes = (
  app: FastifyInstance,
  options: {
    allowAdministrationUploads: boolean;
    credentials: AdminCredentials;
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

  // Public on purpose: it reports only what the deployment already reveals by
  // accepting or refusing a request, and the studio needs it before it can
  // render a sign-in screen or an upload control that will work.
  app.get(API_ROUTES.adminAuth, async () => ({
    administrationUploadsEnabled: options.allowAdministrationUploads,
    passwordConfigured: options.credentials.isPasswordConfigured(),
  }));

  app.post(API_ROUTES.adminSession, async (request, reply) => {
    // Requiring the header forces a preflight on any cross-origin attempt, so
    // an unrelated page cannot open a session against a passwordless gallery.
    if (!hasValidCsrfHeader(request)) {
      throw new ApiError(
        'forbidden',
        `Session creation requires ${ADMIN_SESSION_CSRF_HEADER}`,
      );
    }

    // Checked before the password is verified: deriving a scrypt hash is the
    // expensive part of this route, and a client that is already over its limit
    // must not be able to make the server pay for it.
    app.guardAdministrationAttempt(request, reply);

    const { password } = parseRequestBody(
      adminSessionRequestSchema,
      request.body ?? {},
    );

    if (!(await options.credentials.accepts(password))) {
      app.rejectAdministrationAttempt(
        request,
        reply,
        'The administration password is incorrect',
      );
    }

    const session = options.sessionStore.create();
    return reply
      .status(201)
      .setCookie(ADMIN_SESSION_COOKIE_NAME, session.token, cookieOptions)
      .send(toResponse(session.expiresAt));
  });

  app.get(
    API_ROUTES.adminSession,
    { onRequest: app.requireAdministrationSession },
    async (request) =>
      toResponse(request.administrationSessionExpiresAt as number),
  );

  app.delete(API_ROUTES.adminSession, async (request, reply) => {
    if (!hasValidCsrfHeader(request)) {
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
