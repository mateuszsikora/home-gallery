import { z } from 'zod';

/** `degraded` means the process is alive but a dependency is not ready. */
export const HEALTH_STATUSES = ['ok', 'degraded'] as const;

export const healthStatusSchema = z.enum(HEALTH_STATUSES);

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string(),
  uptimeSeconds: z.number().min(0),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
