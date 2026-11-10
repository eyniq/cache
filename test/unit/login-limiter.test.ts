import { describe, expect, it } from 'vitest';
import { LoginLimiter } from '../../src/auth/login-limiter.ts';

function limiter(
  now: { t: number },
  opts: Partial<ConstructorParameters<typeof LoginLimiter>[0]> = {},
) {
  return new LoginLimiter({ now: () => now.t, ...opts });
}

const allowed = (l: LoginLimiter, name: string, address: string | undefined): boolean => {
  const a = l.reserve(name, address);
  a?.released();
  return a !== null;
};

const fail = (l: LoginLimiter, name: string, address: string | undefined): void => {
  const a = l.reserve(name, address);
  if (!a) throw new Error(`throttled: ${name} ${address ?? ''}`);
  a.failed();
};

describe('LoginLimiter', () => {
  it('allows a few failures per user, then backs off exponentially up to a cap', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 3, userMaxDelayMs: 8_000 });
    for (let i = 0; i < 3; i++) fail(l, 'alice', '10.0.0.1');
    // 3 free failures used: the 4th failure starts a 1 s delay.
    fail(l, 'alice', '10.0.0.1');
    expect(allowed(l, 'alice', '10.0.0.2')).toBe(false); // per user, whatever the address
    now.t += 1_000;
    fail(l, 'alice', '10.0.0.2');
    now.t += 1_999;
    expect(allowed(l, 'alice', '10.0.0.2')).toBe(false); // 2 s now
    now.t += 1;
    expect(allowed(l, 'alice', '10.0.0.2')).toBe(true);
    for (let i = 0; i < 10; i++) {
      fail(l, 'alice', '10.0.0.2');
      now.t += 8_000;
    }
    // capped
    expect(allowed(l, 'alice', '10.0.0.2')).toBe(true);
    // Other users are unaffected.
    expect(allowed(l, 'bob', '10.0.0.3')).toBe(true);
  });

  it('a success resets the user', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 1 });
    fail(l, 'alice', undefined);
    fail(l, 'alice', undefined);
    expect(allowed(l, 'alice', undefined)).toBe(false);
    now.t += 60_000;
    l.reserve('alice', undefined)!.succeeded();
    fail(l, 'alice', undefined);
    expect(allowed(l, 'alice', undefined)).toBe(true);
  });

  it('limits failures per client address within a window, across user names', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxFailures: 5, addressWindowMs: 60_000 });
    for (let i = 0; i < 5; i++) fail(l, `user${i}`, '192.0.2.7');
    expect(allowed(l, 'fresh-user', '192.0.2.7')).toBe(false);
    expect(allowed(l, 'fresh-user', '192.0.2.8')).toBe(true);
    now.t += 60_000;
    expect(allowed(l, 'fresh-user', '192.0.2.7')).toBe(true);
  });

  it('charges an address without blaming a user (registrations)', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxFailures: 2 });
    l.charge('192.0.2.9');
    l.charge('192.0.2.9');
    expect(allowed(l, 'anyone', '192.0.2.9')).toBe(false);
    expect(allowed(l, 'anyone', '192.0.2.10')).toBe(true);
    l.charge(undefined);
  });

  it('treats user names case-insensitively, so spelling variants share one budget', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 1 });
    fail(l, 'Alice', undefined);
    fail(l, 'ALICE', undefined);
    expect(allowed(l, 'alice', undefined)).toBe(false);
  });

  it('counts pending attempts as failures, so a burst cannot outrun the count', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 5, addressMaxPending: 10 });
    const attempts = Array.from({ length: 66 }, () => l.reserve('alice', '10.0.0.1'));
    const granted = attempts.filter((a) => a !== null);
    expect(granted).toHaveLength(5);
    for (const a of granted) a.failed();
    // The free failures are used up: the next failure starts a delay.
    fail(l, 'alice', '10.0.0.1');
    expect(allowed(l, 'alice', '10.0.0.1')).toBe(false);
    // Once the free failures are used up, at most one check runs at a time.
    now.t += 60 * 60_000;
    const l2 = limiter(now, { userFreeFailures: 2, userMaxDelayMs: 1 });
    fail(l2, 'bob', undefined);
    fail(l2, 'bob', undefined);
    now.t += 1_000;
    const first = l2.reserve('bob', undefined);
    expect(first).not.toBeNull();
    expect(l2.reserve('bob', undefined)).toBeNull();
    first!.failed();
  });

  it('counts pending attempts per address too', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxFailures: 3 });
    const granted = Array.from({ length: 10 }, (_, i) => l.reserve(`u${i}`, '10.0.0.1')).filter(
      (a) => a !== null,
    );
    expect(granted).toHaveLength(3);
  });

  it('a released attempt counts nothing, and resolving twice counts once', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 1 });
    for (let i = 0; i < 10; i++) l.reserve('alice', undefined)!.released();
    const a = l.reserve('alice', undefined)!;
    a.failed();
    a.failed();
    a.succeeded();
    expect(allowed(l, 'alice', undefined)).toBe(true); // one failure only: still free
  });

  it('limits IPv6 clients per /64 and IPv4-mapped spellings as IPv4', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxFailures: 3 });
    fail(l, 'a', '2001:db8::1');
    fail(l, 'b', '2001:DB8:0:0:ffff:1:2:3');
    fail(l, 'c', '2001:0db8:0000:0000::9');
    expect(allowed(l, 'd', '2001:db8::abcd')).toBe(false);
    expect(allowed(l, 'd', '2001:db8:0:1::1')).toBe(true);
    fail(l, 'e', '::ffff:192.0.2.1');
    fail(l, 'f', '::FFFF:192.0.2.1');
    fail(l, 'g', '192.0.2.1');
    expect(allowed(l, 'h', '192.0.2.1')).toBe(false);
    // Registrations are charged per /64 as well.
    l.charge('2001:db8:0:2::1');
    l.charge('2001:db8:0:2::2');
    l.charge('2001:db8:0:2::3');
    expect(allowed(l, 'i', '2001:db8:0:2::4')).toBe(false);
  });

  it('bounds its memory', () => {
    const now = { t: 0 };
    const l = limiter(now, { maxEntries: 100, addressMaxFailures: 1_000_000 });
    for (let i = 0; i < 1_000; i++) {
      const a = l.reserve(`u${i}`, `10.0.${i >> 8}.${i & 255}`);
      a?.failed();
    }
    expect(l.size).toBeLessThanOrEqual(200);
  });

  it('a flood of other names never erases a lockout', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 1, maxEntries: 50, buckets: 64 });
    fail(l, 'victim', undefined);
    fail(l, 'victim', undefined);
    expect(allowed(l, 'victim', undefined)).toBe(false);
    for (let i = 0; i < 5_000; i++) l.reserve(`flood${i}`, undefined)?.failed();
    expect(allowed(l, 'victim', undefined)).toBe(false);
    expect(l.size).toBeLessThanOrEqual(50);
  });

  it('names beyond a full map share overflow buckets that still throttle', () => {
    const now = { t: 0 };
    const l = limiter(now, { userFreeFailures: 2, maxEntries: 10, buckets: 1 });
    for (let i = 0; i < 10; i++) fail(l, `held${i}`, undefined);
    // The map is full of live entries: new names share the one bucket.
    fail(l, 'x1', undefined);
    fail(l, 'x2', undefined);
    fail(l, 'x3', undefined);
    expect(allowed(l, 'x4', undefined)).toBe(false); // the documented lockout trade-off
    // Entries whose failures are forgotten are dropped again; new names get their own entry.
    now.t += 2 * 60 * 60_000;
    expect(allowed(l, 'fresh', undefined)).toBe(true);
    fail(l, 'fresh', undefined);
    expect(allowed(l, 'fresh', undefined)).toBe(true);
  });

  it('a flood of addresses never erases an address lockout', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxFailures: 2, maxEntries: 20, buckets: 16 });
    fail(l, 'a', '198.51.100.1');
    fail(l, 'b', '198.51.100.1');
    for (let i = 0; i < 2_000; i++) l.charge(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(allowed(l, 'c', '198.51.100.1')).toBe(false);
  });

  it('caps the password checks one address has in progress', () => {
    const now = { t: 0 };
    const l = limiter(now, { addressMaxPending: 3 });
    const held = [1, 2, 3].map((i) => l.reserve(`user${String(i)}`, '10.0.0.1'));
    expect(held.every((a) => a !== null)).toBe(true);
    expect(allowed(l, 'user4', '10.0.0.1')).toBe(false);
    expect(allowed(l, 'user4', '10.0.0.2')).toBe(true); // other addresses are not affected
    held[0]?.failed();
    expect(allowed(l, 'user4', '10.0.0.1')).toBe(true);
    for (const a of held) a?.released();
  });

  it('defaults to 4 password checks in progress per address', () => {
    const now = { t: 0 };
    const l = limiter(now);
    const held = [1, 2, 3, 4].map((i) => l.reserve(`user${String(i)}`, '10.0.0.1'));
    expect(held.every((a) => a !== null)).toBe(true);
    expect(allowed(l, 'user5', '10.0.0.1')).toBe(false);
    for (const a of held) a?.released();
  });
});
