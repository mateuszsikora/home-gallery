import {
  telegramContributorSchema,
  type TelegramContributor,
  type TelegramContributorDecision,
  type TelegramContributorRegistration,
  type TelegramUserId,
} from '@home-gallery/shared-types';

import type { DatabaseConnection } from './connection.js';

export interface TelegramContributorRepository {
  /**
   * Records the first contact as a pending access request and refreshes the
   * Telegram identity of a contributor that is already known. The stored status
   * is never changed by a registration.
   */
  register(input: TelegramContributorRegistration): TelegramContributor;
  findByTelegramUserId(
    telegramUserId: TelegramUserId,
  ): TelegramContributor | undefined;
  list(): TelegramContributor[];
  decide(
    telegramUserId: TelegramUserId,
    status: TelegramContributorDecision,
  ): TelegramContributor | undefined;
}

interface TelegramContributorRow {
  telegram_user_id: string;
  status: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  requested_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  telegram_user_id, status, first_name, last_name, username, requested_at,
  updated_at
`;

/**
 * Pending requests come first because they are the only ones that need an
 * administrator, and the newest request within a group is the most interesting.
 */
const LIST_ORDER = `
  ORDER BY
    CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
    requested_at DESC,
    telegram_user_id
`;

const toContributor = (row: TelegramContributorRow): TelegramContributor =>
  telegramContributorSchema.parse({
    telegramUserId: row.telegram_user_id,
    status: row.status,
    ...(row.first_name === null ? {} : { firstName: row.first_name }),
    ...(row.last_name === null ? {} : { lastName: row.last_name }),
    ...(row.username === null ? {} : { username: row.username }),
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  });

const identityMatches = (
  row: TelegramContributorRow,
  input: TelegramContributorRegistration,
): boolean =>
  row.first_name === (input.firstName ?? null) &&
  row.last_name === (input.lastName ?? null) &&
  row.username === (input.username ?? null);

export const createTelegramContributorRepository = (
  database: DatabaseConnection,
  now: () => Date = () => new Date(),
): TelegramContributorRepository => {
  const selectByIdStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM telegram_contributors WHERE telegram_user_id = ?`,
  );
  const selectAllStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM telegram_contributors ${LIST_ORDER}`,
  );
  const insertStatement = database.prepare(`
    INSERT INTO telegram_contributors (
      telegram_user_id, status, first_name, last_name, username, requested_at,
      updated_at
    ) VALUES (
      @telegramUserId, @status, @firstName, @lastName, @username, @requestedAt,
      @updatedAt
    )
  `);
  const updateIdentityStatement = database.prepare(`
    UPDATE telegram_contributors
    SET first_name = @firstName,
        last_name = @lastName,
        username = @username,
        updated_at = @updatedAt
    WHERE telegram_user_id = @telegramUserId
  `);
  const updateStatusStatement = database.prepare(`
    UPDATE telegram_contributors
    SET status = @status, updated_at = @updatedAt
    WHERE telegram_user_id = @telegramUserId
  `);

  const readRow = (
    telegramUserId: TelegramUserId,
  ): TelegramContributorRow | undefined =>
    selectByIdStatement.get(telegramUserId) as
      TelegramContributorRow | undefined;

  const requireRow = (
    telegramUserId: TelegramUserId,
  ): TelegramContributorRow => {
    const row = readRow(telegramUserId);

    if (row === undefined) {
      throw new Error(
        'The Telegram contributor disappeared while it was being written',
      );
    }

    return row;
  };

  const applyRegistration = database.transaction(
    (input: TelegramContributorRegistration): TelegramContributor => {
      const timestamp = now().toISOString();
      const identity = {
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        username: input.username ?? null,
      };
      const existing = readRow(input.telegramUserId);

      if (existing === undefined) {
        insertStatement.run({
          telegramUserId: input.telegramUserId,
          status: 'pending',
          ...identity,
          requestedAt: timestamp,
          updatedAt: timestamp,
        });
      } else if (!identityMatches(existing, input)) {
        // Rewriting an unchanged identity would move `updatedAt` on every
        // message, which would hide when the record last really changed.
        updateIdentityStatement.run({
          telegramUserId: input.telegramUserId,
          ...identity,
          updatedAt: timestamp,
        });
      }

      return toContributor(requireRow(input.telegramUserId));
    },
  );

  const applyDecision = database.transaction(
    (
      telegramUserId: TelegramUserId,
      status: TelegramContributorDecision,
    ): TelegramContributor | undefined => {
      const existing = readRow(telegramUserId);

      if (existing === undefined) {
        return undefined;
      }

      if (existing.status !== status) {
        updateStatusStatement.run({
          telegramUserId,
          status,
          updatedAt: now().toISOString(),
        });
      }

      return toContributor(requireRow(telegramUserId));
    },
  );

  return {
    register: (input) => applyRegistration(input),

    findByTelegramUserId: (telegramUserId) => {
      const row = readRow(telegramUserId);
      return row === undefined ? undefined : toContributor(row);
    },

    list: () =>
      (selectAllStatement.all() as TelegramContributorRow[]).map(toContributor),

    decide: (telegramUserId, status) => applyDecision(telegramUserId, status),
  };
};
