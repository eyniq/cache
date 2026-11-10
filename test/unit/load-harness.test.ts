import { describe, expect, it } from 'vitest';
import { compareReports } from '../../load/compare.ts';
import { parseLockfile } from '../../load/lockfile.ts';
import { percentile, summarize } from '../../load/stats.ts';

const PNPM_V9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  '@babel/code-frame@7.24.2':
    resolution: {integrity: sha512-xyz}
    engines: {node: '>=6.9.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-abc}

  react-dom@18.3.1:
    resolution: {integrity: sha512-def}
    peerDependencies:
      react: ^18.3.1

  local-thing@file:packages/local:
    resolution: {directory: packages/local, type: directory}

snapshots:

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      react: 18.3.1
`;

const PNPM_V6 = `lockfileVersion: '6.0'

packages:

  /@babel/core@7.24.0:
    resolution: {integrity: sha512-x}
    dev: true

  /react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-y}
`;

const NPM_V3 = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/lodash': { version: '4.17.21' },
    'node_modules/@types/node': { version: '20.1.0' },
    'node_modules/a/node_modules/lodash': { version: '3.10.1' },
    'node_modules/again/node_modules/lodash': { version: '3.10.1' },
    'node_modules/local': { link: true, resolved: 'packages/local' },
  },
});

describe('lockfile parsing', () => {
  it('reads pnpm v9 packages and ignores snapshots and local packages', () => {
    expect(parseLockfile(PNPM_V9, 'pnpm-lock.yaml')).toEqual([
      { name: '@babel/code-frame', version: '7.24.2' },
      { name: 'lodash', version: '4.17.21' },
      { name: 'react-dom', version: '18.3.1' },
    ]);
  });

  it('reads pnpm v6 packages with leading slashes and peer suffixes', () => {
    expect(parseLockfile(PNPM_V6, 'pnpm-lock.yaml')).toEqual([
      { name: '@babel/core', version: '7.24.0' },
      { name: 'react-dom', version: '18.2.0' },
    ]);
  });

  it('reads package-lock.json v3 and de-duplicates', () => {
    expect(parseLockfile(NPM_V3, 'package-lock.json')).toEqual([
      { name: 'lodash', version: '4.17.21' },
      { name: '@types/node', version: '20.1.0' },
      { name: 'lodash', version: '3.10.1' },
    ]);
  });

  it('rejects unknown lockfile formats', () => {
    expect(() => parseLockfile('{}', 'yarn.lock')).toThrow();
  });
});

describe('stats', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);

  it('computes nearest-rank percentiles', () => {
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([], 99)).toBe(0);
  });

  it('summarizes a sample', () => {
    expect(summarize([3, 1, 2])).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, max: 3, mean: 2 });
  });
});

describe('baseline comparison', () => {
  const report = (o: Record<string, unknown>) =>
    ({
      label: 'x',
      rps: 100,
      errors: 0,
      timeouts: 0,
      metadata: { count: 10, p50: 5, p95: 20, p99: 30, max: 40, mean: 6 },
      tarballs: { count: 10, p50: 5, p95: 20, p99: 30, max: 40, mean: 6 },
      server: {
        cpuPercentMax: 80,
        rssMaxBytes: 500e6,
        eventLoopP99Ms: 30,
        upstreamFetches: 100,
        hitRatio: 0.5,
      },
      ...o,
    }) as Parameters<typeof compareReports>[0];

  it('passes only when the candidate is not worse on any metric', () => {
    const baseline = report({});
    const better = report({
      rps: 200,
      metadata: { count: 10, p50: 1, p95: 2, p99: 3, max: 4, mean: 1 },
      server: {
        cpuPercentMax: 40,
        rssMaxBytes: 200e6,
        eventLoopP99Ms: 5,
        upstreamFetches: 20,
        hitRatio: 0.9,
      },
    });
    const result = compareReports(baseline, better);
    expect(result.pass).toBe(true);
    expect(result.rows.find((r) => r.metric === 'rps')?.verdict).toBe('better');
    expect(result.rows.find((r) => r.metric === 'errors')?.verdict).toBe('equal');

    const worse = compareReports(baseline, report({ errors: 3 }));
    expect(worse.pass).toBe(false);
    expect(worse.rows.find((r) => r.metric === 'errors')?.verdict).toBe('worse');
  });

  it('skips server metrics that a report does not have', () => {
    const result = compareReports(report({ server: {} }), report({}));
    expect(result.rows.some((r) => r.metric === 'server.hitRatio')).toBe(false);
    expect(result.notCompared).toContain('server.hitRatio');
  });
});
