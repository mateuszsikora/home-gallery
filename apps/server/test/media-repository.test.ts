import { mediaRecordSchema } from '@home-gallery/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseConnection } from '../src/database/connection.js';
import {
  createMediaRepository,
  InvalidCursorError,
  type CreateMediaInput,
  type MediaRepository,
} from '../src/database/media-repository.js';
import { createMigratedDatabase } from './helpers.js';

const uploadInput = (
  index: number,
  overrides: Partial<CreateMediaInput> = {},
): CreateMediaInput => ({
  storedFilename: `photo-${index}.webp`,
  originalFilename: `photo-${index}.jpg`,
  mediaType: 'image',
  mimeType: 'image/webp',
  source: 'telegram',
  width: 1920,
  height: 1080,
  ...overrides,
});

describe('media repository', () => {
  let database: DatabaseConnection;
  let repository: MediaRepository;

  beforeEach(() => {
    database = createMigratedDatabase();
    repository = createMediaRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it('creates a record with generated defaults', () => {
    const record = repository.create(uploadInput(1));

    expect(mediaRecordSchema.parse(record)).toEqual(record);
    expect(record.enabled).toBe(true);
    expect(record.sortOrder).toBe(0);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(record.sourceId).toBeUndefined();
    expect(repository.findById(record.id)).toEqual(record);
  });

  it('appends new media to the end of the playlist', () => {
    repository.create(uploadInput(1));
    repository.create(uploadInput(2));

    expect(repository.create(uploadInput(3)).sortOrder).toBe(2);
    expect(repository.count()).toBe(3);
  });

  it('round-trips optional attribution', () => {
    const record = repository.create(
      uploadInput(1, { sourceId: '123456', authorName: 'Contributor' }),
    );

    expect(repository.findById(record.id)).toMatchObject({
      sourceId: '123456',
      authorName: 'Contributor',
    });
  });

  it('finds a record by its stored file name', () => {
    const record = repository.create(uploadInput(7));

    expect(repository.findByStoredFilename('photo-7.webp')).toEqual(record);
    expect(repository.findByStoredFilename('missing.webp')).toBeUndefined();
  });

  it('rejects a duplicate stored file name', () => {
    repository.create(uploadInput(1));

    expect(() => repository.create(uploadInput(1))).toThrow();
    expect(repository.count()).toBe(1);
  });

  it('paginates in playlist order', () => {
    const created = Array.from({ length: 5 }, (_unused, index) =>
      repository.create(uploadInput(index)),
    );

    const firstPage = repository.list({ limit: 2 });

    expect(firstPage.items.map((item) => item.id)).toEqual([
      created[0]?.id,
      created[1]?.id,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = repository.list({
      limit: 2,
      ...(firstPage.nextCursor === null
        ? {}
        : { cursor: firstPage.nextCursor }),
    });

    expect(secondPage.items.map((item) => item.id)).toEqual([
      created[2]?.id,
      created[3]?.id,
    ]);

    const lastPage = repository.list({
      limit: 2,
      ...(secondPage.nextCursor === null
        ? {}
        : { cursor: secondPage.nextCursor }),
    });

    expect(lastPage.items.map((item) => item.id)).toEqual([created[4]?.id]);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('caps the page size at the documented maximum', () => {
    for (let index = 0; index < 3; index += 1) {
      repository.create(uploadInput(index));
    }

    expect(repository.list({ limit: 1000 }).items).toHaveLength(3);
    expect(() => repository.list({ limit: 0 })).toThrow(RangeError);
  });

  it('rejects an unreadable cursor', () => {
    expect(() => repository.list({ cursor: 'not-a-cursor' })).toThrow(
      InvalidCursorError,
    );
  });

  it('lists only enabled media in playlist order', () => {
    const first = repository.create(uploadInput(1));
    const second = repository.create(uploadInput(2, { enabled: false }));
    const third = repository.create(uploadInput(3));

    expect(repository.listEnabled().map((item) => item.id)).toEqual([
      first.id,
      third.id,
    ]);
    expect(repository.findById(second.id)?.enabled).toBe(false);
  });

  it('updates the mutable fields only', () => {
    const record = repository.create(uploadInput(1));

    const updated = repository.update(record.id, {
      enabled: false,
      sortOrder: 7,
    });

    expect(updated).toMatchObject({
      id: record.id,
      enabled: false,
      sortOrder: 7,
      storedFilename: record.storedFilename,
    });
  });

  it('leaves a record untouched for an empty update', () => {
    const record = repository.create(uploadInput(1));

    expect(repository.update(record.id, {})).toEqual(record);
  });

  it('reports a missing record instead of creating one', () => {
    expect(
      repository.update('9f5a6f0e-6d2f-4d5e-9a2b-2b6a2c1d4e5f', {
        enabled: false,
      }),
    ).toBeUndefined();
    expect(
      repository.findById('9f5a6f0e-6d2f-4d5e-9a2b-2b6a2c1d4e5f'),
    ).toBeUndefined();
    expect(repository.count()).toBe(0);
  });

  it('rejects a negative sort order', () => {
    const record = repository.create(uploadInput(1));

    expect(() => repository.update(record.id, { sortOrder: -1 })).toThrow(
      RangeError,
    );
    expect(repository.findById(record.id)?.sortOrder).toBe(0);
  });

  it('deletes a record once', () => {
    const record = repository.create(uploadInput(1));

    expect(repository.delete(record.id)).toBe(true);
    expect(repository.delete(record.id)).toBe(false);
    expect(repository.findById(record.id)).toBeUndefined();
  });
});
