// H2: the statistics page of the web catalog: same read authorization as the catalog, the
// data comes from the H1 reader, and nothing is served when the history or the catalog is off.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.ts';
import { minuteKey } from '../../src/stats/keys.ts';
import { diffSample } from '../../src/stats/points.ts';
import { dict, type HistogramSample, type StatsSample } from '../../src/stats/types.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { json, send } from '../helpers/http.ts';

const PASSWORD = 'correct horse battery';
let dir: string;
let hash: string;
const caches: TestCache[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-web-stats-'));
  hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
});

afterEach(async () => {
  while (caches.length > 0) await caches.pop()?.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}, withUsers = false): Promise<TestCache> {
  const extra: Record<string, string> = {};
  if (withUsers) {
    const t = '2026-10-01T00:00:00.000Z';
    const file = join(dir, `users-${String(caches.length)}-${String(Date.now())}.json`);
    await writeFile(
      file,
      JSON.stringify({ version: 1, users: { alice: { password: hash, created: t, changed: t } } }),
    );
    extra.USERS_FILE = file;
  }
  const cache = await startCache({ WEB_UI: 'true', POD_NAME: 'pod-web', ...extra, ...env });
  caches.push(cache);
  return cache;
}

async function seed(cache: TestCache, requests: number): Promise<void> {
  const empty: StatsSample = {
    requests: dict(),
    cache: dict(),
    coalesced: 0,
    upstreamRequests: 0,
    upstreamErrors: 0,
    blocked: 0,
    bytes: 0,
    evictions: 0,
    gauges: {
      lruBytes: 0,
      workerQueue: 0,
      rss: 1,
      heap: 1,
      loopP50: 0,
      loopP99: 0,
      writeQueue: 0,
      writesInFlight: 0,
    },
    latency: dict<HistogramSample>(),
  };
  const cur: StatsSample = {
    ...empty,
    requests: Object.assign(dict<Record<string, number>>(), {
      packument: Object.assign(dict<number>(), { '2xx': requests }),
    }),
  };
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(`${JSON.stringify(diffSample(empty, cur, now - 60, 60))}\n`);
  await new FsStorage(cache.root).put(minuteKey(now - 60, 'pod-seed'), Readable.from(body));
}

describe('H2: catalog statistics page', () => {
  it('serves the page shell and the data from the history reader', async () => {
    const cache = await start();
    await seed(cache, 12);
    const shell = await send(cache.url, { path: '/-/web/stats' });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toMatch(/^text\/html/);
    expect(shell.headers['content-security-policy']).toContain("style-src 'self'");
    expect(json(await send(cache.url, { path: '/-/web/api/session' }))).toMatchObject({
      stats: true,
    });

    const res = await send(cache.url, { path: '/-/web/api/stats?range=1h' });
    expect(res.status, res.body.toString()).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = json(res) as { totals: { requests: number }; pods: string[]; step: number };
    expect(data.totals.requests).toBe(12);
    expect(data.pods).toContain('pod-seed');
    expect(data.step).toBe(60);

    expect((await send(cache.url, { path: '/-/web/api/stats' })).status).toBe(200); // default 24h
    expect((await send(cache.url, { path: '/-/web/api/stats?range=3y' })).status).toBe(400);
    expect((await send(cache.url, { method: 'POST', path: '/-/web/api/stats' })).status).toBe(405);
  });

  it('needs the same sign-in as the rest of the catalog', async () => {
    const cache = await start({}, true);
    await seed(cache, 3);
    expect((await send(cache.url, { path: '/-/web/api/stats?range=1h' })).status).toBe(401);
    const login = await send(cache.url, {
      method: 'POST',
      path: '/-/web/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: cache.url },
      body: new URLSearchParams({ name: 'alice', password: PASSWORD }).toString(),
    });
    const set = login.headers['set-cookie'];
    const cookie = ((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? '';
    const ok = await send(cache.url, {
      path: '/-/web/api/stats?range=1h',
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
    expect((json(ok) as { totals: { requests: number } }).totals.requests).toBe(3);
  });

  it('is not served when the history is switched off', async () => {
    const cache = await start({ STATS_HISTORY: 'false' });
    expect((await send(cache.url, { path: '/-/web/api/stats' })).status).toBe(404);
    expect(json(await send(cache.url, { path: '/-/web/api/session' }))).toMatchObject({
      stats: false,
    });
  });

  it('is hidden by WEB_STATS=false while /stats on the management port stays', async () => {
    const cache = await start({ WEB_STATS: 'false' });
    expect((await send(cache.url, { path: '/-/web/api/stats' })).status).toBe(404);
    expect(json(await send(cache.url, { path: '/-/web/api/session' }))).toMatchObject({
      stats: false,
    });
    expect((await send(cache.managementUrl, { path: '/stats?range=1h' })).status).toBe(200);
  });

  it('does not exist without the web catalog', async () => {
    const cache = await startCache({ POD_NAME: 'pod-web' });
    caches.push(cache);
    expect((await send(cache.url, { path: '/-/web/api/stats' })).status).toBe(404);
  });
});
