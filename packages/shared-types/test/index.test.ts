import { describe, expect, it } from 'vitest';

import {
  API_ERROR_STATUS,
  API_ROUTES,
  DEFAULT_GALLERY_SETTINGS,
  adminAuthStatusSchema,
  adminSessionSchema,
  apiErrorBodySchema,
  createApiErrorBody,
  gallerySettingsSchema,
  gallerySettingsUpdateInputSchema,
  mediaListQuerySchema,
  mediaRecordSchema,
  mediaUpdateInputSchema,
  mediaUploadMetadataSchema,
  playlistResponseSchema,
  supportedUploadMimeTypeSchema,
  telegramContributorListResponseSchema,
  telegramContributorRegistrationSchema,
  telegramContributorSchema,
  telegramContributorUpdateInputSchema,
  telegramUserIdSchema,
  toPlaylistItem,
} from '../src/index.js';

const mediaRecord = {
  id: '70f16fba-e1c2-40c6-a8c8-9f1acbe4155d',
  storedFilename: '70f16fba-e1c2-40c6-a8c8-9f1acbe4155d.webp',
  originalFilename: 'summer.jpg',
  mediaType: 'image',
  mimeType: 'image/webp',
  uploadedAt: '2026-07-31T10:15:30.000Z',
  source: 'telegram',
  sourceId: '123456',
  authorName: 'Gallery contributor',
  enabled: true,
  sortOrder: 4,
  width: 1920,
  height: 1080,
} as const;

describe('media contracts', () => {
  it('parses the administrative media representation', () => {
    expect(mediaRecordSchema.parse(mediaRecord)).toEqual(mediaRecord);
  });

  it('rejects unsupported normalized content and invalid dimensions', () => {
    expect(
      mediaRecordSchema.safeParse({
        ...mediaRecord,
        mimeType: 'image/jpeg',
        width: 0,
      }).success,
    ).toBe(false);
  });

  it('validates multipart metadata without accepting unknown fields', () => {
    expect(
      mediaUploadMetadataSchema.safeParse({
        originalFilename: 'photo.png',
        source: 'telegram',
        sourceId: '123456',
        token: 'must-not-be-part-of-the-contract',
      }).success,
    ).toBe(false);
    expect(supportedUploadMimeTypeSchema.parse('image/heif')).toBe(
      'image/heif',
    );
    expect(supportedUploadMimeTypeSchema.safeParse('video/mp4').success).toBe(
      false,
    );
  });

  it('requires a non-empty media mutation', () => {
    expect(mediaUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(mediaUpdateInputSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it('validates cursor pagination bounds', () => {
    expect(mediaListQuerySchema.parse({ limit: 100 })).toEqual({ limit: 100 });
    expect(mediaListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('playlist and settings contracts', () => {
  it('derives a public playlist item without administrative metadata', () => {
    expect(toPlaylistItem(mediaRecord)).toEqual({
      id: mediaRecord.id,
      contentUrl: `/media/${mediaRecord.id}`,
      mimeType: 'image/webp',
      width: 1920,
      height: 1080,
    });
  });

  it('parses a playlist and its timing settings', () => {
    const item = toPlaylistItem(mediaRecord);
    const value = {
      items: [item],
      settings: DEFAULT_GALLERY_SETTINGS,
    };

    expect(playlistResponseSchema.parse(value)).toEqual(value);
  });

  it('enforces settings limits and non-empty updates', () => {
    expect(gallerySettingsSchema.parse(DEFAULT_GALLERY_SETTINGS)).toEqual(
      DEFAULT_GALLERY_SETTINGS,
    );
    expect(
      gallerySettingsSchema.safeParse({
        ...DEFAULT_GALLERY_SETTINGS,
        fadeDurationMs: 10_001,
      }).success,
    ).toBe(false);
    expect(gallerySettingsUpdateInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('error contracts', () => {
  it('serializes stable structured validation errors', () => {
    const body = createApiErrorBody('validation_failed', 'Invalid request', [
      { path: 'slideDurationMs', message: 'Must be at least 1000' },
    ]);

    expect(apiErrorBodySchema.parse(body)).toEqual(body);
    expect(API_ERROR_STATUS[body.error.code]).toBe(422);
  });

  it('gives each named refusal its own code under one shared status', () => {
    // A client that acts on a cause has to read the code, because the status
    // these share does not say which of them answered.
    expect(API_ERROR_STATUS.forbidden).toBe(403);
    expect(API_ERROR_STATUS.invalid_password).toBe(403);
    expect(API_ERROR_STATUS.administration_ingestion_disabled).toBe(403);
    expect(
      apiErrorBodySchema.safeParse(
        createApiErrorBody('invalid_password', 'Wrong password'),
      ).success,
    ).toBe(true);
  });
});

describe('administration session contract', () => {
  it('accepts only an ISO expiry timestamp on the documented route', () => {
    const session = { expiresAt: '2026-08-02T12:00:00.000Z' };

    expect(adminSessionSchema.parse(session)).toEqual(session);
    expect(
      adminSessionSchema.safeParse({ expiresAt: 'tomorrow' }).success,
    ).toBe(false);
    expect(API_ROUTES.adminSession).toBe('/api/admin/session');
  });

  it('reads an older auth response as refusing browser uploads', () => {
    // A server that predates the field must leave the studio usable, with the
    // upload control hidden rather than offered and refused.
    expect(adminAuthStatusSchema.parse({ passwordConfigured: true })).toEqual({
      administrationUploadsEnabled: false,
      passwordConfigured: true,
    });
    expect(
      adminAuthStatusSchema.safeParse({
        administrationUploadsEnabled: true,
        passwordConfigured: false,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe('telegram contributor contracts', () => {
  const contributor = {
    telegramUserId: '123456',
    status: 'pending',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada',
    requestedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  } as const;

  it('parses an administrative contributor record', () => {
    expect(telegramContributorSchema.parse(contributor)).toEqual(contributor);
    expect(API_ROUTES.telegramContributors).toBe('/api/telegram/contributors');
    expect(API_ROUTES.telegramContributorById('123456')).toBe(
      '/api/telegram/contributors/123456',
    );
  });

  it('accepts only positive Telegram user IDs', () => {
    expect(telegramUserIdSchema.parse(' 123456 ')).toBe('123456');
    for (const value of ['', '0', '-7', '12a', '1'.repeat(21)]) {
      expect(telegramUserIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it('registers an identity without letting the bot set a status', () => {
    expect(
      telegramContributorRegistrationSchema.parse({ telegramUserId: '123456' }),
    ).toEqual({ telegramUserId: '123456' });
    expect(
      telegramContributorRegistrationSchema.safeParse({
        telegramUserId: '123456',
        status: 'approved',
      }).success,
    ).toBe(false);
  });

  it('limits an administrator to a decided status', () => {
    expect(
      telegramContributorUpdateInputSchema.parse({ status: 'approved' }),
    ).toEqual({ status: 'approved' });
    for (const status of ['pending', 'banned', undefined]) {
      expect(
        telegramContributorUpdateInputSchema.safeParse({ status }).success,
      ).toBe(false);
    }
  });

  it('parses an unpaginated contributor list', () => {
    const value = { items: [contributor] };

    expect(telegramContributorListResponseSchema.parse(value)).toEqual(value);
  });
});
