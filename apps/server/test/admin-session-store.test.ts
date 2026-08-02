import { describe, expect, it } from 'vitest';

import {
  AdminSessionStore,
  hashAdminSessionToken,
} from '../src/http/admin-session-store.js';

describe('AdminSessionStore', () => {
  it('stores only a digest and expires sessions on the server clock', () => {
    let now = 1_000;
    const store = new AdminSessionStore(
      { max: 4, secure: false, ttlMs: 500 },
      () => now,
    );
    const created = store.create();

    expect(created.token).toMatch(/^[\w-]{43}$/u);
    expect(hashAdminSessionToken(created.token)).not.toBe(created.token);
    expect(store.read(created.token)).toEqual({ expiresAt: 1_500 });

    now = 1_500;
    expect(store.read(created.token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('evicts the oldest live session when the bounded capacity is reached', () => {
    let now = 1_000;
    const store = new AdminSessionStore(
      { max: 2, secure: false, ttlMs: 10_000 },
      () => now,
    );
    const first = store.create();
    now += 1;
    const second = store.create();
    now += 1;
    const third = store.create();

    expect(store.size).toBe(2);
    expect(store.read(first.token)).toBeUndefined();
    expect(store.read(second.token)).toBeDefined();
    expect(store.read(third.token)).toBeDefined();
  });

  it('deletes a session without accepting a different token', () => {
    const store = new AdminSessionStore({
      max: 2,
      secure: false,
      ttlMs: 10_000,
    });
    const created = store.create();

    store.delete('different-session-token');
    expect(store.read(created.token)).toBeDefined();

    store.delete(created.token);
    expect(store.read(created.token)).toBeUndefined();
  });
});
