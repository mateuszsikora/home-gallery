import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashAdminPassword,
  verifyAdminPassword,
} from '../src/auth/admin-password.js';

const PASSWORD = 'a-quiet-house-in-the-evening';

describe('administration password hashing', () => {
  it('verifies the password it hashed', async () => {
    await expect(
      verifyAdminPassword(PASSWORD, await hashAdminPassword(PASSWORD)),
    ).resolves.toBe(true);
  });

  it('never stores the password itself', async () => {
    expect(await hashAdminPassword(PASSWORD)).not.toContain(PASSWORD);
  });

  it('salts every hash, so the same password hashes differently', async () => {
    const first = await hashAdminPassword(PASSWORD);
    const second = await hashAdminPassword(PASSWORD);

    expect(first).not.toBe(second);
    await expect(verifyAdminPassword(PASSWORD, second)).resolves.toBe(true);
  });

  it('records the algorithm and its cost parameters', async () => {
    expect((await hashAdminPassword(PASSWORD)).split('$').slice(0, 4)).toEqual([
      'scrypt',
      '16384',
      '8',
      '1',
    ]);
  });

  it('verifies a hash that was produced with other cost parameters', async () => {
    // A password stored before the cost was raised has to keep working, so
    // verification follows the parameters in the record instead of the current
    // constants.
    const salt = randomBytes(16);
    const parameters = { N: 1_024, p: 2, r: 4 };
    const key = scryptSync(PASSWORD, salt, 32, parameters);
    const stored = [
      'scrypt',
      parameters.N,
      parameters.r,
      parameters.p,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');

    await expect(verifyAdminPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(
      verifyAdminPassword('something-else-entirely', stored),
    ).resolves.toBe(false);
  });

  it.each([
    ['a different password', 'a-quiet-house-in-the-morning'],
    ['a prefix of the password', PASSWORD.slice(0, -1)],
    ['the password with an extra character', `${PASSWORD}!`],
    ['an empty candidate', ''],
  ])('rejects %s', async (_label, candidate) => {
    await expect(
      verifyAdminPassword(candidate, await hashAdminPassword(PASSWORD)),
    ).resolves.toBe(false);
  });

  it('rejects a tampered digest', async () => {
    const fields = (await hashAdminPassword(PASSWORD)).split('$');
    const digest = fields[5] as string;
    const tampered = [
      ...fields.slice(0, 5),
      `${digest.startsWith('A') ? 'B' : 'A'}${digest.slice(1)}`,
    ].join('$');

    await expect(verifyAdminPassword(PASSWORD, tampered)).resolves.toBe(false);
  });

  it('rejects a tampered salt', async () => {
    const fields = (await hashAdminPassword(PASSWORD)).split('$');
    const salt = fields[4] as string;
    const tampered = [
      ...fields.slice(0, 4),
      `${salt.startsWith('A') ? 'B' : 'A'}${salt.slice(1)}`,
      fields[5],
    ].join('$');

    await expect(verifyAdminPassword(PASSWORD, tampered)).resolves.toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['an unknown algorithm', 'argon2$16384$8$1$c2FsdA$aGFzaA'],
    ['a truncated record', 'scrypt$16384$8$1'],
    ['a non-numeric cost', 'scrypt$many$8$1$c2FsdA$aGFzaA'],
    ['a zero cost', 'scrypt$0$8$1$c2FsdA$aGFzaA'],
    ['an empty salt', 'scrypt$16384$8$1$$aGFzaA'],
    ['an empty digest', 'scrypt$16384$8$1$c2FsdA$'],
    ['a cost beyond the memory limit', 'scrypt$1048576$8$1$c2FsdA$aGFzaA'],
  ])(
    'reports a stored hash with %s as unverifiable',
    async (_label, stored) => {
      await expect(verifyAdminPassword(PASSWORD, stored)).resolves.toBe(false);
    },
  );
});
