import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ADMIN_SESSION_CSRF_HEADER,
  ADMIN_SESSION_CSRF_VALUE,
} from '@home-gallery/shared-types';
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';

import type { AdminSessionStore } from './admin-session-store.js';
import { ADMIN_SESSION_COOKIE_NAME } from './admin-session-routes.js';
import { ApiError } from './errors.js';
import { rejectWhenRateLimited } from './rate-limit.js';
import type { FixedWindowRateLimiter, RateLimitResult } from './rate-limit.js';

const BEARER_SCHEME = 'bearer';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Compares two secrets without leaking their contents through timing. Hashing
 * first gives both operands a fixed length, so the comparison also cannot leak
 * the expected token length.
 */
export const secretsMatch = (candidate: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(candidate, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );

const readBearerToken = (header: string | undefined): string | undefined => {
  if (header === undefined) {
    return undefined;
  }

  const separator = header.indexOf(' ');

  if (separator < 0) {
    return undefined;
  }

  if (header.slice(0, separator).toLowerCase() !== BEARER_SCHEME) {
    return undefined;
  }

  const token = header.slice(separator + 1).trim();

  return token.length > 0 ? token : undefined;
};

const matchesAny = (
  candidate: string | undefined,
  expectedTokens: readonly string[],
): boolean =>
  candidate !== undefined &&
  expectedTokens.some((expected) => secretsMatch(candidate, expected));

export const hasValidCsrfHeader = (request: FastifyRequest): boolean =>
  request.headers[ADMIN_SESSION_CSRF_HEADER] === ADMIN_SESSION_CSRF_VALUE;

declare module 'fastify' {
  interface FastifyInstance {
    hasAdministrationAuthentication: (request: FastifyRequest) => boolean;
    /**
     * Rejects a client that has already exhausted the authentication limit,
     * without counting the current request. Routes that must derive a password
     * hash before they can tell success from failure call this first, so an
     * exhausted client never makes the server do that work.
     */
    guardAdministrationAttempt: (
      request: FastifyRequest,
      reply: Parameters<onRequestHookHandler>[1],
    ) => void;
    /**
     * Counts a failed credential check for the requesting address and rejects
     * the request. Routes that validate a password themselves reuse it so every
     * administration failure shares one limit. A route that already has a valid
     * session passes `forbidden`, which keeps a mistyped current password from
     * looking like an expired session to the administration app.
     */
    rejectAdministrationAttempt: (
      request: FastifyRequest,
      reply: Parameters<onRequestHookHandler>[1],
      message?: string,
      code?: 'forbidden' | 'unauthorized',
    ) => never;
    requireAdministrationSession: onRequestHookHandler;
    requireIngestionToken: onRequestHookHandler;
  }

  interface FastifyRequest {
    administrationSessionExpiresAt: number | null;
  }
}

export const registerAuthentication = (
  app: FastifyInstance,
  options: {
    ingestionTokens: readonly string[];
    allowAdministrationUploads: boolean;
    failureLimiter: FixedWindowRateLimiter;
    sessionStore: AdminSessionStore;
  },
): void => {
  app.decorateRequest('administrationSessionExpiresAt', null);

  const enforceLimit = (
    request: FastifyRequest,
    reply: Parameters<onRequestHookHandler>[1],
    scope: 'administration' | 'ingestion',
    result: RateLimitResult,
  ): void => {
    if (!result.allowed && result.firstRejection) {
      request.log.warn(
        {
          clientAddress: request.ip,
          limit: options.failureLimiter.config.max,
          scope,
          windowMs: options.failureLimiter.config.windowMs,
        },
        'Authentication failure limit reached',
      );
    }

    rejectWhenRateLimited(
      result,
      reply,
      'Too many invalid authentication attempts',
    );
  };

  const reject = (
    request: FastifyRequest,
    reply: Parameters<onRequestHookHandler>[1],
    scope: 'administration' | 'ingestion',
    message: string,
    code: 'forbidden' | 'unauthorized' = 'unauthorized',
  ): never => {
    enforceLimit(
      request,
      reply,
      scope,
      options.failureLimiter.consume(request.ip),
    );
    throw new ApiError(code, message);
  };

  const acceptAdministrationSession = (request: FastifyRequest): boolean => {
    const record = options.sessionStore.read(
      request.cookies[ADMIN_SESSION_COOKIE_NAME],
    );

    if (record === undefined) {
      return false;
    }

    if (!SAFE_METHODS.has(request.method) && !hasValidCsrfHeader(request)) {
      throw new ApiError(
        'forbidden',
        `Cookie-authenticated mutations require ${ADMIN_SESSION_CSRF_HEADER}`,
      );
    }

    request.administrationSessionExpiresAt = record.expiresAt;
    return true;
  };

  // Reports the same session check without rejecting, for routes that answer an
  // unauthenticated caller with their own uniform response instead of
  // `unauthorized`.
  app.decorate(
    'hasAdministrationAuthentication',
    (request: FastifyRequest): boolean => acceptAdministrationSession(request),
  );

  app.decorate(
    'guardAdministrationAttempt',
    (request: FastifyRequest, reply: Parameters<onRequestHookHandler>[1]) => {
      enforceLimit(
        request,
        reply,
        'administration',
        options.failureLimiter.check(request.ip),
      );
    },
  );

  app.decorate(
    'rejectAdministrationAttempt',
    (
      request,
      reply,
      message = 'A valid administration session is required',
      code: 'forbidden' | 'unauthorized' = 'unauthorized',
    ) => reject(request, reply, 'administration', message, code),
  );

  app.decorate('requireAdministrationSession', (async (request, reply) => {
    if (!acceptAdministrationSession(request)) {
      reject(
        request,
        reply,
        'administration',
        'A valid administration session is required',
      );
    }
  }) satisfies onRequestHookHandler);

  app.decorate('requireIngestionToken', (async (request, reply) => {
    const bearer = readBearerToken(request.headers.authorization);

    if (matchesAny(bearer, options.ingestionTokens)) {
      return;
    }

    // A bearer token that was offered and did not match is a failed credential
    // whatever else the request carries, so it never reaches the session check
    // and always spends the failure limit. Only a request with no ingestion
    // credential at all can be refused for its scope instead.
    if (
      request.headers.authorization === undefined &&
      acceptAdministrationSession(request)
    ) {
      if (options.allowAdministrationUploads) {
        return;
      }

      // The session is valid, so answering `unauthorized` would tell the
      // administration app that it expired and send the administrator back to
      // the sign-in screen. The failure limit is left alone to match: a
      // refused scope is not a failed credential, and counting it would let
      // one disabled control lock its own administrator out of signing in.
      throw new ApiError(
        'forbidden',
        'This server does not accept ingestion from an administration session',
      );
    }

    reject(
      request,
      reply,
      'ingestion',
      'A valid ingestion bearer token is required',
    );
  }) satisfies onRequestHookHandler);
};
