import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/http/metrics.ts';
import { metricsSource } from '../../src/http/stats-source.ts';
import { diffSample, parsePoint, rollup } from '../../src/stats/points.ts';
import { buildResult } from '../../src/stats/reader.ts';
import { dict, GAUGE_NAMES, type StatsSample } from '../../src/stats/types.ts';

const BOUNDS = [0.1, 1, 10];

function sample(over: Partial<StatsSample> = {}): StatsSample {
  return {
    requests: dict(),
    cache: dict(),
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
      writeQueue: 3,
      writesInFlight: 2,
    },
    latency: dict(),
    ...over,
  };
}

const none = { failed: 0, dropped: 0, retries: 0 };

describe('storage write statistics', () => {
  it('turns write counters and the attempt histogram into one interval', () => {
    const prev = sample({
      writes: { ...none, attempts: { bounds: BOUNDS, counts: [5, 5, 5], count: 5 } },
    });
    const cur = sample({
      // 10 new attempts: 8 fast, 2 slow; 1 retry, 1 final failure, 4 dropped.
      writes: {
        failed: 1,
        dropped: 4,
        retries: 1,
        attempts: { bounds: BOUNDS, counts: [13, 13, 15], count: 15 },
      },
    });
    const p = diffSample(prev, cur, 100, 60);
    expect(p.writes).toEqual({ ok: 8, failed: 1, dropped: 4, retries: 1 });
    expect(p.writeLatency?.[3]).toBe(10);
    expect(p.writeLatency?.[1]).toBeGreaterThan(1);
    expect(p.gauges.writeQueue).toEqual({ avg: 3, max: 3 });
    expect(p.gauges.writesInFlight.max).toBe(2);
  });

  it('is zero and null when the source meters no writes', () => {
    const p = diffSample(sample(), sample(), 100, 60);
    expect(p.writes).toEqual({ ok: 0, failed: 0, dropped: 0, retries: 0 });
    expect(p.writeLatency).toBeNull();
  });

  it('rolls writes up: sums, worst latency, peak queue', () => {
    const a = diffSample(
      sample(),
      sample({
        writes: {
          failed: 1,
          dropped: 0,
          retries: 0,
          attempts: { bounds: BOUNDS, counts: [2, 2, 2], count: 2 },
        },
      }),
      60,
      60,
    );
    const b = diffSample(
      sample(),
      sample({
        writes: {
          failed: 0,
          dropped: 2,
          retries: 0,
          attempts: { bounds: BOUNDS, counts: [0, 0, 3], count: 3 },
        },
        gauges: { ...sample().gauges, writeQueue: 9 },
      }),
      120,
      60,
    );
    const r = rollup([a, b], 0);
    expect(r.writes).toEqual({ ok: 4, failed: 1, dropped: 2, retries: 0 });
    expect(r.writeLatency?.[3]).toBe(5);
    expect(r.gauges.writeQueue.max).toBe(9);
    const res = buildResult(
      new Map([['pod', [a, b]]]),
      { range: '1h', from: 0, to: 200, step: 300, tier: 'minute', generatedAt: 200 },
      { truncated: false, skipped: 0 },
    );
    expect(res.totals.writes.failed).toBe(1);
    expect(res.totals.writeLatency?.p95).toBeGreaterThan(0);
  });

  it('reads points stored before the write fields existed', () => {
    const old = diffSample(sample(), sample(), 100, 60) as unknown as Record<string, unknown>;
    delete old.writes;
    delete old.writeLatency;
    const gauges = { ...(old.gauges as Record<string, unknown>) };
    delete gauges.writeQueue;
    delete gauges.writesInFlight;
    old.gauges = gauges;
    const p = parsePoint(JSON.stringify(old));
    expect(p?.writes).toEqual({ ok: 0, failed: 0, dropped: 0, retries: 0 });
    expect(p?.writeLatency).toBeNull();
    expect(p?.gauges.writeQueue).toEqual({ avg: 0, max: 0 });
    expect(Object.keys(p?.gauges ?? {}).sort()).toEqual([...GAUGE_NAMES].sort());
  });

  it('rejects malformed write fields', () => {
    const good = diffSample(sample(), sample(), 100, 60) as unknown as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
    expect(parsePoint(JSON.stringify(good))).not.toBeNull();
    expect(parsePoint(bad({ writes: { ok: -1, failed: 0, dropped: 0, retries: 0 } }))).toBeNull();
    expect(parsePoint(bad({ writes: { ok: 1 } }))).toBeNull();
    expect(parsePoint(bad({ writes: [] }))).toBeNull();
    expect(parsePoint(bad({ writeLatency: [1, 2, 3] }))).toBeNull();
    expect(parsePoint(bad({ writeLatency: [1, 2, 3, 'x'] }))).toBeNull();
    expect(parsePoint(bad({ writeLatency: [1, 2, 3, 1e30] }))).toBeNull();
  });

  it('metricsSource sums the write metrics over kinds', () => {
    const metrics = new Metrics();
    const readers = {
      lruBytes: () => 0,
      workerQueue: () => 0,
      rss: () => 1,
      heap: () => 1,
      loopP50Seconds: () => 0,
      loopP99Seconds: () => 0,
      lruEvictions: () => 0,
      writeQueue: () => 7,
      writesInFlight: () => 4,
    };
    expect(metricsSource(metrics, readers)().writes?.attempts).toBeNull();
    metrics.storageWriteDuration.observe(0.05, { kind: 'meta' });
    metrics.storageWriteDuration.observe(5, { kind: 'tarball' });
    metrics.storageWriteFailures.inc({ kind: 'tarball', reason: 'timeout' });
    metrics.storageWritesDropped.inc({ kind: 'index' });
    metrics.storageWriteRetries.inc({ kind: 'tarball' });
    const s = metricsSource(metrics, readers)();
    expect(s.writes).toMatchObject({ failed: 1, dropped: 1, retries: 1 });
    expect(s.writes?.attempts?.count).toBe(2);
    expect(s.gauges.writeQueue).toBe(7);
    expect(s.gauges.writesInFlight).toBe(4);
  });
});
