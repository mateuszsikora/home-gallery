import { readFile } from 'node:fs/promises';

import sharp, { type Metadata, type OutputInfo } from 'sharp';

/** Keep decompression bombs from exhausting a modest self-hosted machine. */
export const MAX_INPUT_PIXELS = 100_000_000;

const SUPPORTED_SHARP_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

export class UnsupportedImageFormatError extends Error {
  constructor(format: string | undefined) {
    super(
      format === undefined
        ? 'The uploaded file is not a supported image'
        : `The uploaded ${format.toUpperCase()} image format is not supported`,
    );
    this.name = 'UnsupportedImageFormatError';
  }
}

export class InvalidImageError extends Error {
  constructor(options?: ErrorOptions) {
    super('The uploaded file is not a valid image', options);
    this.name = 'InvalidImageError';
  }
}

export interface NormalizedImage {
  width: number;
  height: number;
}

const inspectImage = async (inputPath: string): Promise<Metadata> => {
  try {
    return await sharp(inputPath, {
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch (error) {
    throw new InvalidImageError({ cause: error });
  }
};

const assertSupportedImage = (metadata: Metadata): void => {
  if (!SUPPORTED_SHARP_FORMATS.has(metadata.format)) {
    throw new UnsupportedImageFormatError(metadata.format);
  }

  const { width, height } = metadata.autoOrient;

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_INPUT_PIXELS
  ) {
    throw new InvalidImageError();
  }
};

const normalizeWithSharp = (
  inputPath: string,
  outputPath: string,
): Promise<OutputInfo> =>
  sharp(inputPath, {
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .autoOrient()
    .toColourspace('srgb')
    .webp({ effort: 4, quality: 85 })
    .toFile(outputPath);

/**
 * Sharp's prebuilt libvips can identify HEIC/HEIF but cannot decode its
 * patent-encumbered HEVC payload. A bounded WASM decoder provides that input
 * fallback; Sharp still performs the WebP encoding used by the application.
 */
const normalizeHeifFallback = async (
  inputPath: string,
  outputPath: string,
): Promise<OutputInfo> => {
  const [{ default: decodeHeic }, input] = await Promise.all([
    import('heic-decode'),
    readFile(inputPath),
  ]);
  const decoded = await decodeHeic({ buffer: input });

  if (
    !Number.isSafeInteger(decoded.width) ||
    !Number.isSafeInteger(decoded.height) ||
    decoded.width <= 0 ||
    decoded.height <= 0 ||
    decoded.width * decoded.height > MAX_INPUT_PIXELS
  ) {
    throw new InvalidImageError();
  }

  return sharp(Buffer.from(decoded.data), {
    raw: {
      width: decoded.width,
      height: decoded.height,
      channels: 4,
    },
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .toColourspace('srgb')
    .webp({ effort: 4, quality: 85 })
    .toFile(outputPath);
};

/** Verifies an uploaded image, applies its orientation, and writes WebP. */
export const normalizeImage = async (
  inputPath: string,
  outputPath: string,
): Promise<NormalizedImage> => {
  const metadata = await inspectImage(inputPath);
  assertSupportedImage(metadata);

  let output: OutputInfo;

  try {
    output = await normalizeWithSharp(inputPath, outputPath);
  } catch (sharpError) {
    if (metadata.format !== 'heif') {
      throw new InvalidImageError({ cause: sharpError });
    }

    try {
      output = await normalizeHeifFallback(inputPath, outputPath);
    } catch (fallbackError) {
      throw new InvalidImageError({ cause: fallbackError });
    }
  }

  return { width: output.width, height: output.height };
};
