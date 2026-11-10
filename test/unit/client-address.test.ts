import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientAddress } from '../../src/http/client-address.ts';

const req = (remote: string | undefined, xff?: string | string[]) =>
  ({
    socket: { remoteAddress: remote },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as IncomingMessage;

describe('clientAddress', () => {
  it('uses the socket address when no proxy is trusted, ignoring X-Forwarded-For', () => {
    expect(clientAddress(req('10.0.0.5', '203.0.113.9'), 0)).toBe('10.0.0.5');
    expect(clientAddress(req('::ffff:10.0.0.5'), 0)).toBe('10.0.0.5');
    expect(clientAddress(req(undefined), 0)).toBeUndefined();
  });

  it('takes the address the outermost trusted proxy saw', () => {
    // One ingress: it appended the real client; anything left of it is client-controlled.
    expect(clientAddress(req('10.0.0.1', 'spoofed, 203.0.113.9'), 1)).toBe('203.0.113.9');
    // Two proxies: CDN appended the client, ingress appended the CDN.
    expect(clientAddress(req('10.0.0.1', '1.1.1.1, 203.0.113.9, 198.51.100.2'), 2)).toBe(
      '203.0.113.9',
    );
    expect(clientAddress(req('10.0.0.1', ['1.1.1.1', '203.0.113.9']), 1)).toBe('203.0.113.9');
  });

  it('unwraps IPv4-mapped addresses in any case and keeps other IPv6 addresses', () => {
    expect(clientAddress(req('10.0.0.1', '::FFFF:203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientAddress(req('::ffff:abcd'), 0)).toBe('::ffff:abcd');
    expect(clientAddress(req('2001:DB8::1'), 0)).toBe('2001:db8::1');
  });

  it('falls back to the socket address for a missing or invalid header', () => {
    expect(clientAddress(req('10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(clientAddress(req('10.0.0.1', 'garbage'), 1)).toBe('10.0.0.1');
    expect(clientAddress(req('10.0.0.1', '203.0.113.9'), 3)).toBe('203.0.113.9');
  });
});
