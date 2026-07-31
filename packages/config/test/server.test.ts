import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/errors.js';
import {
  DEFAULT_MAX_STORED_FILES,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  loadServerConfig,
  MIN_API_TOKEN_LENGTH,
  type ServerEnvironment,
} from '../src/server.js';

const VALID_TOKEN = 'a'.repeat(MIN_API_TOKEN_LENGTH);

const environment = (overrides: ServerEnvironment = {}): ServerEnvironment => ({
  HOME_GALLERY_API_TOKEN: VALID_TOKEN,
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
      apiToken: VALID_TOKEN,
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
      'HOME_GALLERY_API_TOKEN',
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
      'HOME_GALLERY_API_TOKEN: Is required',
    );
  });

  it('treats a blank variable as missing', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(environment({ HOME_GALLERY_API_TOKEN: '   ' })),
      ),
    ).toEqual(['HOME_GALLERY_API_TOKEN']);
  });

  it('falls back to the default when an optional variable is blank', () => {
    expect(loadServerConfig(environment({ HOME_GALLERY_PORT: '' })).port).toBe(
      DEFAULT_SERVER_PORT,
    );
  });

  it('rejects a short api token', () => {
    expect(
      issueVariables(() =>
        loadServerConfig(environment({ HOME_GALLERY_API_TOKEN: 'too-short' })),
      ),
    ).toEqual(['HOME_GALLERY_API_TOKEN']);
  });

  it('trims a token that arrives with a trailing newline', () => {
    expect(
      loadServerConfig(
        environment({ HOME_GALLERY_API_TOKEN: `${VALID_TOKEN}\n` }),
      ).apiToken,
    ).toBe(VALID_TOKEN);
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
