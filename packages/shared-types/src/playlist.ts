import { z } from 'zod';

import { mediaIdSchema } from './common.js';
import { normalizedMediaMimeTypeSchema, type MediaRecord } from './media.js';
import { gallerySettingsSchema } from './settings.js';

/** Longest-edge bounds; the v1 recipe produces at most three derivatives. */
export const DISPLAY_VARIANT_EDGES = [1280, 1920, 2560] as const;

export const displayVariantSchema = z.object({
  contentUrl: z.string().min(1),
  width: z.int().positive().max(100_000),
  height: z.int().positive().max(100_000),
});
export type DisplayVariant = z.infer<typeof displayVariantSchema>;

/** Public media metadata intentionally excludes storage and author details. */
export const playlistItemSchema = z.object({
  id: mediaIdSchema,
  contentUrl: z.string().min(1),
  mimeType: normalizedMediaMimeTypeSchema,
  variants: z.array(displayVariantSchema).max(3).optional(),
  width: z.int().positive().max(100_000),
  height: z.int().positive().max(100_000),
});

export type PlaylistItem = z.infer<typeof playlistItemSchema>;

export const playlistResponseSchema = z.object({
  items: z.array(playlistItemSchema),
  settings: gallerySettingsSchema,
});

export type PlaylistResponse = z.infer<typeof playlistResponseSchema>;

export const toPlaylistItem = (
  media: Pick<MediaRecord, 'id' | 'mimeType' | 'width' | 'height'>,
): PlaylistItem => ({
  id: media.id,
  contentUrl: `/media/${encodeURIComponent(media.id)}`,
  mimeType: media.mimeType,
  width: media.width,
  height: media.height,
});
