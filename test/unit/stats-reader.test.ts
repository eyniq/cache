import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Storage } from '../../src/core/contracts.ts';
import { minuteKey, hourKey } from '../../src/stats/keys.ts';
import { diffSample, rollup } from '../../src/stats/points.ts';
import { StatsBusyError, StatsReader, StatsUnavailableError } from '../../src/stats/reader.ts';
import { formatSummary } from '../../src/stats/summary.ts';
import { dict, type StatsPoint, type StatsSample } from '../../src/stats/types.ts';
import { FsStorage } from '../../src/storage/fs.ts';

const NOW = Date.UTC(2026, 9, 17, 13, 30, 0) / 1000;

let root: string;
let storage: FsStorage;

function point(t: number, requests: number, rss = 1000, hit = 0, miss = 0): StatsPoint {
  const classes = dict<number>();
  classes['2xx'] = requests;
  const reqs = dict<Record<string, number>>();
  reqs.packument = classes;
  const cache = dict<number>();
  cache.hit = hit;
  cache.miss = miss;
  const cur: StatsSample = {
    requests: reqs,
    cache,
    coalesced: 0,
    upstreamRequests: miss,
    upstreamErrors: 0,
    blocked: 0,
    bytes: 100,
    evictions: 0,
    gauges: {
      lruBytes: 1,
      workerQueue: 0,
      rss,
      heap: rss / 2,
      loopP50: 0,
      loopP99: 0,
      writeQueue: 0,
      writesInFlight: 0,
    },
    latency: dict(),
  };
  const empty: StatsSample = {
    ...cur,
    requests: dict(),
    cache: dict(),
    bytes: 0,
    upstreamRequests: 0,
  };
  return diffSample(empty, cur, t, 60);
}

async function write(key: string, points: StatsPoint[]): Promise<void> {
  const body = Buffer.from(`${points.map((p) => JSON.stringify(p)).join('\n')}\n`);
  await storage.put(key, Readable.from(body));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-stats-reader-'));
  storage = new FsStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('StatsReader', () => {
  it('merges pods into one series: counters add up, memory stays per pod', async () => {
    const t1 = NOW - 600;
    const t2 = NOW - 300;
    await write(minuteKey(t1, 'pod-a'), [point(t1, 10, 1000, 8, 2), point(t2, 20, 2000, 10, 10)]);
    await write(minuteKey(t1, 'pod-b'), [point(t1, 5, 4000, 5, 0)]);
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('1h');
    expect(r.pods).toEqual(['pod-a', 'pod-b']);
    expect(r.totals.requests).toBe(35);
    expect(r.totals.hitRatio).toBeCloseTo(23 / 35, 6);
    expect(r.totals.gauges.rss.max).toBe(4000);
    const bucket = r.series.find((b) => b.t === Math.floor(t1 / 60) * 60);
    expect(bucket?.requests).toBe(15);
    expect(r.perPod['pod-b']?.[0]).toMatchObject({ rss: 4000 });
    expect(r.step).toBe(60);
    expect(r.truncated).toBe(false);
  });

  it('answers long ranges from the hour and day tiers', async () => {
    const dayAgo = NOW - 3 * 86_400;
    await write(hourKey(dayAgo, 'pod-a'), [
      rollup([point(dayAgo, 100)], Math.floor(dayAgo / 3600) * 3600),
    ]);
    const week = await new StatsReader(storage, { now: () => NOW * 1000 }).query('7d');
    expect(week.tier).toBe('hour');
    expect(week.totals.requests).toBe(100);
    expect(week.series).toHaveLength(1);
  });

  it('leaves out objects outside the range, malformed lines and unreadable objects', async () => {
    await write(minuteKey(NOW - 600, 'pod-a'), [point(NOW - 600, 3)]);
    await write(minuteKey(NOW - 7200, 'pod-a'), [point(NOW - 7200, 99)]); // older than 1h
    await storage.put(minuteKey(NOW - 300, 'pod-b'), Readable.from(Buffer.from('garbage\n')));
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('1h');
    expect(r.totals.requests).toBe(3);
    expect(r.skipped).toBe(1);
  });

  it('counts unparsable lines of a readable object as skipped', async () => {
    const key = minuteKey(NOW - 600, 'pod-a');
    const good = JSON.stringify(point(NOW - 600, 4));
    await storage.put(key, Readable.from(Buffer.from(`${good}\nnot json\n{"t":1}\n`)));
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('1h');
    expect(r.totals.requests).toBe(4);
    expect(r.skipped).toBe(2);
  });

  it('keeps the pods that wrote most recently after 40 rollouts, not the alphabetical first', async () => {
    // Each rollout gets a new pod name; the oldest names sort first, the live pod sorts last.
    for (let i = 0; i < 40; i++) {
      const t = NOW - 86_000 + i * 2000;
      await write(minuteKey(t, `pod-${String(i).padStart(2, '0')}`), [point(t, 1)]);
    }
    await write(minuteKey(NOW - 60, 'zzz-live'), [point(NOW - 60, 100)]);
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('24h');
    expect(r.truncated).toBe(true);
    expect(r.pods).toHaveLength(32);
    expect(r.pods).toContain('zzz-live');
    expect(r.pods).toContain('pod-39');
    expect(r.pods).not.toContain('pod-00');
  });

  it('marks the result truncated when listing hits its page limit', async () => {
    const endless = Object.create(storage) as FsStorage;
    endless.list = () => Promise.resolve({ entries: [], cursor: 'more' });
    const r = await new StatsReader(endless, { now: () => NOW * 1000 }).query('1h');
    expect(r.truncated).toBe(true);
  });

  it('re-buckets other steps of a range from the cached raw points', async () => {
    await write(minuteKey(NOW - 600, 'pod-a'), [point(NOW - 600, 3), point(NOW - 540, 4)]);
    let lists = 0;
    const counting = Object.create(storage) as FsStorage;
    counting.list = (...args: Parameters<FsStorage['list']>) => {
      lists++;
      return storage.list(...args);
    };
    const reader = new StatsReader(counting, { now: () => NOW * 1000 });
    const fine = await reader.query('1h', 60);
    const first = lists;
    const coarse = await reader.query('1h', 3600);
    expect(lists).toBe(first);
    expect(fine.series.length).toBeGreaterThan(coarse.series.length);
    expect(coarse.totals.requests).toBe(7);
  });

  it('fails fast when two computations are already running', async () => {
    const release: Array<() => void> = [];
    const hanging = Object.create(storage) as FsStorage;
    let hang = true;
    hanging.list = (...args: Parameters<FsStorage['list']>) =>
      hang
        ? new Promise((resolve) => {
            release.push(() => {
              resolve({ entries: [] });
            });
          })
        : storage.list(...args);
    const reader = new StatsReader(hanging, { now: () => NOW * 1000 });
    const a = reader.query('1h');
    const b = reader.query('24h');
    await expect(reader.query('7d')).rejects.toBeInstanceOf(StatsBusyError);
    // A query that joins a running computation is not refused.
    const joined = reader.query('1h');
    hang = false;
    for (const r of release) r();
    await Promise.all([a, b, joined]);
    await expect(reader.query('7d')).resolves.toBeDefined();
  });

  it('caches an answer briefly and shares one in-flight computation', async () => {
    await write(minuteKey(NOW - 600, 'pod-a'), [point(NOW - 600, 3)]);
    let now = NOW * 1000;
    let lists = 0;
    const counting = Object.create(storage) as FsStorage;
    counting.list = (...args: Parameters<FsStorage['list']>) => {
      lists++;
      return storage.list(...args);
    };
    const reader = new StatsReader(counting, { now: () => now });
    await Promise.all([reader.query('1h'), reader.query('1h')]);
    const first = lists;
    expect(first).toBeGreaterThan(0);
    await reader.query('1h');
    expect(lists).toBe(first);
    now += 31_000;
    await reader.query('1h');
    expect(lists).toBeGreaterThan(first);
  });

  it('bounds the number of objects read', async () => {
    for (let i = 0; i < 450; i++) {
      await write(minuteKey(NOW - 86_000, `pod-${String(i).padStart(3, '0')}`), [
        point(NOW - 86_000, 1),
      ]);
    }
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('24h');
    expect(r.truncated).toBe(true);
    expect(r.pods.length).toBeLessThanOrEqual(32);
    // 450 writes to the file system take longer than the 5 s default on a busy CI runner.
  }, 20_000);

  it('refuses storage that cannot list', async () => {
    const plain: Storage = {
      get: (k) => storage.get(k),
      head: (k) => storage.head(k),
      check: () => storage.check(),
      put: (k, b, o) => (storage as Storage).put(k, b, o),
    };
    await expect(new StatsReader(plain).query('1h')).rejects.toBeInstanceOf(StatsUnavailableError);
  });
});

describe('formatSummary', () => {
  it('prints totals, hit ratio, upstream fetches, p95 and peak memory', async () => {
    await write(minuteKey(NOW - 600, 'pod-a'), [point(NOW - 600, 40, 5 * 1024 * 1024, 30, 10)]);
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('1h');
    const text = formatSummary(r);
    expect(text).toContain('Requests:        40');
    expect(text).toContain('Cache hit ratio: 75.0%');
    expect(text).toContain('10 fetches');
    expect(text).toContain('Memory peak:     5.0 MiB');
  });

  it('says so when nothing was recorded', async () => {
    const r = await new StatsReader(storage, { now: () => NOW * 1000 }).query('1h');
    expect(formatSummary(r)).toContain('No statistics recorded');
  });
});
