// The logic behind the dashboard: sums, the comparison with the previous period, the health
// thresholds and the refresh schedule. Plain functions of the client module, no DOM.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Level = 'ok' | 'warn' | 'bad' | 'idle';
interface Bucket {
  t: number;
  requests: number;
  classes: Record<string, number>;
  cache?: Record<string, number>;
  hitRatio: number | null;
  upstreamRequests: number;
  upstreamErrors: number;
  blocked: number;
  bytes?: number;
  gauges?: Record<string, { avg: number; max: number }>;
  latency: { p50: number; p95: number; p99: number } | null;
  writes?: { ok: number; failed: number; dropped: number; retries: number };
}
interface Stats {
  range: string;
  from: number;
  to: number;
  step: number;
  pods: string[];
  truncated: boolean;
  totals: Bucket;
  series: Bucket[];
  perPod: Record<string, Array<{ t: number; rss: number; heap: number }>>;
}
interface Summary {
  requests: number;
  hitRatio: number | null;
  upstreamErrorRatio: number | null;
  p95: number | null;
  blocked: number;
  buckets: number;
}
interface Delta {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
  direction: 'up' | 'down' | 'flat';
}
interface Refresher {
  start(): void;
  stop(): void;
  visibilityChanged(): void;
  setPaused(v: boolean): void;
  refreshNow(): Promise<void>;
}
interface Metrics {
  THRESHOLDS: Record<string, unknown>;
  REFRESH_INTERVAL_MS: number;
  COMPARE_RANGE: Record<string, string>;
  summarize(b: Bucket[]): Summary;
  previousPeriod(cur: Stats, wider: Stats | null): Summary | null;
  delta(
    cur: number | null,
    prev: number | null | undefined,
    how: { kind: 'relative' | 'points'; better: 'up' | 'down' | 'none' },
  ): Delta | null;
  assess(d: Stats): { level: Level; label: string; checks: Array<{ id: string; level: Level }> };
  podStatuses(d: Stats): Array<{ name: string; reporting: boolean; lastSeen: number | null }>;
  cacheBreakdown(c: Record<string, number> | undefined): {
    total: number;
    segments: Array<{ key: string; value: number; share: number; slot: string }>;
  };
  createRefresher(o: {
    run: () => Promise<void>;
    intervalMs?: number;
    isHidden: () => boolean;
    now?: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (id: unknown) => void;
  }): Refresher;
  formatAge(s: number): string;
  formatDuration(s: number): string;
  formatBytes(n: number): string;
}

const m = (await import(
  /* @vite-ignore */ pathToFileURL(
    join(import.meta.dirname, '..', '..', 'src', 'web', 'static', 'metrics.js'),
  ).href
)) as Metrics;

const bucket = (t: number, over: Partial<Bucket> = {}): Bucket => ({
  t,
  requests: 100,
  classes: { '2xx': 100 },
  cache: { hit: 80, miss: 20 },
  hitRatio: 0.8,
  upstreamRequests: 20,
  upstreamErrors: 0,
  blocked: 2,
  bytes: 1000,
  gauges: { loopP99: { avg: 0.01, max: 0.02 } },
  latency: { p50: 0.01, p95: 0.2, p99: 0.4 },
  writes: { ok: 50, failed: 0, dropped: 0, retries: 0 },
  ...over,
});

const stats = (over: Partial<Stats> = {}, totals: Partial<Bucket> = {}): Stats => ({
  range: '1h',
  from: 10_000,
  to: 13_600,
  step: 60,
  pods: ['a'],
  truncated: false,
  totals: bucket(10_000, { requests: 1000, upstreamRequests: 100, ...totals }),
  series: [bucket(13_000), bucket(13_500)],
  perPod: { a: [{ t: 13_500, rss: 1, heap: 1 }] },
  ...over,
});

const levelOf = (d: Stats, id: string) => m.assess(d).checks.find((c) => c.id === id)?.level;

describe('sums and the previous period', () => {
  it('recomputes the hit ratio from the cache counts instead of averaging ratios', () => {
    const s = m.summarize([
      bucket(1, { cache: { hit: 1, miss: 0 }, hitRatio: 1 }),
      bucket(2, { cache: { hit: 0, revalidated: 10, stale: 10, miss: 60, coalesced: 19 } }),
    ]);
    // (1 + 20) hits of 100 lookups, not the mean of 100% and 20%.
    expect(s.hitRatio).toBeCloseTo(0.21, 6);
    expect(s.requests).toBe(200);
    expect(m.summarize([]).hitRatio).toBeNull();
  });

  it('takes the worst p95 of the buckets, as the server does for a range', () => {
    const s = m.summarize([
      bucket(1, { latency: { p50: 0, p95: 0.3, p99: 1 } }),
      bucket(2, { latency: null }),
      bucket(3, { latency: { p50: 0, p95: 0.9, p99: 1 } }),
    ]);
    expect(s.p95).toBe(0.9);
  });

  it('takes the period right before the range from the buckets of a longer range', () => {
    const cur = stats();
    const wider = stats({
      range: '24h',
      from: 13_600 - 86_400,
      step: 300,
      series: [
        bucket(6_000, { requests: 7 }), // before the previous hour
        bucket(6_600, { requests: 40 }),
        bucket(9_600, { requests: 10 }),
        bucket(10_200, { requests: 500 }), // already inside the current hour
      ],
    });
    const prev = m.previousPeriod(cur, wider);
    expect(prev?.requests).toBe(50);
    expect(prev?.buckets).toBe(2);
  });

  it('has no previous period when the longer range starts too late or recorded nothing', () => {
    const cur = stats();
    expect(m.previousPeriod(cur, null)).toBeNull();
    expect(
      m.previousPeriod(cur, stats({ range: '24h', from: 9_000, step: 300, series: [] })),
    ).toBeNull();
    expect(
      m.previousPeriod(
        cur,
        stats({ range: '24h', from: 13_600 - 86_400, step: 300, series: [bucket(12_000)] }),
      ),
    ).toBeNull();
  });

  it('knows a longer range for every range but the longest', () => {
    expect(m.COMPARE_RANGE).toEqual({
      '1h': '24h',
      '24h': '7d',
      '7d': '30d',
      '30d': '90d',
      '90d': '1y',
    });
  });
});

describe('deltas', () => {
  it('reports counts as a percent change and judges the direction', () => {
    expect(m.delta(150, 100, { kind: 'relative', better: 'none' })).toMatchObject({
      text: '+50%',
      tone: 'neutral',
      direction: 'up',
    });
    expect(m.delta(0.1, 0.2, { kind: 'relative', better: 'down' })).toMatchObject({
      text: '−50%',
      tone: 'good',
      direction: 'down',
    });
    expect(m.delta(0.3, 0.2, { kind: 'relative', better: 'down' })?.tone).toBe('bad');
  });

  it('reports ratios in percentage points', () => {
    expect(m.delta(0.9, 0.8, { kind: 'points', better: 'up' })).toMatchObject({
      text: '+10.0 pt',
      tone: 'good',
    });
    expect(m.delta(0.02, 0.01, { kind: 'points', better: 'down' })).toMatchObject({
      text: '+1.0 pt',
      tone: 'bad',
    });
  });

  it('calls a tiny change no change, and has nothing to say without a previous value', () => {
    expect(m.delta(1001, 1000, { kind: 'relative', better: 'up' })).toMatchObject({
      text: 'no change',
      tone: 'neutral',
      direction: 'flat',
    });
    expect(m.delta(0.9, 0.9001, { kind: 'points', better: 'up' })?.direction).toBe('flat');
    expect(m.delta(5, null, { kind: 'relative', better: 'up' })).toBeNull();
    expect(m.delta(5, undefined, { kind: 'relative', better: 'up' })).toBeNull();
    expect(m.delta(null, 5, { kind: 'points', better: 'up' })).toBeNull();
  });

  it('does not divide by a previous zero', () => {
    expect(m.delta(5, 0, { kind: 'relative', better: 'down' })).toMatchObject({
      text: 'new',
      tone: 'neutral',
    });
    expect(m.delta(0, 0, { kind: 'relative', better: 'down' })?.direction).toBe('flat');
  });
});

describe('health thresholds', () => {
  it('is healthy for clean traffic', () => {
    const h = m.assess(stats());
    expect(h.level).toBe('ok');
    expect(h.label).toBe('Healthy');
  });

  it('grades the share of 5xx answers at 1% and 5%', () => {
    expect(levelOf(stats({}, { classes: { '5xx': 9 } }), 'errors')).toBe('ok');
    expect(levelOf(stats({}, { classes: { '5xx': 10 } }), 'errors')).toBe('warn');
    expect(levelOf(stats({}, { classes: { '5xx': 50 } }), 'errors')).toBe('bad');
    expect(m.assess(stats({}, { classes: { '5xx': 50 } })).label).toBe('Failing');
  });

  it('grades upstream failures at 5% and 25%', () => {
    expect(levelOf(stats({}, { upstreamErrors: 4 }), 'upstream')).toBe('ok');
    expect(levelOf(stats({}, { upstreamErrors: 5 }), 'upstream')).toBe('warn');
    expect(levelOf(stats({}, { upstreamErrors: 25 }), 'upstream')).toBe('bad');
    expect(m.assess(stats({}, { upstreamErrors: 5 })).label).toBe('Degraded');
  });

  it('does not judge a ratio on a handful of samples', () => {
    // One failure out of two fetches is not an incident.
    const few = stats(
      {},
      { upstreamRequests: 2, upstreamErrors: 1, requests: 4, classes: { '5xx': 1 } },
    );
    expect(levelOf(few, 'upstream')).toBe('idle');
    expect(levelOf(few, 'errors')).toBe('idle');
    expect(m.assess(few).level).not.toBe('bad');
    expect(m.assess(few).level).not.toBe('warn');
  });

  it('grades latency p95 at 3 s and 10 s and the event loop at 100 ms and 500 ms', () => {
    const lat = (p95: number) => stats({}, { latency: { p50: 0, p95, p99: p95 } });
    expect(levelOf(lat(2.9), 'latency')).toBe('ok');
    expect(levelOf(lat(3), 'latency')).toBe('warn');
    expect(levelOf(lat(10), 'latency')).toBe('bad');
    expect(levelOf(stats({}, { latency: null }), 'latency')).toBe('idle');
    const loop = (max: number) => stats({}, { gauges: { loopP99: { avg: 0, max } } });
    expect(levelOf(loop(0.09), 'loop')).toBe('ok');
    expect(levelOf(loop(0.1), 'loop')).toBe('warn');
    expect(levelOf(loop(0.5), 'loop')).toBe('bad');
  });

  it('warns on any lost storage write and fails from 5% of enough writes', () => {
    const w = (failed: number, dropped: number, ok = 100) =>
      stats({}, { writes: { ok, failed, dropped, retries: 0 } });
    expect(levelOf(w(0, 0), 'writes')).toBe('ok');
    expect(levelOf(w(1, 0), 'writes')).toBe('warn');
    expect(levelOf(w(3, 3), 'writes')).toBe('bad');
    expect(levelOf(w(1, 0, 3), 'writes')).toBe('warn');
    expect(levelOf(w(0, 0, 0), 'writes')).toBe('idle');
  });

  it('has no opinion without data', () => {
    const h = m.assess(stats({ series: [], perPod: {} }, { requests: 0, upstreamRequests: 0 }));
    expect(h.level).toBe('idle');
    expect(h.label).toBe('No data');
  });
});

describe('pods', () => {
  it('counts a pod as reporting within the write lag, and old pods as not reporting', () => {
    // 1h range, 60 s buckets: a record up to 16 minutes old is still fine (5 min flush).
    const d = stats({
      perPod: {
        fresh: [{ t: 13_500, rss: 1, heap: 1 }],
        lagging: [{ t: 13_600 - 900, rss: 1, heap: 1 }],
        gone: [{ t: 13_600 - 2_000, rss: 1, heap: 1 }],
      },
    });
    const pods = m.podStatuses(d);
    expect(pods.map((p) => [p.name, p.reporting])).toEqual([
      ['fresh', true],
      ['lagging', true],
      ['gone', false],
    ]);
    // A pod of an earlier rollout never degrades the overall status.
    expect(m.assess(d).level).toBe('ok');
  });

  it('scales the allowance with the bucket width of long ranges', () => {
    const d = stats({
      range: '7d',
      from: 0,
      to: 7 * 86_400,
      step: 3600,
      perPod: { a: [{ t: 7 * 86_400 - 3 * 3600, rss: 1, heap: 1 }] },
    });
    expect(m.podStatuses(d)[0]?.reporting).toBe(true);
  });
});

describe('cache breakdown', () => {
  it('keeps a fixed order and color per result and folds unknown results into Other', () => {
    const b = m.cacheBreakdown({ miss: 30, hit: 60, mystery: 10 });
    expect(b.total).toBe(100);
    expect(b.segments.map((s) => [s.key, s.value, s.slot])).toEqual([
      ['hit', 60, 's0'],
      ['revalidated', 0, 's2'],
      ['stale', 0, 's3'],
      ['miss', 30, 's1'],
      ['coalesced', 0, 'sn'],
      ['passthrough', 0, 'so'],
      ['other', 10, 'so'],
    ]);
    expect(b.segments[0]?.share).toBeCloseTo(0.6, 6);
    expect(m.cacheBreakdown(undefined).total).toBe(0);
  });
});

describe('auto-refresh', () => {
  function harness(opts: { fail?: boolean } = {}) {
    let now = 0;
    let hidden = false;
    let runs = 0;
    let pending: (() => void) | null = null;
    let release: (() => void) | null = null;
    const r = m.createRefresher({
      intervalMs: 30_000,
      now: () => now,
      isHidden: () => hidden,
      setTimer: (fn) => {
        pending = fn;
        return fn;
      },
      clearTimer: (id) => {
        if (pending === id) pending = null;
      },
      run: () => {
        runs++;
        if (opts.fail === true) return Promise.reject(new Error('down'));
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    return {
      r,
      runs: () => runs,
      armed: () => pending !== null,
      setHidden: (v: boolean) => {
        hidden = v;
      },
      /** Lets `ms` pass and fires the timer. */
      async fire(ms = 30_000) {
        now += ms;
        const fn = pending;
        pending = null;
        fn?.();
        await Promise.resolve();
      },
      async finish() {
        release?.();
        release = null;
        await new Promise((res) => setTimeout(res, 0));
      },
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it('refreshes every 30 s by default', () => {
    expect(m.REFRESH_INTERVAL_MS).toBe(30_000);
  });

  it('runs on every tick and re-arms itself', async () => {
    const h = harness();
    h.r.start();
    expect(h.runs()).toBe(0);
    await h.fire();
    expect(h.runs()).toBe(1);
    await h.finish();
    expect(h.armed()).toBe(true);
    await h.fire();
    expect(h.runs()).toBe(2);
  });

  it('skips ticks while the tab is hidden and catches up at once when it shows again', async () => {
    const h = harness();
    h.r.start();
    h.setHidden(true);
    await h.fire();
    await h.fire();
    expect(h.runs()).toBe(0);
    expect(h.armed()).toBe(true);
    h.setHidden(false);
    h.r.visibilityChanged();
    expect(h.runs()).toBe(1);
  });

  it('does not reload on becoming visible when the data is still fresh', async () => {
    const h = harness();
    h.r.start();
    await h.fire();
    await h.finish();
    h.advance(5_000);
    h.setHidden(true);
    h.setHidden(false);
    h.r.visibilityChanged();
    expect(h.runs()).toBe(1);
  });

  it('never overlaps two runs', async () => {
    const h = harness();
    h.r.start();
    await h.fire();
    await h.fire();
    void h.r.refreshNow();
    expect(h.runs()).toBe(1);
    await h.finish();
    await h.fire();
    expect(h.runs()).toBe(2);
  });

  it('stays quiet while paused and resumes', async () => {
    const h = harness();
    h.r.start();
    h.r.setPaused(true);
    await h.fire();
    expect(h.runs()).toBe(0);
    h.r.setPaused(false);
    expect(h.runs()).toBe(1);
  });

  it('stops for good: no timer left, no late run', async () => {
    const h = harness();
    h.r.start();
    h.r.stop();
    expect(h.armed()).toBe(false);
    h.r.visibilityChanged();
    await h.r.refreshNow();
    expect(h.runs()).toBe(0);
  });

  it('keeps its schedule when a run fails', async () => {
    const h = harness({ fail: true });
    h.r.start();
    await h.fire();
    await new Promise((res) => setTimeout(res, 0));
    expect(h.armed()).toBe(true);
    await h.fire();
    expect(h.runs()).toBe(2);
  });
});

describe('formatting', () => {
  it('formats ages, durations and sizes for people', () => {
    expect(m.formatAge(10)).toBe('just now');
    expect(m.formatAge(300)).toBe('5 min ago');
    expect(m.formatAge(7200)).toBe('2 h ago');
    expect(m.formatAge(86_400 * 12)).toBe('12 d ago');
    expect(m.formatDuration(0.2)).toBe('200 ms');
    expect(m.formatDuration(1.239)).toBe('1.24 s');
    expect(m.formatDuration(0.0002)).toBe('<1 ms');
    expect(m.formatBytes(512)).toBe('512 B');
    expect(m.formatBytes(1536)).toBe('1.50 KiB');
    expect(m.formatBytes(50 * 1024 * 1024)).toBe('50.0 MiB');
  });
});
