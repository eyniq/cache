// Pure arithmetic of the statistics history: deltas between two samples, quantiles from
// histogram bucket deltas, rollups, and the strict parser for stored lines.
import {
  EXCLUDED_ROUTES,
  GAUGE_NAMES,
  dict,
  type Dict,
  type GaugeName,
  type GaugeStat,
  type HistogramSample,
  type LatencyStat,
  type StatsPoint,
  type StatsSample,
  type WriteStat,
} from './types.ts';

const OPTIONAL_GAUGES: ReadonlySet<GaugeName> = new Set(['writeQueue', 'writesInFlight']);
const KEY = /^[A-Za-z0-9_.:-]{1,48}$/;
const MAX_KEYS = 64;

function delta(cur: number, prev: number): number {
  // A counter that went down (never within one process) restarts from its current value.
  return cur >= prev ? cur - prev : cur;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Prometheus-style histogram_quantile over cumulative bucket counts. */
export function quantile(bounds: number[], cumulative: number[], total: number, q: number): number {
  if (total <= 0 || bounds.length === 0) return 0;
  const target = q * total;
  let prevCum = 0;
  let prevBound = 0;
  for (let i = 0; i < bounds.length; i++) {
    const cum = cumulative[i] ?? 0;
    const bound = bounds[i] ?? 0;
    if (cum >= target) {
      const inBucket = cum - prevCum;
      if (inBucket <= 0) return bound;
      return prevBound + (bound - prevBound) * ((target - prevCum) / inBucket);
    }
    prevCum = cum;
    prevBound = bound;
  }
  // In the +Inf bucket: the best statement is "above the last bound".
  return bounds[bounds.length - 1] ?? 0;
}

function latencyDelta(prev: HistogramSample | undefined, cur: HistogramSample): LatencyStat | null {
  const same = prev !== undefined && prev.bounds.length === cur.bounds.length;
  const counts = cur.counts.map((c, i) => delta(c, same ? (prev.counts[i] ?? 0) : 0));
  const n = delta(cur.count, same ? prev.count : 0);
  if (n <= 0) return null;
  return [
    round(quantile(cur.bounds, counts, n, 0.5)),
    round(quantile(cur.bounds, counts, n, 0.95)),
    round(quantile(cur.bounds, counts, n, 0.99)),
    n,
  ];
}

function sumDelta(prev: Dict<number>, cur: Dict<number>): Dict<number> {
  const out = dict<number>();
  for (const [k, v] of Object.entries(cur)) {
    const d = delta(v, prev[k] ?? 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

const NO_WRITES: WriteStat = { ok: 0, failed: 0, dropped: 0, retries: 0 };

function writesDelta(
  prev: StatsSample,
  cur: StatsSample,
): { writes: WriteStat; writeLatency: LatencyStat | null } {
  const c = cur.writes;
  if (!c) return { writes: { ...NO_WRITES }, writeLatency: null };
  const p = prev.writes;
  const failed = delta(c.failed, p?.failed ?? 0);
  const retries = delta(c.retries, p?.retries ?? 0);
  const writeLatency = c.attempts ? latencyDelta(p?.attempts ?? undefined, c.attempts) : null;
  const attempts = writeLatency ? writeLatency[3] : 0;
  return {
    writes: {
      ok: Math.max(0, attempts - retries - failed),
      failed,
      dropped: delta(c.dropped, p?.dropped ?? 0),
      retries,
    },
    writeLatency,
  };
}

/** The activity between two cumulative samples, `seconds` apart, ending at `endSec`. */
export function diffSample(
  prev: StatsSample,
  cur: StatsSample,
  endSec: number,
  seconds: number,
): StatsPoint {
  const req = dict<Dict<number>>();
  for (const [route, classes] of Object.entries(cur.requests)) {
    if (EXCLUDED_ROUTES.has(route)) continue;
    const d = sumDelta(prev.requests[route] ?? dict(), classes);
    if (Object.keys(d).length > 0) req[route] = d;
  }
  const lat = dict<LatencyStat>();
  for (const [route, h] of Object.entries(cur.latency)) {
    if (EXCLUDED_ROUTES.has(route)) continue;
    const l = latencyDelta(prev.latency[route], h);
    if (l) lat[route] = l;
  }
  const gauges = {} as Record<GaugeName, GaugeStat>;
  for (const g of GAUGE_NAMES) {
    const v = round(cur.gauges[g]);
    gauges[g] = { avg: v, max: v };
  }
  return {
    t: endSec,
    s: round(seconds),
    k: 1,
    req,
    cache: sumDelta(prev.cache, cur.cache),
    coalesced: delta(cur.coalesced, prev.coalesced),
    upstreamRequests: delta(cur.upstreamRequests, prev.upstreamRequests),
    upstreamErrors: delta(cur.upstreamErrors, prev.upstreamErrors),
    blocked: delta(cur.blocked, prev.blocked),
    bytes: delta(cur.bytes, prev.bytes),
    evictions: delta(cur.evictions, prev.evictions),
    gauges,
    lat,
    ...writesDelta(prev, cur),
  };
}

/**
 * Merges points into one starting at `t`: counters add up, gauges average by sample count
 * (and keep the maximum), latency quantiles take the maximum (an upper-bound approximation:
 * exact quantiles cannot be rebuilt from quantiles).
 */
export function rollup(points: readonly StatsPoint[], t: number): StatsPoint {
  const out: StatsPoint = {
    t,
    s: 0,
    k: 0,
    req: dict(),
    cache: dict(),
    coalesced: 0,
    upstreamRequests: 0,
    upstreamErrors: 0,
    blocked: 0,
    bytes: 0,
    evictions: 0,
    gauges: Object.fromEntries(GAUGE_NAMES.map((g) => [g, { avg: 0, max: 0 }])) as Record<
      GaugeName,
      GaugeStat
    >,
    lat: dict(),
    writes: { ...NO_WRITES },
    writeLatency: null,
  };
  const weighted = Object.fromEntries(GAUGE_NAMES.map((g) => [g, 0])) as Record<GaugeName, number>;
  for (const p of points) {
    out.s += p.s;
    out.k += p.k;
    for (const [route, classes] of Object.entries(p.req)) {
      const target = (out.req[route] ??= dict());
      for (const [c, n] of Object.entries(classes)) target[c] = (target[c] ?? 0) + n;
    }
    for (const [r, n] of Object.entries(p.cache)) out.cache[r] = (out.cache[r] ?? 0) + n;
    out.coalesced += p.coalesced;
    out.upstreamRequests += p.upstreamRequests;
    out.upstreamErrors += p.upstreamErrors;
    out.blocked += p.blocked;
    out.bytes += p.bytes;
    out.evictions += p.evictions;
    for (const g of GAUGE_NAMES) {
      weighted[g] += p.gauges[g].avg * p.k;
      out.gauges[g].max = Math.max(out.gauges[g].max, p.gauges[g].max);
    }
    out.writes.ok += p.writes.ok;
    out.writes.failed += p.writes.failed;
    out.writes.dropped += p.writes.dropped;
    out.writes.retries += p.writes.retries;
    const w = p.writeLatency;
    if (w) {
      const c = out.writeLatency;
      out.writeLatency = c
        ? [Math.max(c[0], w[0]), Math.max(c[1], w[1]), Math.max(c[2], w[2]), c[3] + w[3]]
        : [w[0], w[1], w[2], w[3]];
    }
    for (const [route, l] of Object.entries(p.lat)) {
      const cur = out.lat[route];
      out.lat[route] = cur
        ? [Math.max(cur[0], l[0]), Math.max(cur[1], l[1]), Math.max(cur[2], l[2]), cur[3] + l[3]]
        : [l[0], l[1], l[2], l[3]];
    }
  }
  for (const g of GAUGE_NAMES) out.gauges[g].avg = out.k > 0 ? round(weighted[g] / out.k) : 0;
  out.s = round(out.s);
  return out;
}

function num(v: unknown, max = 1e18): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}

function numDict(v: unknown): Dict<number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_KEYS) return null;
  const out = dict<number>();
  for (const [k, n] of entries) {
    const x = num(n);
    if (!KEY.test(k) || x === null) return null;
    out[k] = x;
  }
  return out;
}

/** Absent (older points) means no writes; present means exactly the four counters. */
function parseWrites(v: unknown): WriteStat | null {
  if (v === undefined) return { ...NO_WRITES };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const [ok, failed, dropped, retries] = [num(o.ok), num(o.failed), num(o.dropped), num(o.retries)];
  if (ok === null || failed === null || dropped === null || retries === null) return null;
  return { ok, failed, dropped, retries };
}

/** Strictly validates one stored line; anything unexpected is rejected (null). */
export function parsePoint(line: string): StatsPoint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const t = num(r.t, 4e9);
  const s = num(r.s, 1e7);
  const k = num(r.k, 1e7);
  const cache = numDict(r.cache);
  const coalesced = num(r.coalesced);
  const upstreamRequests = num(r.upstreamRequests);
  const upstreamErrors = num(r.upstreamErrors);
  const blocked = num(r.blocked);
  const bytes = num(r.bytes);
  const evictions = num(r.evictions);
  if (
    t === null ||
    s === null ||
    k === null ||
    !cache ||
    coalesced === null ||
    upstreamRequests === null ||
    upstreamErrors === null ||
    blocked === null ||
    bytes === null ||
    evictions === null
  ) {
    return null;
  }
  if (typeof r.req !== 'object' || r.req === null || Array.isArray(r.req)) return null;
  const req = dict<Dict<number>>();
  const reqEntries = Object.entries(r.req);
  if (reqEntries.length > MAX_KEYS) return null;
  for (const [route, classes] of reqEntries) {
    const d = numDict(classes);
    if (!KEY.test(route) || !d) return null;
    req[route] = d;
  }
  if (typeof r.gauges !== 'object' || r.gauges === null) return null;
  const gauges = {} as Record<GaugeName, GaugeStat>;
  for (const g of GAUGE_NAMES) {
    const v = (r.gauges as Record<string, unknown>)[g];
    if (v === undefined && OPTIONAL_GAUGES.has(g)) {
      // Points stored before the write metrics existed.
      gauges[g] = { avg: 0, max: 0 };
      continue;
    }
    if (typeof v !== 'object' || v === null) return null;
    const avg = num((v as Record<string, unknown>).avg);
    const max = num((v as Record<string, unknown>).max);
    if (avg === null || max === null) return null;
    gauges[g] = { avg, max };
  }
  if (typeof r.lat !== 'object' || r.lat === null || Array.isArray(r.lat)) return null;
  const lat = dict<LatencyStat>();
  const latEntries = Object.entries(r.lat);
  if (latEntries.length > MAX_KEYS) return null;
  for (const [route, v] of latEntries) {
    if (!KEY.test(route) || !Array.isArray(v) || v.length !== 4) return null;
    const p50 = num(v[0]);
    const p95 = num(v[1]);
    const p99 = num(v[2]);
    const n = num(v[3]);
    if (p50 === null || p95 === null || p99 === null || n === null) return null;
    lat[route] = [p50, p95, p99, n];
  }
  const writes = parseWrites(r.writes);
  if (!writes) return null;
  let writeLatency: LatencyStat | null = null;
  if (r.writeLatency !== undefined && r.writeLatency !== null) {
    const v = r.writeLatency;
    if (!Array.isArray(v) || v.length !== 4) return null;
    const [a, b, c, d] = [num(v[0]), num(v[1]), num(v[2]), num(v[3])];
    if (a === null || b === null || c === null || d === null) return null;
    writeLatency = [a, b, c, d];
  }
  return {
    t,
    s,
    k,
    req,
    cache,
    coalesced,
    upstreamRequests,
    upstreamErrors,
    blocked,
    bytes,
    evictions,
    gauges,
    lat,
    writes,
    writeLatency,
  };
}

/** Lines of an NDJSON object; malformed lines are skipped, at most `maxLines` are read. */
export function parsePoints(text: string, maxLines = 5000): StatsPoint[] {
  return parsePointsCounted(text, maxLines).points;
}

/** Like parsePoints, also counting the lines that were not valid points. */
export function parsePointsCounted(
  text: string,
  maxLines = 5000,
): { points: StatsPoint[]; skipped: number } {
  const points: StatsPoint[] = [];
  let skipped = 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (++n > maxLines) break;
    const p = line.length > 65_536 ? null : parsePoint(line);
    if (p) points.push(p);
    else skipped++;
  }
  return { points, skipped };
}
