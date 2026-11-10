// Password hashing for the community user store (C3): scrypt from node:crypto, encoded as a
// PHC-style string `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>` (base64url, 16-byte salt,
// 64-byte key). The parameters live in the string, so they can be raised later without
// invalidating existing hashes. Default: N=2^15, r=8, p=3 (OWASP's scrypt alternative to
// N=2^17,p=1 with the same CPU cost and 32 MiB instead of 128 MiB of memory per hash).
// Every hash costs that memory, so at most MAX_CONCURRENT run at once and a bounded queue
// waits; beyond it callers get PasswordBusyError instead of piling up memory.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  ln: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: Readonly<ScryptParams> = Object.freeze({ ln: 15, r: 8, p: 3 });
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
/**
 * Accepted ranges: a hostile or mistyped file must not cost unbounded memory or CPU. At the
 * caps (N=2^17, r=8) one hash needs 128 MiB, so the two concurrent checks stay below 300 MiB.
 */
const LIMITS = { ln: [10, 17], r: [1, 8], p: [1, 16] } as const;
const PHC =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 64;

export class PasswordBusyError extends Error {
  constructor() {
    super('too many password checks in progress');
    this.name = 'PasswordBusyError';
  }
}

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new PasswordBusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    // The slot passes straight to the next waiter; `active` only drops when nobody waits.
    if (next) next();
    else active--;
  }
}

function inRange(params: ScryptParams): boolean {
  return (
    params.ln >= LIMITS.ln[0] &&
    params.ln <= LIMITS.ln[1] &&
    params.r >= LIMITS.r[0] &&
    params.r <= LIMITS.r[1] &&
    params.p >= LIMITS.p[0] &&
    params.p <= LIMITS.p[1]
  );
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.ln;
  // scrypt needs 128 * N * r bytes; allow that plus headroom (the default cap is 32 MiB).
  const maxmem = 128 * N * params.r + 16 * 1024 * 1024;
  return withSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password.normalize('NFC'),
          salt,
          KEY_BYTES,
          { N, r: params.r, p: params.p, maxmem },
          (err, key) => {
            if (err) reject(err);
            else resolve(key);
          },
        );
      }),
  );
}

interface Decoded {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function decode(encoded: string): Decoded | null {
  const m = PHC.exec(encoded);
  if (!m) return null;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (!inRange(params)) return null;
  const salt = Buffer.from(m[4] ?? '', 'base64url');
  const key = Buffer.from(m[5] ?? '', 'base64url');
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { params, salt, key };
}

/** True for a well-formed hash with acceptable parameters. */
export function isPasswordHash(encoded: string): boolean {
  return decode(encoded) !== null;
}

/** The parameters of a well-formed hash, else null. */
export function hashParams(encoded: string): ScryptParams | null {
  return decode(encoded)?.params ?? null;
}

/** A problem with the password (never echoing it), or null when it is acceptable. */
export function checkPasswordPolicy(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `passwords must have at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `passwords must have at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Hashes a password. Callers enforce the minimum length with checkPasswordPolicy; the maximum
 * is enforced here, because verifyPassword refuses longer input and the hash could never verify.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`passwords must have at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (!inRange(params)) throw new Error('scrypt parameters out of range');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time check; false for a malformed hash. Throws PasswordBusyError under load. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const decoded = decode(encoded);
  if (!decoded || password.length > PASSWORD_MAX_LENGTH) return false;
  const key = await derive(password, decoded.salt, decoded.params);
  return timingSafeEqual(key, decoded.key);
}

/**
 * Spends the same work as verifying against a hash with `params`, for user names that do not
 * exist: the answer time must not tell whether a user exists.
 */
export async function burnPasswordCheck(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<void> {
  const safe = inRange(params) ? params : DEFAULT_SCRYPT;
  await derive(password.slice(0, PASSWORD_MAX_LENGTH), randomBytes(SALT_BYTES), safe);
}
