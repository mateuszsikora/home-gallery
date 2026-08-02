import { z } from 'zod';

import { isoTimestampSchema } from './common.js';

export const TELEGRAM_CONTRIBUTOR_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const;
export const telegramContributorStatusSchema = z.enum(
  TELEGRAM_CONTRIBUTOR_STATUSES,
);
export type TelegramContributorStatus = z.infer<
  typeof telegramContributorStatusSchema
>;

/** An administrator can only move a contributor into a decided state. */
export const TELEGRAM_CONTRIBUTOR_DECISIONS = ['approved', 'rejected'] as const;
export const telegramContributorDecisionSchema = z.enum(
  TELEGRAM_CONTRIBUTOR_DECISIONS,
);
export type TelegramContributorDecision = z.infer<
  typeof telegramContributorDecisionSchema
>;

/**
 * Telegram identifiers are integers that may exceed the safe integer range, so
 * they are exchanged and stored as digit strings instead of numbers.
 */
export const telegramUserIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{0,19}$/u, 'Must be a positive Telegram user ID');
export type TelegramUserId = z.infer<typeof telegramUserIdSchema>;

const telegramNameSchema = z.string().trim().min(1).max(128);
const telegramUsernameSchema = z.string().trim().min(1).max(64);

/** Identity fields Telegram reports about a contributor; all are optional. */
const telegramIdentitySchema = z.object({
  firstName: telegramNameSchema.optional(),
  lastName: telegramNameSchema.optional(),
  username: telegramUsernameSchema.optional(),
});

/** Administrative representation of one Telegram contributor. */
export const telegramContributorSchema = telegramIdentitySchema.extend({
  telegramUserId: telegramUserIdSchema,
  status: telegramContributorStatusSchema,
  requestedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type TelegramContributor = z.infer<typeof telegramContributorSchema>;

/**
 * Sent by the bot on every contact. The first one creates a pending access
 * request; later ones only refresh the identity Telegram reports.
 */
export const telegramContributorRegistrationSchema = telegramIdentitySchema
  .extend({
    telegramUserId: telegramUserIdSchema,
  })
  .strict();

export type TelegramContributorRegistration = z.infer<
  typeof telegramContributorRegistrationSchema
>;

export const telegramContributorUpdateInputSchema = z
  .object({
    status: telegramContributorDecisionSchema,
  })
  .strict();

export type TelegramContributorUpdateInput = z.infer<
  typeof telegramContributorUpdateInputSchema
>;

/**
 * The contributor list is not paginated: a household gallery has far fewer
 * contributors than media items, and the administrator needs to see all of the
 * pending requests at once.
 */
export const telegramContributorListResponseSchema = z.object({
  items: z.array(telegramContributorSchema),
});

export type TelegramContributorListResponse = z.infer<
  typeof telegramContributorListResponseSchema
>;
