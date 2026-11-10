import { describe, expect, it } from 'vitest';
import { diffSample, parsePoint, parsePoints, quantile, rollup } from '../../src/stats/points.ts';
import { dict, type StatsSample } from '../../src/stats/types.ts';

const BOUNDS = [0.01, 0.1, 1];

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
      lruBytes: 10,
      workerQueue: 0,
      rss: 100,
      heap: 50,
      loopP50: 0.001,
      loopP99: 0.01,
      writeQueue: 0,
      writesInFlight: 0,
    },
    latency: dict(),
    ...over,
  };
}

function obj<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(dict<T>(), entries);
}

describe('quantile', () => {
  it('interpolates inside a bucket like histogram_quantile', () => {
    // 10 observations: 5 <= 0.01, 5 more <= 0.1.
    expect(quantile(BOUNDS, [5, 10, 10], 10, 0.5)).toBeCloseTo(0.01, 6);
    expect(quantile(BOUNDS, [5, 10, 10], 10, 0.75)).toBeCloseTo(0.01 + 0.09 * 0.5, 6);
  });

  it('reports the last bound for observations above every bound, and 0 when empty', () => {
    expect(quantile(BOUNDS, [0, 0, 0], 4, 0.99)).toBe(1);
    expect(quantile(BOUNDS, [0, 0, 0], 0, 0.99)).toBe(0);
  });
});

describe('diffSample', () => {
  it('turns cumulative counters into per-interval deltas by route and status class', () => {
    const prev = sample({
      requests: obj({ packument: obj({ '2xx': 10 }) }),
      cache: obj({ hit: 5 }),
      bytes: 100,
    });
    const cur = sample({
      requests: obj({ packument: obj({ '2xx': 25, '5xx': 1 }), artifact: obj({ '2xx': 3 }) }),
      cache: obj({ hit: 9, miss: 2 }),
      coalesced: 4,
      upstreamRequests: 7,
      upstreamErrors: 1,
      blocked: 2,
      bytes: 600,
      evictions: 3,
    });
    const p = diffSample(prev, cur, 1_000, 60);
    expect(p.t).toBe(1_000);
    expect(p.s).toBe(60);
    expect(p.req.packument).toEqual({ '2xx': 15, '5xx': 1 });
    expect(p.req.artifact).toEqual({ '2xx': 3 });
    expect(p.cache).toEqual({ hit: 4, miss: 2 });
    expect(p).toMatchObject({
      coalesced: 4,
      upstreamRequests: 7,
      upstreamErrors: 1,
      blocked: 2,
      bytes: 500,
      evictions: 3,
    });
    expect(p.gauges.rss).toEqual({ avg: 100, max: 100 });
  });

  it('leaves probe and management routes out', () => {
    const cur = sample({
      requests: obj({
        livez: obj({ '2xx': 99 }),
        metrics: obj({ '2xx': 9 }),
        packument: obj({ '2xx': 1 }),
      }),
    });
    expect(Object.keys(diffSample(sample(), cur, 1, 60).req)).toEqual(['packument']);
  });

  it('derives latency quantiles from the bucket deltas of the interval only', () => {
    const prev = sample({
      latency: obj({ packument: { bounds: BOUNDS, counts: [100, 100, 100], count: 100 } }),
    });
    const cur = sample({
      latency: obj({
        packument: { bounds: BOUNDS, counts: [100, 108, 110], count: 110 },
      }),
    });
    const lat = diffSample(prev, cur, 1, 60).lat.packument;
    // 10 new observations: 0 <= 0.01, 8 <= 0.1, 10 <= 1.
    expect(lat?.[3]).toBe(10);
    expect(lat?.[1]).toBeGreaterThan(0.1);
    expect(lat?.[0]).toBeLessThan(0.1);
  });

  it('treats a counter that went down as a restart instead of going negative', () => {
    const p = diffSample(sample({ bytes: 500 }), sample({ bytes: 20 }), 1, 60);
    expect(p.bytes).toBe(20);
  });
});

describe('rollup', () => {
  it('sums counters, weights gauge averages by samples and keeps the worst latency', () => {
    const a = diffSample(
      sample(),
      sample({
        requests: obj({ packument: obj({ '2xx': 2 }) }),
        gauges: {
          lruBytes: 0,
          workerQueue: 0,
          rss: 100,
          heap: 0,
          loopP50: 0,
          loopP99: 0,
          writeQueue: 0,
          writesInFlight: 0,
        },
        latency: obj({ packument: { bounds: BOUNDS, counts: [2, 2, 2], count: 2 } }),
      }),
      60,
      60,
    );
    const b = diffSample(
      sample(),
      sample({
        requests: obj({ packument: obj({ '2xx': 3 }), artifact: obj({ '4xx': 1 }) }),
        gauges: {
          lruBytes: 0,
          workerQueue: 0,
          rss: 300,
          heap: 0,
          loopP50: 0,
          loopP99: 0,
          writeQueue: 0,
          writesInFlight: 0,
        },
        latency: obj({ packument: { bounds: BOUNDS, counts: [0, 0, 3], count: 3 } }),
      }),
      120,
      60,
    );
    const r = rollup([a, b], 0);
    expect(r.t).toBe(0);
    expect(r.s).toBe(120);
    expect(r.k).toBe(2);
    expect(r.req.packument).toEqual({ '2xx': 5 });
    expect(r.req.artifact).toEqual({ '4xx': 1 });
    expect(r.gauges.rss).toEqual({ avg: 200, max: 300 });
    expect(r.lat.packument?.[3]).toBe(5);
    expect(r.lat.packument?.[1]).toBe(
      Math.max(a.lat.packument?.[1] ?? 0, b.lat.packument?.[1] ?? 0),
    );
  });
});

describe('parsePoint', () => {
  const good = diffSample(
    sample(),
    sample({ requests: obj({ packument: obj({ '2xx': 1 }) }) }),
    5,
    60,
  );

  it('round-trips a point', () => {
    expect(parsePoint(JSON.stringify(good))).toEqual(good);
  });

  it('rejects malformed, negative, oversized-key and non-object input', () => {
    expect(parsePoint('not json')).toBeNull();
    expect(parsePoint('[]')).toBeNull();
    expect(parsePoint(JSON.stringify({ ...good, bytes: -1 }))).toBeNull();
    expect(parsePoint(JSON.stringify({ ...good, req: { 'a b': { '2xx': 1 } } }))).toBeNull();
    expect(parsePoint(JSON.stringify({ ...good, lat: { x: [1, 2, 3] } }))).toBeNull();
  });

  it('keeps a "__proto__" key as plain data', () => {
    const line = JSON.stringify(good).replace('"req":{', '"req":{"__proto__":{"2xx":1},');
    const p = parsePoint(line);
    expect(Object.getPrototypeOf(p?.req)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('skips bad lines and caps the number of lines read', () => {
    const text = `${JSON.stringify(good)}\ngarbage\n${JSON.stringify(good)}\n`;
    expect(parsePoints(text)).toHaveLength(2);
    expect(parsePoints(text, 1)).toHaveLength(1);
  });
});
