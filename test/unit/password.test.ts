import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT,
  checkPasswordPolicy,
  hashPassword,
  hashParams,
  isPasswordHash,
  verifyPassword,
} from '../../src/auth/password.ts';

// Cheap parameters keep the suite fast; the default strength is asserted separately.
const FAST = { ln: 10, r: 8, p: 1 };

describe('password hashing', () => {
  it('uses strong scrypt defaults (OWASP: N=2^15, r=8, p=3)', () => {
    expect(DEFAULT_SCRYPT).toEqual({ ln: 15, r: 8, p: 3 });
  });

  it('refuses to hash a password that verifyPassword would never accept', async () => {
    await expect(hashPassword('x'.repeat(1025), FAST)).rejects.toThrow(/at most 1024/);
  });

  it('produces a PHC-style string with parameters, salt and hash, never the password', async () => {
    const encoded = await hashPassword('correct horse battery', FAST);
    expect(encoded).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(encoded).not.toContain('correct');
    expect(isPasswordHash(encoded)).toBe(true);
    expect(hashParams(encoded)).toEqual(FAST);
  });

  it('salts every hash', async () => {
    const a = await hashPassword('same password here', FAST);
    const b = await hashPassword('same password here', FAST);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const encoded = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse battery', encoded)).toBe(true);
    expect(await verifyPassword('correct horse batterz', encoded)).toBe(false);
    expect(await verifyPassword('', encoded)).toBe(false);
  });

  it.each([
    'plain',
    '$scrypt$ln=10,r=8,p=1$short$hash',
    '$bcrypt$ln=10,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    // Verdaccio htpasswd entries are not importable.
    '$2y$10$abcdefghijklmnopqrstuuJ5f8w6S2mQhK7Tq0Yb0m3hYyqXkz5yS',
    // Parameters outside the accepted range (a hostile file must not cost unbounded memory).
    '$scrypt$ln=25,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    '$scrypt$ln=15,r=64,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    '$scrypt$ln=15,r=8,p=99$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    // Caps: ln <= 17 and r <= 8 (at most 128 MiB per hash).
    '$scrypt$ln=18,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    '$scrypt$ln=15,r=9,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
  ])('rejects the malformed hash %s', async (encoded) => {
    expect(isPasswordHash(encoded)).toBe(false);
    expect(await verifyPassword('anything at all', encoded)).toBe(false);
  });

  it('accepts the largest allowed parameters', () => {
    expect(isPasswordHash('$scrypt$ln=17,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86))).toBe(
      true,
    );
  });

  it('enforces a length policy without echoing the password', () => {
    expect(checkPasswordPolicy('short')).toMatch(/at least 12/);
    expect(checkPasswordPolicy('x'.repeat(1025))).toMatch(/at most 1024/);
    expect(checkPasswordPolicy('long enough password')).toBeNull();
    expect(checkPasswordPolicy('short')).not.toContain('short');
  });
});
