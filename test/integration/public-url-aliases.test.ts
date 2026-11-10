import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT, json, send } from '../helpers/http.ts';

const ALIAS = 'https://npm.lan.example';
let cache: TestCache;
const get = (path: string, headers: Record<string, string> = {}) =>
  send(cache.url, { path, headers });
type Doc = { versions: Record<string, { dist: { tarball: string } }> };

beforeAll(async () => {
  cache = await startCache({ PUBLIC_URL_ALIASES: ALIAS });
  cache.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
  cache.upstream.addPackage('@scope/thing', [{ version: '1.0.0' }]);
});

afterAll(async () => {
  await cache.close();
});

describe('PUBLIC_URL_ALIASES', () => {
  it('keeps PUBLIC_URL for every other host', async () => {
    const res = await get('/lodash');
    expect((json(res) as Doc).versions['4.17.21']!.dist.tarball).toBe(
      `${cache.url}/lodash/-/lodash-4.17.21.tgz`,
    );
    const other = await get('/lodash', { host: 'evil.example' });
    expect((json(other) as Doc).versions['4.17.21']!.dist.tarball).toBe(
      `${cache.url}/lodash/-/lodash-4.17.21.tgz`,
    );
    expect(other.headers.etag).toBe(res.headers.etag);
  });

  it.each([
    ['full', {}],
    ['abbreviated', { accept: ABBREVIATED_ACCEPT }],
  ])('serves %s packuments with tarball URLs on the alias host', async (_view, headers) => {
    const res = await get('/@scope%2fthing', { ...headers, host: 'npm.lan.example' });
    expect(res.status).toBe(200);
    expect((json(res) as Doc).versions['1.0.0']!.dist.tarball).toBe(
      `${ALIAS}/@scope/thing/-/thing-1.0.0.tgz`,
    );
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    expect(res.body.includes(cache.url)).toBe(false);
  });

  it('uses an ETag of its own per alias and answers 304 for it', async () => {
    const canonical = await get('/lodash');
    const aliased = await get('/lodash', { host: 'npm.lan.example' });
    const etag = String(aliased.headers.etag);
    expect(etag).not.toBe(canonical.headers.etag);
    expect((await get('/lodash', { host: 'npm.lan.example', 'if-none-match': etag })).status).toBe(
      304,
    );
    // The canonical ETag does not validate the alias body, and the other way round.
    expect(
      (
        await get('/lodash', {
          host: 'npm.lan.example',
          'if-none-match': String(canonical.headers.etag),
        })
      ).status,
    ).toBe(200);
    expect((await get('/lodash', { 'if-none-match': etag })).status).toBe(200);
  });

  it('serves the tarball itself on either host', async () => {
    const path = '/lodash/-/lodash-4.17.21.tgz';
    const res = await get(path, { host: 'npm.lan.example' });
    expect(res.status).toBe(200);
    expect(res.body.equals(cache.upstream.tarballs.get(path)!)).toBe(true);
  });
});
