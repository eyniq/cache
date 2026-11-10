import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT, send } from '../helpers/http.ts';

const versions = Array.from({ length: 40 }, (_, i) => ({
  version: `1.0.${i}`,
  dependencies: { lodash: '^4.17.0', 'left-pad': '^1.3.0' },
}));

describe('metadata gzip', () => {
  let cache: TestCache;
  const get = (path: string, headers: Record<string, string> = {}) =>
    send(cache.url, { path, headers });

  beforeAll(async () => {
    cache = await startCache();
    cache.upstream.addPackage('big', versions);
  });

  afterAll(async () => {
    await cache.close();
  });

  it('sends gzip when the client accepts it, with its own ETag', async () => {
    const plain = await get('/big');
    const gz = await get('/big', { 'accept-encoding': 'gzip, deflate, br' });
    expect(plain.status).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(gz.status).toBe(200);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.vary).toMatch(/Accept-Encoding/);
    expect(gz.headers['content-length']).toBe(String(gz.body.length));
    expect(gz.body.length).toBeLessThan(plain.body.length);
    expect(gunzipSync(gz.body).equals(plain.body)).toBe(true);
    expect(gz.headers.etag).toBe(String(plain.headers.etag).replace(/"$/, '-gz"'));
  });

  it('gzips the abbreviated form too', async () => {
    const plain = await get('/big', { accept: ABBREVIATED_ACCEPT });
    const gz = await get('/big', { accept: ABBREVIATED_ACCEPT, 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).equals(plain.body)).toBe(true);
  });

  it('does not gzip for q=0 or identity', async () => {
    for (const ae of ['gzip;q=0', 'identity']) {
      const res = await get('/big', { 'accept-encoding': ae });
      expect(res.headers['content-encoding']).toBeUndefined();
    }
  });

  it('answers 304 for either ETag and reports the gzip one', async () => {
    const plain = await get('/big');
    const gz = await get('/big', { 'accept-encoding': 'gzip' });
    for (const tag of [String(plain.headers.etag), String(gz.headers.etag)]) {
      const res = await get('/big', { 'accept-encoding': 'gzip', 'if-none-match': tag });
      expect(res.status).toBe(304);
      expect(res.body.length).toBe(0);
      expect(res.headers.etag).toBe(gz.headers.etag);
    }
  });

  it('answers HEAD with the gzip length and no body', async () => {
    const gz = await get('/big', { 'accept-encoding': 'gzip' });
    const head = await send(cache.url, {
      method: 'HEAD',
      path: '/big',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-encoding']).toBe('gzip');
    expect(head.headers['content-length']).toBe(String(gz.body.length));
  });
});

describe('metadata gzip disabled', () => {
  let cache: TestCache;

  beforeAll(async () => {
    cache = await startCache({ COMPRESS_METADATA: 'false' });
    cache.upstream.addPackage('big', versions);
  });

  afterAll(async () => {
    await cache.close();
  });

  it('never compresses with COMPRESS_METADATA=false', async () => {
    const res = await send(cache.url, { path: '/big', headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
