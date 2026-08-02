import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { ApiError } from './errors.js';
import { rejectWhenRateLimited } from './rate-limit.js';
import type { FixedWindowRateLimiter } from './rate-limit.js';

const BEARER_SCHEME = 'bearer';

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

declare module 'fastify' {
  interface FastifyInstance {
    requireAdministrationToken: onRequestHookHandler;
    requireIngestionToken: onRequestHookHandler;
  }
}

export const registerAuthentication = (
  app: FastifyInstance,
  options: {
    administrationTokens: readonly string[];
    ingestionTokens: readonly string[];
    allowAdministrationUploads: boolean;
    failureLimiter: FixedWindowRateLimiter;
  },
): void => {
  const createGuard =
    (
      scope: 'administration' | 'ingestion',
      expectedTokens: readonly string[],
    ): onRequestHookHandler =>
    (request, reply, done) => {
      const token = readBearerToken(request.headers.authorization);

      if (
        token !== undefined &&
        expectedTokens.some((expected) => secretsMatch(token, expected))
      ) {
        done();
        return;
      }

      try {
        const result = options.failureLimiter.consume(request.ip);

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
        done(new ApiError('unauthorized', 'A valid bearer token is required'));
      } catch (error) {
        done(error as Error);
      }
    };

  app.decorate(
    'requireAdministrationToken',
    createGuard('administration', options.administrationTokens),
  );
  app.decorate(
    'requireIngestionToken',
    createGuard('ingestion', [
      ...options.ingestionTokens,
      ...(options.allowAdministrationUploads
        ? options.administrationTokens
        : []),
    ]),
  );
};
