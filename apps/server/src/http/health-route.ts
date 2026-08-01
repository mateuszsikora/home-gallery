import { API_ROUTES, type HealthResponse } from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import type { DatabaseConnection } from '../database/connection.js';

export interface HealthRouteOptions {
  database: DatabaseConnection;
  version: string;
  startedAt: number;
  now?: () => number;
}

/**
 * Liveness and readiness in one public route: the process answering at all is
 * liveness, while a `503` and `degraded` body report that the metadata database
 * is unusable. Container health checks can therefore rely on the HTTP status.
 */
export const registerHealthRoute = (
  app: FastifyInstance,
  options: HealthRouteOptions,
): void => {
  const { database, version, startedAt } = options;
  const now = options.now ?? Date.now;
  const probe = database.prepare('SELECT 1');

  app.get(API_ROUTES.health, async (request, reply) => {
    let status: HealthResponse['status'] = 'ok';

    try {
      probe.get();
    } catch (error) {
      request.log.error({ err: error }, 'Database health probe failed');
      status = 'degraded';
    }

    const response: HealthResponse = {
      status,
      version,
      uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)),
    };

    return reply.status(status === 'ok' ? 200 : 503).send(response);
  });
};
