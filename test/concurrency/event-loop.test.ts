// DESIGN.md section 12: processing a 20+ MB packument must not block the main thread.
import { request } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT } from '../helpers/http.ts';
import { buildSyntheticPackument } from '../helpers/synthetic-packument.ts';

const fixture = buildSyntheticPackument('big-package');
let cache: TestCache;

beforeAll(async () => {
  cache = await startCache({ WORKERS: '2' });
  // Pre-encoded once, so the fake upstream (same process) does no work during measurement.
  cache.upstream.setRawPackument('big-package', fixture);
});

afterAll(async () => {
  await cache.close();
});

/** Streams the response and only counts bytes: parsing 30 MB here would block the loop. */
function fetchCount(path: string, accept: string): Promise<{ status: number; bytes: number }> {
  const { hostname, port } = new URL(cache.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers: { accept } }, (res) => {
      let bytes = 0;
      res.on('data', (c: Buffer) => (bytes += c.length));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, bytes });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('section 12: event-loop delay', () => {
  it('uses a fixture above 20 MB', () => {
    expect(fixture.length).toBeGreaterThan(20 * 1024 * 1024);
  });

  // One retry: the fake upstream and the client share this process with the cache, so a GC
  // pause on a loaded CI runner can land in the measurement.
  it(
    'keeps event-loop delay at or below 50 ms while processing the fixture',
    { retry: 1 },
    async () => {
      const h = monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      const abbreviated = await fetchCount('/big-package', ABBREVIATED_ACCEPT);
      const full = await fetchCount('/big-package', 'application/json');
      h.disable();
      expect(abbreviated.status).toBe(200);
      expect(full.status).toBe(200);
      expect(full.bytes).toBeGreaterThan(20 * 1024 * 1024);
      const maxMs = h.max / 1e6;
      expect(maxMs, `max event-loop delay ${maxMs.toFixed(1)} ms`).toBeLessThanOrEqual(50);
    },
  );
});
