import { z } from 'zod';

/** Slides advance in storage order or in a shuffled order. */
export const PLAYBACK_MODES = ['sequential', 'shuffle'] as const;

export const playbackModeSchema = z.enum(PLAYBACK_MODES);

export type PlaybackMode = z.infer<typeof playbackModeSchema>;

/**
 * How a photo is laid out when its aspect ratio disagrees with the display:
 * `contain` letterboxes it, `blur` keeps it whole and fills the remaining area
 * with a blurred copy of the same photo, and `auto` crops to fill instead
 * whenever the mismatch is small enough that little of the photo is lost.
 */
export const IMAGE_FIT_MODES = ['contain', 'blur', 'auto'] as const;

export const imageFitSchema = z.enum(IMAGE_FIT_MODES);

export type ImageFit = z.infer<typeof imageFitSchema>;

export const MIN_SLIDE_DURATION_MS = 1_000;
export const MAX_SLIDE_DURATION_MS = 3_600_000;
export const MIN_FADE_DURATION_MS = 0;
export const MAX_FADE_DURATION_MS = 10_000;

export const gallerySettingsSchema = z
  .object({
    slideDurationMs: z
      .int()
      .min(MIN_SLIDE_DURATION_MS)
      .max(MAX_SLIDE_DURATION_MS),
    fadeDurationMs: z.int().min(MIN_FADE_DURATION_MS).max(MAX_FADE_DURATION_MS),
    playbackMode: playbackModeSchema,
    imageFit: imageFitSchema,
  })
  .strict();

export type GallerySettings = z.infer<typeof gallerySettingsSchema>;

export const DEFAULT_GALLERY_SETTINGS: GallerySettings = {
  slideDurationMs: 8_000,
  fadeDurationMs: 1_000,
  playbackMode: 'sequential',
  imageFit: 'blur',
};

/** `PATCH /api/settings` accepts any non-empty subset of the settings. */
export const gallerySettingsUpdateInputSchema = gallerySettingsSchema
  .partial()
  .refine(
    (update) => Object.values(update).some((value) => value !== undefined),
    {
      message: 'At least one setting must be provided',
    },
  );

export type GallerySettingsUpdateInput = z.infer<
  typeof gallerySettingsUpdateInputSchema
>;
