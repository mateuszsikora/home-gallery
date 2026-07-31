import { z } from 'zod';

/**
 * Error codes returned by the server. Clients switch on the code rather than on
 * the human-readable message, which may change without notice.
 */
export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** A single field-level problem, used when a request fails schema validation. */
export const apiErrorIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ApiErrorIssue = z.infer<typeof apiErrorIssueSchema>;

/** Every non-2xx response carries this body. */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    issues: z.array(apiErrorIssueSchema).optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** The HTTP status the server must use for each error code. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
};

/** Builds the response body for an error code without leaking internal details. */
export const createApiErrorBody = (
  code: ApiErrorCode,
  message: string,
  issues?: readonly ApiErrorIssue[],
): ApiErrorBody => ({
  error: {
    code,
    message,
    ...(issues && issues.length > 0 ? { issues: [...issues] } : {}),
  },
});

/** Converts a Zod failure into the transport representation of its issues. */
export const toApiErrorIssues = (error: z.ZodError): ApiErrorIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
