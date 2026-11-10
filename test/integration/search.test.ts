// C2: GET /-/v1/search. The cache fetches the upstream result itself (bounded, no client
// credentials), hides versions the policy blocks, and merges a PackageSource's packages.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity, SearchHit, SearchQuery } from '../../src/core/contracts.ts';
import type { FakeHook } from '../../src/testing/fake-upstream.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { json, send } from '../helpers/http.ts';
import { MemorySource } from '../helpers/memory-source.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Result = { objects: Array<{ package: { name: string; version: string } }>; total: number };

const hit = (name: string, version: string) => ({
  package: { name, version, date: '2026-01-01T00:00:00.000Z' },
  score: { final: 0.5 },
  searchScore: 1,
});

function searchHook(results: unknown[], total = results.length): FakeHook {
  return (req, res) => {
    if (!req.url?.startsWith('/-/v1/search')) return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ objects: results, total, time: 'now' }));
    return true;
  };
}

let cache: TestCache | null = null;
let server: TestServer | null = null;
afterEach(async () => {
  await cache?.close();
  await server?.close();
  cache = null;
  server = null;
});

const searches = (c: { upstream: TestCache['upstream'] }) =>
  c.upstream.requests.filter((r) => r.path.startsWith('/-/v1/search'));

describe('C2: search proxy', () => {
  it('forwards only known parameters and no client credentials or cookies', async () => {
    cache = await startCache();
    cache.upstream.hook = searchHook([hit('a', '1.0.0')]);
    const res = await send(cache.url, {
      path: '/-/v1/search?text=left%20pad&size=5&from=10&quality=0.5&token=secret&x=1',
      headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(200);
    expect((json(res) as Result).objects).toHaveLength(1);
    const [req] = searches(cache);
    expect(req?.path).toBe('/-/v1/search?text=left+pad&size=5&from=10&quality=0.5');
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers['x-forwarded-for']).toBeUndefined();
  });

  it('refuses invalid parameters with 400 before asking upstream', async () => {
    cache = await startCache();
    cache.upstream.hook = searchHook([]);
    for (const q of ['size=1000', 'from=-1', 'quality=2', 'text=a&text=b']) {
      expect((await send(cache.url, { path: `/-/v1/search?${q}` })).status).toBe(400);
    }
    expect(searches(cache)).toHaveLength(0);
  });

  it('answers 405 for writes', async () => {
    cache = await startCache();
    expect((await send(cache.url, { method: 'POST', path: '/-/v1/search?text=x' })).status).toBe(
      405,
    );
  });

  it('caches the upstream result briefly and shares concurrent requests', async () => {
    cache = await startCache();
    cache.upstream.delayMs = 50;
    cache.upstream.hook = searchHook([hit('a', '1.0.0')]);
    const [one, two] = await Promise.all([
      send(cache.url, { path: '/-/v1/search?text=a' }),
      send(cache.url, { path: '/-/v1/search?text=a' }),
    ]);
    expect(one.status).toBe(200);
    expect(two.body.equals(one.body)).toBe(true);
    await send(cache.url, { path: '/-/v1/search?text=a' });
    expect(searches(cache)).toHaveLength(1);
    await send(cache.url, { path: '/-/v1/search?text=b' });
    expect(searches(cache)).toHaveLength(2);
  });

  it('does not cache with SEARCH_CACHE_TTL=0', async () => {
    cache = await startCache({ SEARCH_CACHE_TTL: '0' });
    cache.upstream.hook = searchHook([]);
    await send(cache.url, { path: '/-/v1/search?text=a' });
    await send(cache.url, { path: '/-/v1/search?text=a' });
    expect(searches(cache)).toHaveLength(2);
  });

  it('answers 502 for an upstream error, garbage and an oversized body', async () => {
    cache = await startCache({ SEARCH_CACHE_TTL: '0' });
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(500);
      res.end('boom');
      return true;
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=a' })).status).toBe(502);
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>not json</html>');
      return true;
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=a' })).status).toBe(502);
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(3 * 1024 * 1024, 0x20));
      return true;
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=a' })).status).toBe(502);
  });

  it('answers 504 when upstream is too slow', async () => {
    cache = await startCache({ SEARCH_TIMEOUT: '1s', SEARCH_CACHE_TTL: '0' });
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      setTimeout(() => {
        res.writeHead(200);
        res.end('{"objects":[],"total":0}');
      }, 2500);
      return true;
    };
    const started = Date.now();
    expect((await send(cache.url, { path: '/-/v1/search?text=a' })).status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2400);
  });
});

describe('C2: upstream rate limit on cache misses', () => {
  it('answers 429 with Retry-After once the burst is used, and cache hits stay free', async () => {
    cache = await startCache({ SEARCH_UPSTREAM_RPS: '1', SEARCH_UPSTREAM_BURST: '2' });
    cache.upstream.hook = searchHook([hit('a', '1.0.0')]);
    expect((await send(cache.url, { path: '/-/v1/search?text=one' })).status).toBe(200);
    expect((await send(cache.url, { path: '/-/v1/search?text=two' })).status).toBe(200);
    const limited = await send(cache.url, { path: '/-/v1/search?text=three' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await send(cache.url, { path: '/-/v1/search?text=one' })).status).toBe(200);
    expect(searches(cache)).toHaveLength(2);
  });

  it('SEARCH_UPSTREAM_RPS=0 turns the limit off', async () => {
    cache = await startCache({ SEARCH_UPSTREAM_RPS: '0', SEARCH_UPSTREAM_BURST: '1' });
    cache.upstream.hook = searchHook([hit('a', '1.0.0')]);
    for (let i = 0; i < 5; i++) {
      expect((await send(cache.url, { path: `/-/v1/search?text=q${i}` })).status).toBe(200);
    }
  });

  it('serves a stale result instead of failing when the concurrency cap is reached', async () => {
    cache = await startCache({ SEARCH_UPSTREAM_RPS: '0', SEARCH_CACHE_TTL: '1s' });
    const release: Array<() => void> = [];
    const answer = searchHook([hit('a', '1.0.0')]);
    cache.upstream.hook = (req, res, body) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      if (req.url.includes('text=slow')) {
        release.push(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"objects":[],"total":0}');
        });
        return true;
      }
      return answer(req, res, body);
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=fresh' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // the entry is now stale
    const url = cache.url;
    const slow = [1, 2, 3, 4].map((i) => send(url, { path: `/-/v1/search?text=slow${i}` }));
    while (release.length < 4) await new Promise((r) => setTimeout(r, 10));
    const before = searches(cache).length;
    const stale = await send(cache.url, { path: '/-/v1/search?text=fresh' });
    expect(stale.status).toBe(200);
    expect((json(stale) as Result).objects[0]?.package.name).toBe('a');
    const none = await send(cache.url, { path: '/-/v1/search?text=never-seen' });
    expect(none.status).toBe(429);
    expect(none.headers['retry-after']).toBeDefined();
    expect(searches(cache)).toHaveLength(before);
    for (const fn of release) fn();
    await Promise.all(slow);
  });

  it('aborts the upstream request when the deadline fires before the response head', async () => {
    cache = await startCache({ SEARCH_TIMEOUT: '1s', SEARCH_CACHE_TTL: '0' });
    const started = Date.now();
    let closedAfter = -1;
    // The hook never answers: only an abort from the cache can end this request.
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.on('close', () => {
        closedAfter = Date.now() - started;
      });
      return true;
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=a' })).status).toBe(504);
    await new Promise((r) => setTimeout(r, 300));
    expect(closedAfter).toBeGreaterThan(0);
    expect(closedAfter).toBeLessThan(2000);
  });
});

describe('C2: name-only blocks hide search hits without cached metadata', () => {
  it('drops hits of packages the filter blocks as a whole, keeps version-level ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eyniq-search-filter-'));
    const rules = join(dir, 'rules.json');
    await writeFile(
      rules,
      JSON.stringify({
        block: [
          { package: 'gone' },
          { package: '@evil/*' },
          { package: 'ranged', versions: '>=2.0.0' },
          { package: 'rescued' },
        ],
        allow: [{ package: 'rescued', versions: '1.x' }],
      }),
    );
    cache = await startCache({ FILTER_RULES_PATH: rules });
    cache.upstream.hook = searchHook([
      hit('gone', '1.0.0'),
      hit('@evil/x', '1.0.0'),
      hit('ranged', '2.0.0'),
      hit('rescued', '1.0.0'),
      hit('fine', '1.0.0'),
    ]);
    const res = json(await send(cache.url, { path: '/-/v1/search?text=x' })) as Result;
    expect(res.objects.map((o) => o.package.name)).toEqual(['ranged', 'rescued', 'fine']);
    expect(res.total).toBe(3);
  });
});

describe('C2: results respect the policy', () => {
  it('rewrites a blocked version of a cached package and leaves unknown packages alone', async () => {
    cache = await startCache({ MIN_RELEASE_AGE: '3d' });
    cache.upstream.addPackage('gated', [
      { version: '1.0.0', publishedAt: ago(30 * 24 * H) },
      { version: '2.0.0', publishedAt: ago(2 * H) },
    ]);
    cache.upstream.hook = searchHook([hit('gated', '2.0.0'), hit('uncached', '9.9.9')]);
    // Not cached yet: left as upstream sent it (documented).
    let res = json(await send(cache.url, { path: '/-/v1/search?text=x' })) as Result;
    expect(res.objects.map((o) => o.package.version)).toEqual(['2.0.0', '9.9.9']);

    expect((await send(cache.url, { path: '/gated' })).status).toBe(200);
    res = json(await send(cache.url, { path: '/-/v1/search?text=x&size=19' })) as Result;
    expect(res.objects.map((o) => `${o.package.name}@${o.package.version}`)).toEqual([
      'gated@1.0.0',
      'uncached@9.9.9',
    ]);
  });

  it('hides a package whose versions are all blocked', async () => {
    cache = await startCache({ MIN_RELEASE_AGE: '3d' });
    cache.upstream.addPackage('allnew', [{ version: '1.0.0', publishedAt: ago(H) }]);
    cache.upstream.hook = searchHook([hit('allnew', '1.0.0'), hit('other', '1.0.0')], 2);
    await send(cache.url, { path: '/allnew' });
    const res = json(await send(cache.url, { path: '/-/v1/search?text=x' })) as Result;
    expect(res.objects.map((o) => o.package.name)).toEqual(['other']);
    expect(res.total).toBe(1);
  });
});

class SearchSource extends MemorySource {
  readonly queries: Array<{ query: SearchQuery; identity: string | null }> = [];
  hits: SearchHit[] = [];
  fail = false;
  search(query: SearchQuery, identity: Identity | null): Promise<SearchHit[]> {
    this.queries.push({ query, identity: identity?.name ?? null });
    return this.fail ? Promise.reject(new Error('source down')) : Promise.resolve(this.hits);
  }
}

describe('C2: PackageSource search hook', () => {
  it('merges the hits of a source in front of the upstream results', async () => {
    const source = new SearchSource((n) => n.startsWith('@acme/'));
    source.hits = [{ name: '@acme/lib', version: '1.2.3', description: 'internal' }];
    server = await startServer({ deps: { packageSources: { npm: source } } });
    server.upstream.hook = searchHook([hit('@acme/lib', '9.9.9'), hit('lodash', '4.17.21')], 7);
    const res = json(await send(server.url, { path: '/-/v1/search?text=lib&size=10' })) as Result;
    expect(res.objects.map((o) => `${o.package.name}@${o.package.version}`)).toEqual([
      '@acme/lib@1.2.3',
      'lodash@4.17.21',
    ]);
    expect(res.total).toBe(7);
    expect(source.queries[0]?.query).toMatchObject({ text: 'lib', size: 10, from: 0 });
  });

  it('still answers when the source fails or upstream is down', async () => {
    const source = new SearchSource(() => false);
    source.fail = true;
    server = await startServer({
      deps: { packageSources: { npm: source } },
      env: { SEARCH_CACHE_TTL: '0' },
    });
    server.upstream.hook = searchHook([hit('lodash', '4.17.21')]);
    expect((await send(server.url, { path: '/-/v1/search?text=x' })).status).toBe(200);
    source.fail = false;
    source.hits = [{ name: 'priv', version: '1.0.0' }];
    server.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(503);
      res.end();
      return true;
    };
    const res = json(await send(server.url, { path: '/-/v1/search?text=x' })) as Result;
    expect(res.objects.map((o) => o.package.name)).toEqual(['priv']);
  });
});
