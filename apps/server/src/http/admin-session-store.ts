import { createHash, randomBytes } from 'node:crypto';

import type { AdminSessionConfig } from '@home-gallery/config';

export interface AdminSessionRecord {
  readonly expiresAt: number;
}

export interface CreatedAdminSession extends AdminSessionRecord {
  readonly token: string;
}

export const hashAdminSessionToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');

/**
 * Keeps a bounded set of short-lived browser sessions in process memory. A
 * restart invalidates every session, and only a digest of each cookie value is
 * retained after creation.
 */
export class AdminSessionStore {
  readonly #config: AdminSessionConfig;
  readonly #now: () => number;
  readonly #sessions = new Map<string, AdminSessionRecord>();

  constructor(config: AdminSessionConfig, now: () => number = Date.now) {
    this.#config = config;
    this.#now = now;
  }

  create(): CreatedAdminSession {
    const now = this.#now();
    this.#prune(now);

    while (this.#sessions.size >= this.#config.max) {
      const oldest = this.#sessions.keys().next().value as string | undefined;

      if (oldest === undefined) {
        break;
      }

      this.#sessions.delete(oldest);
    }

    const token = randomBytes(32).toString('base64url');
    const record = { expiresAt: now + this.#config.ttlMs };
    this.#sessions.set(hashAdminSessionToken(token), record);

    return { token, expiresAt: record.expiresAt };
  }

  read(token: string | undefined): AdminSessionRecord | undefined {
    if (token === undefined) {
      return undefined;
    }

    const key = hashAdminSessionToken(token);
    const record = this.#sessions.get(key);

    if (record === undefined) {
      return undefined;
    }

    if (record.expiresAt <= this.#now()) {
      this.#sessions.delete(key);
      return undefined;
    }

    return { expiresAt: record.expiresAt };
  }

  delete(token: string | undefined): void {
    if (token !== undefined) {
      this.#sessions.delete(hashAdminSessionToken(token));
    }
  }

  get size(): number {
    this.#prune(this.#now());
    return this.#sessions.size;
  }

  #prune(now: number): void {
    for (const [key, record] of this.#sessions) {
      if (record.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
  }
}
