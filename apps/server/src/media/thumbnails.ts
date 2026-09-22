import sharp from 'sharp';

import { MAX_INPUT_PIXELS } from './image-normalizer.js';

/**
 * Longest edge of an administration thumbnail. The administration card shows it
 * in a box a few hundred pixels wide, so this is already more than a retina
 * display can use and keeps a card from downloading a full camera photograph.
 */
export const THUMBNAIL_MAX_EDGE = 480;

/** Distinguishes a derivative from the normalized image it was made from. */
export const THUMBNAIL_FILENAME_SUFFIX = '.thumb.webp';

/**
 * Derives the thumbnail name from a stored file name. Stored names are server
 * generated and unique, so the derived name is unique as well and needs no
 * separate bookkeeping: the file either exists next to the original or it does
 * not.
 */
export const thumbnailFilename = (storedFilename: string): string =>
  `${storedFilename.replace(/\.[^.]+$/u, '')}${THUMBNAIL_FILENAME_SUFFIX}`;

/**
 * Writes a downscaled copy of an already normalized image. The source has its
 * orientation applied and is in sRGB, so this only has to resize and encode.
 * Images smaller than the bound are copied at their own size rather than
 * enlarged, because a card cannot show more than the original holds.
 */
export const createThumbnail = async (
  sourcePath: string,
  outputPath: string,
): Promise<void> => {
  await sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize({
      width: THUMBNAIL_MAX_EDGE,
      height: THUMBNAIL_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality: 80 })
    .toFile(outputPath);
};
