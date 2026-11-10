import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isStorageAdmin } from '../../src/core/storage.ts';
import { minuteKey } from '../../src/stats/keys.ts';
import { runStatsCli } from '../../src/stats/cli.ts';
import { diffSample } from '../../src/stats/points.ts';
import { dict, type HistogramSample } from '../../src/stats/types.ts';
import { send } from '../helpers/http.ts';
import { startServer } from '../helpers/server.ts';

async function listStats(t: Awaited<ReturnType<typeof startServer>>): Promise<string[]> {
  const storage = t.deps.storage;
  if (!isStorageAdmin(storage)) return [];
  return (await storage.list('stats/')).entries.map((e) => e.key);
}

describe('statistics history (H1)', () => {
  it('records the pod activity, flushes on shutdown and serves it on /stats and the CLI', async () => {
    const t = await startServer({ env: { POD_NAME: 'pod-it' } });
    try {
      t.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      expect((await send(t.url, { path: '/lodash' })).status).toBe(200);
      expect((await send(t.url, { path: '/lodash' })).status).toBe(200);
      await t.app.drain();
      await t.app.close(); // final tick and flush
      const keys = await listStats(t);
      expect(keys.some((k) => /^stats\/minute\/.*\/pod-it\.ndjson$/.test(k))).toBe(true);
      expect(keys.some((k) => /^stats\/hour\/.*\/pod-it\.ndjson$/.test(k))).toBe(true);
      expect(keys.some((k) => /^stats\/day\/.*\/pod-it\.ndjson$/.test(k))).toBe(true);

      let out = '';
      const code = await runStatsCli(['--range', '1h'], {
        env: {
          PUBLIC_URL: 'http://localhost:4873',
          FS_ROOT: t.root,
        },
        stdout: {
          write: (s) => {
            out += s;
          },
        },
        stderr: { write: () => true },
      });
      expect(code).toBe(0);
      expect(out).toMatch(/Requests:\s+2 /);
      expect(out).toContain('pod-it');
    } finally {
      await t.close();
    }
  });

  it('serves /stats on the management port only, validating its parameters', async () => {
    const t = await startServer({ env: { POD_NAME: 'pod-it' } });
    try {
      const now = Math.floor(Date.now() / 1000);
      const empty = {
        requests: dict<Record<string, number>>(),
        cache: dict<number>(),
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
      const cur = {
        ...empty,
        requests: Object.assign(dict<Record<string, number>>(), {
          packument: Object.assign(dict<number>(), { '2xx': 9 }),
        }),
      };
      const body = Buffer.from(`${JSON.stringify(diffSample(empty, cur, now - 60, 60))}\n`);
      await t.deps.storage.put(minuteKey(now - 60, 'pod-other'), Readable.from(body));

      const ok = await send(t.managementUrl, { path: '/stats?range=1h&step=auto' });
      expect(ok.status).toBe(200);
      const json = JSON.parse(ok.body.toString()) as {
        totals: { requests: number };
        pods: string[];
      };
      expect(json.totals.requests).toBe(9);
      expect(json.pods).toContain('pod-other');

      expect((await send(t.managementUrl, { path: '/stats?range=2y' })).status).toBe(400);
      expect((await send(t.managementUrl, { path: '/stats?range=1h&step=7' })).status).toBe(400);
      expect((await send(t.managementUrl, { path: '/stats', method: 'POST' })).status).toBe(405);
      // HEAD would compute the whole answer for nothing.
      expect((await send(t.managementUrl, { path: '/stats', method: 'HEAD' })).status).toBe(405);
      // The registry port must keep "/stats" free for a package of that name.
      t.upstream.addPackage('stats', [{ version: '1.0.0' }]);
      const pkg = await send(t.url, { path: '/stats' });
      expect(JSON.parse(pkg.body.toString())).toMatchObject({ name: 'stats' });
      const metrics = await send(t.managementUrl, { path: '/metrics' });
      expect(metrics.body.toString()).toContain('eyniq_cache_stats_write_errors_total 0');
    } finally {
      await t.close();
    }
  });

  it('can be switched off: no recording, no /stats', async () => {
    const t = await startServer({ env: { STATS_HISTORY: 'false' } });
    try {
      await send(t.url, { path: '/-/ping' });
      expect((await send(t.managementUrl, { path: '/stats' })).status).toBe(404);
      await t.app.close();
      expect(await listStats(t)).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
