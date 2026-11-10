import { describe, expect, it } from 'vitest';
import { createPublicUrls, rebase } from '../../src/http/public-url.ts';

describe('rebase', () => {
  const from = Buffer.from('http://in:4873/');
  const to = Buffer.from('https://lan.example/');

  it('replaces every occurrence of the base', () => {
    const body = Buffer.from(
      '{"a":"http://in:4873/x/-/x-1.tgz","b":"http://in:4873/x/-/x-2.tgz","c":"keep"}',
    );
    expect(rebase(body, from, to).toString()).toBe(
      '{"a":"https://lan.example/x/-/x-1.tgz","b":"https://lan.example/x/-/x-2.tgz","c":"keep"}',
    );
  });

  it('returns the same buffer when the base does not occur', () => {
    const body = Buffer.from('{"a":"http://in:48731/x"}');
    expect(rebase(body, from, to)).toBe(body);
  });
});

describe('createPublicUrls', () => {
  const urls = createPublicUrls('http://in:4873/npm', [
    'https://lan.example',
    'http://10.0.0.5:8080/npm',
  ]);

  it('uses PUBLIC_URL unless the Host header names an alias exactly', () => {
    expect(urls.forHost(undefined)).toBeNull();
    expect(urls.forHost('in:4873')).toBeNull();
    expect(urls.forHost('evil.example')).toBeNull();
    expect(urls.forHost('lan.example.evil')).toBeNull();
    expect(urls.forHost('LAN.example')?.base).toBe('https://lan.example');
    expect(urls.forHost('10.0.0.5:8080')?.base).toBe('http://10.0.0.5:8080/npm');
    // The default port of the alias's scheme may be sent or left out.
    expect(urls.forHost('lan.example:443')?.base).toBe('https://lan.example');
  });

  it('gives each alias its own ETag variant', () => {
    const a = urls.forHost('lan.example')!;
    const b = urls.forHost('10.0.0.5:8080')!;
    expect(a.etag('"abc"')).toBe('"abc-a1"');
    expect(b.etag('"abc"')).toBe('"abc-a2"');
    expect(a.etag('W/"abc"')).toBe('W/"abc-a1"');
  });

  it('rewrites bodies from PUBLIC_URL to the alias base', () => {
    const a = urls.forHost('lan.example')!;
    expect(a.rewrite(Buffer.from('"http://in:4873/npm/x/-/x-1.tgz"')).toString()).toBe(
      '"https://lan.example/x/-/x-1.tgz"',
    );
  });
});
