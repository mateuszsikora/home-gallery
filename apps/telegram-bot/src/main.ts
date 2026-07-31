import {
  ConfigurationError,
  loadTelegramBotConfig,
} from '@home-gallery/config';

import { createConsoleLogger, safeErrorFields } from './logger.js';
import { createTelegramBot } from './runtime.js';

const logger = createConsoleLogger();

const start = async (): Promise<void> => {
  let secrets: readonly string[] = [];

  try {
    const config = loadTelegramBotConfig();
    secrets = [config.botToken, config.apiToken];
    const bot = createTelegramBot(config, logger);
    let stopping = false;

    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      bot.stop(signal);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await bot.launch();
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
