import { isValidVersion } from '../../src/adapters/npm/names.ts';
import { describe, expect, it } from 'vitest';
import { matches, parseRange, satisfies } from '../../src/adapters/npm/range.ts';

const ok = (range: string, version: string) => satisfies(parseRange(range), version);

describe('npm range matcher', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['=1.2.3', '1.2.3', true],
    ['v1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['>1.2.3', '1.2.4', true],
    ['>1.2.3', '1.2.3', false],
    ['>=1.2.3', '1.2.3', true],
    ['<1.2.3', '1.2.2', true],
    ['<1.2.3', '1.2.3', false],
    ['<=1.2.3', '1.2.3', true],
    ['> 1.2.3', '1.2.4', true],
    ['>=1.0.0 <2.0.0', '1.9.9', true],
    ['>=1.0.0 <2.0.0', '2.0.0', false],
    ['<1.0.0 || >=2.0.0', '1.5.0', false],
    ['<1.0.0 || >=2.0.0', '0.5.0', true],
    ['<1.0.0 || >=2.0.0', '2.0.1', true],
  ])('comparators: %s vs %s', (r, v, want) => {
    expect(ok(r, v)).toBe(want);
  });

  it.each([
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '2.0.0', false],
    ['^1.2.3', '1.2.2', false],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['^1.2', '1.9.0', true],
    ['^1', '1.9.0', true],
    ['^0', '0.9.0', true],
    ['^0', '1.0.0', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~1.2', '1.2.9', true],
    ['~1', '1.9.9', true],
    ['~1', '2.0.0', false],
  ])('caret and tilde: %s vs %s', (r, v, want) => {
    expect(ok(r, v)).toBe(want);
  });

  it.each([
    ['*', '9.9.9', true],
    ['', '1.0.0', true],
    ['x', '1.0.0', true],
    ['1.x', '1.7.0', true],
    ['1.x', '2.0.0', false],
    ['1.2.x', '1.2.9', true],
    ['1.2.x', '1.3.0', false],
    ['1', '1.9.9', true],
    ['1.2', '1.2.5', true],
    ['1.2', '1.3.0', false],
    ['>=1.x', '1.0.0', true],
    ['>1.2', '1.3.0', true],
    ['>1.2', '1.2.9', false],
    ['<=1.2', '1.2.9', true],
    ['<=1.2', '1.3.0', false],
    ['<1.2', '1.1.9', true],
    ['<1.2', '1.2.0', false],
    ['>*', '1.0.0', false],
    ['<*', '1.0.0', false],
  ])('x-ranges: %s vs %s', (r, v, want) => {
    expect(ok(r, v)).toBe(want);
  });

  it.each([
    ['1.2.3 - 2.3.4', '2.3.4', true],
    ['1.2.3 - 2.3.4', '1.2.2', false],
    ['1.2.3 - 2.3.4', '2.3.5', false],
    ['1.2 - 2.3', '2.3.9', true],
    ['1.2 - 2.3', '2.4.0', false],
    ['1 - 2', '2.9.9', true],
    ['1 - 2', '3.0.0', false],
    ['1.0.0 - 2.0.0 || 5.x', '5.1.0', true],
  ])('hyphen ranges: %s vs %s', (r, v, want) => {
    expect(ok(r, v)).toBe(want);
  });

  it('matches prereleases, because a deny list must not skip them', () => {
    expect(ok('>=1.0.0 <2.0.0', '1.5.0-beta.1')).toBe(true);
    expect(ok('^1.2.3', '1.2.3-rc.1')).toBe(false);
    expect(ok('<2.0.0', '2.0.0-rc.1')).toBe(true);
    expect(ok('1.x', '2.0.0-rc.1')).toBe(false);
    expect(ok('1.2.3-beta.2', '1.2.3-beta.2')).toBe(true);
    expect(ok('>1.2.3-beta.2', '1.2.3-beta.10')).toBe(true);
    expect(ok('>1.2.3-beta.2', '1.2.3')).toBe(true);
  });

  it('ignores build metadata', () => {
    expect(ok('1.2.3', '1.2.3+build.5')).toBe(true);
  });

  it('only a match-all range matches versions that are not valid semver', () => {
    expect(ok('*', 'not-a-version')).toBe(true);
    expect(ok('', 'not-a-version')).toBe(true);
    expect(ok('>=0.0.0', 'not-a-version')).toBe(false);
    expect(ok('1.x', 'latest')).toBe(false);
  });

  it.each([
    'abc',
    '1.2.3.4',
    '^',
    '>=',
    '1.2.3 -',
    '01.2.3',
    '1.2.3-',
    '>=1.0.0 ||| 2',
    '1.2.3 - 2.0.0 - 3.0.0',
    'latest',
    '1.0.0 ||',
    '|| 1.0.0',
    '1.0.0 || || 2.0.0',
    '||',
  ])('rejects invalid range %j', (r) => {
    expect(() => parseRange(r)).toThrow();
  });

  it('rejects oversized and pathological ranges quickly', () => {
    expect(() => parseRange('1.0.0 || '.repeat(200))).toThrow(/too (long|many)/);
    expect(() => parseRange('>=1.0.0 '.repeat(100))).toThrow(/too (long|many)/);
    expect(() => parseRange('x'.repeat(5000))).toThrow(/too long/);
    const t = Date.now();
    expect(() => parseRange(`${'1'.repeat(900)}.${' '.repeat(100)}`)).toThrow();
    expect(() => parseRange(`${'1 - '.repeat(200)}1`)).toThrow();
    expect(Date.now() - t).toBeLessThan(200);
  });

  it('accepts every version of the isValidVersion grammar (leading zeros, long identifiers)', () => {
    const range = '>=1.0.0 <2.0.0';
    for (const v of [
      '1.5.0-01',
      '1.5.0-1234567890123456',
      `1.5.0-${'9'.repeat(120)}`,
      `1.5.0-${'a'.repeat(200)}`,
      `1.5.0-${Array.from({ length: 40 }, (_, i) => i).join('.')}`,
      `1.${'9'.repeat(40)}.0`,
    ]) {
      expect(isValidVersion(v)).toBe(true);
      expect(matches(parseRange(range), v)).toBe(true);
    }
    expect(matches(parseRange('<1.0.0'), `1${'0'.repeat(30)}.0.0`)).toBe(false);
    expect(matches(parseRange('>=1.0.0'), `1${'0'.repeat(30)}.0.0`)).toBe(true);
  });

  it('compares numeric prerelease identifiers by value whatever their length or zeros', () => {
    expect(ok('>1.0.0-2', '1.0.0-10')).toBe(true);
    expect(ok('>1.0.0-2', '1.0.0-01')).toBe(false);
    expect(ok('1.0.0-1', '1.0.0-01')).toBe(true);
    expect(ok('>1.0.0-99999999999999999', '1.0.0-100000000000000000')).toBe(true);
  });

  it('gives a definite answer for generated versions, and null only outside the grammar', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const num = () => {
      const len = 1 + rnd(30);
      return rnd(4) === 0 ? '0' : `${1 + rnd(9)}${'0123456789'.repeat(3).slice(0, len - 1)}`;
    };
    const ident = () => {
      const alnum = '0123456789abcXYZ-';
      let out = '';
      for (let i = 0, n = 1 + rnd(120); i < n; i++) out += alnum.charAt(rnd(alnum.length));
      return out;
    };
    const ranges = ['*', '>=1.0.0 <2.0.0', '^1.2.3', '~0.4', '<3.0.0', '1.x || 3.x', '>=0.0.0'].map(
      parseRange,
    );
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const pre = rnd(2) ? `-${Array.from({ length: 1 + rnd(33) }, ident).join('.')}` : '';
      const build = rnd(3) === 0 ? `+${ident()}` : '';
      const v = `${num()}.${num()}.${num()}${pre}${build}`;
      if (!isValidVersion(v)) continue;
      checked++;
      for (const r of ranges) expect(typeof matches(r, v)).toBe('boolean');
    }
    expect(checked).toBeGreaterThan(1000);
    expect(matches(parseRange('>=1.0.0'), 'not-semver')).toBeNull();
    expect(matches(parseRange('*'), 'not-semver')).toBe(true);
  });
});
