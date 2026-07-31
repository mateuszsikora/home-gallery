import { resolve } from 'node:path';

import { z } from 'zod';

import { ConfigurationError, type ConfigurationIssue } from './errors.js';

/** Every server variable is namespaced so it can share a host with other apps. */
export const SERVER_ENV_PREFIX = 'HOME_GALLERY_';

export const DEFAULT_SERVER_HOST = '0.0.0.0';
/** Reserved for the Home Gallery API on the shared LAN host. */
export const DEFAULT_SERVER_PORT = 3012;
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_STORED_FILES = 5_000;
export const DEFAULT_SERVER_VERSION = '0.0.0';

export const MIN_API_TOKEN_LENGTH = 32;
export const MAX_API_TOKEN_LENGTH = 512;
export const MIN_MAX_UPLOAD_BYTES = 1024;
export const MAX_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_MAX_STORED_FILES = 1_000_000;

/** Matches the levels accepted by the server's pino logger. */
export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export const logLevelSchema = z.enum(LOG_LEVELS);

export type LogLevel = z.infer<typeof logLevelSchema>;

/** Sentinel that disables origin checking; only valid as the sole entry. */
export const ALLOW_ALL_ORIGINS = '*';

export interface ServerConfig {
  host: string;
  port: number;
  apiToken: string;
  dataDirectory: string;
  maxUploadBytes: number;
  maxStoredFiles: number;
  /** Normalized origins, or `['*']` when every origin is allowed. */
  allowedOrigins: readonly string[];
  logLevel: LogLevel;
  version: string;
}

const integerVariable = (min: number, max: number) => {
  const range = `Must be an integer between ${min} and ${max}`;

  return z
    .string()
    .trim()
    .regex(/^\d+$/u, range)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.int().min(min, range).max(max, range));
};

const hostSchema = z.string().trim().min(1, 'Must not be empty').max(255);

const portSchema = integerVariable(1, 65_535);

const apiTokenSchema = z
  .string()
  .trim()
  .min(
    MIN_API_TOKEN_LENGTH,
    `Must be at least ${MIN_API_TOKEN_LENGTH} characters`,
  )
  .max(
    MAX_API_TOKEN_LENGTH,
    `Must be at most ${MAX_API_TOKEN_LENGTH} characters`,
  )
  .refine((token) => !/\s/u.test(token), 'Must not contain whitespace');

const dataDirectorySchema = z
  .string()
  .trim()
  .min(1, 'Must not be empty')
  .transform((value) => resolve(value));

const normalizeOrigin = (origin: string, context: z.RefinementCtx): string => {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    context.addIssue({
      code: 'custom',
      message: `"${origin}" is not an absolute http(s) origin`,
    });
    return z.NEVER;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({
      code: 'custom',
      message: `"${origin}" must use http or https`,
    });
    return z.NEVER;
  }

  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: `"${origin}" must not contain credentials, a query, or a fragment`,
    });
    return z.NEVER;
  }

  return url.origin;
};

const allowedOriginsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .transform((origins, context) => {
    if (origins.includes(ALLOW_ALL_ORIGINS)) {
      if (origins.length > 1) {
        context.addIssue({
          code: 'custom',
          message: `"${ALLOW_ALL_ORIGINS}" cannot be combined with explicit origins`,
        });
        return z.NEVER;
      }

      return [ALLOW_ALL_ORIGINS];
    }

    return origins.map((origin) => normalizeOrigin(origin, context));
  });

const versionSchema = z.string().trim().min(1, 'Must not be empty').max(64);

const serverEnvSchema = z.object({
  HOME_GALLERY_HOST: hostSchema.optional(),
  HOME_GALLERY_PORT: portSchema.optional(),
  HOME_GALLERY_API_TOKEN: apiTokenSchema,
  HOME_GALLERY_DATA_DIR: dataDirectorySchema,
  HOME_GALLERY_MAX_UPLOAD_BYTES: integerVariable(
    MIN_MAX_UPLOAD_BYTES,
    MAX_MAX_UPLOAD_BYTES,
  ).optional(),
  HOME_GALLERY_MAX_STORED_FILES: integerVariable(
    1,
    MAX_MAX_STORED_FILES,
  ).optional(),
  HOME_GALLERY_ALLOWED_ORIGINS: allowedOriginsSchema.optional(),
  HOME_GALLERY_LOG_LEVEL: logLevelSchema.optional(),
  HOME_GALLERY_VERSION: versionSchema.optional(),
});

export type ServerEnvironment = Readonly<
  Partial<Record<keyof z.input<typeof serverEnvSchema>, string | undefined>>
>;

/**
 * Blank variables are a common deployment mistake and are indistinguishable
 * from an unset variable in practice, so they are dropped before validation.
 * Required variables then report "is required" instead of a length error.
 */
const withoutBlankValues = (
  environment: ServerEnvironment,
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

/**
 * Validates the process environment and returns a fully defaulted server
 * configuration. The environment is injectable so tests can point the server at
 * an isolated temporary data directory.
 */
export const loadServerConfig = (
  environment: ServerEnvironment = process.env,
): ServerConfig => {
  const provided = withoutBlankValues(environment);
  const parsed = serverEnvSchema.safeParse(provided);

  if (!parsed.success) {
    throw new ConfigurationError(
      'Invalid Home Gallery server configuration',
      toConfigurationIssues(parsed.error, provided),
    );
  }

  const values = parsed.data;

  return {
    host: values.HOME_GALLERY_HOST ?? DEFAULT_SERVER_HOST,
    port: values.HOME_GALLERY_PORT ?? DEFAULT_SERVER_PORT,
    apiToken: values.HOME_GALLERY_API_TOKEN,
    dataDirectory: values.HOME_GALLERY_DATA_DIR,
    maxUploadBytes:
      values.HOME_GALLERY_MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES,
    maxStoredFiles:
      values.HOME_GALLERY_MAX_STORED_FILES ?? DEFAULT_MAX_STORED_FILES,
    allowedOrigins: values.HOME_GALLERY_ALLOWED_ORIGINS ?? [],
    logLevel: values.HOME_GALLERY_LOG_LEVEL ?? 'info',
    version: values.HOME_GALLERY_VERSION ?? DEFAULT_SERVER_VERSION,
  };
};
