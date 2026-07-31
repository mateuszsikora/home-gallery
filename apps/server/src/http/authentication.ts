import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, onRequestHookHandler } from 'fastify';

import { ApiError } from './errors.js';

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
    /** `onRequest` hook that rejects anything without the configured token. */
    requireBearerToken: onRequestHookHandler;
  }
}

export const registerAuthentication = (
  app: FastifyInstance,
  apiToken: string,
): void => {
  const requireBearerToken: onRequestHookHandler = (request, reply, done) => {
    const token = readBearerToken(request.headers.authorization);

    if (token === undefined || !secretsMatch(token, apiToken)) {
      done(new ApiError('unauthorized', 'A valid bearer token is required'));
      return;
    }

    done();
  };

  app.decorate('requireBearerToken', requireBearerToken);
};
