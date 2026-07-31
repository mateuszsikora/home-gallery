import {
  API_ERROR_STATUS,
  createApiErrorBody,
  type ApiErrorCode,
  type ApiErrorIssue,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

/** An error that is safe to describe to the client verbatim. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly issues: readonly ApiErrorIssue[] | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    issues?: readonly ApiErrorIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.issues = issues;
  }

  get statusCode(): number {
    return API_ERROR_STATUS[this.code];
  }
}

/** Fastify reports its own failures with a status code but no API error code. */
const STATUS_TO_ERROR_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

const toApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) {
    return error;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;

  // Any other client error stays a client error rather than being reported as
  // a server fault, even when its exact status has no dedicated error code.
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return new ApiError(
      STATUS_TO_ERROR_CODE[statusCode] ?? 'bad_request',
      error instanceof Error ? error.message : 'Request failed',
    );
  }

  // Anything unrecognized may carry internal detail, so it is not echoed back.
  return new ApiError('internal_error', 'Internal server error');
};

/**
 * Guarantees that every failure leaves the server as the documented error body
 * instead of Fastify's default shape.
 */
export const registerErrorHandling = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(API_ERROR_STATUS.not_found)
      .send(
        createApiErrorBody('not_found', 'The requested route does not exist'),
      );
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);

    if (apiError.code === 'internal_error') {
      request.log.error({ err: error }, 'Unhandled request failure');
    } else {
      request.log.info({ err: error, code: apiError.code }, 'Request rejected');
    }

    if (apiError.code === 'unauthorized') {
      void reply.header('www-authenticate', 'Bearer');
    }

    void reply
      .status(apiError.statusCode)
      .send(
        createApiErrorBody(apiError.code, apiError.message, apiError.issues),
      );
  });
};
