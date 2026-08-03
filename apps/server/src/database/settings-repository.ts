import {
  gallerySettingsSchema,
  type GallerySettings,
  type GallerySettingsUpdateInput,
} from '@home-gallery/shared-types';

import type { DatabaseConnection } from './connection.js';

export interface SettingsRepository {
  read(): GallerySettings;
  update(update: GallerySettingsUpdateInput): GallerySettings;
}

interface SettingsRow {
  slide_duration_ms: number;
  fade_duration_ms: number;
  playback_mode: string;
  image_fit: string;
}

/** The settings row is seeded by a migration, so it is always present. */
export class MissingSettingsError extends Error {
  constructor() {
    super('Gallery settings row is missing; run the database migrations');
    this.name = 'MissingSettingsError';
  }
}

export const createSettingsRepository = (
  database: DatabaseConnection,
): SettingsRepository => {
  const selectStatement = database.prepare(
    `SELECT slide_duration_ms, fade_duration_ms, playback_mode, image_fit
     FROM gallery_settings WHERE id = 1`,
  );
  const updateStatement = database.prepare(
    `UPDATE gallery_settings
     SET slide_duration_ms = @slideDurationMs,
         fade_duration_ms = @fadeDurationMs,
         playback_mode = @playbackMode,
         image_fit = @imageFit
     WHERE id = 1`,
  );

  const read = (): GallerySettings => {
    const row = selectStatement.get() as SettingsRow | undefined;

    if (row === undefined) {
      throw new MissingSettingsError();
    }

    return gallerySettingsSchema.parse({
      slideDurationMs: row.slide_duration_ms,
      fadeDurationMs: row.fade_duration_ms,
      playbackMode: row.playback_mode,
      imageFit: row.image_fit,
    });
  };

  const applyUpdate = database.transaction(
    (update: GallerySettingsUpdateInput): GallerySettings => {
      // An explicitly undefined field means "leave unchanged", so spreading the
      // raw update would otherwise overwrite a stored value with undefined.
      const changes = Object.fromEntries(
        Object.entries(update).filter(([, value]) => value !== undefined),
      );
      const merged = gallerySettingsSchema.parse({ ...read(), ...changes });

      updateStatement.run(merged);

      return merged;
    },
  );

  return {
    read,
    update: (update) => applyUpdate(update),
  };
};
