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
    const first = repository.create(uploadInput(1));
    repository.create(uploadInput(2));

    const updated = repository.update(first.id, {
      enabled: false,
      sortOrder: 1,
    });

    expect(updated).toMatchObject({
      id: first.id,
      enabled: false,
      sortOrder: 1,
      storedFilename: first.storedFilename,
    });
  });

  it('moves a record to the requested position and closes the gap', () => {
    const first = repository.create(uploadInput(1));
    const second = repository.create(uploadInput(2));
    const third = repository.create(uploadInput(3));
    const fourth = repository.create(uploadInput(4));

    repository.update(fourth.id, { sortOrder: 1 });

    expect(repository.list().items).toMatchObject([
      { id: first.id, sortOrder: 0 },
      { id: fourth.id, sortOrder: 1 },
      { id: second.id, sortOrder: 2 },
      { id: third.id, sortOrder: 3 },
    ]);
  });

  it('moves a record to the end when the position is past the last one', () => {
    const first = repository.create(uploadInput(1));
    const second = repository.create(uploadInput(2));
    const third = repository.create(uploadInput(3));

    expect(repository.update(first.id, { sortOrder: 999 })?.sortOrder).toBe(2);
    expect(repository.list().items.map((item) => item.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
  });

  it('keeps the playlist stable when the same move is repeated', () => {
    repository.create(uploadInput(1));
    repository.create(uploadInput(2));
    const third = repository.create(uploadInput(3));

    repository.update(third.id, { sortOrder: 0 });
    const afterFirstMove = repository.list().items;
    repository.update(third.id, { sortOrder: 0 });

    expect(repository.list().items).toEqual(afterFirstMove);
  });

  it('renumbers the remaining media after a deletion', () => {
    const first = repository.create(uploadInput(1));
    repository.create(uploadInput(2));
    repository.create(uploadInput(3));

    repository.delete(first.id);

    expect(repository.list().items.map((item) => item.sortOrder)).toEqual([
      0, 1,
    ]);
    expect(repository.create(uploadInput(4)).sortOrder).toBe(2);
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
