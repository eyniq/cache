import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLoad } from '../../load/harness.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';

let cache: TestCache;
let dir: string;

beforeAll(async () => {
  cache = await startCache();
  cache.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
  cache.upstream.addPackage('@scope/thing', [{ version: '1.0.0' }]);
  dir = await mkdtemp(join(tmpdir(), 'eyniq-load-'));
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

describe('slice 6: load harness', () => {
  it('replays a package set as parallel installs and reports latency and errors', async () => {
    const result = await runLoad({
      registry: cache.url,
      packages: [
        { name: 'lodash', version: '4.17.21' },
        { name: '@scope/thing', version: '1.0.0' },
      ],
      installs: 3,
      concurrency: 4,
      timeoutMs: 10_000,
    });
    expect(result.errors).toBe(0);
    expect(result.timeouts).toBe(0);
    expect(result.metadata.count).toBe(6);
    expect(result.tarballs.count).toBe(6);
    expect(result.requests).toBe(12);
    expect(result.rps).toBeGreaterThan(0);
    // Tarballs are fetched from the URL the registry rewrote, as real clients do.
    expect(cache.upstream.countPath('/lodash/-/lodash-4.17.21.tgz')).toBe(1);
  });

  it('counts errors for packages the registry does not have', async () => {
    const result = await runLoad({
      registry: cache.url,
      packages: [{ name: 'does-not-exist', version: '1.0.0' }],
      installs: 1,
      concurrency: 1,
      timeoutMs: 10_000,
    });
    expect(result.errors).toBe(1);
    expect(result.errorSamples[0]).toMatch(/404/);
    // Failed requests do not count towards latency percentiles.
    expect(result.metadata.count).toBe(0);
  });

  it('runs from the command line and writes a JSON report with server metrics', async () => {
    const lock = join(dir, 'pnpm-lock.yaml');
    await writeFile(
      lock,
      "lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n",
    );
    const out = join(dir, 'report.json');
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          'load/run.ts',
          '--lockfile',
          lock,
          '--registry',
          cache.url,
          '--installs',
          '2',
          '--label',
          'test',
          '--metrics-url',
          `${cache.managementUrl}/metrics`,
          '--out',
          out,
        ],
        { stdio: 'ignore' },
      );
      child.on('close', (c) => {
        resolve(c ?? 1);
      });
    });
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ label: 'test', errors: 0, requests: 4 });
    expect(report.server).toMatchObject({ upstreamFetches: expect.any(Number) as unknown });
  });
});
