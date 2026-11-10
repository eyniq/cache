import { describe, expect, it } from 'vitest';
import { matchNpmPath } from '../../src/adapters/npm/routes.ts';

describe('npm route matching (unscoped)', () => {
  it('matches a packument', () => {
    expect(matchNpmPath('GET', '/lodash')).toEqual({
      kind: 'metadata',
      name: 'lodash',
      view: 'full',
    });
  });

  it('ignores the query string', () => {
    expect(matchNpmPath('GET', '/lodash?write=true')).toEqual({
      kind: 'metadata',
      name: 'lodash',
      view: 'full',
    });
  });

  it('matches a tarball', () => {
    expect(matchNpmPath('GET', '/lodash/-/lodash-4.17.21.tgz')).toEqual({
      kind: 'artifact',
      name: 'lodash',
      file: 'lodash-4.17.21.tgz',
    });
  });

  it.each([
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e',
    '/%2e%2e/-/x.tgz',
    '/lodash%00',
    '/lodash/-/..%2fsecret.tgz',
    '/lodash/-/%2e%2e%2f%2e%2e%2fsecret.tgz',
    '/a%ZZ',
    '/lodash/-/lodash-1.0.0.tgz%00',
    '/.hidden',
    '/lodash%252f..',
  ])('rejects malicious path %s with 400', (path) => {
    expect(matchNpmPath('GET', path)).toMatchObject({ kind: 'reject', status: 400 });
  });

  it('returns 404 for the bare root', () => {
    expect(matchNpmPath('GET', '/')).toMatchObject({ kind: 'reject', status: 404 });
  });
});
