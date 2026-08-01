import { z } from 'zod';

import { ConfigurationError, type ConfigurationIssue } from './errors.js';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_API_TOKEN_LENGTH,
  MAX_MAX_UPLOAD_BYTES,
  MIN_API_TOKEN_LENGTH,
  MIN_MAX_UPLOAD_BYTES,
} from './server.js';

export const DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
export const MIN_TELEGRAM_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_TELEGRAM_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_TELEGRAM_MAX_DOWNLOAD_BYTES = DEFAULT_MAX_UPLOAD_BYTES;

export interface TelegramBotConfig {
  botToken: string;
  apiUrl: string;
  apiToken: string;
  allowedUserIds: ReadonlySet<number>;
  requestTimeoutMs: number;
  maxDownloadBytes: number;
}

const requiredString = z.string().trim().min(1, 'Must not be empty');

const botTokenSchema = requiredString
  .regex(/^\d{1,20}:[A-Za-z0-9_-]{20,}$/u, 'Must be a valid Telegram bot token')
  .max(256, 'Must be at most 256 characters');

const apiTokenSchema = requiredString
  .min(
    MIN_API_TOKEN_LENGTH,
    `Must be at least ${MIN_API_TOKEN_LENGTH} characters`,
  )
  .max(
    MAX_API_TOKEN_LENGTH,
    `Must be at most ${MAX_API_TOKEN_LENGTH} characters`,
  )
  .refine((token) => !/\s/u.test(token), 'Must not contain whitespace');

const apiUrlSchema = requiredString.transform((value, context) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Must be an absolute HTTP or HTTPS URL',
    });
    return z.NEVER;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({
      code: 'custom',
      message: 'Must use HTTP or HTTPS',
    });
    return z.NEVER;
  }

  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'Must not contain credentials, a query, or a fragment',
    });
    return z.NEVER;
  }

  return url.toString().replace(/\/+$/u, '');
});

const allowedUserIdsSchema = requiredString.transform((value, context) => {
  const entries = value.split(',').map((entry) => entry.trim());
  const identifiers = new Set<number>();

  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      context.addIssue({
        code: 'custom',
        message: 'Must be a comma-separated list of positive Telegram user IDs',
      });
      return z.NEVER;
    }

    const identifier = Number(entry);

    if (!Number.isSafeInteger(identifier) || identifier <= 0) {
      context.addIssue({
        code: 'custom',
        message: 'Every Telegram user ID must be a positive safe integer',
      });
      return z.NEVER;
    }

    identifiers.add(identifier);
  }

  return identifiers;
});

const requestTimeoutSchema = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'Must be an integer')
  .transform((value) => Number(value))
  .pipe(
    z
      .int()
      .min(MIN_TELEGRAM_REQUEST_TIMEOUT_MS)
      .max(MAX_TELEGRAM_REQUEST_TIMEOUT_MS),
  );

const maxDownloadBytesSchema = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'Must be an integer')
  .transform((value) => Number(value))
  .pipe(z.int().min(MIN_MAX_UPLOAD_BYTES).max(MAX_MAX_UPLOAD_BYTES));

const telegramBotEnvSchema = z.object({
  HOME_GALLERY_TELEGRAM_BOT_TOKEN: botTokenSchema,
  HOME_GALLERY_API_URL: apiUrlSchema,
  HOME_GALLERY_API_TOKEN: apiTokenSchema,
  HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS: allowedUserIdsSchema,
  HOME_GALLERY_TELEGRAM_REQUEST_TIMEOUT_MS: requestTimeoutSchema.optional(),
  HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES: maxDownloadBytesSchema.optional(),
});

export type TelegramBotEnvironment = Readonly<
  Partial<
    Record<keyof z.input<typeof telegramBotEnvSchema>, string | undefined>
  >
>;

const withoutBlankValues = (
  environment: TelegramBotEnvironment,
): Record<string, string> => {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      normalized[key] = value;
    }
  }

  return normalized;
};

const toConfigurationIssues = (
  error: z.ZodError,
  provided: Readonly<Record<string, string>>,
): ConfigurationIssue[] =>
  error.issues.map((issue) => {
    const variable = issue.path.join('.');

    return {
      variable,
      message: provided[variable] === undefined ? 'Is required' : issue.message,
    };
  });

export const loadTelegramBotConfig = (
  environment: TelegramBotEnvironment = process.env,
): TelegramBotConfig => {
  const provided = withoutBlankValues(environment);
  const parsed = telegramBotEnvSchema.safeParse(provided);

  if (!parsed.success) {
    throw new ConfigurationError(
      'Invalid Home Gallery Telegram bot configuration',
      toConfigurationIssues(parsed.error, provided),
    );
  }

  return {
    botToken: parsed.data.HOME_GALLERY_TELEGRAM_BOT_TOKEN,
    apiUrl: parsed.data.HOME_GALLERY_API_URL,
    apiToken: parsed.data.HOME_GALLERY_API_TOKEN,
    allowedUserIds: parsed.data.HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS,
    requestTimeoutMs:
      parsed.data.HOME_GALLERY_TELEGRAM_REQUEST_TIMEOUT_MS ??
      DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
    maxDownloadBytes:
      parsed.data.HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES ??
      DEFAULT_TELEGRAM_MAX_DOWNLOAD_BYTES,
  };
};
