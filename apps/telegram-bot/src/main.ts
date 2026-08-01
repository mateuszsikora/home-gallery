import { rmSync, writeFileSync } from 'node:fs';

import {
  ConfigurationError,
  loadTelegramBotConfig,
} from '@home-gallery/config';

import { createConsoleLogger, safeErrorFields } from './logger.js';
import { createTelegramBot } from './runtime.js';

const logger = createConsoleLogger();
export const TELEGRAM_BOT_READY_FILE = '/tmp/home-gallery-telegram-bot-ready';

const start = async (): Promise<void> => {
  let secrets: readonly string[] = [];

  try {
    const config = loadTelegramBotConfig();
    secrets = [config.botToken, config.ingestionToken];
    const bot = createTelegramBot(config, logger);
    let stopping = false;

    rmSync(TELEGRAM_BOT_READY_FILE, { force: true });

    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      rmSync(TELEGRAM_BOT_READY_FILE, { force: true });
      bot.stop(signal);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await bot.launch(() => {
      writeFileSync(TELEGRAM_BOT_READY_FILE, 'ready\n', { mode: 0o600 });
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      logger.error(
        safeErrorFields(error, secrets),
        'Telegram bot failed to start',
      );
    }

    process.exitCode = 1;
  }
};

await start();
