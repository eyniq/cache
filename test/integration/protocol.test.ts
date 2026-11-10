import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT, json, send } from '../helpers/http.ts';

let cache: TestCache;
const get = (path: string, headers: Record<string, string> = {}) =>
  send(cache.url, { path, headers });

beforeAll(async () => {
  cache = await startCache();
  const up = cache.upstream;
  up.addPackage('lodash', [
    { version: '4.17.20', scripts: { postinstall: 'node x.js' } },
    { version: '4.17.21' },
  ]);
  up.addPackage('@scope/thing', [{ version: '1.0.0', dependencies: { lodash: '^4.17.0' } }]);
  up.hook = (req, res, body) => {
    const url = req.url ?? '';
    if (url.startsWith('/-/v1/search') || url.startsWith('/-/npm/v1/security/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=1' });
      res.end(
        JSON.stringify({
          method: req.method,
          url,
          bodyBytes: body.length,
          authorization: req.headers.authorization ?? null,
          cookie: req.headers.cookie ?? null,
          contentEncoding: req.headers['content-encoding'] ?? null,
          objects: [],
          total: 0,
        }),
      );
      return true;
    }
    return false;
  };
});

afterAll(async () => {
  await cache.close();
});

describe('slice 2: scoped packages', () => {
  it.each(['/@scope%2fthing', '/@scope/thing'])('serves the packument at %s', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const doc = json(res) as { versions: Record<string, { dist: { tarball: string } }> };
    expect(doc.versions['1.0.0']!.dist.tarball).toBe(`${cache.url}/@scope/thing/-/thing-1.0.0.tgz`);
  });

  it('serves the scoped tarball', async () => {
    const path = '/@scope/thing/-/thing-1.0.0.tgz';
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.equals(cache.upstream.tarballs.get(path)!)).toBe(true);
  });
});

describe('slice 2: abbreviated packuments and version documents', () => {
  it('serves the abbreviated form but always fetches the full document upstream', async () => {
    const res = await get('/lodash', { accept: ABBREVIATED_ACCEPT });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.npm.install-v1+json');
    const doc = json(res) as {
      versions: Record<string, Record<string, unknown>>;
      readme?: string;
    };
    expect(doc.readme).toBeUndefined();
    expect(doc.versions['4.17.20']!.hasInstallScript).toBe(true);
    const upstreamAccepts = cache.upstream.requests
      .filter((r) => r.path === '/lodash')
      .map((r) => r.headers.accept);
    expect(upstreamAccepts.every((a) => a === 'application/json')).toBe(true);
  });

  it('varies on Accept', async () => {
    const res = await get('/lodash');
    expect(String(res.headers.vary)).toMatch(/accept/i);
  });

  it('serves version and dist-tag documents', async () => {
    expect(json(await get('/lodash/4.17.20')).version).toBe('4.17.20');
    expect(json(await get('/lodash/latest')).version).toBe('4.17.21');
    expect(json(await get('/@scope/thing/1.0.0')).version).toBe('1.0.0');
    expect((await get('/lodash/9.9.9')).status).toBe(404);
  });
});

describe('slice 2: ETag, 304 and HEAD', () => {
  it('answers 304 for a matching packument ETag', async () => {
    const first = await get('/lodash');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"/);
    const again = await get('/lodash', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect((await get('/lodash', { 'if-none-match': `"x", ${etag}` })).status).toBe(304);
    expect((await get('/lodash', { 'if-none-match': `W/${etag}` })).status).toBe(304);
  });

  it('uses different ETags for the full and abbreviated forms', async () => {
    const full = await get('/lodash');
    const abbr = await get('/lodash', { accept: ABBREVIATED_ACCEPT });
    expect(full.headers.etag).not.toBe(abbr.headers.etag);
  });

  it('answers 304 for a matching tarball ETag', async () => {
    const path = '/lodash/-/lodash-4.17.21.tgz';
    const first = await get(path);
    expect(first.status).toBe(200);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"sha512-/);
    expect((await get(path, { 'if-none-match': etag })).status).toBe(304);
  });

  it('answers HEAD for a packument with headers only', async () => {
    const full = await get('/lodash');
    const head = await send(cache.url, { method: 'HEAD', path: '/lodash' });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(full.body.length));
    expect(head.headers.etag).toBe(full.headers.etag);
  });

  it('answers HEAD for an uncached tarball via upstream HEAD, without caching it', async () => {
    cache.upstream.addPackage('headonly', [{ version: '1.0.0' }]);
    const path = '/headonly/-/headonly-1.0.0.tgz';
    const head = await send(cache.url, { method: 'HEAD', path });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(cache.upstream.tarballs.get(path)!.length));
    expect(cache.upstream.count((r) => r.path === path && r.method === 'GET')).toBe(0);
    expect(cache.upstream.count((r) => r.path === path && r.method === 'HEAD')).toBe(1);
  });

  it('answers HEAD for a cached tarball from storage', async () => {
    const path = '/lodash/-/lodash-4.17.20.tgz';
    await get(path);
    const before = cache.upstream.requests.length;
    const head = await send(cache.url, { method: 'HEAD', path });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(cache.upstream.tarballs.get(path)!.length));
    expect(cache.upstream.requests.length).toBe(before);
  });
});

describe('slice 2: special endpoints', () => {
  it('answers ping', async () => {
    const res = await get('/-/ping');
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({});
  });

  it('answers whoami with 401 without token auth', async () => {
    expect((await get('/-/whoami')).status).toBe(401);
  });

  it('passes audit requests through uncached, without credentials', async () => {
    const path = '/-/npm/v1/security/advisories/bulk';
    const body = JSON.stringify({ lodash: ['4.17.20'] });
    const call = () =>
      send(cache.url, {
        method: 'POST',
        path,
        body,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
          cookie: 'session=1',
        },
      });
    const res = await call();
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      method: 'POST',
      url: path,
      bodyBytes: body.length,
      authorization: null,
      cookie: null,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    await call();
    expect(cache.upstream.countPath(path)).toBe(2);
  });

  it('forwards a gzip-encoded audit body untouched', async () => {
    const res = await send(cache.url, {
      method: 'POST',
      path: '/-/npm/v1/security/audits/quick',
      body: Buffer.from([0x1f, 0x8b, 1, 2, 3]),
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    expect(json(res)).toMatchObject({ bodyBytes: 5, contentEncoding: 'gzip' });
  });

  it('refuses audit bodies above 10 MB with 413 before contacting upstream', async () => {
    const before = cache.upstream.requests.length;
    const res = await send(cache.url, {
      method: 'POST',
      path: '/-/npm/v1/security/advisories/bulk',
      body: Buffer.alloc(10 * 1024 * 1024 + 1, 32),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
    expect(cache.upstream.requests.length).toBe(before);
  });

  it('passes search through with its query', async () => {
    const res = await get('/-/v1/search?text=lodash&size=1');
    expect(json(res)).toMatchObject({ method: 'GET', url: '/-/v1/search?text=lodash&size=1' });
  });

  it.each([
    ['PUT', '/lodash'],
    ['DELETE', '/lodash/-/lodash-4.17.21.tgz/-rev/1-x'],
    ['PUT', '/-/user/org.couchdb.user:bob'],
    ['POST', '/lodash'],
  ])('rejects %s %s with 405', async (method, path) => {
    // Node's client sends a DELETE body without framing; npm unpublish sends none either.
    const body = method === 'DELETE' ? undefined : '{}';
    const res = await send(cache.url, { method, path, ...(body ? { body } : {}) });
    expect(res.status, res.body.toString()).toBe(405);
    expect((json(res) as { error: string }).error).toMatch(/read-only/);
  });
});

describe('slice 2: /npm mount', () => {
  it.each([
    '/npm/lodash',
    '/npm/@scope%2fthing',
    '/npm/lodash/-/lodash-4.17.21.tgz',
    '/npm/-/ping',
  ])('serves %s', async (path) => {
    expect((await get(path)).status).toBe(200);
  });
});
