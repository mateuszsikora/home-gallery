import type { HomeGalleryClient } from '@home-gallery/api-client';
import {
  SUPPORTED_UPLOAD_MIME_TYPES,
  type SupportedUploadMimeType,
  type TelegramContributorRegistration,
  type TelegramContributorStatus,
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
  homeGalleryClient: Pick<
    HomeGalleryClient,
    'registerTelegramContributor' | 'uploadMedia'
  >;
  telegram: TelegramGateway;
  fetch?: typeof globalThis.fetch;
  logger: BotLogger;
  requestTimeoutMs: number;
  maxDownloadBytes: number;
  secrets?: readonly string[];
}

export type TelegramIngestionResult =
  'pending' | 'rejected' | 'unsupported' | 'uploaded' | 'failed';

export class TelegramDownloadLimitError extends Error {
  constructor(maxDownloadBytes: number) {
    super(`Telegram media exceeds the ${maxDownloadBytes} byte download limit`);
    this.name = 'TelegramDownloadLimitError';
  }
}

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

const MAX_TELEGRAM_NAME_LENGTH = 128;
const MAX_TELEGRAM_USERNAME_LENGTH = 64;

/** Keeps optional identity fields within the contract the API accepts. */
const identityField = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  const trimmed = value?.trim();

  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const toRegistration = (
  user: TelegramUser,
): TelegramContributorRegistration => {
  const firstName = identityField(user.firstName, MAX_TELEGRAM_NAME_LENGTH);
  const lastName = identityField(user.lastName, MAX_TELEGRAM_NAME_LENGTH);
  const username = identityField(user.username, MAX_TELEGRAM_USERNAME_LENGTH);

  return {
    telegramUserId: String(user.id),
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
    ...(username === undefined ? {} : { username }),
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

/**
 * Reads Telegram media without allowing an absent or dishonest Content-Length
 * header to make the bot buffer an unbounded response in memory.
 */
const readDownloadedMedia = async (
  response: Response,
  maxDownloadBytes: number,
): Promise<ArrayBuffer> => {
  const contentLength = response.headers.get('content-length');

  if (contentLength !== null) {
    const declaredLength = Number(contentLength);

    if (Number.isFinite(declaredLength) && declaredLength > maxDownloadBytes) {
      await response.body?.cancel();
      throw new TelegramDownloadLimitError(maxDownloadBytes);
    }
  }

  if (response.body === null) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      receivedBytes += value.byteLength;

      if (receivedBytes > maxDownloadBytes) {
        await reader.cancel();
        throw new TelegramDownloadLimitError(maxDownloadBytes);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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

    let status: TelegramContributorStatus;

    // Registering first means an unknown contributor becomes a reviewable
    // access request without the bot looking up or downloading anything.
    try {
      const contributor = await withTimeout(
        () =>
          options.homeGalleryClient.registerTelegramContributor(
            toRegistration(message.from),
          ),
        options.requestTimeoutMs,
        'Home Gallery contributor registration',
      );
      status = contributor.status;
    } catch (error) {
      options.logger.error(
        {
          ...logContext,
          ...safeErrorFields(error, options.secrets ?? []),
        },
        'Could not register the Telegram contributor; the message was retained',
      );
      await attemptReply(
        options,
        message,
        'The gallery could not be reached. Your original message was kept so it can be retried.',
      );
      return 'failed';
    }

    if (status !== 'approved') {
      options.logger.info(
        { ...logContext, status },
        'Ignored media from a contributor without approval',
      );
      await attemptReply(
        options,
        message,
        status === 'pending'
          ? 'Your access request is waiting for the gallery administrator. You can send photos once it is approved.'
          : 'You are not authorized to upload media to this gallery.',
      );
      return status === 'pending' ? 'pending' : 'rejected';
    }

    const selectedMedia = selectMedia(message);

    if (!selectedMedia) {
      options.logger.info(logContext, 'Rejected unsupported Telegram media');
      await attemptReply(
        options,
        message,
        'Send a JPEG, PNG, WebP, HEIC, or HEIF image to add it to the gallery.',
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
        () => readDownloadedMedia(response, options.maxDownloadBytes),
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
