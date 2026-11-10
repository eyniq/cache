// Reads the metrics registry (and the gauge readers the server already exposes) as one
// cumulative StatsSample for the statistics history. Called once per tick, off the request path.
import {
  dict,
  type Dict,
  type HistogramSample,
  type StatsSample,
  type WriteSample,
} from '../stats/types.ts';
import type { Metrics } from './metrics.ts';

export interface StatsGaugeReaders {
  lruBytes: () => number;
  workerQueue: () => number;
  rss: () => number;
  heap: () => number;
  loopP50Seconds: () => number;
  loopP99Seconds: () => number;
  lruEvictions: () => number;
  writeQueue: () => number;
  writesInFlight: () => number;
}

/** The statistics endpoints themselves; their polling must not show up in the statistics. */
const STATS_ROUTES: ReadonlySet<string> = new Set(['stats', 'web_stats']);

function statusClass(status: string): string {
  return /^[1-5]\d\d$/.test(status) ? `${status[0]}xx` : 'other';
}

function total(entries: Array<[Record<string, string>, number]>): number {
  return entries.reduce((sum, [, v]) => sum + v, 0);
}

/** Sums the per-kind write duration histograms into one; null before the first write. */
function writeAttempts(metrics: Metrics): HistogramSample | null {
  const snap = metrics.storageWriteDuration.snapshot();
  if (snap.series.length === 0) return null;
  const counts = snap.bounds.map(() => 0);
  let count = 0;
  for (const s of snap.series) {
    s.counts.forEach((c, i) => {
      counts[i] = (counts[i] ?? 0) + c;
    });
    count += s.count;
  }
  return { bounds: snap.bounds, counts, count };
}

function writes(metrics: Metrics): WriteSample {
  return {
    failed: total(metrics.storageWriteFailures.entries()),
    dropped: total(metrics.storageWritesDropped.entries()),
    retries: total(metrics.storageWriteRetries.entries()),
    attempts: writeAttempts(metrics),
  };
}

export function metricsSource(metrics: Metrics, g: StatsGaugeReaders): () => StatsSample {
  return () => {
    const requests = dict<Dict<number>>();
    for (const [labels, v] of metrics.requests.entries()) {
      const route = labels.route ?? 'unknown';
      if (STATS_ROUTES.has(route)) continue;
      const byClass = (requests[route] ??= dict());
      const c = statusClass(labels.status ?? '');
      byClass[c] = (byClass[c] ?? 0) + v;
    }
    const cache = dict<number>();
    for (const [labels, v] of metrics.cacheResults.entries()) {
      const r = labels.result ?? 'unknown';
      cache[r] = (cache[r] ?? 0) + v;
    }
    const snap = metrics.requestDuration.snapshot();
    const latency = dict<HistogramSample>();
    for (const s of snap.series) {
      if (STATS_ROUTES.has(s.labels.route ?? '')) continue;
      latency[s.labels.route ?? 'unknown'] = {
        bounds: snap.bounds,
        counts: s.counts,
        count: s.count,
      };
    }
    return {
      requests,
      cache,
      coalesced: total(metrics.coalescedWaiters.entries()),
      upstreamRequests: total(metrics.upstreamRequests.entries()),
      upstreamErrors: total(metrics.upstreamErrors.entries()),
      blocked: total(metrics.blockedVersions.entries()),
      bytes: total(metrics.tarballBytes.entries()),
      evictions: g.lruEvictions(),
      gauges: {
        lruBytes: g.lruBytes(),
        workerQueue: g.workerQueue(),
        rss: g.rss(),
        heap: g.heap(),
        loopP50: g.loopP50Seconds(),
        loopP99: g.loopP99Seconds(),
        writeQueue: g.writeQueue(),
        writesInFlight: g.writesInFlight(),
      },
      latency,
      writes: writes(metrics),
    };
  };
}
