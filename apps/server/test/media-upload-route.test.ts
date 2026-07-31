import { randomBytes } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  API_ROUTES,
  apiErrorBodySchema,
  mediaRecordSchema,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
  TEST_API_TOKEN,
} from './helpers.js';

interface MultipartField {
  name: string;
  value: string;
}

interface MultipartFile {
  bytes: Buffer;
  fieldName?: string;
  filename?: string;
  mimeType?: string;
  first?: boolean;
}

const multipartBody = (
  fields: readonly MultipartField[],
  file?: MultipartFile,
): { boundary: string; payload: Buffer } => {
  const boundary = 'home-gallery-test-boundary';
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => {
    chunks.push(typeof value === 'string' ? Buffer.from(value) : value);
  };

  const appendFile = () => {
    if (file === undefined) {
      return;
    }

    append(`--${boundary}\r\n`);
    append(
      `Content-Disposition: form-data; name="${file.fieldName ?? 'file'}"; filename="${file.filename ?? 'upload.bin'}"\r\n`,
    );
    append(
      `Content-Type: ${file.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
    );
    append(file.bytes);
    append('\r\n');
  };

  if (file?.first) {
    appendFile();
  }

  for (const field of fields) {
    append(`--${boundary}\r\n`);
    append(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n`);
    append(field.value);
    append('\r\n');
  }

  if (file !== undefined && !file.first) {
    appendFile();
  }

  append(`--${boundary}--\r\n`);

  return { boundary, payload: Buffer.concat(chunks) };
};

const validFields = (
  overrides: Partial<
    Record<'originalFilename' | 'source' | 'sourceId' | 'authorName', string>
  > = {},
): MultipartField[] =>
  Object.entries({
    originalFilename: 'family-photo.png',
    source: 'telegram',
    sourceId: '123456',
    authorName: 'Gallery contributor',
    ...overrides,
  }).map(([name, value]) => ({ name, value }));

const createImage = (
  format: 'gif' | 'jpeg' | 'png' | 'webp' = 'png',
): Promise<Buffer> => {
  const image = sharp({
    create: {
      width: 16,
      height: 9,
      channels: 3,
      background: { r: 15, g: 90, b: 180 },
    },
  });

  return image[format]().toBuffer();
};

describe('POST /api/media', () => {
  let dataDirectory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    app = await createApp(createTestConfig(dataDirectory));
  });

  afterEach(async () => {
    await app.close();
    await removeTemporaryDataDirectory(dataDirectory);
  });

  const upload = async (
    fields: readonly MultipartField[],
    file?: MultipartFile,
    token: string | null = TEST_API_TOKEN,
  ) => {
    const { boundary, payload } = multipartBody(fields, file);

    return app.inject({
      method: 'POST',
      url: API_ROUTES.media,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      payload,
    });
  };

  const expectEmptyStorage = async () => {
    expect(await readdir(app.mediaStorage.mediaDirectory)).toEqual([]);
    expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
    expect(app.mediaRepository.count()).toBe(0);
  };

  it('stores a verified image as normalized WebP and returns its metadata', async () => {
    const response = await upload(validFields(), {
      bytes: await createImage('png'),
      filename: 'untrusted-name.jpg',
      mimeType: 'image/jpeg',
      first: true,
    });

    expect(response.statusCode).toBe(201);
    const record = mediaRecordSchema.parse(response.json());
    expect(record).toMatchObject({
      originalFilename: 'family-photo.png',
      mediaType: 'image',
      mimeType: 'image/webp',
      source: 'telegram',
      sourceId: '123456',
      authorName: 'Gallery contributor',
      enabled: true,
      sortOrder: 0,
      width: 16,
      height: 9,
    });
    expect(record.storedFilename).toBe(`${record.id}.webp`);
    expect(app.mediaRepository.findById(record.id)).toEqual(record);

    const storedPath = app.mediaStorage.resolveMediaPath(record.storedFilename);
    const metadata = await sharp(await readFile(storedPath)).metadata();
    expect(metadata.format).toBe('webp');
    expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
  });

  it('trusts verified bytes instead of the claimed filename or content type', async () => {
    const escapedName = `escaped-${crypto.randomUUID()}.png`;
    const escapedPath = join(dataDirectory, '..', escapedName);
    const response = await upload(
      validFields({ originalFilename: `../../${escapedName}`, source: 'api' }),
      {
        bytes: await createImage('webp'),
        filename: '../../not-an-image.txt',
        mimeType: 'text/plain',
      },
    );

    expect(response.statusCode).toBe(201);
    const record = mediaRecordSchema.parse(response.json());
    expect(record.mimeType).toBe('image/webp');
    expect(record.storedFilename).toMatch(/^[0-9a-f-]+\.webp$/u);
    await expect(access(escapedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the request before reading media when authorization is missing', async () => {
    const response = await upload(
      validFields(),
      { bytes: await createImage() },
      null,
    );

    expect(response.statusCode).toBe(401);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'unauthorized',
    );
    await expectEmptyStorage();
  });

  it('rejects missing or invalid upload metadata and removes temporary files', async () => {
    const response = await upload(validFields({ source: 'unknown-source' }), {
      bytes: await createImage(),
    });

    expect(response.statusCode).toBe(422);
    const body = apiErrorBodySchema.parse(response.json());
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues).toContainEqual(
      expect.objectContaining({ path: 'source' }),
    );
    await expectEmptyStorage();
  });

  it('requires exactly one file field', async () => {
    const response = await upload(validFields());

    expect(response.statusCode).toBe(422);
    expect(apiErrorBodySchema.parse(response.json()).error).toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'file' }],
    });
    await expectEmptyStorage();
  });

  it('rejects supported-by-Sharp formats outside the upload allowlist', async () => {
    const response = await upload(validFields(), {
      bytes: await createImage('gif'),
      filename: 'animation.gif',
      mimeType: 'image/gif',
    });

    expect(response.statusCode).toBe(415);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'unsupported_media_type',
    );
    await expectEmptyStorage();
  });

  it('rejects corrupt image data with a stable validation error', async () => {
    const response = await upload(validFields(), {
      bytes: Buffer.from('corrupt image data'),
      filename: 'corrupt.jpg',
      mimeType: 'image/jpeg',
    });

    expect(response.statusCode).toBe(422);
    expect(apiErrorBodySchema.parse(response.json()).error).toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'file' }],
    });
    await expectEmptyStorage();
  });

  it('enforces the configured byte limit and cleans up a partial upload', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, { maxUploadBytes: 50 }),
    );

    const response = await upload(validFields(), {
      bytes: await createImage('png'),
      filename: 'too-large.png',
      mimeType: 'image/png',
    });

    expect(response.statusCode).toBe(413);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'payload_too_large',
    );
    await expectEmptyStorage();
  });

  it("streams files larger than Fastify's default one-megabyte body limit", async () => {
    const width = 640;
    const height = 640;
    const bytes = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(1024 * 1024);

    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, { maxUploadBytes: bytes.length + 1 }),
    );

    const response = await upload(validFields(), {
      bytes,
      filename: 'large.png',
      mimeType: 'image/png',
    });

    expect(response.statusCode).toBe(201);
    expect(mediaRecordSchema.parse(response.json())).toMatchObject({
      width,
      height,
    });
  });

  it('rejects uploads when the configured stored-file limit is exhausted', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, { maxStoredFiles: 1 }),
    );
    const file = { bytes: await createImage(), filename: 'photo.png' };

    expect((await upload(validFields(), file)).statusCode).toBe(201);
    const response = await upload(validFields(), file);

    expect(response.statusCode).toBe(409);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'conflict',
    );
    expect(app.mediaRepository.count()).toBe(1);
    expect(await readdir(app.mediaStorage.mediaDirectory)).toHaveLength(1);
    expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
  });

  it('reserves capacity across concurrent uploads', async () => {
    await app.close();
    app = await createApp(
      createTestConfig(dataDirectory, { maxStoredFiles: 1 }),
    );
    const file = { bytes: await createImage('jpeg'), filename: 'photo.jpg' };

    const responses = await Promise.all([
      upload(validFields(), file),
      upload(validFields(), file),
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(app.mediaRepository.count()).toBe(1);
    expect(await readdir(app.mediaStorage.mediaDirectory)).toHaveLength(1);
    expect(await readdir(app.mediaStorage.temporaryDirectory)).toEqual([]);
  });

  it('removes the normalized file when the database write fails', async () => {
    vi.spyOn(app.mediaRepository, 'create').mockImplementation(() => {
      throw new Error('simulated database failure');
    });

    const response = await upload(validFields(), {
      bytes: await createImage(),
      filename: 'photo.png',
    });

    expect(response.statusCode).toBe(500);
    expect(apiErrorBodySchema.parse(response.json()).error.code).toBe(
      'internal_error',
    );
    await expectEmptyStorage();
  });
});
