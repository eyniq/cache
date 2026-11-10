import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

const summary = (p50: number, p95: number, p99: number) => ({ p50, p95, p99 });
const result = (rps: number, errors = 0, errorSamples: string[] = []) => ({
  rps,
  errors,
  timeouts: 0,
  errorSamples,
  metadata: summary(21, 892, 2107),
  tarballs: summary(23, 347, 1690),
});
const meta = (alive: boolean, seedDelta: number) => ({
  alive,
  serverCpuAvgPct: 187.1,
  serverRssMaxMiB: 1620,
  seedDelta,
  harnessCpuPct: 79,
});

describe('load/bench/render.ts', () => {
  it('renders one table per scenario with both runs of a cell and marks a dead server', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eyniq-bench-render-'));
    const put = (name: string, data: unknown) => writeFile(join(dir, name), JSON.stringify(data));
    await put('environment.json', { cpus: 16 });
    await put('eyniq-fs-cold4-1.json', result(433.2));
    await put('eyniq-fs-cold4-1.meta.json', meta(true, 1866));
    await put('eyniq-fs-cold4-2.json', result(454));
    await put('eyniq-fs-cold4-2.meta.json', meta(true, 1866));
    await put(
      'verdaccio-s3-warm16-1.json',
      result(235, 5776, ['x: read ECONNRESET', 'y: socket hang up']),
    );
    await put('verdaccio-s3-warm16-1.meta.json', meta(false, 9994));

    const out = execFileSync('node', ['load/bench/render.ts', dir], { encoding: 'utf8' });

    expect(out).toContain('#### Cold, 4 installs');
    expect(out).toContain('| Eyniq, filesystem | 433.2 / 454 | 21-892-2,107 / 21-892-2,107 |');
    expect(out).toContain('1,866 / 1,866');
    expect(out).toContain('#### Warm, 16 installs');
    expect(out).toContain('5,776 (read ECONNRESET, socket hang up)');
    expect(out).toMatch(/Verdaccio 6\.10\.5, S3 \(versitygw\) \|.*\| NO \|/);
    expect(out).not.toContain('#### Warm, 64 installs');
    expect(await readFile(join(dir, 'tables.md'), 'utf8')).toContain('"cpus": 16');
  });
});
