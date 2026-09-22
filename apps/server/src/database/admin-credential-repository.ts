import type { DatabaseConnection } from './connection.js';

export interface AdminCredentialRepository {
  /** The encoded password hash, or `undefined` when no password is set. */
  readPasswordHash(): string | undefined;
  setPasswordHash(passwordHash: string, updatedAt?: Date): void;
  clearPasswordHash(): void;
}

interface AdminCredentialRow {
  password_hash: string;
}

export const createAdminCredentialRepository = (
  database: DatabaseConnection,
): AdminCredentialRepository => {
  const selectStatement = database.prepare(
    'SELECT password_hash FROM admin_credentials WHERE id = 1',
  );
  // The single row is replaced rather than updated so setting the first
  // password and changing a later one are the same statement.
  const upsertStatement = database.prepare(
    `INSERT INTO admin_credentials (id, password_hash, updated_at)
     VALUES (1, @passwordHash, @updatedAt)
     ON CONFLICT (id) DO UPDATE
       SET password_hash = excluded.password_hash,
           updated_at = excluded.updated_at`,
  );
  const deleteStatement = database.prepare(
    'DELETE FROM admin_credentials WHERE id = 1',
  );

  return {
    readPasswordHash: () => {
      const row = selectStatement.get() as AdminCredentialRow | undefined;

      return row?.password_hash;
    },

    setPasswordHash: (passwordHash, updatedAt = new Date()) => {
      upsertStatement.run({
        passwordHash,
        updatedAt: updatedAt.toISOString(),
      });
    },

    clearPasswordHash: () => {
      deleteStatement.run();
    },
  };
};
