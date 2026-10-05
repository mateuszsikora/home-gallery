import {
  API_ROUTES,
  DISPLAY_VARIANT_EDGES,
  type DisplayVariant,
  type MediaRecord,
} from '@home-gallery/shared-types';
import sharp from 'sharp';

import type { MediaStorage } from '../storage/media-storage.js';
import { MAX_INPUT_PIXELS } from './image-normalizer.js';

/** Version the recipe in both the disk name and public URL. Never overwrite it. */
export const displayVariantFilename = (
  filename: string,
  edge: number,
): string => `${filename.replace(/\.[^.]+$/u, '')}.display-v1-${edge}.webp`;

export const displayVariantSizes = ({
  width,
  height,
}: Pick<MediaRecord, 'width' | 'height'>): {
  edge: number;
  width: number;
  height: number;
}[] =>
  DISPLAY_VARIANT_EDGES.filter((edge) => edge < Math.max(width, height)).map(
    (edge) => ({
      edge,
      width: Math.max(1, Math.round((width * edge) / Math.max(width, height))),
      height: Math.max(
        1,
        Math.round((height * edge) / Math.max(width, height)),
      ),
    }),
  );

export const createDisplayVariant = async (
  sourcePath: string,
  outputPath: string,
  edge: number,
): Promise<void> => {
  await sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize({
      width: edge,
      height: edge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality: 80 })
    .toFile(outputPath);
};

/** Advertise only committed files; an absent derivative never blocks the API. */
export const availableDisplayVariants = async (
  record: MediaRecord,
  storage: MediaStorage,
): Promise<DisplayVariant[]> => {
  const variants: DisplayVariant[] = [];
  for (const size of displayVariantSizes(record)) {
    try {
      if (
        await storage.exists(
          displayVariantFilename(record.storedFilename, size.edge),
        )
      ) {
        variants.push({
          contentUrl: API_ROUTES.mediaDisplayVariantById(record.id, size.edge),
          width: size.width,
          height: size.height,
        });
      }
    } catch {
      // The full-size route remains usable even if derivative storage fails.
    }
  }
  return variants;
};
