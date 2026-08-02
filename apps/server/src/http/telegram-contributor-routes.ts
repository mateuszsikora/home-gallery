import {
  API_ROUTES,
  telegramContributorRegistrationSchema,
  telegramContributorUpdateInputSchema,
  telegramUserIdSchema,
  toApiErrorIssues,
  type TelegramContributor,
  type TelegramContributorListResponse,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import { NO_STORE_CACHE_CONTROL } from './cache.js';
import { ApiError } from './errors.js';

/** Fastify parameter form of `API_ROUTES.telegramContributorById`. */
const CONTRIBUTOR_BY_ID_ROUTE = `${API_ROUTES.telegramContributors}/:telegramUserId`;

interface TelegramContributorParams {
  telegramUserId: string;
}

/**
 * An unknown identifier and a malformed one are reported the same way: both
 * mean the administrator asked about a contributor that does not exist.
 */
const requireContributor = (
  app: FastifyInstance,
  telegramUserId: string,
): TelegramContributor => {
  const parsedId = telegramUserIdSchema.safeParse(telegramUserId);
  const contributor = parsedId.success
    ? app.telegramContributorRepository.findByTelegramUserId(parsedId.data)
    : undefined;

  if (contributor === undefined) {
    throw new ApiError(
      'not_found',
      'The requested Telegram contributor does not exist',
    );
  }

  return contributor;
};

/**
 * Contributor access requests. The bot registers contacts with the ingestion
 * credential and learns nothing beyond its own contributor's status, while
 * reviewing and deciding requests requires administration authentication.
 */
export const registerTelegramContributorRoutes = (
  app: FastifyInstance,
): void => {
  const administrationRoute = { onRequest: app.requireAdministrationToken };

  app.post(
    API_ROUTES.telegramContributors,
    { onRequest: app.requireIngestionToken },
    async (request, reply) => {
      const parsed = telegramContributorRegistrationSchema.safeParse(
        request.body,
      );

      if (!parsed.success) {
        throw new ApiError(
          'validation_failed',
          'Invalid Telegram contributor registration',
          toApiErrorIssues(parsed.error),
        );
      }

      // Registering is an upsert, so a repeated contact answers 200 with the
      // current record instead of reporting a conflict the bot cannot resolve.
      return reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .send(app.telegramContributorRepository.register(parsed.data));
    },
  );

  app.get(
    API_ROUTES.telegramContributors,
    administrationRoute,
    async (request, reply) => {
      const body: TelegramContributorListResponse = {
        items: app.telegramContributorRepository.list(),
      };

      return reply.header('cache-control', NO_STORE_CACHE_CONTROL).send(body);
    },
  );

  app.patch<{ Params: TelegramContributorParams }>(
    CONTRIBUTOR_BY_ID_ROUTE,
    administrationRoute,
    async (request, reply) => {
      const contributor = requireContributor(
        app,
        request.params.telegramUserId,
      );
      const parsed = telegramContributorUpdateInputSchema.safeParse(
        request.body,
      );

      if (!parsed.success) {
        throw new ApiError(
          'validation_failed',
          'Invalid Telegram contributor update',
          toApiErrorIssues(parsed.error),
        );
      }

      const updated = app.telegramContributorRepository.decide(
        contributor.telegramUserId,
        parsed.data.status,
      );

      if (updated === undefined) {
        throw new ApiError(
          'not_found',
          'The requested Telegram contributor does not exist',
        );
      }

      return reply
        .header('cache-control', NO_STORE_CACHE_CONTROL)
        .send(updated);
    },
  );
};
