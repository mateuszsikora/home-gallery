import type { HomeGalleryClient } from '@home-gallery/api-client';
import {
  SUPPORTED_UPLOAD_MIME_TYPES,
  type SupportedUploadMimeType,
} from '@home-gallery/shared-types';

import { safeErrorFields, type BotLogger } from './logger.js';

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface TelegramPhoto {
  fileId: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface TelegramDocument {
  fileId: string;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramMediaMessage {
  chatId: number;
  messageId: number;
  from: TelegramUser;
  photo?: readonly TelegramPhoto[];
  document?: TelegramDocument;
}

export interface TelegramGateway {
  getFileLink(fileId: string): Promise<URL>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  reply(chatId: number, messageId: number, text: string): Promise<void>;
}

export interface TelegramIngestionOptions {
  allowedUserIds: ReadonlySet<number>;
  homeGalleryClient: Pick<HomeGalleryClient, 'uploadMedia'>;
  telegram: TelegramGateway;
  fetch?: typeof globalThis.fetch;
  logger: BotLogger;
  requestTimeoutMs: number;
  secrets?: readonly string[];
}

export type TelegramIngestionResult =
  'rejected' | 'unsupported' | 'uploaded' | 'failed';

interface SelectedMedia {
  fileId: string;
  fileName: string;
  mimeType: SupportedUploadMimeType;
}

const MIME_TYPE_EXTENSIONS: Readonly<Record<SupportedUploadMimeType, string>> =
  {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };

const supportedMimeTypes = new Set<string>(SUPPORTED_UPLOAD_MIME_TYPES);

const normalizeFileName = (
  value: string | undefined,
  fallback: string,
): string => (value?.trim() || fallback).slice(0, 255);

const selectLargestPhoto = (
  photos: readonly TelegramPhoto[],
): TelegramPhoto | undefined =>
  photos.reduce<TelegramPhoto | undefined>((selected, candidate) => {
    if (!selected) {
      return candidate;
    }

    const selectedPixels = selected.width * selected.height;
    const candidatePixels = candidate.width * candidate.height;

    if (candidatePixels !== selectedPixels) {
      return candidatePixels > selectedPixels ? candidate : selected;
    }

    return (candidate.fileSize ?? 0) > (selected.fileSize ?? 0)
      ? candidate
      : selected;
  }, undefined);

const toSupportedMimeType = (
  value: string | undefined,
): SupportedUploadMimeType | undefined => {
  const normalized = value?.trim().toLowerCase();

  return normalized && supportedMimeTypes.has(normalized)
    ? (normalized as SupportedUploadMimeType)
    : undefined;
};

const selectMedia = (
  message: TelegramMediaMessage,
): SelectedMedia | undefined => {
  const photo = selectLargestPhoto(message.photo ?? []);

  if (photo) {
    return {
      fileId: photo.fileId,
      fileName: `telegram-photo-${message.messageId}.jpg`,
      mimeType: 'image/jpeg',
    };
  }

  if (!message.document) {
    return undefined;
  }

  const mimeType = toSupportedMimeType(message.document.mimeType);

  if (!mimeType) {
    return undefined;
  }

  return {
    fileId: message.document.fileId,
    fileName: normalizeFileName(
      message.document.fileName,
      `telegram-document-${message.messageId}.${MIME_TYPE_EXTENSIONS[mimeType]}`,
    ),
    mimeType,
  };
};

const authorName = (user: TelegramUser): string => {
  const displayName = [user.firstName, user.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();

  if (displayName) {
    return displayName;
  }

  return user.username ? `@${user.username}` : `Telegram user ${user.id}`;
};

export const withTimeout = async <Value>(
  operation: () => Promise<Value>,
  timeoutMs: number,
  operationName: string,
): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${operationName} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const attemptReply = async (
  options: TelegramIngestionOptions,
  message: TelegramMediaMessage,
  text: string,
): Promise<void> => {
  try {
    await withTimeout(
      () => options.telegram.reply(message.chatId, message.messageId, text),
      options.requestTimeoutMs,
      'Telegram reply',
    );
  } catch (error) {
    options.logger.warn(
      {
        userId: message.from.id,
        messageId: message.messageId,
        ...safeErrorFields(error, options.secrets ?? []),
      },
      'Could not send a Telegram status reply',
    );
  }
};

export const createTelegramIngestionHandler = (
  options: TelegramIngestionOptions,
): ((message: TelegramMediaMessage) => Promise<TelegramIngestionResult>) => {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async (message) => {
    const logContext = {
      userId: message.from.id,
      messageId: message.messageId,
      chatId: message.chatId,
    };

    if (!options.allowedUserIds.has(message.from.id)) {
      options.logger.warn(logContext, 'Rejected media from unauthorized user');
      await attemptReply(
        options,
        message,
        'You are not authorized to upload media to this gallery.',
      );
      return 'rejected';
    }

    const selectedMedia = selectMedia(message);

    if (!selectedMedia) {
      options.logger.info(logContext, 'Rejected unsupported Telegram media');
      await attemptReply(
        options,
        message,
        'This file type is not supported. Send a JPEG, PNG, WebP, HEIC, or HEIF image.',
      );
      return 'unsupported';
    }

    try {
      const fileUrl = await withTimeout(
        () => options.telegram.getFileLink(selectedMedia.fileId),
        options.requestTimeoutMs,
        'Telegram file lookup',
      );
      const response = await withTimeout(
        () =>
          fetchImplementation(fileUrl, {
            signal: AbortSignal.timeout(options.requestTimeoutMs),
          }),
        options.requestTimeoutMs,
        'Telegram file download',
      );

      if (!response.ok) {
        throw new Error(
          `Telegram file download failed with status ${response.status}`,
        );
      }

      const bytes = await withTimeout(
        () => response.arrayBuffer(),
        options.requestTimeoutMs,
        'Telegram file read',
      );
      const file = new Blob([bytes], { type: selectedMedia.mimeType });

      await withTimeout(
        () =>
          options.homeGalleryClient.uploadMedia({
            file,
            originalFilename: selectedMedia.fileName,
            source: 'telegram',
            sourceId: String(message.from.id),
            authorName: authorName(message.from),
          }),
        options.requestTimeoutMs,
        'Home Gallery upload',
      );

      await withTimeout(
        () => options.telegram.deleteMessage(message.chatId, message.messageId),
        options.requestTimeoutMs,
        'Telegram message deletion',
      );

      options.logger.info(logContext, 'Uploaded Telegram media');
      return 'uploaded';
    } catch (error) {
      options.logger.error(
        {
          ...logContext,
          ...safeErrorFields(error, options.secrets ?? []),
        },
        'Telegram media ingestion failed; the source message was retained',
      );
      await attemptReply(
        options,
        message,
        'The upload failed. Your original message was kept so it can be retried.',
      );
      return 'failed';
    }
  };
};
