import { describe, expect, it } from 'vitest';
import { prefersAbbreviated } from '../../src/adapters/npm/accept.ts';
import { matchNpmPath } from '../../src/adapters/npm/routes.ts';

const ABBR = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

describe('npm route matching: scoped packages', () => {
  it.each(['/@types%2fnode', '/@types%2Fnode', '/@types/node'])('matches packument %s', (p) => {
    expect(matchNpmPath('GET', p)).toEqual({ kind: 'metadata', name: '@types/node', view: 'full' });
  });

  it.each(['/@types/node/-/node-20.1.0.tgz', '/@types%2fnode/-/node-20.1.0.tgz'])(
    'matches scoped tarball %s',
    (p) => {
      expect(matchNpmPath('GET', p)).toEqual({
        kind: 'artifact',
        name: '@types/node',
        file: 'node-20.1.0.tgz',
      });
    },
  );

  it.each(['/@types/node/20.1.0', '/@types%2fnode/20.1.0'])('matches version doc %s', (p) => {
    expect(matchNpmPath('GET', p)).toEqual({
      kind: 'metadata',
      name: '@types/node',
      view: 'version',
      ref: '20.1.0',
    });
  });

  it.each(['/@types', '/@types/', '/@Types/node', '/@types/node%2fx', '/@types/%2e%2e'])(
    'rejects %s',
    (p) => {
      expect(matchNpmPath('GET', p)).toMatchObject({ kind: 'reject' });
    },
  );
});

describe('npm route matching: views', () => {
  it('serves the abbreviated packument when the client prefers it', () => {
    expect(matchNpmPath('GET', '/lodash', ABBR)).toEqual({
      kind: 'metadata',
      name: 'lodash',
      view: 'abbreviated',
    });
  });

  it('matches version and dist-tag documents', () => {
    expect(matchNpmPath('GET', '/lodash/4.17.21')).toEqual({
      kind: 'metadata',
      name: 'lodash',
      view: 'version',
      ref: '4.17.21',
    });
    expect(matchNpmPath('GET', '/lodash/latest')).toMatchObject({ view: 'version', ref: 'latest' });
  });

  it('rejects an invalid version reference', () => {
    expect(matchNpmPath('GET', '/lodash/..')).toMatchObject({ kind: 'reject', status: 400 });
    expect(matchNpmPath('GET', '/lodash/1.0.0%00')).toMatchObject({ kind: 'reject', status: 400 });
  });
});

describe('npm route matching: special endpoints', () => {
  it('answers ping and whoami', () => {
    expect(matchNpmPath('GET', '/-/ping')).toEqual({ kind: 'ping' });
    expect(matchNpmPath('GET', '/-/ping?write=true')).toEqual({ kind: 'ping' });
    expect(matchNpmPath('GET', '/-/whoami')).toEqual({ kind: 'whoami' });
  });

  it.each([
    '/-/npm/v1/security/advisories/bulk',
    '/-/npm/v1/security/audits/quick',
    '/-/npm/v1/security/audits',
  ])('passes POST %s through with a 10 MB body limit', (p) => {
    expect(matchNpmPath('POST', p)).toEqual({
      kind: 'passthrough',
      upstreamPath: p,
      maxBodyBytes: 10 * 1024 * 1024,
    });
  });

  it('passes search through with its query string', () => {
    expect(matchNpmPath('GET', '/-/v1/search?text=lodash&size=2')).toEqual({
      kind: 'passthrough',
      upstreamPath: '/-/v1/search?text=lodash&size=2',
      search: true,
      maxBodyBytes: 0,
    });
  });

  it('only passes through the exact known endpoints', () => {
    expect(matchNpmPath('POST', '/-/npm/v1/security/../../x')).toMatchObject({ kind: 'reject' });
    expect(matchNpmPath('POST', '/-/npm/v1/security/audits/quick/x')).toMatchObject({
      kind: 'reject',
    });
    expect(matchNpmPath('GET', '/-/npm/v1/security/audits/quick')).toMatchObject({
      kind: 'reject',
      status: 405,
    });
    expect(matchNpmPath('GET', '/-/something-else')).toMatchObject({ kind: 'reject', status: 404 });
  });

  it.each([
    ['PUT', '/lodash'],
    ['DELETE', '/lodash/-/lodash-1.0.0.tgz/-rev/1-abc'],
    ['POST', '/lodash'],
    ['PUT', '/-/user/org.couchdb.user:bob'],
    ['GET', '/-/user/org.couchdb.user:bob'],
    ['DELETE', '/-/user/token/abc'],
    ['PUT', '/@scope%2fpkg'],
  ])('rejects %s %s with 405 (read-only cache)', (method, p) => {
    const route = matchNpmPath(method, p);
    expect(route).toMatchObject({ kind: 'reject', status: 405 });
    expect((route as { message: string }).message).toMatch(/read-only/);
  });
});

describe('Accept negotiation', () => {
  it.each([
    [ABBR, true],
    ['application/vnd.npm.install-v1+json', true],
    ['application/json', false],
    ['*/*', false],
    ['', false],
    ['application/vnd.npm.install-v1+json; q=0.5, application/json', false],
    ['application/vnd.npm.install-v1+json; q=0', false],
    ['APPLICATION/VND.NPM.INSTALL-V1+JSON', true],
  ])('%j prefers abbreviated: %s', (accept, expected) => {
    expect(prefersAbbreviated(accept)).toBe(expected);
  });
});
