import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/errors.js';
import {
  DEFAULT_TELEGRAM_MAX_DOWNLOAD_BYTES,
  DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
  loadTelegramBotConfig,
  type TelegramBotEnvironment,
} from '../src/telegram-bot.js';

const BOT_TOKEN = '123456789:telegram_bot_token_value';
const API_TOKEN = 'a'.repeat(32);

const environment = (
  overrides: TelegramBotEnvironment = {},
): TelegramBotEnvironment => ({
  HOME_GALLERY_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  HOME_GALLERY_API_URL: 'http://home-gallery-server:3012',
  HOME_GALLERY_API_TOKEN: API_TOKEN,
  HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS: '123,456',
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

describe('loadTelegramBotConfig', () => {
  it('loads required values and applies the timeout default', () => {
    const config = loadTelegramBotConfig(environment());

    expect(config).toMatchObject({
      botToken: BOT_TOKEN,
      apiUrl: 'http://home-gallery-server:3012',
      apiToken: API_TOKEN,
      requestTimeoutMs: DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
      maxDownloadBytes: DEFAULT_TELEGRAM_MAX_DOWNLOAD_BYTES,
    });
    expect([...config.allowedUserIds]).toEqual([123, 456]);
  });

  it('normalizes values and removes duplicate user IDs', () => {
    const config = loadTelegramBotConfig(
      environment({
        HOME_GALLERY_API_URL: 'https://gallery.example.test/',
        HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS: ' 123, 456,123 ',
        HOME_GALLERY_TELEGRAM_REQUEST_TIMEOUT_MS: '15000',
        HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES: '1048576',
      }),
    );

    expect(config.apiUrl).toBe('https://gallery.example.test');
    expect([...config.allowedUserIds]).toEqual([123, 456]);
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.maxDownloadBytes).toBe(1_048_576);
  });

  it('reports every missing security-critical variable', () => {
    expect(issueVariables(() => loadTelegramBotConfig({}))).toEqual([
      'HOME_GALLERY_TELEGRAM_BOT_TOKEN',
      'HOME_GALLERY_API_URL',
      'HOME_GALLERY_API_TOKEN',
      'HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS',
    ]);
  });

  it.each([
    ['HOME_GALLERY_TELEGRAM_BOT_TOKEN', 'not-a-token'],
    ['HOME_GALLERY_TELEGRAM_BOT_TOKEN', '123:x'],
    ['HOME_GALLERY_API_URL', 'ftp://gallery.example.test'],
    ['HOME_GALLERY_API_URL', 'https://user:secret@gallery.example.test'],
    ['HOME_GALLERY_API_TOKEN', 'too-short'],
    ['HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS', '123,nope'],
    ['HOME_GALLERY_TELEGRAM_ALLOWED_USER_IDS', '0'],
    ['HOME_GALLERY_TELEGRAM_REQUEST_TIMEOUT_MS', '999'],
    ['HOME_GALLERY_TELEGRAM_REQUEST_TIMEOUT_MS', '120001'],
    ['HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES', '1023'],
    ['HOME_GALLERY_TELEGRAM_MAX_DOWNLOAD_BYTES', '1073741825'],
  ] as const)('rejects invalid %s values', (variable, value) => {
    expect(
      issueVariables(() =>
        loadTelegramBotConfig(environment({ [variable]: value })),
      ),
    ).toEqual([variable]);
  });

  it('treats blank required values as missing', () => {
    expect(
      issueVariables(() =>
        loadTelegramBotConfig(
          environment({ HOME_GALLERY_TELEGRAM_BOT_TOKEN: ' ' }),
        ),
      ),
    ).toEqual(['HOME_GALLERY_TELEGRAM_BOT_TOKEN']);
  });
});
