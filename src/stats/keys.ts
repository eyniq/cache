// Storage keys of the statistics history. Only digits and a sanitized pod id enter a key, so
// every key passes isSafeKey and nothing a request says can reach one.
import { createHash } from 'node:crypto';
import type { StatsTier } from './types.ts';

export const STATS_PREFIX = 'stats/';

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * A pod id that is safe as a key segment: [A-Za-z0-9_-] plus inner dots, at most 63 chars.
 * When sanitizing changed the name, a short hash of the raw name is appended so two different
 * raw names do not end up sharing (and overwriting) one pod's objects.
 */
export function sanitizePod(raw: string | undefined): string {
  const input = raw ?? '';
  const clean = (s: string, max: number): string =>
    s
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^[._-]+/, '')
      .replace(/\.{2,}/g, '.')
      .slice(0, max)
      .replace(/[.-]+$/, '');
  const cleaned = clean(input, 63);
  if (input === '') return 'pod';
  if (cleaned === input) return cleaned;
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 6);
  const base = clean(input, 56);
  return `${base === '' ? 'pod' : base}-${hash}`;
}

export function hourStart(sec: number): number {
  return Math.floor(sec / 3600) * 3600;
}

export function dayStart(sec: number): number {
  return Math.floor(sec / 86_400) * 86_400;
}

export function monthStart(sec: number): number {
  const d = new Date(sec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

export function nextMonth(sec: number): number {
  const d = new Date(sec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

export function minuteKey(sec: number, pod: string): string {
  const d = new Date(hourStart(sec) * 1000);
  return `stats/minute/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${pod}.ndjson`;
}

export function hourKey(sec: number, pod: string): string {
  const d = new Date(dayStart(sec) * 1000);
  return `stats/hour/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pod}.ndjson`;
}

export function dayKey(sec: number, pod: string): string {
  const d = new Date(monthStart(sec) * 1000);
  return `stats/day/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/${pod}.ndjson`;
}

export interface ParsedKey {
  tier: StatsTier;
  /** First second the object covers, and the first second after it. */
  start: number;
  end: number;
  pod: string;
}

const POD_FILE = '([A-Za-z0-9][A-Za-z0-9._-]{0,62})\\.ndjson';
const MINUTE = new RegExp(`^stats/minute/(\\d{4})/(\\d{2})/(\\d{2})/(\\d{2})/${POD_FILE}$`);
const HOUR = new RegExp(`^stats/hour/(\\d{4})/(\\d{2})/(\\d{2})/${POD_FILE}$`);
const DAY = new RegExp(`^stats/day/(\\d{4})/(\\d{2})/${POD_FILE}$`);

export function parseKey(key: string): ParsedKey | null {
  const n = (v: string | undefined): number => Number(v ?? 0);
  let m = MINUTE.exec(key);
  if (m) {
    const start = Date.UTC(n(m[1]), n(m[2]) - 1, n(m[3]), n(m[4])) / 1000;
    return { tier: 'minute', start, end: start + 3600, pod: m[5] ?? '' };
  }
  m = HOUR.exec(key);
  if (m) {
    const start = Date.UTC(n(m[1]), n(m[2]) - 1, n(m[3])) / 1000;
    return { tier: 'hour', start, end: start + 86_400, pod: m[4] ?? '' };
  }
  m = DAY.exec(key);
  if (m) {
    const start = Date.UTC(n(m[1]), n(m[2]) - 1, 1) / 1000;
    return { tier: 'day', start, end: nextMonth(start), pod: m[3] ?? '' };
  }
  return null;
}

/** The listing prefixes that cover [fromSec, toSec] in a tier (a day, a month or a year). */
export function listPrefixes(tier: StatsTier, fromSec: number, toSec: number): string[] {
  const out: string[] = [];
  if (tier === 'minute') {
    for (let t = dayStart(fromSec); t <= toSec; t += 86_400) {
      const d = new Date(t * 1000);
      out.push(
        `stats/minute/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`,
      );
    }
  } else if (tier === 'hour') {
    for (let t = monthStart(fromSec); t <= toSec; t = nextMonth(t)) {
      const d = new Date(t * 1000);
      out.push(`stats/hour/${pad(d.getUTCFullYear(), 4)}/${pad(d.getUTCMonth() + 1)}/`);
    }
  } else {
    const last = new Date(toSec * 1000).getUTCFullYear();
    for (let y = new Date(fromSec * 1000).getUTCFullYear(); y <= last; y++) {
      out.push(`stats/day/${pad(y, 4)}/`);
    }
  }
  return out;
}
