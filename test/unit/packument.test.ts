import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { processMetadata, renderMetadata } from '../../src/adapters/npm/packument.ts';
import type { ProcessContext, RawMetadata } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';

const SHA512_B64 = Buffer.alloc(64, 7).toString('base64');
const SHA512_HEX = Buffer.alloc(64, 7).toString('hex');

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'lodash',
    _rev: '9-x',
    name: 'lodash',
    description: 'Lodash',
    'dist-tags': { latest: '1.1.0' },
    versions: {
      '1.0.0': {
        name: 'lodash',
        version: '1.0.0',
        readme: 'drop me in abbreviated',
        dist: {
          tarball: 'https://registry.npmjs.org/lodash/-/lodash-1.0.0.tgz',
          integrity: `sha512-${SHA512_B64}`,
          shasum: 'a'.repeat(40),
        },
      },
      '1.1.0': {
        name: 'lodash',
        version: '1.1.0',
        dist: {
          // Foreign host in the packument must never be followed.
          tarball: 'https://evil.example/lodash/-/lodash-1.1.0.tgz',
          shasum: 'b'.repeat(40),
        },
      },
    },
    time: {
      created: '2012-01-01T00:00:00.000Z',
      modified: '2020-01-02T00:00:00.000Z',
      '1.0.0': '2012-01-01T00:00:00.000Z',
      '1.1.0': '2020-01-02T00:00:00.000Z',
    },
    readme: 'top readme',
    ...overrides,
  };
}

const ctx: ProcessContext = {
  name: 'lodash',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 10 * 1024 * 1024,
  options: {},
};

function raw(value: unknown, gzip = false): RawMetadata {
  const json = Buffer.from(JSON.stringify(value));
  return gzip ? { body: gzipSync(json), encoding: 'gzip' } : { body: json, encoding: 'identity' };
}

function renderFull(allowed: string[], value = doc()): Record<string, unknown> {
  const processed = processMetadata(raw(value), ctx);
  const out = renderMetadata({ processed, allowed: new Set(allowed), view: 'full' });
  if (out.status !== 200) throw new Error(`unexpected ${out.status}`);
  expect(out.contentType).toBe('application/json');
  return JSON.parse(out.body.toString('utf8')) as Record<string, unknown>;
}

describe('npm packument processing', () => {
  it('builds a version index with publish times and integrity', () => {
    const p = processMetadata(raw(doc()), ctx);
    expect(p.name).toBe('lodash');
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.byteSize).toBeGreaterThan(0);
    expect(p.versions).toEqual([
      {
        version: '1.0.0',
        publishedAt: Date.parse('2012-01-01T00:00:00.000Z'),
        artifact: {
          file: 'lodash-1.0.0.tgz',
          upstreamPath: '/lodash/-/lodash-1.0.0.tgz',
          integrity: { algorithm: 'sha512', hex: SHA512_HEX },
        },
        facts: {
          publisher: null,
          maintainers: 0,
          hasInstallScript: false,
          license: null,
          deprecated: false,
          hasAttestations: false,
          hasSignatures: false,
          previousPublisher: null,
          publisherFirstSeen: null,
        },
      },
      {
        version: '1.1.0',
        publishedAt: Date.parse('2020-01-02T00:00:00.000Z'),
        artifact: {
          file: 'lodash-1.1.0.tgz',
          // Rebuilt on the upstream host; the foreign host is ignored.
          upstreamPath: '/lodash/-/lodash-1.1.0.tgz',
          integrity: { algorithm: 'sha1', hex: 'b'.repeat(40) },
        },
        facts: {
          publisher: null,
          maintainers: 0,
          hasInstallScript: false,
          license: null,
          deprecated: false,
          hasAttestations: false,
          hasSignatures: false,
          previousPublisher: null,
          publisherFirstSeen: null,
        },
      },
    ]);
  });

  it('decodes gzip-encoded upstream bodies', () => {
    const p = processMetadata(raw(doc(), true), ctx);
    expect(p.versions).toHaveLength(2);
  });

  it('rewrites every tarball URL to the public base URL', () => {
    const out = renderFull(['1.0.0', '1.1.0']);
    const versions = out.versions as Record<string, { dist: { tarball: string } }>;
    expect(versions['1.0.0']!.dist.tarball).toBe('https://cache.example/lodash/-/lodash-1.0.0.tgz');
    expect(versions['1.1.0']!.dist.tarball).toBe('https://cache.example/lodash/-/lodash-1.1.0.tgz');
  });

  it('preserves the other top-level fields, time and dist-tags', () => {
    const out = renderFull(['1.0.0', '1.1.0']);
    expect(out).toMatchObject({
      _id: 'lodash',
      name: 'lodash',
      description: 'Lodash',
      readme: 'top readme',
      'dist-tags': { latest: '1.1.0' },
    });
    expect(out.time).toEqual(doc().time);
    expect((out.versions as Record<string, { readme?: string }>)['1.0.0']!.readme).toBe(
      'drop me in abbreviated',
    );
  });

  it('omits versions that are not allowed from versions and time', () => {
    const out = renderFull(['1.0.0']);
    expect(Object.keys(out.versions as object)).toEqual(['1.0.0']);
    expect(Object.keys(out.time as object)).toEqual(['created', 'modified', '1.0.0']);
  });

  it('rejects documents above the size limit with 502', () => {
    const big = doc({ readme: 'x'.repeat(2048) });
    expect(() => processMetadata(raw(big, true), { ...ctx, maxBytes: 1024 })).toThrow(HttpError);
    try {
      processMetadata(raw(big), { ...ctx, maxBytes: 1024 });
    } catch (err) {
      expect((err as HttpError).status).toBe(502);
    }
  });

  it('rejects invalid JSON and non-packuments with 502', () => {
    expect(() =>
      processMetadata({ body: Buffer.from('{nope'), encoding: 'identity' }, ctx),
    ).toThrow(HttpError);
    expect(() => processMetadata(raw([1, 2]), ctx)).toThrow(HttpError);
    expect(() => processMetadata(raw({ name: 'x', versions: 'no' }), ctx)).toThrow(HttpError);
  });

  it('skips versions whose key is not a valid semver', () => {
    const d = doc();
    (d.versions as Record<string, unknown>)['../../evil'] = { dist: { tarball: 'x' } };
    const p = processMetadata(raw(d), ctx);
    expect(p.versions.map((v) => v.version)).toEqual(['1.0.0', '1.1.0']);
  });

  it('produces byte-identical output for identical input', () => {
    const a = renderFull(['1.0.0', '1.1.0']);
    const b = renderFull(['1.0.0', '1.1.0']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('npm packument hardening (review findings)', () => {
  function versionDoc(dist: Record<string, unknown>): Record<string, unknown> {
    return doc({
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { name: 'lodash', version: '2.0.0', dist } },
      time: { '2.0.0': '2021-01-01T00:00:00.000Z' },
    });
  }

  it('rejects a document whose name differs from the requested name', () => {
    expect(() => processMetadata(raw(doc({ name: 'other' })), ctx)).toThrow(HttpError);
    expect(() =>
      processMetadata(raw(doc({ name: '../../-/npm/v1/x?y#' })), {
        ...ctx,
        name: '../../-/npm/v1/x?y#',
      }),
    ).toThrow(HttpError);
  });

  it('builds upstream paths and public URLs from the requested name only', () => {
    const p = processMetadata(raw(doc({ _id: '../evil' })), ctx);
    expect(p.versions.every((v) => v.artifact?.upstreamPath.startsWith('/lodash/-/'))).toBe(true);
  });

  it('does not downgrade to sha1 when an integrity field is present but unusable', () => {
    const p = processMetadata(
      raw(versionDoc({ integrity: 'sha512-garbage', shasum: 'c'.repeat(40) })),
      ctx,
    );
    expect(p.versions[0]!.artifact!.integrity).toBeNull();
  });

  it('accepts an explicit sha1 SRI token', () => {
    const b64 = Buffer.alloc(20, 9).toString('base64');
    const p = processMetadata(raw(versionDoc({ integrity: `sha1-${b64}` })), ctx);
    expect(p.versions[0]!.artifact!.integrity).toEqual({
      algorithm: 'sha1',
      hex: Buffer.alloc(20, 9).toString('hex'),
    });
  });

  it('ignores tarball file names that do not belong to the version', () => {
    const p = processMetadata(
      raw(versionDoc({ tarball: 'https://registry.npmjs.org/lodash/-/lodash-1.0.0.tgz' })),
      ctx,
    );
    expect(p.versions[0]!.artifact!.file).toBe('lodash-2.0.0.tgz');
  });

  it('serves no artifact twice when two versions resolve to the same file', () => {
    const d = doc({
      versions: {
        '1.0.0': { dist: { tarball: 'x/lodash-1.0.0.tgz' } },
        '1.0.0+build.1': { dist: { tarball: 'x/lodash-1.0.0.tgz' } },
      },
    });
    const p = processMetadata(raw(d), ctx);
    const files = p.versions.map((v) => v.artifact?.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it.each([
    ['no versions', { versions: {} }],
    ['no time map', { time: undefined }],
    ['no dist-tags', { 'dist-tags': undefined }],
    ['unicode content', { description: 'naïve 🚀   \ud800' }],
  ])('renders valid JSON with %s', (_label, overrides) => {
    const out = renderFull(['1.0.0', '1.1.0'], doc(overrides));
    expect(out.name).toBe('lodash');
  });

  it('keeps a version without a publish time, with publishedAt null', () => {
    const d = doc();
    delete (d.time as Record<string, unknown>)['1.1.0'];
    const p = processMetadata(raw(d), ctx);
    expect(p.versions[1]!.publishedAt).toBeNull();
    expect(Object.keys(renderFull(['1.0.0', '1.1.0'], d).time as object)).not.toContain('1.1.0');
  });

  it('repoints dist-tags that point at a filtered version', () => {
    const out = renderFull(['1.0.0']);
    expect(out['dist-tags']).toEqual({ latest: '1.0.0' });
  });

  it.each(['2020', '1', 'Jan 1 2000', '2020-01-01T00:00:00', '-000001-01-01T00:00:00Z'])(
    'treats the non-ISO publish time %j as unknown (fails closed)',
    (value) => {
      const d = doc();
      (d.time as Record<string, unknown>)['1.0.0'] = value;
      expect(processMetadata(raw(d), ctx).versions[0]!.publishedAt).toBeNull();
    },
  );

  it('keeps the payload in its own ArrayBuffer', () => {
    const p = processMetadata(raw(doc()), ctx);
    const full = (p.payload as { full: Uint8Array }).full;
    expect(full.byteOffset).toBe(0);
    expect(full.buffer.byteLength).toBe(full.length);
  });
});
