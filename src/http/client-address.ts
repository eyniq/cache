// The client's address, for per-address limits (login throttling). With TRUST_PROXY_HOPS=0
// (default) it is the socket peer and X-Forwarded-For is ignored: any client can write that
// header. With N trusted proxies in front, each appends the address it received the request
// from, so the entry N places from the right is the client as the outermost trusted proxy saw
// it; everything to its left is client-controlled.
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

function normalize(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  // Lowercased first: a proxy may write ::FFFF:a.b.c.d.
  const a = address.trim().toLowerCase();
  // IPv4 clients on a dual-stack socket appear as ::ffff:a.b.c.d; anything else after the
  // prefix is a plain IPv6 address and stays one.
  const v4 = a.startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
  return isIP(v4) !== 0 ? v4 : undefined;
}

export function clientAddress(req: IncomingMessage, trustedHops: number): string | undefined {
  const socket = normalize(req.socket.remoteAddress);
  if (trustedHops <= 0) return socket;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw === undefined) return socket;
  const hops = raw.split(',').map((s) => s.trim());
  const index = Math.max(0, hops.length - trustedHops);
  return normalize(hops[index]) ?? socket;
}
