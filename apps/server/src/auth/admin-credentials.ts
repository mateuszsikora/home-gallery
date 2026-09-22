import type { AdminCredentialRepository } from '../database/admin-credential-repository.js';
import { hashAdminPassword, verifyAdminPassword } from './admin-password.js';

export interface AdminCredentials {
  isPasswordConfigured(): boolean;
  /**
   * Whether a candidate proves administration ownership. An installation with
   * no password accepts every candidate, including none at all, which is what
   * makes a fresh gallery usable without any setup.
   */
  accepts(candidate: string | undefined): Promise<boolean>;
  setPassword(password: string): Promise<void>;
  clearPassword(): void;
}

export const createAdminCredentials = (
  repository: AdminCredentialRepository,
): AdminCredentials => ({
  isPasswordConfigured: () => repository.readPasswordHash() !== undefined,

  accepts: async (candidate) => {
    const storedHash = repository.readPasswordHash();

    if (storedHash === undefined) {
      return true;
    }

    return (
      candidate !== undefined &&
      (await verifyAdminPassword(candidate, storedHash))
    );
  },

  setPassword: async (password) => {
    repository.setPasswordHash(await hashAdminPassword(password));
  },

  clearPassword: () => {
    repository.clearPasswordHash();
  },
});
