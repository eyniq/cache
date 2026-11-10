import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '../../src/core/contracts.ts';
import { readLimited } from '../../src/core/streams.ts';
import { StatsRecorder } from '../../src/stats/recorder.ts';
import { parsePoints } from '../../src/stats/points.ts';
import { dict, type StatsSample } from '../../src/stats/types.ts';
import { FsStorage } from '../../src/storage/fs.ts';

const T0 = Date.UTC(2026, 9, 17, 13, 0, 0);
const HOUR_KEY = 'stats/minute/2026/10/17/13/pod-a.ndjson';

let root: string;
let storage: FsStorage;
let nowMs: number;
let total: number;

function source(): StatsSample {
  const routeClasses = dict<number>();
  routeClasses['2xx'] = total;
  const requests = dict<Record<string, number>>();
  requests.packument = routeClasses;
  return {
    requests,
    cache: dict(),
    coalesced: 0,
    upstreamRequests: 0,
    upstreamErrors: 0,
    blocked: 0,
    bytes: 0,
    evictions: 0,
    gauges: {
      lruBytes: 1,
      workerQueue: 0,
      rss: 1000,
      heap: 500,
      loopP50: 0,
      loopP99: 0,
      writeQueue: 0,
      writesInFlight: 0,
    },
    latency: dict(),
  };
}

function recorder(over: Partial<ConstructorParameters<typeof StatsRecorder>[0]> = {}) {
  return new StatsRecorder({
    storage,
    source,
    pod: 'pod-a',
    intervalMs: 60_000,
    retention: { minuteMs: 7 * 86_400_000, hourMs: 90 * 86_400_000, dayMs: 0 },
    now: () => nowMs,
    ...over,
  });
}

async function readPoints(key: string) {
  const stream = await storage.get(key);
  if (!stream) return null;
  return parsePoints((await readLimited(stream, 1e7, () => new Error('big'))).toString());
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-stats-'));
  storage = new FsStorage(root);
  nowMs = T0;
  total = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('StatsRecorder', () => {
  it('writes deltas per tick into the pod hour object and rolls up hour and day', async () => {
    const r = recorder();
    r.start();
    for (const add of [10, 20, 30]) {
      nowMs += 60_000;
      total += add;
      r.tick();
    }
    await r.flush();
    const minutes = await readPoints(HOUR_KEY);
    expect(minutes?.map((p) => p.req.packument?.['2xx'])).toEqual([10, 20, 30]);
    expect(minutes?.[0]?.s).toBe(60);
    const hours = await readPoints('stats/hour/2026/10/17/pod-a.ndjson');
    expect(hours).toHaveLength(1);
    expect(hours?.[0]?.t).toBe(T0 / 1000);
    expect(hours?.[0]?.req.packument?.['2xx']).toBe(60);
    const days = await readPoints('stats/day/2026/10/pod-a.ndjson');
    expect(days?.[0]?.t).toBe(Date.UTC(2026, 9, 17) / 1000);
    expect(days?.[0]?.req.packument?.['2xx']).toBe(60);
  });

  it('does not flush before the flush interval has passed', async () => {
    const r = recorder({ flushIntervalMs: 300_000 });
    r.start();
    for (let i = 0; i < 4; i++) {
      nowMs += 60_000;
      total += 1;
      r.tick();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readPoints(HOUR_KEY)).toBeNull();
    nowMs += 60_000;
    total += 1;
    r.tick(); // five minutes since the start: this tick flushes
    await r.flush(); // waits for that flush (and flushes nothing new)
    expect((await readPoints(HOUR_KEY))?.length).toBe(5);
  });

  it('keeps the earlier run points when the same pod restarts within the hour', async () => {
    const first = recorder();
    first.start();
    nowMs += 60_000;
    total += 5;
    first.tick();
    await first.stop();
    total = 0;
    nowMs += 120_000;
    const second = recorder();
    second.start();
    nowMs += 60_000;
    total += 7;
    second.tick();
    await second.stop();
    const minutes = await readPoints(HOUR_KEY);
    expect(minutes?.map((p) => p.req.packument?.['2xx'])).toEqual([5, 7]);
    const hours = await readPoints('stats/hour/2026/10/17/pod-a.ndjson');
    expect(hours?.[0]?.req.packument?.['2xx']).toBe(12);
  });

  it('starts a new object when the hour changes and flushes the finished one', async () => {
    const r = recorder();
    r.start();
    nowMs = T0 + 3_540_000;
    total += 1;
    r.tick(); // 13:59
    nowMs = T0 + 3_600_000 + 60_000;
    total += 2;
    r.tick(); // 14:01, hour rolled
    await r.flush();
    expect((await readPoints(HOUR_KEY))?.length).toBe(1);
    expect((await readPoints('stats/minute/2026/10/17/14/pod-a.ndjson'))?.length).toBe(1);
    expect((await readPoints('stats/hour/2026/10/17/pod-a.ndjson'))?.length).toBe(2);
  });

  it('survives storage errors: counts them, never throws, and recovers', async () => {
    let failing = true;
    const flaky: Storage = {
      get: (k) => storage.get(k),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: (k, b, o) =>
        failing ? Promise.reject(new Error('disk full')) : (storage as Storage).put(k, b, o),
    };
    const onWriteError = vi.fn();
    const r = recorder({ storage: flaky, onWriteError });
    r.start();
    nowMs += 60_000;
    total += 1;
    r.tick();
    await expect(r.flush()).resolves.toBeUndefined();
    expect(onWriteError).toHaveBeenCalled();
    expect(await readPoints(HOUR_KEY)).toBeNull();
    failing = false;
    nowMs += 60_000;
    total += 1;
    r.tick();
    await r.flush();
    expect((await readPoints(HOUR_KEY))?.length).toBe(2);
  });

  it('bounds memory while storage is down', async () => {
    const down: Storage = {
      get: () => Promise.reject(new Error('down')),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: () => Promise.reject(new Error('down')),
    };
    const r = recorder({ storage: down });
    r.start();
    for (let h = 0; h < 12; h++) {
      nowMs += 3_600_000;
      total += 1;
      r.tick();
      await r.flush();
    }
    const internal = r as unknown as { objects: Map<string, unknown> };
    expect(internal.objects.size).toBeLessThanOrEqual(8);
  });

  it('prunes expired objects of every pod, keeps fresh ones, and waits 10 minutes after start', async () => {
    const put = (key: string) => storage.put(key, Readable.from(Buffer.from('x\n')));
    await put('stats/minute/2026/10/01/00/pod-a.ndjson'); // 16 days old: expired (7d)
    await put('stats/minute/2026/10/01/00/pod-b.ndjson'); // a dead pod of an old rollout: expired
    await put('stats/minute/2026/10/16/12/pod-a.ndjson'); // fresh: kept
    await put('stats/minute/2026/10/16/12/pod-b.ndjson'); // fresh other pod: kept
    await put('stats/hour/2026/10/01/pod-a.ndjson'); // 90d retention: kept
    await put('stats/day/2020/01/pod-a.ndjson'); // day retention 0: kept
    const r = recorder();
    r.start();
    nowMs += 60_000;
    r.tick();
    await r.flush();
    const exists = async (k: string) => (await storage.head(k)) !== null;
    // Too early after boot: nothing is pruned yet.
    expect(await exists('stats/minute/2026/10/01/00/pod-a.ndjson')).toBe(true);
    nowMs += 10 * 60_000;
    total += 1;
    r.tick();
    await r.flush();
    expect(await exists('stats/minute/2026/10/01/00/pod-a.ndjson')).toBe(false);
    expect(await exists('stats/minute/2026/10/01/00/pod-b.ndjson')).toBe(false);
    expect(await exists('stats/minute/2026/10/16/12/pod-a.ndjson')).toBe(true);
    expect(await exists('stats/minute/2026/10/16/12/pod-b.ndjson')).toBe(true);
    expect(await exists('stats/hour/2026/10/01/pod-a.ndjson')).toBe(true);
    expect(await exists('stats/day/2020/01/pod-a.ndjson')).toBe(true);
  });

  it('cleans up the objects of 40 dead pods from rollouts', async () => {
    const put = (key: string) => storage.put(key, Readable.from(Buffer.from('x\n')));
    for (let i = 0; i < 40; i++) {
      await put(`stats/minute/2026/10/01/${String(i % 24).padStart(2, '0')}/pod-old-${i}.ndjson`);
    }
    const r = recorder();
    r.start();
    nowMs += 11 * 60_000;
    total += 1;
    r.tick();
    await r.flush();
    const left = (await storage.list('stats/minute/2026/10/01/')).entries;
    expect(left).toHaveLength(0);
    expect(await readPoints(HOUR_KEY)).not.toBeNull();
  });

  it('does not prune on the final flush at shutdown', async () => {
    const put = (key: string) => storage.put(key, Readable.from(Buffer.from('x\n')));
    await put('stats/minute/2026/10/01/00/pod-b.ndjson');
    const r = recorder();
    r.start();
    nowMs += 11 * 60_000;
    total += 1;
    await r.stop();
    expect(await storage.head('stats/minute/2026/10/01/00/pod-b.ndjson')).not.toBeNull();
    expect((await readPoints(HOUR_KEY))?.length).toBe(1);
  });

  it('gives up on a hanging storage at shutdown instead of blocking it', async () => {
    const hanging: Storage = {
      get: () => new Promise(() => undefined),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: () => new Promise(() => undefined),
    };
    const r = recorder({ storage: hanging });
    r.start();
    nowMs += 60_000;
    total += 1;
    r.tick();
    const started = Date.now();
    await expect(r.stop(50)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not queue flushes while one is still running', async () => {
    let puts = 0;
    const slow: Storage = {
      get: (k) => storage.get(k),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: () => {
        puts++;
        return new Promise(() => undefined);
      },
    };
    const r = recorder({ storage: slow, flushIntervalMs: 60_000 });
    r.start();
    for (let i = 0; i < 5; i++) {
      nowMs += 60_000;
      total += 1;
      r.tick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(puts).toBe(1);
  });

  it('replaces an oversized object of its own instead of failing on it', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0x61);
    await storage.put(HOUR_KEY, Readable.from(big));
    const onWriteError = vi.fn();
    const r = recorder({ onWriteError });
    r.start();
    nowMs += 60_000;
    total += 1;
    r.tick();
    await r.flush();
    expect(onWriteError).not.toHaveBeenCalled();
    expect(await readPoints(HOUR_KEY)).toHaveLength(1);
  });

  it('skips pruning when the storage has no admin operations', async () => {
    const plain: Storage = {
      get: (k) => storage.get(k),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: (k, b, o) => (storage as Storage).put(k, b, o),
    };
    const onWriteError = vi.fn();
    const r = recorder({ storage: plain, onWriteError });
    r.start();
    nowMs += 60_000;
    total += 1;
    r.tick();
    await r.flush();
    expect(onWriteError).not.toHaveBeenCalled();
    expect((await readPoints(HOUR_KEY))?.length).toBe(1);
  });

  it('ticks on its own timer and writes a final partial point on stop', async () => {
    vi.useFakeTimers({ now: T0 });
    nowMs = T0;
    const r = recorder({ now: () => Date.now() });
    r.start();
    total += 4;
    await vi.advanceTimersByTimeAsync(60_000);
    total += 2;
    await vi.advanceTimersByTimeAsync(30_000);
    await r.stop();
    const minutes = await readPoints(HOUR_KEY);
    expect(minutes?.map((p) => p.req.packument?.['2xx'])).toEqual([4, 2]);
    expect(minutes?.[1]?.s).toBe(30);
  });
});
