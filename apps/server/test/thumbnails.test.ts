import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createThumbnail,
  THUMBNAIL_MAX_EDGE,
  thumbnailFilename,
} from '../src/media/thumbnails.js';
import {
  createTemporaryDataDirectory,
  removeTemporaryDataDirectory,
} from './helpers.js';

describe('thumbnailFilename', () => {
  it('names the derivative next to the file it came from', () => {
    expect(thumbnailFilename('7f1c9f0e-1c2b-4a4f-9f2c-8f5a1d1c0f9b.webp')).toBe(
      '7f1c9f0e-1c2b-4a4f-9f2c-8f5a1d1c0f9b.thumb.webp',
    );
  });

  it('accepts a stored name without an extension', () => {
    expect(thumbnailFilename('stored-image')).toBe('stored-image.thumb.webp');
  });
});

describe('createThumbnail', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTemporaryDataDirectory();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(directory);
  });

  const writeSource = async (
    width: number,
    height: number,
  ): Promise<string> => {
    const path = join(directory, `source-${width}x${height}.webp`);
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .webp()
      .toFile(path);

    return path;
  };

  it('bounds the longest edge and keeps the aspect ratio', async () => {
    const source = await writeSource(4_000, 3_000);
    const output = join(directory, 'landscape.thumb.webp');

    await createThumbnail(source, output);

    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(THUMBNAIL_MAX_EDGE);
    expect(metadata.height).toBe(360);
  });

  it('bounds the longest edge of a portrait image as well', async () => {
    const source = await writeSource(1_500, 3_000);
    const output = join(directory, 'portrait.thumb.webp');

    await createThumbnail(source, output);

    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(240);
    expect(metadata.height).toBe(THUMBNAIL_MAX_EDGE);
  });

  it('never enlarges an image that is already small', async () => {
    const source = await writeSource(120, 90);
    const output = join(directory, 'small.thumb.webp');

    await createThumbnail(source, output);

    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(120);
    expect(metadata.height).toBe(90);
  });
});
