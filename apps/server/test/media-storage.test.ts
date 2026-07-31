import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMediaStorage,
  MEDIA_DIRECTORY_NAME,
  TEMPORARY_DIRECTORY_NAME,
  UnsafeStoredFilenameError,
  type MediaStorage,
} from '../src/storage/media-storage.js';
import {
  createTemporaryDataDirectory,
  removeTemporaryDataDirectory,
} from './helpers.js';

describe('media storage', () => {
  let dataDirectory: string;
  let storage: MediaStorage;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
    storage = createMediaStorage(dataDirectory);
    await storage.initialize();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(dataDirectory);
  });

  it('creates the media and temporary directories', async () => {
    expect(
      (await stat(join(dataDirectory, MEDIA_DIRECTORY_NAME))).isDirectory(),
    ).toBe(true);
    expect(
      (await stat(join(dataDirectory, TEMPORARY_DIRECTORY_NAME))).isDirectory(),
    ).toBe(true);
  });

  it('writes outside the media directory until the upload is committed', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'image-bytes');

    expect(temporary.path.startsWith(storage.temporaryDirectory)).toBe(true);
    expect(await readdir(storage.mediaDirectory)).toEqual([]);

    const target = await temporary.commit('committed.webp');

    expect(target).toBe(join(storage.mediaDirectory, 'committed.webp'));
    expect(await readdir(storage.mediaDirectory)).toEqual(['committed.webp']);
    expect(await readdir(storage.temporaryDirectory)).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('image-bytes');
  });

  it('leaves nothing behind when an upload is discarded', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'partial');
    await temporary.discard();

    expect(await readdir(storage.temporaryDirectory)).toEqual([]);
    expect(await readdir(storage.mediaDirectory)).toEqual([]);
  });

  it('allows discard to run after a successful commit', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'image-bytes');
    await temporary.commit('kept.webp');
    await temporary.discard();

    expect(await readdir(storage.mediaDirectory)).toEqual(['kept.webp']);
  });

  it('refuses to commit twice', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'image-bytes');
    await temporary.commit('once.webp');

    await expect(temporary.commit('twice.webp')).rejects.toThrow();
  });

  it('tolerates discarding an upload that never wrote a file', async () => {
    const temporary = await storage.createTemporaryFile();

    await expect(temporary.discard()).resolves.toBeUndefined();
  });

  it.each(['../escape.webp', 'nested/file.webp', '..', '.hidden.webp', ''])(
    'rejects the unsafe stored file name %j',
    async (storedFilename) => {
      expect(() => storage.resolveMediaPath(storedFilename)).toThrow(
        UnsafeStoredFilenameError,
      );
      await expect(storage.remove(storedFilename)).rejects.toThrow(
        UnsafeStoredFilenameError,
      );
    },
  );

  it('reports whether a stored file exists', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'image-bytes');
    await temporary.commit('present.webp');

    expect(await storage.exists('present.webp')).toBe(true);
    expect(await storage.exists('absent.webp')).toBe(false);
  });

  it('removes a stored file at most once', async () => {
    const temporary = await storage.createTemporaryFile();

    await writeFile(temporary.path, 'image-bytes');
    await temporary.commit('removable.webp');

    expect(await storage.remove('removable.webp')).toBe(true);
    expect(await storage.remove('removable.webp')).toBe(false);
  });

  it('prunes leftovers from interrupted uploads', async () => {
    const first = await storage.createTemporaryFile();
    const second = await storage.createTemporaryFile();

    await writeFile(first.path, 'partial');
    await writeFile(second.path, 'partial');

    expect(await storage.pruneTemporaryFiles()).toBe(2);
    expect(await readdir(storage.temporaryDirectory)).toEqual([]);
    expect(await storage.pruneTemporaryFiles()).toBe(0);
  });
});
