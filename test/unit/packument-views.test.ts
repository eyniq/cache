import { describe, expect, it } from 'vitest';
import {
  ABBREVIATED_CONTENT_TYPE,
  processMetadata,
  renderMetadata,
} from '../../src/adapters/npm/packument.ts';
import type { ProcessContext, RenderResult } from '../../src/core/contracts.ts';

const ctx: ProcessContext = {
  name: '@scope/pkg',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 10 * 1024 * 1024,
  options: {},
};

const doc = {
  _id: '@scope/pkg',
  _rev: '3-x',
  name: '@scope/pkg',
  readme: 'top readme',
  'dist-tags': { latest: '1.1.0', next: '2.0.0-beta.1' },
  versions: {
    '1.0.0': {
      name: '@scope/pkg',
      version: '1.0.0',
      readme: 'version readme',
      description: 'not in abbreviated',
      dependencies: { lodash: '^4.0.0' },
      peerDependencies: { react: '*' },
      peerDependenciesMeta: { react: { optional: true } },
      optionalDependencies: { fsevents: '*' },
      bin: { pkg: 'cli.js' },
      engines: { node: '>=18' },
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
      funding: 'https://example.invalid',
      deprecated: 'use 1.1.0',
      scripts: { test: 'vitest', postinstall: 'node build.js' },
      dist: {
        tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
        shasum: 'a'.repeat(40),
      },
    },
    '1.1.0': {
      name: '@scope/pkg',
      version: '1.1.0',
      scripts: { test: 'vitest' },
      dist: {
        tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.1.0.tgz',
        shasum: 'b'.repeat(40),
      },
    },
    '2.0.0-beta.1': {
      name: '@scope/pkg',
      version: '2.0.0-beta.1',
      _hasShrinkwrap: false,
      hasInstallScript: true,
      dist: {
        tarball: 'https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz',
        shasum: 'c'.repeat(40),
      },
    },
  },
  time: {
    created: '2020-01-01T00:00:00.000Z',
    modified: '2021-03-01T00:00:00.000Z',
    '1.0.0': '2020-01-01T00:00:00.000Z',
    '1.1.0': '2020-06-01T00:00:00.000Z',
    '2.0.0-beta.1': '2021-03-01T00:00:00.000Z',
  },
};

const processed = processMetadata(
  { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' },
  ctx,
);
const all = new Set(['1.0.0', '1.1.0', '2.0.0-beta.1']);

function ok(r: RenderResult): Record<string, unknown> {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  return JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
}

describe('abbreviated packument', () => {
  const out = renderMetadata({ processed, allowed: all, view: 'abbreviated' });

  it('uses the npm install media type', () => {
    expect(out.status === 200 && out.contentType).toBe(ABBREVIATED_CONTENT_TYPE);
  });

  it('has only the abbreviated top-level members', () => {
    const body = ok(out);
    expect(Object.keys(body).sort()).toEqual(['dist-tags', 'modified', 'name', 'versions']);
    expect(body.modified).toBe('2021-03-01T00:00:00.000Z');
    expect(body['dist-tags']).toEqual({ latest: '1.1.0', next: '2.0.0-beta.1' });
  });

  it('keeps install-relevant version fields and drops the rest', () => {
    const v = (ok(out).versions as Record<string, Record<string, unknown>>)['1.0.0']!;
    expect(v).toMatchObject({
      name: '@scope/pkg',
      version: '1.0.0',
      dependencies: { lodash: '^4.0.0' },
      peerDependencies: { react: '*' },
      peerDependenciesMeta: { react: { optional: true } },
      optionalDependencies: { fsevents: '*' },
      bin: { pkg: 'cli.js' },
      engines: { node: '>=18' },
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
      deprecated: 'use 1.1.0',
      hasInstallScript: true,
    });
    expect((v.dist as { tarball: string }).tarball).toBe(
      'https://cache.example/@scope/pkg/-/pkg-1.0.0.tgz',
    );
    expect(v.readme).toBeUndefined();
    expect(v.description).toBeUndefined();
    expect(v.scripts).toBeUndefined();
  });

  it('computes hasInstallScript only for install lifecycle scripts', () => {
    const versions = ok(out).versions as Record<string, Record<string, unknown>>;
    expect(versions['1.1.0']!.hasInstallScript).toBeUndefined();
    expect(versions['2.0.0-beta.1']!.hasInstallScript).toBe(true);
  });

  it('filters versions and dist-tags like the full document', () => {
    const body = ok(
      renderMetadata({ processed, allowed: new Set(['1.0.0', '1.1.0']), view: 'abbreviated' }),
    );
    expect(Object.keys(body.versions as object)).toEqual(['1.0.0', '1.1.0']);
    expect(body['dist-tags']).toEqual({ latest: '1.1.0' });
  });
});

describe('version documents', () => {
  it('serves one version by number with the rewritten tarball URL', () => {
    const v = ok(renderMetadata({ processed, allowed: all, view: 'version', ref: '1.1.0' }));
    expect(v.version).toBe('1.1.0');
    expect((v.dist as { tarball: string }).tarball).toBe(
      'https://cache.example/@scope/pkg/-/pkg-1.1.0.tgz',
    );
  });

  it('resolves dist-tags', () => {
    const v = ok(renderMetadata({ processed, allowed: all, view: 'version', ref: 'next' }));
    expect(v.version).toBe('2.0.0-beta.1');
  });

  it('returns 404 for unknown and filtered versions', () => {
    expect(renderMetadata({ processed, allowed: all, view: 'version', ref: '9.9.9' }).status).toBe(
      404,
    );
    expect(
      renderMetadata({ processed, allowed: new Set(['1.0.0']), view: 'version', ref: '1.1.0' })
        .status,
    ).toBe(404);
    // A tag whose target is filtered is repointed (slice 4), so `latest` resolves to 1.0.0.
    const latest = renderMetadata({
      processed,
      allowed: new Set(['1.0.0']),
      view: 'version',
      ref: 'latest',
    });
    expect(ok(latest).version).toBe('1.0.0');
  });
});
