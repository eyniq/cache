// npm search API (`GET /-/v1/search`): query validation and result composition. The core
// fetches the upstream body (bounded, without client credentials); this file decides what the
// client may see: only known parameters go upstream, results never advertise a version the
// policy blocks (when the package is in the metadata cache), and packages of a PackageSource
// are merged in front of the first page.
import type { SearchComposeInput, SearchHit, SearchQuery } from '../../core/contracts.ts';
import { isValidPackageName, isValidVersion } from './names.ts';
import { repointVersion, type NpmPayload } from './packument.ts';

const ENDPOINT = '/-/v1/search';
const DEFAULT_SIZE = 20;
const MAX_SIZE = 250;
const MAX_FROM = 10_000;
const MAX_TEXT = 512;
const WEIGHTS = ['quality', 'popularity', 'maintenance'] as const;
const KNOWN = new Set(['text', 'size', 'from', ...WEIGHTS]);

/** `query` is the raw query string, with its "?" or empty. Null for anything out of range. */
export function parseSearchQuery(query: string): SearchQuery | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  } catch {
    return null;
  }
  const seen = new Map<string, string>();
  for (const [key, value] of params) {
    if (!KNOWN.has(key)) continue;
    if (seen.has(key)) return null;
    seen.set(key, value);
  }
  const text = seen.get('text') ?? '';
  if (text.length > MAX_TEXT) return null;
  const size = seen.has('size') ? integer(seen.get('size') ?? '', 1, MAX_SIZE, 3) : DEFAULT_SIZE;
  const from = seen.has('from') ? integer(seen.get('from') ?? '', 0, MAX_FROM, 5) : 0;
  if (size === null || from === null) return null;

  const out = new URLSearchParams();
  out.set('text', text);
  if (seen.has('size')) out.set('size', String(size));
  if (seen.has('from')) out.set('from', String(from));
  for (const key of WEIGHTS) {
    const raw = seen.get(key);
    if (raw === undefined) continue;
    // 0 to 1 with at most six decimals; no exponents, signs or spaces.
    if (!/^\d(?:\.\d{1,6})?$/.test(raw) || Number(raw) > 1) return null;
    out.set(key, raw);
  }
  return { text, size, from, upstreamPath: `${ENDPOINT}?${out.toString()}` };
}

function integer(raw: string, min: number, max: number, digits: number): number | null {
  if (!new RegExp(`^\\d{1,${digits}}$`).test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function localObject(hit: SearchHit): Obj | null {
  if (!isValidPackageName(hit.name) || !isValidVersion(hit.version)) return null;
  const slash = hit.name.indexOf('/');
  return {
    package: {
      name: hit.name,
      scope: slash === -1 ? 'unscoped' : hit.name.slice(1, slash),
      version: hit.version,
      ...(hit.description !== undefined ? { description: hit.description } : {}),
      ...(hit.keywords !== undefined ? { keywords: hit.keywords.map(String) } : {}),
      ...(hit.date !== undefined ? { date: hit.date } : {}),
      ...(hit.publisher !== undefined ? { publisher: { username: hit.publisher } } : {}),
      // npm's search output reads maintainers unconditionally (a missing list crashes it).
      maintainers: hit.publisher !== undefined ? [{ username: hit.publisher }] : [],
      links: {},
    },
    flags: {},
    // Packages of this registry are not ranked against the public ones: they come first.
    score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
    searchScore: 1,
  };
}

/** An upstream search response, parsed once and shared by every request that uses it. */
export interface ParsedSearch {
  readonly objects: readonly unknown[];
  readonly total: number;
  /** Top-level fields other than objects and total, passed through. */
  readonly extra: Readonly<Obj>;
}

/** Null when the body is not a search response. Never mutate the result. */
export function parseSearchUpstream(body: Buffer): ParsedSearch | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(doc) || !Array.isArray(doc.objects)) return null;
  const { objects, total, ...extra } = doc;
  return {
    objects: objects as unknown[],
    total:
      typeof total === 'number' && Number.isSafeInteger(total)
        ? Math.max(total, 0)
        : (objects as unknown[]).length,
    extra,
  };
}

/** Builds the response body; null when there is nothing to answer with. */
export function composeSearch(input: SearchComposeInput): Buffer | null {
  let objects: Obj[] = [];
  let total = 0;
  let extra: Obj = {};
  let usable = false;

  const upstream = input.upstream as ParsedSearch | null;
  if (upstream !== null) {
    usable = true;
    extra = { ...upstream.extra };
    let dropped = 0;
    for (const o of upstream.objects) {
      const kept = filterHit(o, input, false);
      if (kept === null) dropped++;
      else objects.push(kept);
    }
    total = Math.max(upstream.total - dropped, 0);
  }

  const local: Obj[] = [];
  for (const hit of input.local) {
    const o = localObject(hit);
    if (o === null) continue;
    const kept = filterHit(o, input, true);
    if (kept !== null) local.push(kept);
  }
  if (!usable && local.length === 0) return null;
  total += local.length;
  if (input.query.from === 0) objects = [...local.slice(0, input.query.size), ...objects];
  objects = objects.slice(0, input.query.size);

  return Buffer.from(JSON.stringify({ time: new Date().toUTCString(), ...extra, objects, total }));
}

/** The result as it may be shown, or null when it must be hidden. */
function filterHit(raw: unknown, input: SearchComposeInput, local: boolean): Obj | null {
  if (!isObj(raw) || !isObj(raw.package)) return null;
  const { name, version } = raw.package;
  if (typeof name !== 'string' || typeof version !== 'string' || !isValidPackageName(name)) {
    return null;
  }
  // A public package of a name this registry hosts itself must not shadow the private one.
  if (!local && input.isOwned(name)) return null;
  // Name-only blocks hide a package no matter what the metadata cache holds.
  if (input.isBlocked(name)) return null;
  const view = input.view(name);
  if (view === null || view.allowed.has(version)) return raw;
  const shown = repointVersion(view.processed, view.allowed, version);
  if (shown === null) return null;
  const date = (view.processed.payload as NpmPayload).times[shown];
  return {
    ...raw,
    package: { ...raw.package, version: shown, ...(date !== undefined ? { date } : {}) },
  };
}
