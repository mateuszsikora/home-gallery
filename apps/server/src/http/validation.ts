import { toApiErrorIssues } from '@home-gallery/shared-types';
import type { z } from 'zod';

import { ApiError } from './errors.js';

/**
 * Validates a JSON request body and reports every rejected field at once. The
 * message stays generic so a schema that guards a credential cannot describe
 * the secret it rejected.
 */
export const parseRequestBody = <Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
  message = 'Invalid request body',
): z.infer<Schema> => {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ApiError(
      'validation_failed',
      message,
      toApiErrorIssues(parsed.error),
    );
  }

  return parsed.data;
};
