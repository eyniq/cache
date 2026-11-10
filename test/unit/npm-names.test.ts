import { describe, expect, it } from 'vitest';
import {
  isValidPackageName,
  isValidTarballFile,
  isValidVersion,
} from '../../src/adapters/npm/names.ts';

describe('npm package names', () => {
  it.each([
    'lodash',
    'a',
    'a-b.c_d',
    '@types/node',
    '@babel/core',
    'JSONStream', // legacy uppercase names are still installable
    "fn-args'", // legacy URL-safe punctuation
    'x'.repeat(214),
  ])('accepts %s', (name) => {
    expect(isValidPackageName(name)).toBe(true);
  });

  it.each([
    '',
    '.hidden',
    '_private',
    '..',
    '../etc/passwd',
    'a/b',
    'a b',
    'a\0b',
    'a%2fb',
    'node_modules',
    'favicon.ico',
    'x'.repeat(215),
    '@scope',
    '@/x',
    '@scope/',
    '@scope/x/y',
    '@Scope/x',
    '@scope/.x',
    '@scope/..',
    'é',
    'a\\b',
  ])('rejects %j', (name) => {
    expect(isValidPackageName(name)).toBe(false);
  });
});

describe('npm versions', () => {
  it.each(['1.0.0', '0.0.1-alpha.1', '1.2.3+build.5', '10.20.30-rc.1+exp.sha.5114f85'])(
    'accepts %s',
    (v) => {
      expect(isValidVersion(v)).toBe(true);
    },
  );

  it.each(['', '1', '1.0', 'latest', '../1.0.0', '1.0.0/x', '1.0.0\0', 'v'.repeat(300)])(
    'rejects %j',
    (v) => {
      expect(isValidVersion(v)).toBe(false);
    },
  );
});

describe('tarball file names', () => {
  it.each(['lodash-4.17.21.tgz', 'node-20.1.0.tgz', 'JSONStream-1.3.5.tgz'])('accepts %s', (f) => {
    expect(isValidTarballFile(f)).toBe(true);
  });

  it.each(['', '.tgz', '../x.tgz', 'a/b.tgz', 'x.tar', 'x.tgz\0', '..%2fx.tgz', '.x.tgz'])(
    'rejects %j',
    (f) => {
      expect(isValidTarballFile(f)).toBe(false);
    },
  );
});
