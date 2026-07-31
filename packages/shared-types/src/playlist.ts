import { z } from 'zod';

import { mediaIdSchema } from './common.js';
import { normalizedMediaMimeTypeSchema, type MediaRecord } from './media.js';
import { gallerySettingsSchema } from './settings.js';

/** Public media metadata intentionally excludes storage and author details. */
export const playlistItemSchema = z.object({
  id: mediaIdSchema,
  contentUrl: z.string().min(1),
  mimeType: normalizedMediaMimeTypeSchema,
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
