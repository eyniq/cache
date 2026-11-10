import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { send } from '../helpers/http.ts';

let cache: TestCache;

beforeAll(async () => {
  cache = await startCache();
  cache.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
});

afterAll(async () => {
  await cache.close();
});

describe('slice 3: probes', () => {
  it('answers /livez without I/O', async () => {
    const res = await send(cache.managementUrl, { path: '/livez' });
    expect(res.status).toBe(200);
  });

  it('answers /readyz when healthy', async () => {
    const res = await send(cache.managementUrl, { path: '/readyz' });
    expect(res.status).toBe(200);
  });

  it('reports not ready when storage is unreachable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eyniq-ready-'));
    const file = join(dir, 'not-a-dir');
    await writeFile(file, 'x');
    const broken = await startCache({ FS_ROOT: file });
    try {
      const res = await send(broken.managementUrl, { path: '/readyz' });
      expect(res.status).toBe(503);
      expect(res.body.toString()).toMatch(/storage/);
    } finally {
      await broken.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports not ready while the event loop is saturated', async () => {
    const busy = await startCache({ READY_MAX_LAG_MS: '20' });
    try {
      // Block the loop repeatedly so the p99 of the current window exceeds the threshold.
      for (let i = 0; i < 20; i++) {
        const until = Date.now() + 60;
        while (Date.now() < until) {
          /* busy */
        }
        await new Promise((r) => setImmediate(r));
      }
      const res = await send(busy.managementUrl, { path: '/readyz' });
      expect(res.status).toBe(503);
      expect(res.body.toString()).toMatch(/event loop/);
    } finally {
      await busy.close();
    }
  });
});

describe('slice 3: management port', () => {
  it('keeps probe paths free on the registry port (the npm package "metrics" exists)', async () => {
    cache.upstream.addPackage('metrics', [{ version: '1.0.0' }]);
    const res = await send(cache.url, { path: '/metrics' });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body.toString()) as { name: string }).name).toBe('metrics');
  });
});

describe('slice 3: metrics', () => {
  it('exposes Prometheus text with the documented metric families', async () => {
    await send(cache.url, { path: '/lodash' });
    await send(cache.url, { path: '/lodash' });
    await send(cache.url, { path: '/lodash/-/lodash-4.17.21.tgz' });
    const res = await send(cache.managementUrl, { path: '/metrics' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = res.body.toString();
    for (const family of [
      'eyniq_cache_http_requests_total',
      'eyniq_cache_http_request_duration_seconds_bucket',
      'eyniq_cache_cache_results_total',
      'eyniq_cache_coalesced_waiters_total',
      'eyniq_cache_upstream_requests_total',
      'eyniq_cache_upstream_errors_total',
      'eyniq_cache_upstream_request_duration_seconds_bucket',
      'eyniq_cache_blocked_versions_total',
      'eyniq_cache_tarball_bytes_served_total',
      'eyniq_cache_lru_bytes',
      'eyniq_cache_lru_evictions_total',
      'eyniq_cache_lru_lookups_total',
      'eyniq_cache_worker_queue_length',
      'eyniq_cache_event_loop_delay_seconds',
      'eyniq_cache_heap_used_bytes',
    ]) {
      expect(text, family).toContain(family);
    }
    expect(text).toMatch(/eyniq_cache_http_requests_total\{route="metadata",status="200"\} [1-9]/);
    expect(text).toMatch(/eyniq_cache_cache_results_total\{result="hit"\} [1-9]/);
    // /lodash twice: the first lookup misses the metadata LRU, the second hits it.
    expect(text).toMatch(/eyniq_cache_lru_lookups_total\{result="miss"\} [1-9]/);
    expect(text).toMatch(/eyniq_cache_lru_lookups_total\{result="hit"\} [1-9]/);
    expect(text).toMatch(/eyniq_cache_lru_lookups_total\{result="expired"\} 0/);
    expect(text).toMatch(/eyniq_cache_event_loop_delay_seconds\{quantile="0.99"\}/);
  });
});

describe('slice 3: bounded memory', () => {
  it('honours LRU_MAX_BYTES and falls back to the fresh stored copy, not upstream', async () => {
    const tiny = await startCache({ LRU_MAX_BYTES: '1' });
    try {
      tiny.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      expect((await send(tiny.url, { path: '/lodash' })).status).toBe(200);
      await tiny.running.drain();
      const second = await send(tiny.url, { path: '/lodash' });
      expect(second.status).toBe(200);
      expect(tiny.upstream.countPath('/lodash')).toBe(1);
    } finally {
      await tiny.close();
    }
  });

  it('refuses packuments above MAX_PACKUMENT_BYTES with a clear 502', async () => {
    const small = await startCache({ MAX_PACKUMENT_BYTES: '200' });
    try {
      small.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      const res = await send(small.url, { path: '/lodash' });
      expect(res.status).toBe(502);
      expect(res.body.toString()).toMatch(/MAX_PACKUMENT_BYTES/);
    } finally {
      await small.close();
    }
  });
});
