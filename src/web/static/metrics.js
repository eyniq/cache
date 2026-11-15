// @ts-check
// Pure logic of the dashboard and the statistics page: formatting, sums over buckets, the
// comparison with the previous period, the health thresholds and the refresh schedule. No DOM
// in here, so the unit tests import it directly.

/**
 * @typedef {{ avg: number, max: number }} GaugeStat
 * @typedef {{ p50: number, p95: number, p99: number }} Quantiles
 * @typedef {{ t: number, requests: number, classes: Record<string, number>,
 *   routes?: Record<string, number>, cache?: Record<string, number>,
 *   hitRatio: number | null, coalesced?: number, upstreamRequests: number,
 *   upstreamErrors: number, blocked: number, bytes?: number, evictions?: number,
 *   gauges?: Record<string, GaugeStat>, latency: Quantiles | null,
 *   writes?: { ok: number, failed: number, dropped: number, retries: number },
 *   writeLatency?: Quantiles | null }} StatsBucket
 * @typedef {{ requests: number, clientErrors: number, serverErrors: number,
 *   latency: Quantiles | null }} RouteStat
 * @typedef {{ range: string, from: number, to: number, step: number, pods: string[],
 *   truncated: boolean, skipped?: number, totals: StatsBucket, series: StatsBucket[],
 *   routeStats?: Record<string, RouteStat>,
 *   perPod: Record<string, Array<{ t: number, rss: number, heap: number }>> }} StatsResponse
 * @typedef {'ok' | 'warn' | 'bad' | 'idle'} Level
 * @typedef {{ id: string, label: string, level: Level, value: string, detail: string }} Check
 */

export const STATS_RANGES = ['1h', '24h', '7d', '30d', '90d', '1y'];

/** The longer range whose buckets hold the period before a range; none for the longest. */
export const COMPARE_RANGE = /** @type {Readonly<Record<string, string>>} */ ({
  '1h': '24h',
  '24h': '7d',
  '7d': '30d',
  '30d': '90d',
  '90d': '1y',
});

/** The share of the previous period that must be recorded before it is compared with. */
export const PREVIOUS_MIN_COVERAGE = 0.9;

/** The comparison range changes slowly: it is read again at most this often. */
export const COMPARE_REFRESH_MS = 300_000;

/** How often the dashboard and the statistics page reload their numbers. */
export const REFRESH_INTERVAL_MS = 30_000;

/**
 * Thresholds behind the status labels (documented in docs/OPERATIONS.md, "Web catalog").
 * A ratio only counts once there are enough samples, so one failure out of two never reads
 * as an incident.
 */
export const THRESHOLDS = Object.freeze({
  /** Share of 5xx answers among all requests. */
  serverErrors: { warn: 0.01, bad: 0.05, minSamples: 20 },
  /** Share of failed upstream fetches. */
  upstreamErrors: { warn: 0.05, bad: 0.25, minSamples: 10 },
  /**
   * Request latency p95 in seconds (worst pod and route of an interval, an upper bound). A
   * range's own figure is its worst interval, so one slow minute would mark a whole month:
   * the level counts the share of intervals at or above the limit instead.
   */
  latencyP95: { warn: 3, bad: 10, share: 0.05, minSamples: 5 },
  /** Event-loop delay p99 in seconds (highest sample of an interval), graded the same way. */
  loopP99: { warn: 0.1, bad: 0.5, share: 0.05, minSamples: 5 },
  /** Share of background storage writes that failed or were dropped; any loss warns. */
  writeLoss: { bad: 0.05, minSamples: 20 },
  /**
   * A pod counts as reporting while its newest record is at most this many buckets old, and
   * never less than `podStaleSeconds`: a pod writes its history every 5 minutes.
   */
  podStaleBuckets: 3,
  podStaleSeconds: 900,
});

// ---- Formatting --------------------------------------------------------------------------

/** @param {number} value */
export function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i] ?? 'B'}`;
}

/** Seconds as "850 ms" or "1.24 s". @param {number} seconds */
export function formatDuration(seconds) {
  const ms = seconds * 1000;
  if (ms < 1) return ms === 0 ? '0 ms' : '<1 ms';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * @param {number} value
 * @param {string} unit '%' (a 0..1 ratio), 'ms' (seconds), 'MiB' and 'bytes' (bytes), '/s'
 */
export function formatValue(value, unit) {
  if (unit === '%') return `${(value * 100).toFixed(value >= 0.9995 || value === 0 ? 0 : 1)}%`;
  if (unit === 'ms') return formatDuration(value);
  if (unit === 'MiB') return `${(value / 1048576).toFixed(value < 10485760 ? 1 : 0)} MiB`;
  if (unit === 'bytes') return formatBytes(value);
  if (unit === '/s') return `${value >= 10 ? String(Math.round(value)) : value.toFixed(2)}/s`;
  return formatCount(Math.round(value * 100) / 100);
}

/** @param {number} value */
export function formatCount(value) {
  return new Intl.NumberFormat('en', {
    notation: value >= 100000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 100000 ? 1 : 2,
  }).format(value);
}

/** "just now", "4 min ago", "3 h ago", "12 d ago". @param {number} seconds */
export function formatAge(seconds) {
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${String(Math.max(1, Math.round(seconds / 60)))} min ago`;
  if (seconds < 86_400 * 2) return `${String(Math.round(seconds / 3600))} h ago`;
  if (seconds < 86_400 * 60) return `${String(Math.round(seconds / 86_400))} d ago`;
  if (seconds < 86_400 * 365 * 2) return `${String(Math.round(seconds / (86_400 * 30.44)))} mo ago`;
  return `${String(Math.round(seconds / (86_400 * 365.25)))} y ago`;
}

/** "5 min", "1 h", "1 d": the width of one bucket. @param {number} step */
export function formatStep(step) {
  if (step >= 86_400) return `${String(step / 86_400)} d`;
  if (step >= 3600) return `${String(step / 3600)} h`;
  return `${String(step / 60)} min`;
}

/** Route labels of the metrics registry in plain words. @param {string} route */
export function routeLabel(route) {
  /** @type {Record<string, string>} */
  const known = {
    metadata: 'Package metadata',
    artifact: 'Tarballs',
    passthrough: 'Pass-through',
    web: 'Web catalog',
    write: 'Publish and writes',
    account: 'Accounts and tokens',
    unknown: 'Unmatched',
  };
  const label = Object.hasOwn(known, route) ? known[route] : undefined;
  if (label !== undefined) return label;
  const words = route.replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'Unnamed' : words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- Sums and the previous period ------------------------------------------------------

/**
 * @typedef {{ requests: number, serverErrors: number, hits: number, lookups: number,
 *   hitRatio: number | null, upstreamRequests: number, upstreamErrors: number,
 *   upstreamErrorRatio: number | null, blocked: number, bytes: number,
 *   p95: number | null, buckets: number }} Summary
 */

/**
 * Sums buckets. The hit ratio is recomputed from the cache counts (ratios are never averaged):
 * hits are hit, revalidated and stale; lookups add miss and coalesced. Latency is the worst
 * bucket, as the server reports it for a range.
 * @param {readonly StatsBucket[]} buckets
 * @returns {Summary}
 */
export function summarize(buckets) {
  let requests = 0;
  let serverErrors = 0;
  let hits = 0;
  let lookups = 0;
  let upstreamRequests = 0;
  let upstreamErrors = 0;
  let blocked = 0;
  let bytes = 0;
  /** @type {number | null} */
  let p95 = null;
  for (const b of buckets) {
    requests += b.requests;
    serverErrors += b.classes['5xx'] ?? 0;
    const c = b.cache ?? {};
    const h = (c.hit ?? 0) + (c.revalidated ?? 0) + (c.stale ?? 0);
    hits += h;
    lookups += h + (c.miss ?? 0) + (c.coalesced ?? 0);
    upstreamRequests += b.upstreamRequests;
    upstreamErrors += b.upstreamErrors;
    blocked += b.blocked;
    bytes += b.bytes ?? 0;
    if (b.latency) p95 = p95 === null ? b.latency.p95 : Math.max(p95, b.latency.p95);
  }
  return {
    requests,
    serverErrors,
    hits,
    lookups,
    hitRatio: lookups > 0 ? hits / lookups : null,
    upstreamRequests,
    upstreamErrors,
    upstreamErrorRatio: upstreamRequests > 0 ? upstreamErrors / upstreamRequests : null,
    blocked,
    bytes,
    p95,
    buckets: buckets.length,
  };
}

/**
 * The period of the same length right before `current`, taken from the buckets of a longer
 * range. Null when that range does not reach back far enough or recorded nothing there.
 * @param {StatsResponse} current
 * @param {StatsResponse | null} wider
 * @returns {Summary | null}
 */
export function previousPeriod(current, wider) {
  if (!wider) return null;
  const length = current.to - current.from;
  const start = current.from - length;
  // Whole buckets only; the first one may start up to one step early.
  if (wider.from > start + wider.step) return null;
  const before = wider.series.filter(
    (b) => b.t >= start - wider.step / 2 && b.t + wider.step <= current.from + wider.step / 2,
  );
  // A pod writes a record every interval, so the number of buckets says how much of the
  // period was recorded. A period that is mostly missing (the registry was not running yet)
  // would turn every delta into a huge jump: no comparison then.
  const expected = Math.max(1, Math.round(length / wider.step));
  return before.length >= expected * PREVIOUS_MIN_COVERAGE ? summarize(before) : null;
}

/**
 * @typedef {{ text: string, tone: 'good' | 'bad' | 'neutral', direction: 'up' | 'down' | 'flat',
 *   spoken: string }} Delta
 */

/**
 * The change against the previous period, or null when there is nothing to compare with.
 * `relative` compares counts (percent change), `points` compares ratios (percentage points),
 * `seconds` compares durations (percent change, absolute difference spoken).
 * @param {number | null} current
 * @param {number | null | undefined} previous
 * @param {{ kind: 'relative' | 'points', better: 'up' | 'down' | 'none' }} how
 * @returns {Delta | null}
 */
export function delta(current, previous, how) {
  if (current === null || previous === null || previous === undefined) return null;
  /** @type {number} */
  let change;
  /** @type {string} */
  let text;
  if (how.kind === 'points') {
    change = (current - previous) * 100;
    if (Math.abs(change) < 0.05) change = 0;
    text = `${Math.abs(change).toFixed(1)} pt`;
  } else {
    if (previous === 0) {
      if (current === 0) change = 0;
      else return { text: 'new', tone: 'neutral', direction: 'up', spoken: 'none before' };
    } else change = ((current - previous) / previous) * 100;
    if (Math.abs(change) < 0.5) change = 0;
    const size = Math.abs(change);
    text = size >= 1000 ? `${(size / 100 + 1).toFixed(0)}x` : `${size.toFixed(size < 10 ? 1 : 0)}%`;
  }
  if (change === 0) {
    return { text: 'no change', tone: 'neutral', direction: 'flat', spoken: 'no change' };
  }
  const direction = change > 0 ? 'up' : 'down';
  const tone = how.better === 'none' ? 'neutral' : how.better === direction ? 'good' : 'bad';
  return {
    text: `${direction === 'up' ? '+' : '−'}${text}`,
    tone,
    direction,
    spoken: `${direction} ${text}`,
  };
}

// ---- Health ----------------------------------------------------------------------------

/** @param {number} value @param {{ warn: number, bad: number }} t @returns {Level} */
function grade(value, t) {
  return value >= t.bad ? 'bad' : value >= t.warn ? 'warn' : 'ok';
}

/**
 * Grades a measure by how many intervals reach the limits, not by its single worst interval.
 * @param {Array<number | null | undefined>} values one per interval; missing ones are skipped
 * @param {{ warn: number, bad: number, share: number, minSamples: number }} t
 * @returns {{ level: Level, detail: string }}
 */
export function gradeIntervals(values, t) {
  const seen = values.flatMap((v) => (v === null || v === undefined ? [] : [v]));
  const over = seen.filter((v) => v >= t.warn).length;
  const far = seen.filter((v) => v >= t.bad).length;
  const detail = `${formatCount(over)} of ${formatCount(seen.length)} intervals`;
  if (seen.length < t.minSamples) return { level: 'idle', detail };
  const level =
    far / seen.length >= t.share ? 'bad' : over / seen.length >= t.share ? 'warn' : 'ok';
  return { level, detail };
}

/** @param {Level[]} levels @returns {Level} */
export function worst(levels) {
  if (levels.includes('bad')) return 'bad';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('ok')) return 'ok';
  return 'idle';
}

/**
 * The health checks of a range, each with a level from THRESHOLDS. `idle` means there is not
 * enough traffic to judge; it never counts against the overall status.
 * @param {StatsResponse} data
 * @returns {{ level: Level, label: string, checks: Check[] }}
 */
export function assess(data) {
  const t = data.totals;
  /** @type {Check[]} */
  const checks = [];
  const fiveXx = t.classes['5xx'] ?? 0;
  const errShare = t.requests > 0 ? fiveXx / t.requests : 0;
  checks.push({
    id: 'errors',
    label: 'Server errors',
    level:
      t.requests < THRESHOLDS.serverErrors.minSamples
        ? fiveXx === 0 && t.requests > 0
          ? 'ok'
          : 'idle'
        : grade(errShare, THRESHOLDS.serverErrors),
    value: t.requests > 0 ? formatValue(errShare, '%') : 'n/a',
    detail: `${formatCount(fiveXx)} of ${formatCount(t.requests)} requests answered 5xx`,
  });
  const upShare = t.upstreamRequests > 0 ? t.upstreamErrors / t.upstreamRequests : 0;
  checks.push({
    id: 'upstream',
    label: 'Upstream',
    level:
      t.upstreamRequests < THRESHOLDS.upstreamErrors.minSamples
        ? t.upstreamErrors === 0 && t.upstreamRequests > 0
          ? 'ok'
          : 'idle'
        : grade(upShare, THRESHOLDS.upstreamErrors),
    value: t.upstreamRequests > 0 ? formatValue(upShare, '%') : 'n/a',
    detail: `${formatCount(t.upstreamErrors)} of ${formatCount(t.upstreamRequests)} upstream fetches failed`,
  });
  const lat = gradeIntervals(
    data.series.map((b) => b.latency?.p95),
    THRESHOLDS.latencyP95,
  );
  checks.push({
    id: 'latency',
    label: 'Latency p95',
    level: lat.level,
    value: t.latency === null ? 'n/a' : formatDuration(t.latency.p95),
    detail: `Worst interval, pod and route. ${lat.detail} at or above ${formatDuration(THRESHOLDS.latencyP95.warn)}`,
  });
  const loop = t.gauges?.loopP99;
  const loops = gradeIntervals(
    data.series.map((b) => b.gauges?.loopP99?.max),
    THRESHOLDS.loopP99,
  );
  checks.push({
    id: 'loop',
    label: 'Event loop',
    level: loops.level,
    value: loop === undefined || data.series.length === 0 ? 'n/a' : formatDuration(loop.max),
    detail: `Highest event-loop delay p99. ${loops.detail} at or above ${formatDuration(THRESHOLDS.loopP99.warn)}`,
  });
  const w = t.writes;
  if (w !== undefined) {
    const lost = w.failed + w.dropped;
    const all = w.ok + lost;
    checks.push({
      id: 'writes',
      label: 'Storage writes',
      level:
        all === 0
          ? 'idle'
          : lost === 0
            ? 'ok'
            : all >= THRESHOLDS.writeLoss.minSamples && lost / all >= THRESHOLDS.writeLoss.bad
              ? 'bad'
              : 'warn',
      value: all === 0 ? 'n/a' : `${formatCount(lost)} lost`,
      detail: `${formatCount(w.ok)} stored, ${formatCount(w.failed)} failed, ${formatCount(w.dropped)} dropped, ${formatCount(w.retries)} retried`,
    });
  }
  const pods = podStatuses(data);
  const reporting = pods.filter((p) => p.reporting).length;
  checks.push({
    id: 'pods',
    label: 'Pods',
    level: pods.length === 0 ? 'idle' : reporting > 0 ? 'ok' : 'idle',
    value: `${String(reporting)} of ${String(pods.length)}`,
    detail: 'Pods with a recent history record (older pods belong to earlier rollouts)',
  });
  const level = data.series.length === 0 ? 'idle' : worst(checks.map((c) => c.level));
  return { level, label: LEVEL_LABELS[level], checks };
}

/** @type {Readonly<Record<Level, string>>} */
export const LEVEL_LABELS = { ok: 'Healthy', warn: 'Degraded', bad: 'Failing', idle: 'No data' };

/**
 * @typedef {{ name: string, reporting: boolean, lastSeen: number | null, rss: number,
 *   rssPeak: number, heap: number, points: Array<{ t: number, v: number }> }} PodStatus
 */

/**
 * One row per pod. A pod's bucket `t` is the start of the bucket and the history is written
 * every 5 minutes, so "reporting" allows for both (THRESHOLDS.podStale*).
 * @param {StatsResponse} data
 * @returns {PodStatus[]}
 */
export function podStatuses(data) {
  const allowed = Math.max(
    THRESHOLDS.podStaleBuckets * data.step,
    THRESHOLDS.podStaleSeconds + data.step,
  );
  return Object.entries(data.perPod)
    .map(([name, points]) => {
      const last = points[points.length - 1];
      const lastSeen = last ? Math.min(last.t + data.step, data.to) : null;
      return {
        name,
        reporting: lastSeen !== null && data.to - lastSeen <= allowed,
        lastSeen,
        rss: last?.rss ?? 0,
        rssPeak: points.reduce((m, p) => Math.max(m, p.rss), 0),
        heap: last?.heap ?? 0,
        points: points.map((p) => ({ t: p.t, v: p.rss })),
      };
    })
    .sort(
      (a, b) =>
        Number(b.reporting) - Number(a.reporting) ||
        (b.lastSeen ?? 0) - (a.lastSeen ?? 0) ||
        (a.name < b.name ? -1 : 1),
    );
}

// ---- Breakdowns ------------------------------------------------------------------------

/**
 * @typedef {{ key: string, label: string, hint: string, value: number, share: number,
 *   slot: string }} Segment
 */

const CACHE_RESULTS = /** @type {const} */ ([
  ['hit', 'Hit', 'Served from the cache', 's0'],
  ['revalidated', 'Revalidated', 'Cached copy confirmed upstream (304)', 's2'],
  ['stale', 'Stale', 'Cached copy served while upstream failed or was busy', 's3'],
  ['miss', 'Miss', 'Fetched from upstream', 's1'],
  ['coalesced', 'Coalesced', 'Waited for a fetch another request had started', 'sn'],
  ['passthrough', 'Pass-through', 'Forwarded to upstream without a cache lookup', 'so'],
]);

/**
 * Cache results in a fixed order with fixed colors (color follows the result, never its
 * rank); results the client does not know are folded into "Other".
 * @param {Record<string, number> | undefined} cache
 * @returns {{ total: number, segments: Segment[] }}
 */
export function cacheBreakdown(cache) {
  const c = cache ?? {};
  /** @type {Segment[]} */
  const segments = [];
  let total = 0;
  let known = 0;
  for (const v of Object.values(c)) total += v;
  for (const [key, label, hint, slot] of CACHE_RESULTS) {
    const value = c[key] ?? 0;
    known += value;
    segments.push({ key, label, hint, value, share: total > 0 ? value / total : 0, slot });
  }
  if (total - known > 0) {
    segments.push({
      key: 'other',
      label: 'Other',
      hint: 'Results this page does not know',
      value: total - known,
      share: (total - known) / total,
      slot: 'so',
    });
  }
  return { total, segments };
}

/**
 * @typedef {{ route: string, label: string, requests: number, share: number,
 *   clientErrors: number | null, serverErrors: number | null,
 *   latency: Quantiles | null }} RouteRow
 */

/**
 * The request mix per route, busiest first. Error counts and latency per route come from
 * `routeStats` (absent on servers before it existed: then they read as unknown).
 * @param {StatsResponse} data
 * @returns {RouteRow[]}
 */
export function routeRows(data) {
  const total = data.totals.requests;
  return Object.entries(data.totals.routes ?? {})
    .map(([route, requests]) => {
      const stats = data.routeStats ?? {};
      const s = Object.hasOwn(stats, route) ? stats[route] : undefined;
      return {
        route,
        label: routeLabel(route),
        requests,
        share: total > 0 ? requests / total : 0,
        clientErrors: s ? s.clientErrors : null,
        serverErrors: s ? s.serverErrors : null,
        latency: s ? s.latency : null,
      };
    })
    .sort((a, b) => b.requests - a.requests || (a.route < b.route ? -1 : 1));
}

/**
 * @param {StatsResponse} data
 * @param {(b: StatsBucket) => number | null | undefined} f
 */
export function seriesOf(data, f) {
  return data.series.flatMap((b) => {
    const v = f(b);
    return v === null || v === undefined ? [] : [{ t: b.t, v }];
  });
}

// ---- Auto-refresh ----------------------------------------------------------------------

/**
 * Runs `run` every `intervalMs` while the page is visible and not paused. A hidden tab skips
 * its ticks; when it becomes visible again and the last run is older than the interval, it
 * runs at once. One run at a time. Timers and visibility are injected for the tests.
 * @param {{
 *   run: () => Promise<void>,
 *   intervalMs?: number,
 *   isHidden: () => boolean,
 *   now?: () => number,
 *   setTimer: (fn: () => void, ms: number) => unknown,
 *   clearTimer: (id: unknown) => void,
 * }} opts
 */
export function createRefresher(opts) {
  const interval = opts.intervalMs ?? REFRESH_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  /** @type {unknown} */
  let timer = null;
  let running = false;
  let paused = false;
  let stopped = true;
  let lastRun = 0;

  function schedule() {
    if (timer !== null) opts.clearTimer(timer);
    timer = stopped ? null : opts.setTimer(tick, interval);
  }

  async function runNow() {
    if (running || stopped) return;
    running = true;
    lastRun = now();
    try {
      await opts.run();
    } catch {
      // the caller reports failures; the schedule goes on
    } finally {
      running = false;
    }
  }

  function tick() {
    timer = null;
    schedule();
    if (!paused && !opts.isHidden()) void runNow();
  }

  return {
    /** Starts the schedule; the first run happens after one interval. */
    start() {
      stopped = false;
      lastRun = now();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) opts.clearTimer(timer);
      timer = null;
    },
    /** Call on `visibilitychange`. */
    visibilityChanged() {
      if (stopped || paused || opts.isHidden()) return;
      if (now() - lastRun >= interval) {
        schedule();
        void runNow();
      }
    },
    /** @param {boolean} value */
    setPaused(value) {
      paused = value;
      if (!paused && !stopped && !opts.isHidden() && now() - lastRun >= interval) {
        schedule();
        void runNow();
      }
    },
    /** Runs now (the Refresh button) and restarts the interval. */
    refreshNow() {
      if (stopped) return Promise.resolve();
      schedule();
      return runNow();
    },
    get paused() {
      return paused;
    },
    get active() {
      return !stopped;
    },
  };
}
