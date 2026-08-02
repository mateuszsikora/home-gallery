import { resolve } from 'node:path';
import { isIP } from 'node:net';

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
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_UPLOAD_RATE_LIMIT_MAX = 30;
export const DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const DEFAULT_ADMIN_SESSION_MAX = 64;

export const MIN_API_TOKEN_LENGTH = 32;
export const MAX_API_TOKEN_LENGTH = 512;
export const MIN_MAX_UPLOAD_BYTES = 1024;
export const MAX_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_MAX_STORED_FILES = 1_000_000;
export const MAX_RATE_LIMIT_REQUESTS = 100_000;
export const MIN_RATE_LIMIT_WINDOW_MS = 1_000;
export const MAX_RATE_LIMIT_WINDOW_MS = 86_400_000;
export const MIN_ADMIN_SESSION_TTL_MS = 60_000;
export const MAX_ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_ADMIN_SESSIONS = 10_000;

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface AdminSessionConfig {
  max: number;
  secure: boolean;
  ttlMs: number;
}

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
  administrationTokens: readonly string[];
  ingestionTokens: readonly string[];
  allowAdministrationUploads: boolean;
  adminSession: AdminSessionConfig;
  authenticationRateLimit: RateLimitConfig;
  uploadRateLimit: RateLimitConfig;
  /** IP addresses and CIDRs of proxies allowed to supply forwarding headers. */
  trustedProxies: readonly string[];
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

const credentialTokenSchema = z
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

const booleanVariable = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const TRUSTED_PROXY_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const isValidTrustedProxy = (entry: string): boolean => {
  if (TRUSTED_PROXY_ALIASES.has(entry)) {
    return true;
  }

  const slash = entry.lastIndexOf('/');
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const family = isIP(address);

  if (family === 0) {
    return false;
  }

  if (slash < 0) {
    return true;
  }

  const prefix = entry.slice(slash + 1);
  const maximum = family === 4 ? 32 : 128;

  return /^\d+$/u.test(prefix) && Number(prefix) <= maximum;
};

const trustedProxiesSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine(
    (entries) => entries.every(isValidTrustedProxy),
    'Must contain only IP addresses, CIDRs, or supported proxy range aliases',
  );

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
  HOME_GALLERY_ADMIN_TOKEN: credentialTokenSchema,
  HOME_GALLERY_ADMIN_TOKEN_PREVIOUS: credentialTokenSchema.optional(),
  HOME_GALLERY_INGESTION_TOKEN: credentialTokenSchema,
  HOME_GALLERY_INGESTION_TOKEN_PREVIOUS: credentialTokenSchema.optional(),
  HOME_GALLERY_ALLOW_ADMIN_UPLOADS: booleanVariable.optional(),
  HOME_GALLERY_ADMIN_SESSION_TTL_MS: integerVariable(
    MIN_ADMIN_SESSION_TTL_MS,
    MAX_ADMIN_SESSION_TTL_MS,
  ).optional(),
  HOME_GALLERY_ADMIN_SESSION_MAX: integerVariable(
    1,
    MAX_ADMIN_SESSIONS,
  ).optional(),
  HOME_GALLERY_ADMIN_SESSION_SECURE: booleanVariable.optional(),
  HOME_GALLERY_AUTH_RATE_LIMIT_MAX: integerVariable(
    1,
    MAX_RATE_LIMIT_REQUESTS,
  ).optional(),
  HOME_GALLERY_AUTH_RATE_LIMIT_WINDOW_MS: integerVariable(
    MIN_RATE_LIMIT_WINDOW_MS,
    MAX_RATE_LIMIT_WINDOW_MS,
  ).optional(),
  HOME_GALLERY_UPLOAD_RATE_LIMIT_MAX: integerVariable(
    1,
    MAX_RATE_LIMIT_REQUESTS,
  ).optional(),
  HOME_GALLERY_UPLOAD_RATE_LIMIT_WINDOW_MS: integerVariable(
    MIN_RATE_LIMIT_WINDOW_MS,
    MAX_RATE_LIMIT_WINDOW_MS,
  ).optional(),
  HOME_GALLERY_TRUSTED_PROXIES: trustedProxiesSchema.optional(),
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
    administrationTokens: [
      values.HOME_GALLERY_ADMIN_TOKEN,
      ...(values.HOME_GALLERY_ADMIN_TOKEN_PREVIOUS === undefined
        ? []
        : [values.HOME_GALLERY_ADMIN_TOKEN_PREVIOUS]),
    ],
    ingestionTokens: [
      values.HOME_GALLERY_INGESTION_TOKEN,
      ...(values.HOME_GALLERY_INGESTION_TOKEN_PREVIOUS === undefined
        ? []
        : [values.HOME_GALLERY_INGESTION_TOKEN_PREVIOUS]),
    ],
    allowAdministrationUploads:
      values.HOME_GALLERY_ALLOW_ADMIN_UPLOADS ?? false,
    adminSession: {
      max: values.HOME_GALLERY_ADMIN_SESSION_MAX ?? DEFAULT_ADMIN_SESSION_MAX,
      secure: values.HOME_GALLERY_ADMIN_SESSION_SECURE ?? false,
      ttlMs:
        values.HOME_GALLERY_ADMIN_SESSION_TTL_MS ??
        DEFAULT_ADMIN_SESSION_TTL_MS,
    },
    authenticationRateLimit: {
      max:
        values.HOME_GALLERY_AUTH_RATE_LIMIT_MAX ?? DEFAULT_AUTH_RATE_LIMIT_MAX,
      windowMs:
        values.HOME_GALLERY_AUTH_RATE_LIMIT_WINDOW_MS ??
        DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
    },
    uploadRateLimit: {
      max:
        values.HOME_GALLERY_UPLOAD_RATE_LIMIT_MAX ??
        DEFAULT_UPLOAD_RATE_LIMIT_MAX,
      windowMs:
        values.HOME_GALLERY_UPLOAD_RATE_LIMIT_WINDOW_MS ??
        DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS,
    },
    trustedProxies: values.HOME_GALLERY_TRUSTED_PROXIES ?? [],
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
