// Statistics history (DESIGN.md section 17): plain data shapes shared by the recorder, the
// reader and the clients. Everything here is ecosystem-agnostic and has no I/O.

export const GAUGE_NAMES = [
  'lruBytes',
  'workerQueue',
  'rss',
  'heap',
  'loopP50',
  'loopP99',
  // Background storage writes (the write limiter); absent in points stored before 0.4.0.
  'writeQueue',
  'writesInFlight',
] as const;
export type GaugeName = (typeof GAUGE_NAMES)[number];

/** A null-prototype record: keys come from stored data, so "__proto__" must be a plain key. */
export type Dict<T> = Record<string, T>;

export function dict<T>(): Dict<T> {
  return Object.create(null) as Dict<T>;
}

/** Cumulative histogram state, as read from the metrics registry. */
export interface HistogramSample {
  /** Upper bounds in seconds, ascending. */
  bounds: number[];
  /** Cumulative counts (observations <= bound), one per bound. */
  counts: number[];
  /** Observations in total (the +Inf bucket). */
  count: number;
}

/** Cumulative background storage write counters (all kinds together). */
export interface WriteSample {
  failed: number;
  dropped: number;
  retries: number;
  /** Duration of every write attempt (successful or not); null when nothing was observed yet. */
  attempts: HistogramSample | null;
}

/** Background storage writes of one interval. */
export interface WriteStat {
  /** Writes that were stored (attempts minus retries and final failures). */
  ok: number;
  /** Writes that failed for good (timeout or error, after the one retry). */
  failed: number;
  /** Writes dropped because the queue was full. */
  dropped: number;
  /** Writes repeated once after a timeout. */
  retries: number;
}

/** Cumulative counters and instantaneous gauges at one moment. */
export interface StatsSample {
  /** route -> status class ("2xx") -> requests. */
  requests: Dict<Dict<number>>;
  /** cache result -> requests. */
  cache: Dict<number>;
  coalesced: number;
  upstreamRequests: number;
  upstreamErrors: number;
  blocked: number;
  bytes: number;
  evictions: number;
  gauges: Record<GaugeName, number>;
  /** route -> request duration histogram. */
  latency: Dict<HistogramSample>;
  /** Absent when the source does not meter storage writes. */
  writes?: WriteSample;
}

export interface GaugeStat {
  avg: number;
  max: number;
}

/** [p50, p95, p99, observations]; seconds. */
export type LatencyStat = [number, number, number, number];

/**
 * One record: the activity of one pod over `s` seconds ending at `t` (epoch seconds, UTC).
 * Rollups (hour, day) use the same shape: `t` is the start of the hour or day, `s` the
 * seconds actually covered and `k` the number of samples behind it.
 */
export interface StatsPoint {
  t: number;
  s: number;
  k: number;
  req: Dict<Dict<number>>;
  cache: Dict<number>;
  coalesced: number;
  upstreamRequests: number;
  upstreamErrors: number;
  blocked: number;
  bytes: number;
  evictions: number;
  gauges: Record<GaugeName, GaugeStat>;
  lat: Dict<LatencyStat>;
  /** Background storage writes in the interval. */
  writes: WriteStat;
  /** Write attempt duration [p50, p95, p99, attempts]; seconds; null without attempts. */
  writeLatency: LatencyStat | null;
}

/** Routes that are probes or management traffic, not registry load. */
export const EXCLUDED_ROUTES: ReadonlySet<string> = new Set([
  'livez',
  'readyz',
  'metrics',
  'management',
  'stats',
]);

export type StatsTier = 'minute' | 'hour' | 'day';
