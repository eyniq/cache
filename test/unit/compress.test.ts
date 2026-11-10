import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MetadataCompressor, acceptsGzip, gzipEtag } from '../../src/http/compress.ts';

describe('acceptsGzip', () => {
  it.each([
    ['gzip', true],
    ['gzip, deflate, br', true],
    ['br;q=1.0, gzip;q=0.8', true],
    ['x-gzip', true],
    ['*', true],
    ['GZIP', true],
    ['identity', false],
    ['br', false],
    ['gzip;q=0', false],
    ['gzip; q=0.000', false],
    ['*;q=0', false],
    ['', false],
  ])('%j -> %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it('is false without the header and joins repeated headers', () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip(['br', 'gzip'])).toBe(true);
  });
});

describe('gzipEtag', () => {
  it('suffixes strong and weak ETags inside the quotes', () => {
    expect(gzipEtag('"abc"')).toBe('"abc-gz"');
    expect(gzipEtag('W/"abc"')).toBe('W/"abc-gz"');
  });
});

describe('MetadataCompressor', () => {
  const body = Buffer.from(JSON.stringify({ name: 'x', readme: 'a'.repeat(10_000) }));

  it('gzips a body that round-trips', async () => {
    const c = new MetadataCompressor({ maxCacheBytes: 1_000_000 });
    const gz = await c.gzip('"k"', body);
    expect(gz.length).toBeLessThan(body.length);
    expect(gunzipSync(gz).equals(body)).toBe(true);
  });

  it('caches by key and coalesces concurrent calls', async () => {
    const c = new MetadataCompressor({ maxCacheBytes: 1_000_000 });
    const [a, b] = await Promise.all([c.gzip('"k"', body), c.gzip('"k"', body)]);
    expect(a).toBe(b);
    expect(await c.gzip('"k"', body)).toBe(a);
    expect(c.cacheBytes).toBe(a.length);
  });

  it('stays within its byte cap', async () => {
    const c = new MetadataCompressor({ maxCacheBytes: 0 });
    const gz = await c.gzip('"k"', body);
    expect(gunzipSync(gz).equals(body)).toBe(true);
    expect(c.cacheBytes).toBe(0);
  });

  it('only compresses bodies of at least minBytes', () => {
    const c = new MetadataCompressor({ maxCacheBytes: 1_000_000, minBytes: 1024 });
    expect(c.worthCompressing(Buffer.alloc(1023))).toBe(false);
    expect(c.worthCompressing(Buffer.alloc(1024))).toBe(true);
  });
});
