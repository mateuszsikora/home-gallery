import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/errors.js';
import {
  DEFAULT_ADMIN_SESSION_MAX,
  DEFAULT_ADMIN_SESSION_TTL_MS,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
  DEFAULT_MAX_STORED_FILES,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_UPLOAD_RATE_LIMIT_MAX,
  DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS,
  loadServerConfig,
  MIN_API_TOKEN_LENGTH,
  type ServerEnvironment,
} from '../src/server.js';

const INGESTION_TOKEN = 'b'.repeat(MIN_API_TOKEN_LENGTH);

const environment = (overrides: ServerEnvironment = {}): ServerEnvironment => ({
  HOME_GALLERY_INGESTION_TOKEN: INGESTION_TOKEN,
  HOME_GALLERY_DATA_DIR: '/srv/home-gallery/data',
  ...overrides,
});

const issueVariables = (call: () => unknown): string[] => {
  try {
    call();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.issues.map((issue) => issue.variable);
    }

    throw error;
  }

  throw new Error('Expected the configuration to be rejected');
};

describe('loadServerConfig', () => {
  it('applies documented defaults', () => {
    expect(loadServerConfig(environment())).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      ingestionTokens: [INGESTION_TOKEN],
      allowAdministrationUploads: false,
      adminSession: {
        max: DEFAULT_ADMIN_SESSION_MAX,
        secure: false,
        ttlMs: DEFAULT_ADMIN_SESSION_TTL_MS,
      },
      authenticationRateLimit: {
        max: DEFAULT_AUTH_RATE_LIMIT_MAX,
        windowMs: DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
      },
      uploadRateLimit: {
        max: DEFAULT_UPLOAD_RATE_LIMIT_MAX,
        windowMs: DEFAULT_UPLOAD_RATE_LIMIT_WINDOW_MS,
      },
      trustedProxies: [],
      dataDirectory: '/srv/home-gallery/data',
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      maxStoredFiles: DEFAULT_MAX_STORED_FILES,
      allowedOrigins: [],
      logLevel: 'info',
      version: '0.0.0',
    });
  });

  it('reads every supported variable', () => {
    expect(
      loadServerConfig(
        environment({
          HOME_GALLERY_HOST: '127.0.0.1',
          HOME_GALLERY_PORT: '3012',
          HOME_GALLERY_INGESTION_TOKEN_PREVIOUS: 'd'.repeat(32),
          HOME_GALLERY_ALLOW_ADMIN_UPLOADS: 'true',
          HOME_GALLERY_ADMIN_SESSION_TTL_MS: '3600000',
          HOME_GALLERY_ADMIN_SESSION_MAX: '12',
          HOME_GALLERY_ADMIN_SESSION_SECURE: 'true',
          HOME_GALLERY_AUTH_RATE_LIMIT_MAX: '5',
          HOME_GALLERY_AUTH_RATE_LIMIT_WINDOW_MS: '120000',
          HOME_GALLERY_UPLOAD_RATE_LIMIT_MAX: '8',
          HOME_GALLERY_UPLOAD_RATE_LIMIT_WINDOW_MS: '30000',
          HOME_GALLERY_TRUSTED_PROXIES: '127.0.0.1, 10.10.0.0/16',
          HOME_GALLERY_MAX_UPLOAD_BYTES: '1048576',
          HOME_GALLERY_MAX_STORED_FILES: '250',
          HOME_GALLERY_ALLOWED_ORIGINS:
            'http://gallery.local:3010, https://admin.local',
          HOME_GALLERY_LOG_LEVEL: 'debug',
          HOME_GALLERY_VERSION: '1.4.0',
        }),
      ),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 3012,
      ingestionTokens: [INGESTION_TOKEN, 'd'.repeat(32)],
      allowAdministrationUploads: true,
      adminSession: { max: 12, secure: true, ttlMs: 3_600_000 },
      authenticationRateLimit: { max: 5, windowMs: 120_000 },
      uploadRateLimit: { max: 8, windowMs: 30_000 },
      trustedProxies: ['127.0.0.1', '10.10.0.0/16'],
      maxUploadBytes: 1_048_576,
      maxStoredFiles: 250,
      allowedOrigins: ['http://gallery.local:3010', 'https://admin.local'],
      logLevel: 'debug',
      version: '1.4.0',
    });
  });

  it('resolves a relative data directory against the working directory', () => {
    expect(
      loadServerConfig(environment({ HOME_GALLERY_DATA_DIR: './data' }))
        .dataDirectory,
    ).toBe(resolve('./data'));
  });

  it('reports every missing security-critical variable at once', () => {
    expect(issueVariables(() => loadServerConfig({}))).toEqual([
      'HOME_GALLERY_INGESTION_TOKEN',
      'HOME_GALLERY_DATA_DIR',
    ]);
  });

  it('names the variable and the reason in the message', () => {
    const error = (() => {
      try {
        loadServerConfig({ HOME_GALLERY_DATA_DIR: '/data' });
      } catch (caught) {
        return caught;
      }

      throw new Error('Expected the configuration to be rejected');
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).message).toContain(
      'HOME_GALLERY_INGESTION_TOKEN: Is required',
    );
  });

  it('treats a blank variable as missing', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(environment({ HOME_GALLERY_INGESTION_TOKEN: '   ' })),
      ),
    ).toEqual(['HOME_GALLERY_INGESTION_TOKEN']);
  });

  it('falls back to the default when an optional variable is blank', () => {
    expect(loadServerConfig(environment({ HOME_GALLERY_PORT: '' })).port).toBe(
      DEFAULT_SERVER_PORT,
    );
  });

  it('rejects a short api token', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(
          environment({ HOME_GALLERY_INGESTION_TOKEN: 'too-short' }),
        ),
      ),
    ).toEqual(['HOME_GALLERY_INGESTION_TOKEN']);
  });

  it('trims a token that arrives with a trailing newline', () => {
    expect(
      loadServerConfig(
        environment({ HOME_GALLERY_INGESTION_TOKEN: `${INGESTION_TOKEN}\n` }),
      ).ingestionTokens,
    ).toEqual([INGESTION_TOKEN]);
  });

  it.each([
    ['HOME_GALLERY_AUTH_RATE_LIMIT_MAX', '0'],
    ['HOME_GALLERY_AUTH_RATE_LIMIT_WINDOW_MS', '999'],
    ['HOME_GALLERY_UPLOAD_RATE_LIMIT_MAX', '100001'],
    ['HOME_GALLERY_UPLOAD_RATE_LIMIT_WINDOW_MS', '86400001'],
    ['HOME_GALLERY_ALLOW_ADMIN_UPLOADS', 'yes'],
    ['HOME_GALLERY_ADMIN_SESSION_TTL_MS', '59999'],
    ['HOME_GALLERY_ADMIN_SESSION_MAX', '0'],
    ['HOME_GALLERY_ADMIN_SESSION_SECURE', 'yes'],
  ] as const)(
    'rejects invalid defense-in-depth variable %s',
    (variable, value) => {
      expect(
        issueVariables(() =>
          loadServerConfig(environment({ [variable]: value })),
        ),
      ).toEqual([variable]);
    },
  );

  it.each(['all', '*', 'example.test', '10.0.0.0/33', '2001:db8::/129'])(
    'rejects the invalid trusted proxy %j',
    (trustedProxy) => {
      expect(
        issueVariables(() =>
          loadServerConfig(
            environment({ HOME_GALLERY_TRUSTED_PROXIES: trustedProxy }),
          ),
        ),
      ).toEqual(['HOME_GALLERY_TRUSTED_PROXIES']);
    },
  );

  it('accepts supported trusted proxy aliases and IPv6 ranges', () => {
    expect(
      loadServerConfig(
        environment({
          HOME_GALLERY_TRUSTED_PROXIES: 'loopback,uniquelocal,2001:db8::/64',
        }),
      ).trustedProxies,
    ).toEqual(['loopback', 'uniquelocal', '2001:db8::/64']);
  });

  it.each(['0', '65536', '-1', '3012.5', 'http'])(
    'rejects the invalid port %j',
    (port) => {
      expect(
        issueVariables(() =>
          loadServerConfig(environment({ HOME_GALLERY_PORT: port })),
        ),
      ).toEqual(['HOME_GALLERY_PORT']);
    },
  );

  it.each(['512', '2147483648'])(
    'rejects the out-of-range upload limit %j',
    (bytes) => {
      expect(
        issueVariables(() =>
          loadServerConfig(
            environment({ HOME_GALLERY_MAX_UPLOAD_BYTES: bytes }),
          ),
        ),
      ).toEqual(['HOME_GALLERY_MAX_UPLOAD_BYTES']);
    },
  );

  it('rejects a zero file-count limit', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(environment({ HOME_GALLERY_MAX_STORED_FILES: '0' })),
      ),
    ).toEqual(['HOME_GALLERY_MAX_STORED_FILES']);
  });

  it('rejects an unknown log level', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(environment({ HOME_GALLERY_LOG_LEVEL: 'verbose' })),
      ),
    ).toEqual(['HOME_GALLERY_LOG_LEVEL']);
  });

  it('normalizes origins to scheme, host, and port', () => {
    expect(
      loadServerConfig(
        environment({
          HOME_GALLERY_ALLOWED_ORIGINS: 'http://gallery.local:3010/,,  ',
        }),
      ).allowedOrigins,
    ).toEqual(['http://gallery.local:3010']);
  });

  it('supports allowing every origin explicitly', () => {
    expect(
      loadServerConfig(environment({ HOME_GALLERY_ALLOWED_ORIGINS: '*' }))
        .allowedOrigins,
    ).toEqual(['*']);
  });

  it.each([
    'gallery.local',
    'ftp://gallery.local',
    'http://gallery.local?a=1',
    'http://user:pass@gallery.local',
    '*,http://gallery.local',
  ])('rejects the invalid origin list %j', (origins) => {
    expect(
      issueVariables(() =>
        loadServerConfig(
          environment({ HOME_GALLERY_ALLOWED_ORIGINS: origins }),
        ),
      ),
    ).toEqual(['HOME_GALLERY_ALLOWED_ORIGINS']);
  });

  it('ignores unrelated environment variables', () => {
    expect(
      loadServerConfig({
        ...environment(),
        PATH: '/usr/bin',
      } as ServerEnvironment).host,
    ).toBe(DEFAULT_SERVER_HOST);
  });
});
