import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import type { MultipartFile } from '@fastify/multipart';
import {
  API_ROUTES,
  mediaUploadMetadataSchema,
  toApiErrorIssues,
  type MediaRecord,
  type MediaUploadMetadata,
} from '@home-gallery/shared-types';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  InvalidImageError,
  normalizeImage,
  UnsupportedImageFormatError,
} from '../media/image-normalizer.js';
import type { TemporaryMediaFile } from '../storage/media-storage.js';
import { ApiError } from './errors.js';

const FILE_FIELD_NAME = 'file';

interface ParsedUpload {
  metadata: MediaUploadMetadata;
  uploadedFile: TemporaryMediaFile;
}

const validationError = (
  message: string,
  path: string,
  issueMessage: string,
): ApiError =>
  new ApiError('validation_failed', message, [{ path, message: issueMessage }]);

const saveFilePart = async (
  app: FastifyInstance,
  part: MultipartFile,
): Promise<TemporaryMediaFile> => {
  const temporary = await app.mediaStorage.createTemporaryFile();

  try {
    await pipeline(
      part.file,
      createWriteStream(temporary.path, { flags: 'wx', mode: 0o600 }),
    );

    if (part.file.truncated) {
      throw new ApiError(
        'payload_too_large',
        `The uploaded file exceeds the ${app.config.maxUploadBytes} byte limit`,
      );
    }

    return temporary;
  } catch (error) {
    await temporary.discard();
    throw error;
  }
};

const parseUpload = async (
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<ParsedUpload> => {
  const fields: Record<string, unknown> = {};
  let uploadedFile: TemporaryMediaFile | undefined;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== FILE_FIELD_NAME || uploadedFile !== undefined) {
          part.file.resume();
          throw validationError(
            'Invalid media upload',
            part.fieldname,
            `Exactly one file field named "${FILE_FIELD_NAME}" is required`,
          );
        }

        uploadedFile = await saveFilePart(app, part);
        continue;
      }

      if (Object.hasOwn(fields, part.fieldname)) {
        throw validationError(
          'Invalid upload metadata',
          part.fieldname,
          'Must be provided only once',
        );
      }

      if (part.valueTruncated || typeof part.value !== 'string') {
        throw validationError(
          'Invalid upload metadata',
          part.fieldname,
          'Must be an untruncated text value',
        );
      }

      fields[part.fieldname] = part.value;
    }

    if (uploadedFile === undefined) {
      throw validationError(
        'Invalid media upload',
        FILE_FIELD_NAME,
        'A file is required',
      );
    }

    const parsedMetadata = mediaUploadMetadataSchema.safeParse(fields);

    if (!parsedMetadata.success) {
      throw new ApiError(
        'validation_failed',
        'Invalid upload metadata',
        toApiErrorIssues(parsedMetadata.error),
      );
    }

    return { metadata: parsedMetadata.data, uploadedFile };
  } catch (error) {
    await uploadedFile?.discard();
    throw error;
  }
};

const toImageApiError = (error: unknown): ApiError => {
  if (error instanceof UnsupportedImageFormatError) {
    return new ApiError('unsupported_media_type', error.message);
  }

  if (error instanceof InvalidImageError) {
    return new ApiError('validation_failed', error.message, [
      { path: FILE_FIELD_NAME, message: error.message },
    ]);
  }

  throw error;
};

export const registerMediaUploadRoute = (app: FastifyInstance): void => {
  let reservedUploads = 0;

  app.post(
    API_ROUTES.media,
    { onRequest: app.requireBearerToken },
    async (request, reply) => {
      if (
        app.mediaRepository.count() + reservedUploads >=
        app.config.maxStoredFiles
      ) {
        throw new ApiError(
          'conflict',
          `The media library has reached its ${app.config.maxStoredFiles} file limit`,
        );
      }

      reservedUploads += 1;

      let uploadedFile: TemporaryMediaFile | undefined;
      let normalizedFile: TemporaryMediaFile | undefined;
      try {
        const parsed = await parseUpload(app, request);
        uploadedFile = parsed.uploadedFile;
        normalizedFile = await app.mediaStorage.createTemporaryFile();

        let dimensions;

        try {
          dimensions = await normalizeImage(
            uploadedFile.path,
            normalizedFile.path,
          );
        } catch (error) {
          throw toImageApiError(error);
        }

        const id = randomUUID();
        const storedFilename = `${id}.webp`;

        try {
          await normalizedFile.commit(storedFilename);
        } catch (error) {
          await app.mediaStorage.remove(storedFilename);
          throw error;
        }

        let record: MediaRecord;

        try {
          record = app.mediaRepository.create({
            id,
            storedFilename,
            originalFilename: parsed.metadata.originalFilename,
            mediaType: 'image',
            mimeType: 'image/webp',
            source: parsed.metadata.source,
            ...(parsed.metadata.sourceId === undefined
              ? {}
              : { sourceId: parsed.metadata.sourceId }),
            ...(parsed.metadata.authorName === undefined
              ? {}
              : { authorName: parsed.metadata.authorName }),
            width: dimensions.width,
            height: dimensions.height,
          });
        } catch (error) {
          await app.mediaStorage.remove(storedFilename);
          throw error;
        }

        return await reply.status(201).send(record);
      } finally {
        reservedUploads -= 1;
        await Promise.all([uploadedFile?.discard(), normalizedFile?.discard()]);
      }
    },
  );
};
