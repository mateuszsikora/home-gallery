import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseConnection } from '../src/database/connection.js';
import {
  createTelegramContributorRepository,
  type TelegramContributorRepository,
} from '../src/database/telegram-contributor-repository.js';
import { createMigratedDatabase } from './helpers.js';

describe('telegram contributor repository', () => {
  let database: DatabaseConnection;
  let repository: TelegramContributorRepository;
  let clock: Date;

  beforeEach(() => {
    database = createMigratedDatabase();
    clock = new Date('2026-08-01T10:00:00.000Z');
    repository = createTelegramContributorRepository(database, () => clock);
  });

  afterEach(() => {
    database.close();
  });

  it('records a first contact as a pending request', () => {
    const contributor = repository.register({
      telegramUserId: '123',
      firstName: 'Ada',
      username: 'ada',
    });

    expect(contributor).toEqual({
      telegramUserId: '123',
      status: 'pending',
      firstName: 'Ada',
      username: 'ada',
      requestedAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
  });

  it('keeps one record and the original request time across repeated contacts', () => {
    repository.register({ telegramUserId: '123', firstName: 'Ada' });
    clock = new Date('2026-08-02T10:00:00.000Z');

    const refreshed = repository.register({
      telegramUserId: '123',
      firstName: 'Ada',
    });

    expect(refreshed.requestedAt).toBe('2026-08-01T10:00:00.000Z');
    // An unchanged identity must not move the timestamp that tells the
    // administrator when the record last really changed.
    expect(refreshed.updatedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(repository.list()).toHaveLength(1);
  });

  it('replaces identity fields Telegram no longer reports', () => {
    repository.register({
      telegramUserId: '123',
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
    });
    clock = new Date('2026-08-02T10:00:00.000Z');

    const refreshed = repository.register({
      telegramUserId: '123',
      firstName: 'Ada',
    });

    expect(refreshed).toMatchObject({
      firstName: 'Ada',
      updatedAt: '2026-08-02T10:00:00.000Z',
    });
    expect(refreshed.lastName).toBeUndefined();
    expect(refreshed.username).toBeUndefined();
  });

  it('never changes a decided status through a later contact', () => {
    repository.register({ telegramUserId: '123', firstName: 'Ada' });
    repository.decide('123', 'approved');

    expect(
      repository.register({ telegramUserId: '123', firstName: 'Ada' }).status,
    ).toBe('approved');
  });

  it('approves and rejects an existing contributor', () => {
    repository.register({ telegramUserId: '123', firstName: 'Ada' });
    clock = new Date('2026-08-03T10:00:00.000Z');

    expect(repository.decide('123', 'approved')).toMatchObject({
      status: 'approved',
      updatedAt: '2026-08-03T10:00:00.000Z',
    });
    expect(repository.decide('123', 'rejected')?.status).toBe('rejected');
    expect(repository.findByTelegramUserId('123')?.status).toBe('rejected');
  });

  it('reports an unknown contributor instead of creating one', () => {
    expect(repository.decide('404', 'approved')).toBeUndefined();
    expect(repository.findByTelegramUserId('404')).toBeUndefined();
    expect(repository.list()).toEqual([]);
  });

  it('lists pending requests first and the newest request within a group', () => {
    repository.register({ telegramUserId: '1' });
    clock = new Date('2026-08-02T10:00:00.000Z');
    repository.register({ telegramUserId: '2' });
    clock = new Date('2026-08-03T10:00:00.000Z');
    repository.register({ telegramUserId: '3' });
    repository.decide('1', 'approved');
    repository.decide('3', 'rejected');

    expect(repository.list().map((item) => item.telegramUserId)).toEqual([
      '2',
      '1',
      '3',
    ]);
  });

  it('reads back what an earlier process wrote', () => {
    repository.register({ telegramUserId: '123', firstName: 'Ada' });
    repository.decide('123', 'approved');

    const reopened = createTelegramContributorRepository(database);

    expect(reopened.findByTelegramUserId('123')).toMatchObject({
      status: 'approved',
      firstName: 'Ada',
    });
  });
});
