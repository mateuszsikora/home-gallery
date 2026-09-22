import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Work factors for a new hash. They are also encoded into every stored hash, so
 * raising them here keeps existing passwords verifiable until their owner sets
 * a new one. `maxmem` leaves room for a future increase of `N`; scrypt needs
 * roughly `128 * N * r` bytes and refuses to run above the limit.
 */
interface ScryptParameters {
  readonly N: number;
  readonly p: number;
  readonly r: number;
}

const SCRYPT_PARAMETERS: ScryptParameters = { N: 16_384, p: 1, r: 8 };
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const ALGORITHM = 'scrypt';
const FIELD_SEPARATOR = '$';

/**
 * Derivation runs on the libuv thread pool rather than the request thread. A
 * single sign-in costs tens of milliseconds on the modest hardware this project
 * targets, and blocking for that long would stall gallery playback too.
 */
const deriveKey = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: ScryptParameters & { maxmem: number },
) => Promise<Buffer>;

const derive = (
  password: string,
  salt: Buffer,
  keyBytes: number,
  parameters: ScryptParameters,
): Promise<Buffer> =>
  deriveKey(password.normalize('NFC'), salt, keyBytes, {
    ...parameters,
    maxmem: SCRYPT_MAX_MEMORY,
  });

/**
 * Produces the single string stored in the database. It carries the algorithm
 * and its cost parameters so verification never depends on the constants that
 * happened to be current when the password was set.
 */
export const hashAdminPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, SCRYPT_PARAMETERS);

  return [
    ALGORITHM,
    SCRYPT_PARAMETERS.N,
    SCRYPT_PARAMETERS.r,
    SCRYPT_PARAMETERS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(FIELD_SEPARATOR);
};

const parsePositiveInteger = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return parsed > 0 ? parsed : undefined;
};

/**
 * Verifies a candidate against a stored hash in constant time. A stored value
 * that is malformed, truncated, or produced by an unknown algorithm verifies as
 * false instead of throwing, so a damaged row locks the studio rather than
 * crashing every administration request.
 */
export const verifyAdminPassword = async (
  password: string,
  storedHash: string,
): Promise<boolean> => {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] =
    storedHash.split(FIELD_SEPARATOR);

  if (
    algorithm !== ALGORITHM ||
    rawSalt === undefined ||
    rawKey === undefined
  ) {
    return false;
  }

  const N = parsePositiveInteger(rawN);
  const r = parsePositiveInteger(rawR);
  const p = parsePositiveInteger(rawP);

  if (N === undefined || r === undefined || p === undefined) {
    return false;
  }

  const salt = Buffer.from(rawSalt, 'base64url');
  const expected = Buffer.from(rawKey, 'base64url');

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let candidate: Buffer;

  try {
    candidate = await derive(password, salt, expected.length, { N, p, r });
  } catch {
    return false;
  }

  return timingSafeEqual(candidate, expected);
};
