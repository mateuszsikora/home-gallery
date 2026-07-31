import { randomUUID } from 'node:crypto';

import {
  DEFAULT_MEDIA_LIST_LIMIT,
  MAX_MEDIA_LIST_LIMIT,
  mediaRecordSchema,
  type MediaId,
  type MediaListResponse,
  type MediaRecord,
  type MediaType,
  type NormalizedMediaMimeType,
  type UploadSource,
} from '@home-gallery/shared-types';

import type { DatabaseConnection } from './connection.js';

/** Raised when a client returns a cursor the server cannot interpret. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The pagination cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

export interface CreateMediaInput {
  id?: MediaId;
  storedFilename: string;
  originalFilename: string;
  mediaType: MediaType;
  mimeType: NormalizedMediaMimeType;
  uploadedAt?: string;
  source: UploadSource;
  sourceId?: string;
  authorName?: string;
  enabled?: boolean;
  /** Defaults to the end of the playlist. */
  sortOrder?: number;
  width: number;
  height: number;
}

/** An absent or explicitly undefined field means "leave this value unchanged". */
export interface MediaUpdate {
  enabled?: boolean | undefined;
  /**
   * Target position in playlist order. Positions are kept contiguous, so a
   * value beyond the end of the library moves the record to the last position.
   */
  sortOrder?: number | undefined;
}

export interface ListMediaOptions {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface MediaRepository {
  create(input: CreateMediaInput): MediaRecord;
  findById(id: MediaId): MediaRecord | undefined;
  findByStoredFilename(storedFilename: string): MediaRecord | undefined;
  list(options?: ListMediaOptions): MediaListResponse;
  listEnabled(): MediaRecord[];
  update(id: MediaId, update: MediaUpdate): MediaRecord | undefined;
  delete(id: MediaId): boolean;
  count(): number;
}

interface MediaRow {
  id: string;
  stored_filename: string;
  original_filename: string;
  media_type: string;
  mime_type: string;
  uploaded_at: string;
  source: string;
  source_id: string | null;
  author_name: string | null;
  enabled: number;
  sort_order: number;
  width: number;
  height: number;
}

/** Minimal projection used while rewriting playlist positions. */
interface OrderRow {
  id: string;
  sort_order: number;
}

const SELECT_COLUMNS = `
  id, stored_filename, original_filename, media_type, mime_type, uploaded_at,
  source, source_id, author_name, enabled, sort_order, width, height
`;

/**
 * Validates on read as well as on write so a hand-edited or partially restored
 * database surfaces as a server error instead of an API contract violation.
 */
const toRecord = (row: MediaRow): MediaRecord =>
  mediaRecordSchema.parse({
    id: row.id,
    storedFilename: row.stored_filename,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
    source: row.source,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.author_name === null ? {} : { authorName: row.author_name }),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
  });

interface CursorPosition {
  sortOrder: number;
  id: string;
}

const encodeCursor = (position: CursorPosition): string =>
  Buffer.from(`${position.sortOrder}:${position.id}`, 'utf8').toString(
    'base64url',
  );

const decodeCursor = (cursor: string): CursorPosition => {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');

  if (separator <= 0) {
    throw new InvalidCursorError();
  }

  const sortOrder = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || id.length === 0) {
    throw new InvalidCursorError();
  }

  return { sortOrder, id };
};

const normalizeLimit = (limit: number | undefined): number => {
  if (limit === undefined) {
    return DEFAULT_MEDIA_LIST_LIMIT;
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Media list limit must be a positive integer');
  }

  return Math.min(limit, MAX_MEDIA_LIST_LIMIT);
};

export const createMediaRepository = (
  database: DatabaseConnection,
): MediaRepository => {
  const insertStatement = database.prepare(`
    INSERT INTO media (
      id, stored_filename, original_filename, media_type, mime_type, uploaded_at,
      source, source_id, author_name, enabled, sort_order, width, height
    ) VALUES (
      @id, @storedFilename, @originalFilename, @mediaType, @mimeType, @uploadedAt,
      @source, @sourceId, @authorName, @enabled, @sortOrder, @width, @height
    )
  `);
  const selectByIdStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM media WHERE id = ?`,
  );
  const selectByFilenameStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM media WHERE stored_filename = ?`,
  );
  const selectFirstPageStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM media ORDER BY sort_order, id LIMIT ?`,
  );
  const selectAfterCursorStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM media
     WHERE (sort_order, id) > (?, ?)
     ORDER BY sort_order, id LIMIT ?`,
  );
  const selectEnabledStatement = database.prepare(
    `SELECT ${SELECT_COLUMNS} FROM media WHERE enabled = 1 ORDER BY sort_order, id`,
  );
  const selectOrderStatement = database.prepare(
    'SELECT id, sort_order FROM media ORDER BY sort_order, id',
  );
  const updateSortOrderStatement = database.prepare(
    'UPDATE media SET sort_order = ? WHERE id = ?',
  );
  const updateEnabledStatement = database.prepare(
    'UPDATE media SET enabled = ? WHERE id = ?',
  );
  const nextSortOrderStatement = database.prepare(
    'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM media',
  );
  const deleteStatement = database.prepare('DELETE FROM media WHERE id = ?');
  const countStatement = database.prepare(
    'SELECT COUNT(*) AS total FROM media',
  );

  const findById = (id: MediaId): MediaRecord | undefined => {
    const row = selectByIdStatement.get(id) as MediaRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  };

  const insert = database.transaction(
    (input: CreateMediaInput): MediaRecord => {
      const { next } = nextSortOrderStatement.get() as { next: number };

      const record = mediaRecordSchema.parse({
        id: input.id ?? randomUUID(),
        storedFilename: input.storedFilename,
        originalFilename: input.originalFilename,
        mediaType: input.mediaType,
        mimeType: input.mimeType,
        uploadedAt: input.uploadedAt ?? new Date().toISOString(),
        source: input.source,
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        ...(input.authorName === undefined
          ? {}
          : { authorName: input.authorName }),
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? next,
        width: input.width,
        height: input.height,
      });

      insertStatement.run({
        id: record.id,
        storedFilename: record.storedFilename,
        originalFilename: record.originalFilename,
        mediaType: record.mediaType,
        mimeType: record.mimeType,
        uploadedAt: record.uploadedAt,
        source: record.source,
        sourceId: record.sourceId ?? null,
        authorName: record.authorName ?? null,
        enabled: record.enabled ? 1 : 0,
        sortOrder: record.sortOrder,
        width: record.width,
        height: record.height,
      });

      return record;
    },
  );

  /**
   * Rewrites the playlist so positions are `0..n-1` without gaps or duplicates.
   * Only rows that actually move are written, which keeps a repeated update from
   * touching the whole table.
   */
  const writeContiguousOrder = (ordered: readonly OrderRow[]): void => {
    ordered.forEach((row, position) => {
      if (row.sort_order !== position) {
        updateSortOrderStatement.run(position, row.id);
      }
    });
  };

  const moveToPosition = (id: MediaId, position: number): void => {
    const rows = selectOrderStatement.all() as OrderRow[];
    const currentIndex = rows.findIndex((row) => row.id === id);
    const moved = rows[currentIndex];

    if (moved === undefined) {
      return;
    }

    rows.splice(currentIndex, 1);
    rows.splice(Math.min(position, rows.length), 0, moved);
    writeContiguousOrder(rows);
  };

  const applyUpdate = database.transaction(
    (id: MediaId, update: MediaUpdate): MediaRecord | undefined => {
      const existing = findById(id);

      if (existing === undefined) {
        return undefined;
      }

      if (update.enabled !== undefined) {
        updateEnabledStatement.run(update.enabled ? 1 : 0, id);
      }

      if (update.sortOrder !== undefined) {
        if (!Number.isSafeInteger(update.sortOrder) || update.sortOrder < 0) {
          throw new RangeError('Sort order must be a non-negative integer');
        }

        moveToPosition(id, update.sortOrder);
      }

      return findById(id);
    },
  );

  const removeRecord = database.transaction((id: MediaId): boolean => {
    if (deleteStatement.run(id).changes === 0) {
      return false;
    }

    // Closing the gap keeps the remaining positions meaningful as targets for a
    // later reorder.
    writeContiguousOrder(selectOrderStatement.all() as OrderRow[]);

    return true;
  });

  return {
    create: (input) => insert(input),

    findById,

    findByStoredFilename: (storedFilename) => {
      const row = selectByFilenameStatement.get(storedFilename) as
        MediaRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    list: (options = {}) => {
      const limit = normalizeLimit(options.limit);
      const rows = (
        options.cursor === undefined
          ? selectFirstPageStatement.all(limit + 1)
          : (() => {
              const position = decodeCursor(options.cursor);
              return selectAfterCursorStatement.all(
                position.sortOrder,
                position.id,
                limit + 1,
              );
            })()
      ) as MediaRow[];

      const page = rows.slice(0, limit).map(toRecord);
      const last = page.at(-1);

      return {
        items: page,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last) : null,
      };
    },

    listEnabled: () =>
      (selectEnabledStatement.all() as MediaRow[]).map(toRecord),

    update: (id, update) => applyUpdate(id, update),

    delete: (id) => removeRecord(id),

    count: () => (countStatement.get() as { total: number }).total,
  };
};
