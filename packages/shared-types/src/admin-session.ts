import { z } from 'zod';

/** Public metadata for an authenticated browser administration session. */
export const adminSessionSchema = z.object({
  expiresAt: z.iso.datetime(),
});

export type AdminSession = z.infer<typeof adminSessionSchema>;
