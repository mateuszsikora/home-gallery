import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashAdminPassword,
  verifyAdminPassword,
} from '../src/auth/admin-password.js';

const PASSWORD = 'a-quiet-house-in-the-evening';

describe('administration password hashing', () => {
  it('verifies the password it hashed', () => {
    expect(verifyAdminPassword(PASSWORD, hashAdminPassword(PASSWORD))).toBe(
      true,
    );
  });

  it('never stores the password itself', () => {
    expect(hashAdminPassword(PASSWORD)).not.toContain(PASSWORD);
  });

  it('salts every hash, so the same password hashes differently', () => {
    const first = hashAdminPassword(PASSWORD);
    const second = hashAdminPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(verifyAdminPassword(PASSWORD, second)).toBe(true);
  });

  it('records the algorithm and its cost parameters', () => {
    expect(hashAdminPassword(PASSWORD).split('$').slice(0, 4)).toEqual([
      'scrypt',
      '16384',
      '8',
      '1',
    ]);
  });

  it('verifies a hash that was produced with other cost parameters', () => {
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

    expect(verifyAdminPassword(PASSWORD, stored)).toBe(true);
    expect(verifyAdminPassword('something-else-entirely', stored)).toBe(false);
  });

  it.each([
    ['a different password', 'a-quiet-house-in-the-morning'],
    ['a prefix of the password', PASSWORD.slice(0, -1)],
    ['the password with an extra character', `${PASSWORD}!`],
    ['an empty candidate', ''],
  ])('rejects %s', (_label, candidate) => {
    expect(verifyAdminPassword(candidate, hashAdminPassword(PASSWORD))).toBe(
      false,
    );
  });

  it('rejects a tampered digest', () => {
    const fields = hashAdminPassword(PASSWORD).split('$');
    const digest = fields[5] as string;
    const tampered = [
      ...fields.slice(0, 5),
      `${digest.startsWith('A') ? 'B' : 'A'}${digest.slice(1)}`,
    ].join('$');

    expect(verifyAdminPassword(PASSWORD, tampered)).toBe(false);
  });

  it('rejects a tampered salt', () => {
    const fields = hashAdminPassword(PASSWORD).split('$');
    const salt = fields[4] as string;
    const tampered = [
      ...fields.slice(0, 4),
      `${salt.startsWith('A') ? 'B' : 'A'}${salt.slice(1)}`,
      fields[5],
    ].join('$');

    expect(verifyAdminPassword(PASSWORD, tampered)).toBe(false);
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
  ])('reports a stored hash with %s as unverifiable', (_label, stored) => {
    expect(verifyAdminPassword(PASSWORD, stored)).toBe(false);
  });
});
