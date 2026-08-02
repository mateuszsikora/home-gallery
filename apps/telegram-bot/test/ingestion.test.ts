import type { UploadMediaInput } from '@home-gallery/api-client';
import {
  SUPPORTED_UPLOAD_MIME_TYPES,
  type MediaRecord,
  type TelegramContributor,
  type TelegramContributorStatus,
} from '@home-gallery/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  createTelegramIngestionHandler,
  type TelegramGateway,
  type TelegramMediaMessage,
} from '../src/ingestion.js';
import type { BotLogger, LogFields } from '../src/logger.js';

const MEDIA_RECORD: MediaRecord = {
  id: '70f16fba-e1c2-40c6-a8c8-9f1acbe4155d',
  storedFilename: '70f16fba-e1c2-40c6-a8c8-9f1acbe4155d.webp',
  originalFilename: 'telegram-photo-42.jpg',
  mediaType: 'image',
  mimeType: 'image/webp',
  uploadedAt: '2026-07-31T10:15:30.000Z',
  source: 'telegram',
  sourceId: '123',
  authorName: 'Ada Lovelace',
  enabled: true,
  sortOrder: 0,
  width: 1600,
  height: 900,
};

const CONTRIBUTOR: TelegramContributor = {
  telegramUserId: '123',
  status: 'approved',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  requestedAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:30:00.000Z',
};

const PHOTO_MESSAGE: TelegramMediaMessage = {
  chatId: -100987,
  messageId: 42,
  from: {
    id: 123,
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada',
  },
  photo: [
    { fileId: 'medium', width: 800, height: 600, fileSize: 50_000 },
    { fileId: 'small', width: 320, height: 240, fileSize: 10_000 },
    { fileId: 'large', width: 1600, height: 1200, fileSize: 200_000 },
  ],
};

interface LogEntry {
  level: 'error' | 'info' | 'warn';
  fields: LogFields;
  message: string;
}

const createHarness = (status: TelegramContributorStatus = 'approved') => {
  const calls: string[] = [];
  const logs: LogEntry[] = [];
  const uploadMedia = vi.fn(async (_input: UploadMediaInput) => {
    void _input;
    calls.push('upload');
    return MEDIA_RECORD;
  });
  const registerTelegramContributor = vi.fn(async () => {
    calls.push('register');
    return { ...CONTRIBUTOR, status };
  });
  const getFileLink = vi.fn(async (fileId: string) => {
    calls.push(`lookup:${fileId}`);
    return new URL(`https://telegram.example.test/files/${fileId}`);
  });
  const deleteMessage = vi.fn(async () => {
    calls.push('delete');
  });
  const reply = vi.fn(async () => {
    calls.push('reply');
  });
  const telegram: TelegramGateway = { getFileLink, deleteMessage, reply };
  const fetchMock = vi.fn(async () => {
    calls.push('download');
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  const logger: BotLogger = {
    info: (fields, message) => logs.push({ level: 'info', fields, message }),
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };

  const handler = createTelegramIngestionHandler({
    homeGalleryClient: { registerTelegramContributor, uploadMedia },
    telegram,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    logger,
    requestTimeoutMs: 100,
    maxDownloadBytes: 1_024,
  });

  return {
    calls,
    logs,
    registerTelegramContributor,
    uploadMedia,
    getFileLink,
    deleteMessage,
    reply,
    fetchMock,
    logger,
    telegram,
    handler,
  };
};

describe('Telegram media ingestion', () => {
  it('records first contact as a pending request without looking up or downloading media', async () => {
    const harness = createHarness('pending');

    const result = await harness.handler({
      ...PHOTO_MESSAGE,
      from: { id: 999, firstName: 'Grace', username: 'grace' },
    });

    expect(result).toBe('pending');
    expect(harness.registerTelegramContributor).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: '999',
        firstName: 'Grace',
        username: 'grace',
      },
    );
    expect(harness.getFileLink).not.toHaveBeenCalled();
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
  });

  it('keeps blocking a rejected contributor', async () => {
    const harness = createHarness('rejected');

    const result = await harness.handler(PHOTO_MESSAGE);

    expect(result).toBe('rejected');
    expect(harness.calls).toEqual(['register', 'reply']);
    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
  });

  it('registers a contributor that sends no media at all', async () => {
    const harness = createHarness('pending');

    const result = await harness.handler({
      chatId: PHOTO_MESSAGE.chatId,
      messageId: PHOTO_MESSAGE.messageId,
      from: PHOTO_MESSAGE.from,
    });

    expect(result).toBe('pending');
    expect(harness.registerTelegramContributor).toHaveBeenCalledOnce();
    expect(harness.reply).toHaveBeenCalledOnce();
  });

  it('retains the message when the contributor cannot be registered', async () => {
    const harness = createHarness();
    harness.registerTelegramContributor.mockRejectedValueOnce(
      new Error('API unavailable'),
    );

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('failed');

    expect(harness.getFileLink).not.toHaveBeenCalled();
    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message:
          'Could not register the Telegram contributor; the message was retained',
        fields: expect.objectContaining({ errorMessage: 'API unavailable' }),
      }),
    );
  });

  it('selects the highest-quality photo, uploads attribution, then deletes exactly once', async () => {
    const harness = createHarness();

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('uploaded');

    expect(harness.getFileLink).toHaveBeenCalledWith('large');
    expect(harness.uploadMedia).toHaveBeenCalledOnce();
    const upload = harness.uploadMedia.mock.calls[0]?.[0];
    expect(upload).toMatchObject({
      originalFilename: 'telegram-photo-42.jpg',
      source: 'telegram',
      sourceId: '123',
      authorName: 'Ada Lovelace',
    });
    expect(upload?.file).toBeInstanceOf(Blob);
    expect(upload?.file.type).toBe('image/jpeg');
    expect(harness.deleteMessage).toHaveBeenCalledExactlyOnceWith(-100987, 42);
    expect(harness.calls).toEqual([
      'register',
      'lookup:large',
      'download',
      'upload',
      'delete',
    ]);
  });

  it.each(SUPPORTED_UPLOAD_MIME_TYPES)(
    'accepts a %s image document',
    async (mimeType) => {
      const harness = createHarness();
      const message: TelegramMediaMessage = {
        chatId: PHOTO_MESSAGE.chatId,
        messageId: PHOTO_MESSAGE.messageId,
        from: PHOTO_MESSAGE.from,
        document: {
          fileId: `document-${mimeType}`,
          fileName: 'family-photo',
          mimeType,
        },
      };

      await expect(harness.handler(message)).resolves.toBe('uploaded');

      expect(harness.uploadMedia.mock.calls[0]?.[0].file.type).toBe(mimeType);
      expect(harness.deleteMessage).toHaveBeenCalledOnce();
    },
  );

  it('rejects an unsupported document without downloading it', async () => {
    const harness = createHarness();
    const result = await harness.handler({
      chatId: PHOTO_MESSAGE.chatId,
      messageId: PHOTO_MESSAGE.messageId,
      from: PHOTO_MESSAGE.from,
      document: {
        fileId: 'pdf-file',
        fileName: 'notes.pdf',
        mimeType: 'application/pdf',
      },
    });

    expect(result).toBe('unsupported');
    expect(harness.getFileLink).not.toHaveBeenCalled();
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
  });

  it('retains the source message and reports a useful failure when upload fails', async () => {
    const harness = createHarness();
    harness.uploadMedia.mockRejectedValueOnce(new Error('API unavailable'));

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('failed');

    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message:
          'Telegram media ingestion failed; the source message was retained',
        fields: expect.objectContaining({ errorMessage: 'API unavailable' }),
      }),
    );
  });

  it('retains the source message when the Telegram download fails', async () => {
    const harness = createHarness();
    harness.fetchMock.mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    );

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('failed');

    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
  });

  it('times out a stalled Home Gallery upload and retains the message', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.uploadMedia.mockImplementationOnce(
      () => new Promise<MediaRecord>(() => undefined),
    );
    const handler = createTelegramIngestionHandler({
      homeGalleryClient: {
        registerTelegramContributor: harness.registerTelegramContributor,
        uploadMedia: harness.uploadMedia,
      },
      telegram: harness.telegram,
      fetch: harness.fetchMock as unknown as typeof globalThis.fetch,
      logger: harness.logger,
      requestTimeoutMs: 1_000,
      maxDownloadBytes: 1_024,
    });

    const result = handler(PHOTO_MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe('failed');
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('times out a stalled Telegram API operation and retains the message', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.getFileLink.mockImplementationOnce(
      () => new Promise<URL>(() => undefined),
    );
    const handler = createTelegramIngestionHandler({
      homeGalleryClient: {
        registerTelegramContributor: harness.registerTelegramContributor,
        uploadMedia: harness.uploadMedia,
      },
      telegram: harness.telegram,
      fetch: harness.fetchMock as unknown as typeof globalThis.fetch,
      logger: harness.logger,
      requestTimeoutMs: 1_000,
      maxDownloadBytes: 1_024,
    });

    const result = handler(PHOTO_MESSAGE);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe('failed');
    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('redacts the bot and API tokens from failure logs', async () => {
    const harness = createHarness();
    const botToken = '123456789:super-secret-bot-token';
    const apiToken = 'super-secret-home-gallery-api-token';
    harness.uploadMedia.mockRejectedValueOnce(
      new Error(`Request ${botToken} failed with Bearer ${apiToken}`),
    );
    const handler = createTelegramIngestionHandler({
      homeGalleryClient: {
        registerTelegramContributor: harness.registerTelegramContributor,
        uploadMedia: harness.uploadMedia,
      },
      telegram: harness.telegram,
      fetch: harness.fetchMock as unknown as typeof globalThis.fetch,
      logger: harness.logger,
      requestTimeoutMs: 100,
      maxDownloadBytes: 1_024,
      secrets: [botToken, apiToken],
    });

    await handler(PHOTO_MESSAGE);

    const output = JSON.stringify(harness.logs);
    expect(output).not.toContain(botToken);
    expect(output).not.toContain(apiToken);
    expect(output).toContain('[REDACTED]');
  });

  it('rejects a Telegram response whose declared size exceeds the limit', async () => {
    const harness = createHarness();
    harness.fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': '2048' },
      }),
    );

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('failed');

    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledOnce();
  });

  it('stops reading a Telegram response that streams beyond the limit', async () => {
    const harness = createHarness();
    harness.fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(1_025)),
    );

    await expect(harness.handler(PHOTO_MESSAGE)).resolves.toBe('failed');

    expect(harness.uploadMedia).not.toHaveBeenCalled();
    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          errorName: 'TelegramDownloadLimitError',
        }),
      }),
    );
  });
});
