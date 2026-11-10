// DESIGN.md section 12, concurrency: request coalescing must hold under real HTTP load.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { send } from '../helpers/http.ts';

let cache: TestCache;
const SLOW = 1500;

beforeAll(async () => {
  cache = await startCache();
  const up = cache.upstream;
  up.addPackage('burst', [{ version: '1.0.0' }]);
  up.addPackage('tarburst', [{ version: '1.0.0' }]);
  up.addPackage('badburst', [{ version: '1.0.0', corrupt: true }]);
  // Keep upstream answers in flight long enough for every client request to arrive.
  up.hook = (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/failburst')) {
      setTimeout(() => {
        res.writeHead(500);
        res.end();
      }, SLOW);
      return true;
    }
    if (/^\/(burst|tarburst|badburst)(\/|$)/.test(url)) {
      setTimeout(() => {
        up.serve(req, res);
      }, SLOW);
      return true;
    }
    return false;
  };
});

afterAll(async () => {
  await cache.close();
});

const many = <T>(n: number, fn: () => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, fn));

describe('section 12: concurrency', () => {
  it('1,000 concurrent requests for one uncached packument cause exactly 1 upstream fetch', async () => {
    const responses = await many(1000, () => send(cache.url, { path: '/burst' }));
    expect(responses.filter((r) => r.status !== 200)).toEqual([]);
    expect(new Set(responses.map((r) => r.body.toString('base64'))).size).toBe(1);
    expect(cache.upstream.countPath('/burst')).toBe(1);
  });

  it('200 concurrent cold tarball requests cause 1 upstream fetch and identical bytes', async () => {
    const path = '/tarburst/-/tarburst-1.0.0.tgz';
    const expected = cache.upstream.tarballs.get(path)!;
    const responses = await many(200, () => send(cache.url, { path }));
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.aborted).toBe(false);
      expect(r.body.equals(expected)).toBe(true);
    }
    expect(cache.upstream.count((r) => r.path === path && r.method === 'GET')).toBe(1);
    expect(cache.upstream.countPath('/tarburst')).toBe(1);
  });

  it('shares an upstream failure with every waiter instead of retrying per request', async () => {
    const responses = await many(50, () => send(cache.url, { path: '/failburst' }));
    expect(responses.every((r) => r.status === 502)).toBe(true);
    expect(cache.upstream.countPath('/failburst')).toBe(1);
  });

  it('never hands verified-looking bytes of a corrupt tarball to any waiter', async () => {
    const path = '/badburst/-/badburst-1.0.0.tgz';
    const responses = await many(20, () => send(cache.url, { path }));
    expect(responses.every((r) => r.aborted || r.status >= 500)).toBe(true);
  });
});
