import { describe, expect, it } from 'vitest';
import { isSafeKey } from '../../src/core/names.ts';
import {
  dayKey,
  hourKey,
  listPrefixes,
  minuteKey,
  parseKey,
  sanitizePod,
} from '../../src/stats/keys.ts';

const T = Date.UTC(2026, 9, 17, 13, 45, 12) / 1000;

describe('sanitizePod', () => {
  it('keeps normal pod names and neutralizes everything else', () => {
    expect(sanitizePod('eyniq-cache-7d9f8-abcde')).toBe('eyniq-cache-7d9f8-abcde');
    expect(sanitizePod('../../etc/passwd')).toMatch(/^etc-passwd-[0-9a-f]{6}$/);
    expect(sanitizePod('a/b\\c d')).toMatch(/^a-b-c-d-[0-9a-f]{6}$/);
    expect(sanitizePod('..')).toMatch(/^pod-[0-9a-f]{6}$/);
    expect(sanitizePod('')).toBe('pod');
    expect(sanitizePod(undefined)).toBe('pod');
    expect(sanitizePod('x'.repeat(200))).toHaveLength(63);
  });

  it('appends a hash of the raw name when sanitizing changed it, so names stay distinct', () => {
    expect(sanitizePod('a/b')).not.toBe(sanitizePod('a b'));
    expect(sanitizePod('a/b')).toBe(sanitizePod('a/b'));
    expect(sanitizePod('x'.repeat(200))).toMatch(/-[0-9a-f]{6}$/);
  });

  it('always yields a key segment that passes isSafeKey and parses back', () => {
    for (const raw of ['host.example.com', '.hidden', 'a..b', 'ünï', '_x_', 'pod.ndjson']) {
      const pod = sanitizePod(raw);
      const key = minuteKey(T, pod);
      expect(isSafeKey(key)).toBe(true);
      expect(parseKey(key)?.pod).toBe(pod);
    }
  });
});

describe('keys', () => {
  it('lays objects out by UTC time', () => {
    expect(minuteKey(T, 'p1')).toBe('stats/minute/2026/10/17/13/p1.ndjson');
    expect(hourKey(T, 'p1')).toBe('stats/hour/2026/10/17/p1.ndjson');
    expect(dayKey(T, 'p1')).toBe('stats/day/2026/10/p1.ndjson');
  });

  it('parses keys back into their period and rejects look-alikes', () => {
    const m = parseKey('stats/minute/2026/10/17/13/p1.ndjson');
    expect(m).toMatchObject({ tier: 'minute', pod: 'p1', start: Date.UTC(2026, 9, 17, 13) / 1000 });
    expect(m?.end).toBe((m?.start ?? 0) + 3600);
    expect(parseKey('stats/day/2026/12/p1.ndjson')?.end).toBe(Date.UTC(2027, 0, 1) / 1000);
    expect(parseKey('stats/hour/2026/10/17/../x.ndjson')).toBeNull();
    expect(parseKey('stats/hour/2026/10/17/p1.txt')).toBeNull();
    expect(parseKey('tarballs/sha512/abc')).toBeNull();
  });

  it('lists the prefixes that cover a range', () => {
    expect(listPrefixes('minute', T - 86_400, T)).toEqual([
      'stats/minute/2026/10/16/',
      'stats/minute/2026/10/17/',
    ]);
    expect(listPrefixes('hour', T - 30 * 86_400, T)).toEqual([
      'stats/hour/2026/09/',
      'stats/hour/2026/10/',
    ]);
    expect(listPrefixes('day', T - 365 * 86_400, T)).toEqual([
      'stats/day/2025/',
      'stats/day/2026/',
    ]);
  });
});
