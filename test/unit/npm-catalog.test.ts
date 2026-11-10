import { describe, expect, it } from 'vitest';
import { npmCatalog } from '../../src/adapters/npm/catalog.ts';
import { processMetadata } from '../../src/adapters/npm/packument.ts';
import type { CatalogInput, ProcessContext } from '../../src/core/contracts.ts';

const ctx: ProcessContext = {
  name: '@acme/lib',
  publicBaseUrl: 'https://npm.example.com',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 1 << 24,
  options: {},
};

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const version = (v: string, extra: Record<string, unknown> = {}) => ({
  name: '@acme/lib',
  version: v,
  dist: { tarball: `https://registry.npmjs.org/@acme/lib/-/lib-${v}.tgz`, integrity },
  ...extra,
});

function input(
  over: Partial<CatalogInput> = {},
  docOver: Record<string, unknown> = {},
): CatalogInput {
  const doc = {
    name: '@acme/lib',
    description: 'Shared helpers',
    readme: '# Lib\n\nHello',
    license: 'MIT',
    keywords: ['utils', 42],
    homepage: 'javascript:alert(1)',
    repository: { type: 'git', url: 'git+https://github.com/acme/lib.git' },
    bugs: { url: 'https://github.com/acme/lib/issues' },
    maintainers: [{ name: 'alice', email: 'a@x' }, { name: 'bob' }],
    'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
    versions: {
      '1.0.0': version('1.0.0', { deprecated: 'use 2' }),
      '2.0.0': version('2.0.0', {
        dependencies: { 'left-pad': '^1.0.0' },
        peerDependencies: { react: '>=18' },
        _npmUser: { name: 'alice' },
      }),
      '3.0.0-beta.1': version('3.0.0-beta.1'),
    },
    time: {
      '1.0.0': '2026-01-01T00:00:00.000Z',
      '2.0.0': '2026-02-01T00:00:00.000Z',
      '3.0.0-beta.1': '2026-10-15T00:00:00.000Z',
    },
    ...docOver,
  };
  const processed = processMetadata(
    { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' },
    ctx,
  );
  return {
    processed,
    allowed: new Set(['1.0.0', '2.0.0']),
    blocked: new Map([
      [
        '3.0.0-beta.1',
        {
          reason: 'blocked by minimum release age',
          allowedAfter: Date.parse('2026-10-18T00:00:00.000Z'),
        },
      ],
    ]),
    ...over,
  };
}

describe('npm catalog', () => {
  it('validates names like the registry', () => {
    expect(npmCatalog.isValidName('@acme/lib')).toBe(true);
    expect(npmCatalog.isValidName('lodash')).toBe(true);
    expect(npmCatalog.isValidName('../etc')).toBe(false);
    expect(npmCatalog.isValidName('')).toBe(false);
  });

  it('describes the package with safe links, newest versions first and served dist-tags', () => {
    const d = npmCatalog.describe(input());
    expect(d).toMatchObject({
      name: '@acme/lib',
      description: 'Shared helpers',
      license: 'MIT',
      keywords: ['utils'],
      maintainers: ['alice', 'bob'],
      links: {
        repository: 'https://github.com/acme/lib',
        bugs: 'https://github.com/acme/lib/issues',
      },
    });
    expect(d.links.homepage).toBeUndefined(); // javascript: is never a link
    expect(d.versions.map((v) => v.version)).toEqual(['3.0.0-beta.1', '2.0.0', '1.0.0']);
    // `next` points at a blocked prerelease with no allowed version of its channel: dropped.
    expect(d.distTags).toEqual([{ tag: 'latest', version: '2.0.0' }]);
  });

  it('marks blocked versions with the reason and never offers them for download', () => {
    const d = npmCatalog.describe(input());
    const beta = d.versions.find((v) => v.version === '3.0.0-beta.1');
    expect(beta?.blocked).toEqual({
      reason: 'blocked by minimum release age',
      allowedAfter: '2026-10-18T00:00:00.000Z',
    });
    const blocked = npmCatalog.describe(input({ version: '3.0.0-beta.1' }));
    expect(blocked.selected?.version).toBe('3.0.0-beta.1');
    expect(blocked.selected?.blocked?.reason).toBe('blocked by minimum release age');
    expect(blocked.selected?.download).toBeUndefined();
    expect(blocked.install).toEqual([]);
  });

  it('details the selected (default: latest) version with dependencies, install and download', () => {
    const d = npmCatalog.describe(input());
    expect(d.selected).toMatchObject({
      version: '2.0.0',
      published: '2026-02-01T00:00:00.000Z',
      publisher: 'alice',
      download: { url: 'https://npm.example.com/@acme/lib/-/lib-2.0.0.tgz', integrity },
      dependencies: [
        { kind: 'dependencies', entries: [{ name: 'left-pad', range: '^1.0.0' }] },
        { kind: 'peerDependencies', entries: [{ name: 'react', range: '>=18' }] },
      ],
    });
    expect(d.install).toEqual([
      { label: 'npm', command: 'npm install @acme/lib@2.0.0' },
      { label: 'pnpm', command: 'pnpm add @acme/lib@2.0.0' },
      { label: 'yarn', command: 'yarn add @acme/lib@2.0.0' },
    ]);
    expect(npmCatalog.describe(input({ version: '1.0.0' })).selected?.deprecated).toBe('use 2');
    expect(npmCatalog.describe(input({ version: '9.9.9' })).selected).toBeNull();
  });

  it('returns the README source', () => {
    expect(npmCatalog.readme(input())).toBe('# Lib\n\nHello');
    expect(npmCatalog.readme(input({}, { readme: undefined }))).toBeNull();
  });

  it('maps a search response to plain results', () => {
    const body = Buffer.from(
      JSON.stringify({
        objects: [
          {
            package: {
              name: 'a',
              version: '1.0.0',
              description: 'A',
              date: '2026-01-01T00:00:00.000Z',
            },
          },
          { package: { name: 'b' } },
          'garbage',
        ],
        total: 7,
      }),
    );
    expect(npmCatalog.searchResults(body)).toEqual({
      total: 7,
      results: [
        { name: 'a', version: '1.0.0', description: 'A', date: '2026-01-01T00:00:00.000Z' },
      ],
    });
  });
});
