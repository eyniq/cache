// P3: npm write grammar (only when a PackageSource makes the adapter writable) and npm
// publish-body parsing into the generic PublishRequest.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWriteBody } from '../../src/adapters/npm/publish.ts';
import { matchNpmPath } from '../../src/adapters/npm/routes.ts';
import type { AdapterRoute, WriteRoute } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';
import { makeTarball, sha1Hex, sha512Integrity } from '../helpers/tarball.ts';

const READ_ONLY = 'method not allowed: this is a read-only cache';

describe('P3: npm write routes', () => {
  it.each([
    ['PUT', '/lodash'],
    ['PUT', '/lodash/-rev/1-abc'],
    ['DELETE', '/lodash/-rev/1-abc'],
    ['DELETE', '/lodash/-/lodash-1.0.0.tgz/-rev/1-abc'],
    ['PUT', '/@scope%2fpkg'],
  ])('stays read-only without a package source: %s %s', (method, path) => {
    expect(matchNpmPath(method, path, '', false)).toEqual({
      kind: 'reject',
      status: 405,
      message: READ_ONLY,
    });
  });

  it('keeps dist-tag paths a 404 without a package source (as before)', () => {
    expect(matchNpmPath('PUT', '/-/package/x/dist-tags/beta', '', false)).toMatchObject({
      kind: 'reject',
      status: 404,
    });
  });

  it.each<[string, string, AdapterRoute]>([
    ['PUT', '/pkg', { kind: 'publish', name: 'pkg' }],
    ['PUT', '/@scope%2fpkg', { kind: 'publish', name: '@scope/pkg' }],
    ['PUT', '/@scope/pkg', { kind: 'publish', name: '@scope/pkg' }],
    ['PUT', '/pkg/-rev/3-abc', { kind: 'publish', name: 'pkg', rev: '3-abc' }],
    ['DELETE', '/pkg/-rev/3-abc', { kind: 'unpublish', name: 'pkg', rev: '3-abc' }],
    [
      'DELETE',
      '/@scope/pkg/-/pkg-1.0.0.tgz/-rev/4-def',
      { kind: 'unpublish', name: '@scope/pkg', file: 'pkg-1.0.0.tgz', rev: '4-def' },
    ],
    [
      'PUT',
      '/-/package/@scope%2fpkg/dist-tags/beta',
      { kind: 'dist-tag', name: '@scope/pkg', tag: 'beta', op: 'set' },
    ],
    [
      'DELETE',
      '/-/package/pkg/dist-tags/next',
      { kind: 'dist-tag', name: 'pkg', tag: 'next', op: 'delete' },
    ],
  ])('maps %s %s when writable', (method, path, route) => {
    expect(matchNpmPath(method, path, '', true)).toEqual(route);
  });

  it.each([
    ['PUT', '/../x', 400],
    ['PUT', '/pkg/-rev/bad%20rev', 400],
    ['PUT', '/-/package/pkg/dist-tags/1.0.0', 400],
    ['PUT', '/-/package/BAD%2fname/dist-tags/beta', 400],
    ['DELETE', '/pkg/-/evil.txt/-rev/1-a', 400],
    ['POST', '/pkg', 405],
    ['PUT', '/pkg/1.0.0', 405],
    ['GET', '/-/package/pkg/dist-tags/x', 404],
  ])('rejects %s %s with %i when writable', (method, path, status) => {
    expect(matchNpmPath(method, path, '', true)).toMatchObject({ kind: 'reject', status });
  });

  it('serves the dist-tags view only when writable', () => {
    expect(matchNpmPath('GET', '/-/package/@s%2fpkg/dist-tags', '', true)).toEqual({
      kind: 'metadata',
      name: '@s/pkg',
      view: 'dist-tags',
    });
    expect(matchNpmPath('GET', '/-/package/pkg/dist-tags', '', false)).toMatchObject({
      kind: 'reject',
      status: 404,
    });
  });

  it('keeps reads unchanged when writable', () => {
    expect(matchNpmPath('GET', '/pkg', '', true)).toEqual(matchNpmPath('GET', '/pkg', '', false));
  });
});

const tgz = makeTarball({ 'package.json': '{"name":"pkg","version":"1.0.0"}' });

function publishBody(over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}) {
  return {
    _id: 'pkg',
    name: 'pkg',
    description: 'test package',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        name: 'pkg',
        version: '1.0.0',
        _npmUser: { name: 'forged' },
        dist: {
          integrity: sha512Integrity(tgz),
          shasum: sha1Hex(tgz),
          tarball: 'http://elsewhere.invalid/pkg/-/pkg-1.0.0.tgz',
          attestations: { url: 'http://forged.invalid' },
          signatures: [{ keyid: 'forged', sig: 'x' }],
        },
        ...manifest,
      },
    },
    access: null,
    _attachments: {
      'pkg-1.0.0.tgz': {
        content_type: 'application/octet-stream',
        data: tgz.toString('base64'),
        length: tgz.length,
      },
    },
    ...over,
  };
}

const parse = (route: WriteRoute, body: unknown) =>
  parseWriteBody(route, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));

function expectStatus(fn: () => unknown, status: number, message?: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    if (message) expect((err as HttpError).message).toMatch(message);
    return;
  }
  throw new Error('expected an HttpError');
}

describe('P3: npm publish body parsing', () => {
  const route: WriteRoute = { kind: 'publish', name: 'pkg' };

  it('turns an npm publish body into a PublishRequest with verified artifacts', () => {
    const out = parse(route, publishBody());
    expect(out.type).toBe('publish');
    if (out.type !== 'publish') return;
    const req = out.request;
    expect(req).toMatchObject({ ecosystem: 'npm', name: 'pkg', distTags: { latest: '1.0.0' } });
    expect(req.versions).toHaveLength(1);
    const v = req.versions[0]!;
    expect(v.version).toBe('1.0.0');
    expect(Buffer.from(v.artifact.data).equals(tgz)).toBe(true);
    expect(v.artifact.file).toBe('pkg-1.0.0.tgz');
    expect(v.artifact.integrity).toEqual({
      algorithm: 'sha512',
      hex: createHash('sha512').update(tgz).digest('hex'),
    });
    // Server-side fields a client must not forge are dropped; the tarball URL is normalised.
    expect(v.manifest).not.toHaveProperty('_npmUser');
    const dist = v.manifest.dist as Record<string, unknown>;
    expect(dist).not.toHaveProperty('attestations');
    expect(dist).not.toHaveProperty('signatures');
    expect(dist.tarball).toBe('/pkg/-/pkg-1.0.0.tgz');
    expect(dist.integrity).toBe(sha512Integrity(tgz));
    expect(req.document).toMatchObject({ description: 'test package' });
    expect(req.document).not.toHaveProperty('_attachments');
    expect(req.document).not.toHaveProperty('versions');
  });

  it('accepts scoped attachment keys and ignores sigstore provenance bundles', () => {
    const scoped = '@scope/pkg';
    const body = publishBody(
      {
        _id: scoped,
        name: scoped,
        _attachments: {
          '@scope/pkg-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length },
          '@scope/pkg-1.0.0.sigstore': { data: Buffer.from('{}').toString('base64') },
        },
      },
      { name: scoped },
    );
    const out = parse({ kind: 'publish', name: scoped }, body);
    expect(out.type === 'publish' && out.request.versions[0]?.artifact.file).toBe('pkg-1.0.0.tgz');
  });

  it('computes integrity when the manifest has none', () => {
    const body = publishBody({}, { dist: {} });
    const out = parse(route, body);
    expect(out.type === 'publish' && out.request.versions[0]?.manifest.dist).toMatchObject({
      integrity: sha512Integrity(tgz),
      shasum: sha1Hex(tgz),
    });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, RegExp]>([
    ['a different package name', { name: 'other' }, {}, /name/],
    ['a different _id', { _id: 'other' }, {}, /name/],
    ['a manifest for another package', {}, { name: 'other' }, /manifest/],
    [
      'an integrity mismatch',
      {},
      { dist: { integrity: sha512Integrity(Buffer.from('x')) } },
      /integrity/,
    ],
    ['a shasum mismatch', {}, { dist: { shasum: sha1Hex(Buffer.from('x')) } }, /integrity/],
    [
      'invalid base64',
      { _attachments: { 'pkg-1.0.0.tgz': { data: 'not base64!!' } } },
      {},
      /base64/,
    ],
    [
      'a length mismatch',
      { _attachments: { 'pkg-1.0.0.tgz': { data: tgz.toString('base64'), length: 1 } } },
      {},
      /length/,
    ],
    [
      'a version without attachment',
      { _attachments: { 'pkg-2.0.0.tgz': { data: 'AA==' } } },
      {},
      /attachment/,
    ],
    ['a dist-tag on an unpublished version', { 'dist-tags': { latest: '9.9.9' } }, {}, /dist-tag/],
    ['an invalid dist-tag name', { 'dist-tags': { '1.0.0': '1.0.0' } }, {}, /dist-tag/],
    ['an invalid version', { versions: { 'not-semver': {} } }, {}, /version/],
    ['a deprecation with a bidi override', {}, { deprecated: 'use \u202eevil' }, /deprecated/],
    ['a deprecation with a control character', {}, { deprecated: 'beep\u0007' }, /deprecated/],
    ['an overlong deprecation', {}, { deprecated: 'x'.repeat(1025) }, /deprecated/],
    ['a deprecation that is not text', {}, { deprecated: { html: 1 } }, /deprecated/],
  ])('rejects %s with 400', (_label, over, manifest, message) => {
    expectStatus(() => parse(route, publishBody(over, manifest)), 400, message);
  });

  it('keeps a printable deprecation message of a published version', () => {
    const out = parse(route, publishBody({}, { deprecated: 'use pkg2 instead' }));
    expect(out.type === 'publish' && out.request.versions[0]?.manifest.deprecated).toBe(
      'use pkg2 instead',
    );
  });

  it('rejects bodies that are not a JSON object', () => {
    expectStatus(() => parse(route, 'nope'), 400);
    expectStatus(() => parse(route, '[1]'), 400);
  });

  it('reads a body without attachments as the versions to retain (npm unpublish of a version)', () => {
    const body = publishBody({ _attachments: undefined, _rev: '5-abc' });
    expect(parse({ kind: 'publish', name: 'pkg', rev: '5-abc' }, body)).toEqual({
      type: 'retain',
      versions: ['1.0.0'],
      rev: '5-abc',
    });
  });

  it('parses dist-tag bodies as a JSON string version', () => {
    const tag: WriteRoute = { kind: 'dist-tag', name: 'pkg', tag: 'beta', op: 'set' };
    expect(parse(tag, '"1.2.3"')).toEqual({ type: 'dist-tag', version: '1.2.3' });
    expectStatus(() => parse(tag, '"latest"'), 400);
    expectStatus(() => parse(tag, '{"v":1}'), 400);
  });
});
