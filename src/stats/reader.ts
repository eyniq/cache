// Read side of the statistics history: lists the pods' objects for a range, reads them with
// bounded work and merges all pods into one time series (DESIGN.md section 17).
import type { Storage } from '../core/contracts.ts';
import { readLimited } from '../core/streams.ts';
import { isStorageAdmin } from '../core/storage.ts';
import { listPrefixes, parseKey } from './keys.ts';
import { parsePointsCounted, rollup } from './points.ts';
import {
  dict,
  type Dict,
  type GaugeName,
  type GaugeStat,
  type StatsPoint,
  type StatsTier,
  type WriteStat,
} from './types.ts';

export const STATS_RANGES = ['1h', '24h', '7d', '30d', '90d', '1y'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** Which tier answers a range and the bucket width of `step=auto`. */
const RANGE_PLAN: Record<StatsRange, { seconds: number; tier: StatsTier; step: number }> = {
  '1h': { seconds: 3600, tier: 'minute', step: 60 },
  '24h': { seconds: 86_400, tier: 'minute', step: 300 },
  '7d': { seconds: 7 * 86_400, tier: 'hour', step: 3600 },
  '30d': { seconds: 30 * 86_400, tier: 'hour', step: 21_600 },
  '90d': { seconds: 90 * 86_400, tier: 'hour', step: 86_400 },
  '1y': { seconds: 365 * 86_400, tier: 'day', step: 86_400 },
};

/** Bucket widths a caller may ask for instead of `auto` (seconds). */
export const STATS_STEPS: readonly number[] = [60, 300, 900, 3600, 21_600, 86_400];

const MAX_OBJECTS = 200;
const MAX_POD_COUNT = 32;
export const MAX_STATS_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_LIST_PAGES = 20;
const READ_CONCURRENCY = 8;
const CACHE_TTL_MS = 30_000;
/** One entry per range. */
const MAX_CACHED = 6;
/** Computations (listing and reading storage) that may run at the same time. */
const MAX_CONCURRENT_COMPUTES = 2;

export class StatsUnavailableError extends Error {}

/** Too many computations are running; the caller should retry shortly. */
export class StatsBusyError extends Error {}

export function isStatsRange(v: string): v is StatsRange {
  return (STATS_RANGES as readonly string[]).includes(v);
}

export interface StatsBucket {
  t: number;
  requests: number;
  /** Status class ("2xx") -> requests. */
  classes: Dict<number>;
  routes: Dict<number>;
  cache: Dict<number>;
  /** Cache hits (hit, revalidated, stale) over those plus misses and coalesced; null if none. */
  hitRatio: number | null;
  coalesced: number;
  upstreamRequests: number;
  upstreamErrors: number;
  blocked: number;
  bytes: number;
  evictions: number;
  gauges: Record<GaugeName, GaugeStat>;
  /** Seconds; the worst pod and route (an upper-bound approximation). Null without requests. */
  latency: { p50: number; p95: number; p99: number } | null;
  /** Background storage writes (counts) in the bucket. */
  writes: WriteStat;
  /** Seconds per write attempt; worst pod (an upper bound). Null without attempts. */
  writeLatency: { p50: number; p95: number; p99: number } | null;
}

export interface StatsPodPoint {
  t: number;
  rss: number;
  heap: number;
}

export interface StatsResult {
  range: StatsRange;
  from: number;
  to: number;
  step: number;
  tier: StatsTier;
  generatedAt: number;
  pods: string[];
  /** Some objects or pods were left out to bound the work. */
  truncated: boolean;
  /** Objects that could not be read or parsed. */
  skipped: number;
  totals: StatsBucket;
  series: StatsBucket[];
  perPod: Dict<StatsPodPoint[]>;
}

function push(m: Map<number, StatsPoint[]>, k: number, p: StatsPoint): void {
  const list = m.get(k);
  if (list) list.push(p);
  else m.set(k, [p]);
}

export function toBucket(p: StatsPoint): StatsBucket {
  const classes = dict<number>();
  const routes = dict<number>();
  let requests = 0;
  for (const [route, byClass] of Object.entries(p.req)) {
    for (const [c, n] of Object.entries(byClass)) {
      classes[c] = (classes[c] ?? 0) + n;
      routes[route] = (routes[route] ?? 0) + n;
      requests += n;
    }
  }
  const c = p.cache;
  const hits = (c.hit ?? 0) + (c.revalidated ?? 0) + (c.stale ?? 0);
  const all = hits + (c.miss ?? 0) + (c.coalesced ?? 0);
  let latency: StatsBucket['latency'] = null;
  for (const l of Object.values(p.lat)) {
    latency = latency
      ? {
          p50: Math.max(latency.p50, l[0]),
          p95: Math.max(latency.p95, l[1]),
          p99: Math.max(latency.p99, l[2]),
        }
      : { p50: l[0], p95: l[1], p99: l[2] };
  }
  return {
    t: p.t,
    requests,
    classes,
    routes,
    cache: p.cache,
    hitRatio: all > 0 ? hits / all : null,
    coalesced: p.coalesced,
    upstreamRequests: p.upstreamRequests,
    upstreamErrors: p.upstreamErrors,
    blocked: p.blocked,
    bytes: p.bytes,
    evictions: p.evictions,
    gauges: p.gauges,
    latency,
    writes: p.writes,
    writeLatency: p.writeLatency
      ? { p50: p.writeLatency[0], p95: p.writeLatency[1], p99: p.writeLatency[2] }
      : null,
  };
}

/** Merges pods' points into buckets of `step` seconds. Exported for tests. */
export function buildResult(
  byPod: Map<string, StatsPoint[]>,
  meta: Pick<StatsResult, 'range' | 'from' | 'to' | 'step' | 'tier' | 'generatedAt'>,
  flags: { truncated: boolean; skipped: number },
): StatsResult {
  const inRange = (p: StatsPoint): boolean => p.t >= meta.from && p.t <= meta.to;
  const bucketOf = (t: number): number => Math.floor(t / meta.step) * meta.step;
  const all: StatsPoint[] = [];
  const buckets = new Map<number, StatsPoint[]>();
  const perPod = dict<StatsPodPoint[]>();
  for (const [pod, points] of byPod) {
    const mine = new Map<number, StatsPoint[]>();
    for (const p of points) {
      if (!inRange(p)) continue;
      all.push(p);
      const b = bucketOf(p.t);
      push(buckets, b, p);
      push(mine, b, p);
    }
    perPod[pod] = [...mine]
      .sort((a, b) => a[0] - b[0])
      .map(([t, ps]) => {
        const r = rollup(ps, t);
        return { t, rss: r.gauges.rss.max, heap: r.gauges.heap.max };
      });
  }
  const series = [...buckets].sort((a, b) => a[0] - b[0]).map(([t, ps]) => toBucket(rollup(ps, t)));
  return {
    ...meta,
    pods: [...byPod.keys()].sort(),
    truncated: flags.truncated,
    skipped: flags.skipped,
    totals: toBucket(rollup(all, meta.from)),
    series,
    perPod,
  };
}

export interface StatsReaderOptions {
  now?: () => number;
  cacheTtlMs?: number;
}

interface RawStats {
  from: number;
  to: number;
  tier: StatsTier;
  byPod: Map<string, StatsPoint[]>;
  truncated: boolean;
  skipped: number;
}

export class StatsReader {
  private readonly now: () => number;
  private readonly ttl: number;
  /** Raw points per range; steps are re-bucketed from them in memory. */
  private readonly cache = new Map<StatsRange, { at: number; value: RawStats }>();
  private readonly inflight = new Map<StatsRange, Promise<RawStats>>();
  private computing = 0;

  private readonly storage: Storage;

  constructor(storage: Storage, opts: StatsReaderOptions = {}) {
    this.storage = storage;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  /**
   * `step` in seconds, or undefined for the range's default. The raw points of a range are
   * cached briefly; at most two computations run at once, a third fails with StatsBusyError.
   */
  async query(range: StatsRange, step?: number): Promise<StatsResult> {
    const raw = await this.raw(range);
    return buildResult(
      raw.byPod,
      {
        range,
        from: raw.from,
        to: raw.to,
        step: step ?? RANGE_PLAN[range].step,
        tier: raw.tier,
        generatedAt: raw.to,
      },
      { truncated: raw.truncated, skipped: raw.skipped },
    );
  }

  private raw(range: StatsRange): Promise<RawStats> {
    const hit = this.cache.get(range);
    if (hit && this.now() - hit.at < this.ttl) return Promise.resolve(hit.value);
    const running = this.inflight.get(range);
    if (running) return running;
    if (this.computing >= MAX_CONCURRENT_COMPUTES) {
      return Promise.reject(new StatsBusyError('too many statistics queries are running'));
    }
    this.computing++;
    const p = this.compute(range).then(
      (value) => {
        this.computing--;
        this.inflight.delete(range);
        this.cache.delete(range);
        this.cache.set(range, { at: this.now(), value });
        while (this.cache.size > MAX_CACHED) {
          const oldest = this.cache.keys().next();
          if (oldest.done) break;
          this.cache.delete(oldest.value);
        }
        return value;
      },
      (err: unknown) => {
        this.computing--;
        this.inflight.delete(range);
        throw err;
      },
    );
    this.inflight.set(range, p);
    return p;
  }

  private async compute(range: StatsRange): Promise<RawStats> {
    const storage = this.storage;
    if (!isStorageAdmin(storage)) {
      throw new StatsUnavailableError('this storage cannot list objects');
    }
    const plan = RANGE_PLAN[range];
    const to = Math.floor(this.now() / 1000);
    const from = to - plan.seconds;
    const tier = plan.tier;
    const wanted: Array<{ key: string; pod: string; start: number }> = [];
    let truncated = false;
    for (const prefix of listPrefixes(tier, from, to)) {
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) {
          truncated = true;
          break;
        }
        const res = await storage.list(prefix, cursor ? { cursor } : {});
        for (const e of res.entries) {
          const k = parseKey(e.key);
          if (k?.tier !== tier || k.end < from || k.start > to) continue;
          if (e.size > MAX_STATS_OBJECT_BYTES) continue;
          wanted.push({ key: e.key, pod: k.pod, start: k.start });
        }
        cursor = res.cursor;
        if (!cursor) break;
      }
    }
    // Keep the pods that wrote most recently, so a rollout's dead pods never hide live ones.
    const latest = new Map<string, number>();
    for (const w of wanted) latest.set(w.pod, Math.max(latest.get(w.pod) ?? 0, w.start));
    const pods = [...latest].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (pods.length > MAX_POD_COUNT) truncated = true;
    const keptPods = new Set(pods.slice(0, MAX_POD_COUNT).map(([pod]) => pod));
    let objects = wanted.filter((w) => keptPods.has(w.pod)).sort((a, b) => b.start - a.start);
    if (objects.length > MAX_OBJECTS) {
      objects = objects.slice(0, MAX_OBJECTS);
      truncated = true;
    }
    const byPod = new Map<string, StatsPoint[]>();
    let skipped = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < objects.length; i = next++) {
        const o = objects[i];
        if (!o) continue;
        try {
          const stream = await storage.get(o.key);
          if (!stream) continue;
          const buf = await readLimited(
            stream,
            MAX_STATS_OBJECT_BYTES,
            () => new Error('too large'),
          );
          const parsed = parsePointsCounted(buf.toString('utf8'));
          skipped += parsed.skipped;
          const list = byPod.get(o.pod) ?? [];
          for (const p of parsed.points) list.push(p);
          byPod.set(o.pod, list);
        } catch {
          skipped++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, objects.length) }, worker));
    return { from, to, tier, byPod, truncated, skipped };
  }
}
