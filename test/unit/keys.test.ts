import { describe, expect, it } from 'vitest';
import { indexKey, packumentKey } from '../../src/adapters/npm/keys.ts';
import { assertSafeKey, contentKey } from '../../src/core/names.ts';

describe('storage keys', () => {
  it.each(['npm/packuments/lodash.json', 'npm/packuments/@types/node.json', 'tarballs/sha512/ab'])(
    'accepts %s',
    (key) => {
      expect(() => assertSafeKey(key)).not.toThrow();
    },
  );

  it.each([
    '',
    '/abs',
    '../x',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    'a\0b',
    'a\\b',
    'a b',
    'a%2fb',
    'x'.repeat(1025),
  ])('rejects %j', (key) => {
    expect(() => assertSafeKey(key)).toThrow();
  });

  it('derives npm keys from validated names only', () => {
    expect(packumentKey('lodash')).toBe('npm/packuments/lodash.json.gz');
    expect(packumentKey('@types/node')).toBe('npm/packuments/@types/node.json.gz');
    expect(indexKey('@types/node', '20.0.0')).toBe('index/npm/@types/node/20.0.0');
    expect(() => packumentKey('../etc')).toThrow();
    expect(() => indexKey('lodash', '../1.0.0')).toThrow();
  });

  it('derives content-addressed keys from validated digests only', () => {
    expect(contentKey({ algorithm: 'sha512', hex: 'a'.repeat(128) })).toBe(
      `tarballs/sha512/${'a'.repeat(128)}`,
    );
    expect(contentKey({ algorithm: 'sha1', hex: 'b'.repeat(40) })).toBe(
      `tarballs/sha1/${'b'.repeat(40)}`,
    );
    expect(() => contentKey({ algorithm: 'sha512', hex: '../x' })).toThrow();
    expect(() => contentKey({ algorithm: 'sha1', hex: 'A'.repeat(40) })).toThrow();
    expect(contentKey({ algorithm: 'sha256', hex: 'c'.repeat(64) })).toBe(
      `tarballs/sha256/${'c'.repeat(64)}`,
    );
    expect(() => contentKey({ algorithm: 'sha256', hex: 'c'.repeat(128) })).toThrow();
    // Adapter-defined digests have no core content key (adapters derive their own).
    expect(() => contentKey({ algorithm: 'go-h1', hex: 'c'.repeat(64) })).toThrow();
  });
});
