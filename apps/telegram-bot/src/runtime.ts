import { createHomeGalleryClient } from '@home-gallery/api-client';
import type { TelegramBotConfig } from '@home-gallery/config';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import {
  createTelegramIngestionHandler,
  type TelegramMediaMessage,
} from './ingestion.js';
import {
  createConsoleLogger,
  safeErrorFields,
  type BotLogger,
} from './logger.js';

export interface RunningTelegramBot {
  launch(onReady?: () => void): Promise<void>;
  stop(reason?: string): void;
}

const timeoutFetch =
  (timeoutMs: number): typeof globalThis.fetch =>
  async (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    return globalThis.fetch(input, { ...init, signal });
  };

export const createTelegramBot = (
  config: TelegramBotConfig,
  logger: BotLogger = createConsoleLogger(),
): RunningTelegramBot => {
  const bot = new Telegraf(config.botToken, {
    // Ingestion performs up to six sequential bounded operations, including a
    // failure reply. Keep Telegraf's outer deadline above those inner limits so
    // it never abandons a handler that is still completing its cleanup path.
    handlerTimeout: config.requestTimeoutMs * 6 + 1_000,
  });
  const secrets = [config.botToken, config.ingestionToken];
  const ingestionHandler = createTelegramIngestionHandler({
    allowedUserIds: config.allowedUserIds,
    homeGalleryClient: createHomeGalleryClient({
      baseUrl: config.apiUrl,
      token: config.ingestionToken,
      fetch: timeoutFetch(config.requestTimeoutMs),
    }),
    telegram: {
      getFileLink: (fileId) => bot.telegram.getFileLink(fileId),
      deleteMessage: async (chatId, messageId) => {
        await bot.telegram.deleteMessage(chatId, messageId);
      },
      reply: async (chatId, messageId, text) => {
        await bot.telegram.sendMessage(chatId, text, {
          reply_parameters: { message_id: messageId },
        });
      },
    },
    fetch: timeoutFetch(config.requestTimeoutMs),
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
    maxDownloadBytes: config.maxDownloadBytes,
    secrets,
  });

  bot.on(message('photo'), async (context) => {
    const incoming: TelegramMediaMessage = {
      chatId: context.chat.id,
      messageId: context.message.message_id,
      from: {
        id: context.from.id,
        firstName: context.from.first_name,
        ...(context.from.last_name ? { lastName: context.from.last_name } : {}),
        ...(context.from.username ? { username: context.from.username } : {}),
      },
      photo: context.message.photo.map((photo) => ({
        fileId: photo.file_id,
        width: photo.width,
        height: photo.height,
        ...(photo.file_size === undefined ? {} : { fileSize: photo.file_size }),
      })),
    };

    await ingestionHandler(incoming);
  });

  bot.on(message('document'), async (context) => {
    const document = context.message.document;
    const incoming: TelegramMediaMessage = {
      chatId: context.chat.id,
      messageId: context.message.message_id,
      from: {
        id: context.from.id,
        firstName: context.from.first_name,
        ...(context.from.last_name ? { lastName: context.from.last_name } : {}),
        ...(context.from.username ? { username: context.from.username } : {}),
      },
      document: {
        fileId: document.file_id,
        ...(document.file_name ? { fileName: document.file_name } : {}),
        ...(document.mime_type ? { mimeType: document.mime_type } : {}),
      },
    };

    await ingestionHandler(incoming);
  });

  bot.catch((error, context) => {
    logger.error(
      {
        updateId: context.update.update_id,
        ...safeErrorFields(error, secrets),
      },
      'Unhandled Telegram update error',
    );
  });

  return {
    launch: async (onReady) => {
      await bot.launch({ allowedUpdates: ['message'] }, () => {
        onReady?.();
        logger.info({}, 'Telegram bot started');
      });
    },
    stop: (reason) => {
      bot.stop(reason);
      logger.info(reason ? { reason } : {}, 'Telegram bot stopped');
    },
  };
};
