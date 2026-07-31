import { z } from 'zod';

import {
  isoTimestampSchema,
  mediaIdSchema,
  paginationCursorSchema,
} from './common.js';

export const MEDIA_TYPES = ['image'] as const;
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const SUPPORTED_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const supportedUploadMimeTypeSchema = z.enum(
  SUPPORTED_UPLOAD_MIME_TYPES,
);
export type SupportedUploadMimeType = z.infer<
  typeof supportedUploadMimeTypeSchema
>;

export const NORMALIZED_MEDIA_MIME_TYPES = ['image/webp'] as const;
export const normalizedMediaMimeTypeSchema = z.enum(
  NORMALIZED_MEDIA_MIME_TYPES,
);
export type NormalizedMediaMimeType = z.infer<
  typeof normalizedMediaMimeTypeSchema
>;

export const UPLOAD_SOURCES = ['telegram', 'admin', 'api'] as const;
export const uploadSourceSchema = z.enum(UPLOAD_SOURCES);
export type UploadSource = z.infer<typeof uploadSourceSchema>;

const filenameSchema = z.string().trim().min(1).max(255);
const sourceIdentifierSchema = z.string().trim().min(1).max(128);
const authorNameSchema = z.string().trim().min(1).max(256);
const imageDimensionSchema = z.int().positive().max(100_000);

/** Metadata submitted alongside the multipart image body. */
export const mediaUploadMetadataSchema = z
  .object({
    originalFilename: filenameSchema,
    source: uploadSourceSchema,
    sourceId: sourceIdentifierSchema.optional(),
    authorName: authorNameSchema.optional(),
  })
  .strict();

export type MediaUploadMetadata = z.infer<typeof mediaUploadMetadataSchema>;

/** Administrative representation returned after an upload or mutation. */
export const mediaRecordSchema = z.object({
  id: mediaIdSchema,
  storedFilename: filenameSchema,
  originalFilename: filenameSchema,
  mediaType: mediaTypeSchema,
  mimeType: normalizedMediaMimeTypeSchema,
  uploadedAt: isoTimestampSchema,
  source: uploadSourceSchema,
  sourceId: sourceIdentifierSchema.optional(),
  authorName: authorNameSchema.optional(),
  enabled: z.boolean(),
  sortOrder: z.int().nonnegative(),
  width: imageDimensionSchema,
  height: imageDimensionSchema,
});

export type MediaRecord = z.infer<typeof mediaRecordSchema>;

export const DEFAULT_MEDIA_LIST_LIMIT = 50;
export const MAX_MEDIA_LIST_LIMIT = 100;

export const mediaListQuerySchema = z
  .object({
    cursor: paginationCursorSchema.optional(),
    limit: z.int().min(1).max(MAX_MEDIA_LIST_LIMIT).optional(),
  })
  .strict();

export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;

export const mediaListResponseSchema = z.object({
  items: z.array(mediaRecordSchema),
  nextCursor: paginationCursorSchema.nullable(),
});

export type MediaListResponse = z.infer<typeof mediaListResponseSchema>;

/** `PATCH /api/media/{id}` accepts any non-empty subset of mutable fields. */
export const mediaUpdateInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    sortOrder: z.int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (update) => Object.values(update).some((value) => value !== undefined),
    {
      message: 'At least one media field must be provided',
    },
  );

export type MediaUpdateInput = z.infer<typeof mediaUpdateInputSchema>;
