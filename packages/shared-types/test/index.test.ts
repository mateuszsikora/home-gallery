import { describe, expect, it } from 'vitest';

import {
  API_ERROR_STATUS,
  DEFAULT_GALLERY_SETTINGS,
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
});
