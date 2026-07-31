import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidImageError,
  normalizeImage,
  UnsupportedImageFormatError,
} from '../src/media/image-normalizer.js';
import {
  createTemporaryDataDirectory,
  removeTemporaryDataDirectory,
} from './helpers.js';

const HEIC_FIXTURE_BASE64 =
  'AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAAB7W1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAABEGlwcnAAAADuaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAEAAAAAgAAAChjbGFwAAAAAwAAAAEAAAACAAAAAf/AAAAAgAAAAAAAAAAAAAEAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcmh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAJEIBAQNwAAADALAAAAMAAAMAHqAUIEHAnwQYh7kWVTcCAgYAgKIAAQAJRAHAYXLIRFNkAAAAGmlwbWEAAAAAAAAAAQABB4ECAwaHhIUAAAAsaWxvYwAAAABEAAACAAEAAAABAAACYQAAAF0AAgAAAAEAAAIVAAAATAAAAAFtZGF0AAAAAAAAALkAAAAGRXhpZgAATU0AKgAAAAgAAwEaAAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAWSgBr6NfGl/pGCdAa0BugKE2Ci5P/kfZYnnP/9Y2OSU/TvYjnLB55+kXL3fEv+/9MnaOUDJQPUsY6f/tn+b/Ty6GqEegTwNux28K1rU98f95/5GEyra/SXXA';

describe('image normalization', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await createTemporaryDataDirectory();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(directory);
  });

  const sourceImage = () =>
    sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: { r: 20, g: 80, b: 160, alpha: 0.75 },
      },
    });

  it.each([
    ['JPEG', 'jpeg', (path: string) => sourceImage().jpeg().toFile(path)],
    ['PNG', 'png', (path: string) => sourceImage().png().toFile(path)],
    ['WebP', 'webp', (path: string) => sourceImage().webp().toFile(path)],
  ])(
    'normalizes verified %s content to WebP',
    async (_name, extension, save) => {
      const input = join(directory, `input.${extension}`);
      const output = join(directory, `${extension}.part`);
      await save(input);

      await expect(normalizeImage(input, output)).resolves.toEqual({
        width: 12,
        height: 8,
      });

      const metadata = await sharp(await readFile(output)).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBe(12);
      expect(metadata.height).toBe(8);
    },
  );

  it.each([
    ['HEIC', 'heic', 'heic'],
    ['HEIF', 'heif', 'mif1'],
  ])(
    'decodes and normalizes %s when the bundled Sharp decoder cannot',
    async (_name, extension, majorBrand) => {
      const input = join(directory, `input.${extension}`);
      const output = join(directory, `${extension}.part`);
      const bytes = Buffer.from(HEIC_FIXTURE_BASE64, 'base64');
      bytes.write(majorBrand, 8, 4, 'ascii');
      await writeFile(input, bytes);

      await expect(normalizeImage(input, output)).resolves.toEqual({
        width: 3,
        height: 2,
      });

      expect((await sharp(output).metadata()).format).toBe('webp');
    },
  );

  it('applies EXIF orientation and removes it from the normalized output', async () => {
    const input = join(directory, 'rotated.jpg');
    const output = join(directory, 'rotated.part');
    await sourceImage().jpeg().withMetadata({ orientation: 6 }).toFile(input);

    await expect(normalizeImage(input, output)).resolves.toEqual({
      width: 8,
      height: 12,
    });

    const metadata = await sharp(output).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(12);
  });

  it('rejects a valid image format outside the upload allowlist', async () => {
    const input = join(directory, 'animated.gif');
    const output = join(directory, 'unsupported.part');
    await sourceImage().gif().toFile(input);

    await expect(normalizeImage(input, output)).rejects.toThrow(
      UnsupportedImageFormatError,
    );
  });

  it('rejects corrupt data without leaving normalized output', async () => {
    const input = join(directory, 'corrupt.jpg');
    const output = join(directory, 'corrupt.part');
    await writeFile(input, 'not an image');

    await expect(normalizeImage(input, output)).rejects.toThrow(
      InvalidImageError,
    );
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
