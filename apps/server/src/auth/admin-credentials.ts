import type { AdminCredentialRepository } from '../database/admin-credential-repository.js';
import { hashAdminPassword, verifyAdminPassword } from './admin-password.js';

export interface AdminCredentials {
  isPasswordConfigured(): boolean;
  /**
   * Whether a candidate proves administration ownership. An installation with
   * no password accepts every candidate, including none at all, which is what
   * makes a fresh gallery usable without any setup.
   */
  accepts(candidate: string | undefined): boolean;
  setPassword(password: string): void;
  clearPassword(): void;
}

export const createAdminCredentials = (
  repository: AdminCredentialRepository,
): AdminCredentials => ({
  isPasswordConfigured: () => repository.readPasswordHash() !== undefined,

  accepts: (candidate) => {
    const storedHash = repository.readPasswordHash();

    if (storedHash === undefined) {
      return true;
    }

    return (
      candidate !== undefined && verifyAdminPassword(candidate, storedHash)
    );
  },

  setPassword: (password) => {
    repository.setPasswordHash(hashAdminPassword(password));
  },

  clearPassword: () => {
    repository.clearPasswordHash();
  },
});
