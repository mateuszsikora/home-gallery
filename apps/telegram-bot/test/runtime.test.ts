import type { TelegramBotConfig } from '@home-gallery/config';
import { Telegraf } from 'telegraf';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotLogger } from '../src/logger.js';
import { createTelegramBot } from '../src/runtime.js';

const CONFIG: TelegramBotConfig = {
  botToken: '123456789:abcdefghijklmnopqrstuvwxyz',
  apiUrl: 'http://server:3012',
  ingestionToken: '0123456789abcdef0123456789abcdef',
  allowedUserIds: new Set([123]),
  requestTimeoutMs: 30_000,
  maxDownloadBytes: 25 * 1024 * 1024,
};

describe('Telegram runtime readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports readiness only after Telegram accepts the bot credentials', async () => {
    const events: string[] = [];
    const logger: BotLogger = {
      info: (_fields, message) => events.push(message),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const launch = vi
      .spyOn(Telegraf.prototype, 'launch')
      .mockImplementation(async (_config, onLaunch) => {
        onLaunch?.();
      });
    const onReady = vi.fn(() => events.push('ready'));

    await createTelegramBot(CONFIG, logger).launch(onReady);

    expect(launch).toHaveBeenCalledWith(
      { allowedUpdates: ['message'] },
      expect.any(Function),
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(events).toEqual(['ready', 'Telegram bot started']);
  });
});
