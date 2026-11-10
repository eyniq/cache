import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/http/metrics.ts';
import { metricsSource } from '../../src/http/stats-source.ts';

const readers = {
  lruBytes: () => 0,
  workerQueue: () => 0,
  rss: () => 1,
  heap: () => 1,
  loopP50Seconds: () => 0,
  loopP99Seconds: () => 0,
  lruEvictions: () => 0,
  writeQueue: () => 0,
  writesInFlight: () => 0,
};

describe('metricsSource', () => {
  it('leaves the statistics endpoints out of the request counts and latency', () => {
    const metrics = new Metrics();
    for (const route of ['packument', 'stats', 'web_stats']) {
      metrics.requests.inc({ route, status: '200' });
      metrics.requestDuration.observe(0.01, { route });
    }
    const sample = metricsSource(metrics, readers)();
    expect(Object.keys(sample.requests)).toEqual(['packument']);
    expect(Object.keys(sample.latency)).toEqual(['packument']);
  });
});
