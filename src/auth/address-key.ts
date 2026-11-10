// The key a client address is limited under. IPv4 addresses are their own key. An IPv6 client
// usually gets a whole /64 (and can pick any address in it, per request), so IPv6 addresses
// are limited per /64: the first four groups, expanded and lowercased. IPv4-mapped IPv6
// (::ffff:a.b.c.d, in any spelling) is keyed as the IPv4 address.
import { isIP } from 'node:net';

function expandIPv6(address: string): number[] | null {
  let s = address;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const p = tail.split('.').map(Number);
    const hi = ((p[0] ?? 0) << 8) | (p[1] ?? 0);
    const lo = ((p[2] ?? 0) << 8) | (p[3] ?? 0);
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** The limit key of an address (see the header); unparsable input is returned lowercased. */
export function addressLimitKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, '');
  if (isIP(a) !== 6) return a;
  const g = expandIPv6(a);
  if (!g) return a;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}
