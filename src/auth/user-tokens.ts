// Tokens of the community user store (C3), issued by npm login and `npm token create`. A
// token is 32 random bytes, `eyc_<base64url>`; only its sha256 is stored, at
//   auth/user-tokens/<sha256 hex>                     the record (user, expiry, revocation)
//   auth/user-index/<sha256 of the user>/<sha256 hex> an empty marker, to list a user's tokens
// Records change only through compare-and-swap (StorageAdmin), so pods sharing storage agree.
// Every pod caches lookups for a short TTL (unknown tokens in a separate, smaller map so a
// flood of made-up tokens cannot evict real ones): a revocation takes effect on other pods
// within that TTL, on the revoking pod at once (a lookup that read the record before the
// revocation does not cache it). The cache-hit path is a sha256 and a map lookup; storage is
// read (and a small record parsed) only on a cache miss, and misses for unknown tokens are
// bounded per client and globally (LookupLimiter). Index markers of expired, revoked or
// missing tokens are removed (with the expired or revoked record) while a user's tokens are
// listed, so they do not pile up.
// Compatible in spirit with downstream token stores, with the community record format.
import { createHash, randomBytes } from 'node:crypto';
import type { Storage, StorageAdmin } from '../core/contracts.ts';
import { isStorageAdmin } from '../core/storage.ts';
import { readLimited } from '../core/streams.ts';
import type { LookupLimiter } from './lookup-limiter.ts';

const TOKEN = /^eyc_[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const PREFIX = 'auth/user-tokens/';
const INDEX = 'auth/user-index/';
const MAX_RECORD_BYTES = 16 * 1024;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

export interface UserTokenRecord {
  user: string;
  created: string;
  expires: string;
  revoked: boolean;
  revokedAt?: string;
  /** Read-only tokens never publish (npm token create --read-only). */
  readonly?: boolean;
  /** Name given at creation (npm token create --name). */
  label?: string;
  /** Issued by a password login (npm login), not by `npm token create`. */
  login?: boolean;
  /** The user's generation when it was issued (users.ts): valid only while it matches. */
  generation: number;
  /** `eyc_` and the first four characters, for recognition in lists. */
  preview: string;
}

export interface StoredUserToken {
  /** sha256 hex of the token: the stable, non-secret key. */
  hash: string;
  record: UserTokenRecord;
}

export function isUserToken(token: string): boolean {
  return TOKEN.test(token);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isTokenHash(value: string): boolean {
  return HASH.test(value);
}

function indexPrefix(user: string): string {
  return `${INDEX}${createHash('sha256').update(user, 'utf8').digest('hex')}/`;
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
}

function parseRecord(text: string): UserTokenRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.user !== 'string' ||
    !isTime(r.created) ||
    !isTime(r.expires) ||
    typeof r.revoked !== 'boolean' ||
    typeof r.preview !== 'string' ||
    (r.readonly !== undefined && typeof r.readonly !== 'boolean') ||
    (r.label !== undefined && typeof r.label !== 'string') ||
    (r.revokedAt !== undefined && !isTime(r.revokedAt)) ||
    (r.login !== undefined && typeof r.login !== 'boolean') ||
    typeof r.generation !== 'number' ||
    !Number.isSafeInteger(r.generation)
  ) {
    return null;
  }
  return {
    user: r.user,
    created: r.created,
    expires: r.expires,
    revoked: r.revoked,
    preview: r.preview,
    generation: r.generation,
    ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
    ...(r.readonly === true ? { readonly: true } : {}),
    ...(r.label !== undefined ? { label: r.label } : {}),
    ...(r.login === true ? { login: true } : {}),
  };
}

export interface UserTokenStoreOptions {
  storage: Storage;
  /** How long a pod trusts its copy of a record (revocation delay elsewhere). 0: no cache. */
  cacheTtlMs: number;
  now?: () => number;
  maxCacheEntries?: number;
  /** Bounds storage reads for unknown tokens; absent: unbounded (tests). */
  lookupLimiter?: LookupLimiter;
}

interface Cached {
  record: UserTokenRecord | null;
  at: number;
}

export class UserTokenStore {
  private readonly storage: Storage & StorageAdmin;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, Cached>();
  private readonly unknown = new Map<string, Cached>();
  private readonly limiter: LookupLimiter | undefined;
  /** Counts revocations: a lookup that overlapped one does not cache what it read. */
  private revocations = 0;

  constructor(opts: UserTokenStoreOptions) {
    if (!isStorageAdmin(opts.storage)) {
      throw new Error('user tokens need storage with list, delete and compare-and-swap');
    }
    this.storage = opts.storage;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxCacheEntries ?? 10_000;
    this.limiter = opts.lookupLimiter;
  }

  currentTime(): number {
    return this.now();
  }

  isActive(record: UserTokenRecord): boolean {
    return !record.revoked && this.now() < Date.parse(record.expires);
  }

  async create(
    user: string,
    expiresAt: number,
    opts: { generation: number; readonly?: boolean; label?: string; login?: boolean },
  ): Promise<{ token: string; hash: string; record: UserTokenRecord }> {
    const token = `eyc_${randomBytes(32).toString('base64url')}`;
    const hash = hashToken(token);
    const record: UserTokenRecord = {
      user,
      created: new Date(this.now()).toISOString(),
      expires: new Date(expiresAt).toISOString(),
      revoked: false,
      preview: token.slice(0, 8),
      generation: opts.generation,
      ...(opts.readonly ? { readonly: true } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.login ? { login: true } : {}),
    };
    const written = await this.storage.putIfAbsent(
      `${PREFIX}${hash}`,
      Buffer.from(JSON.stringify(record)),
      { contentType: 'application/json' },
    );
    if (!written) throw new Error('token collision'); // 256 random bits: never in practice
    // After the record, so a marker never points at a record still being written. A failure
    // here leaves an unlisted token that still expires.
    await this.storage.putIfAbsent(`${indexPrefix(user)}${hash}`, Buffer.alloc(0), {
      contentType: 'application/octet-stream',
    });
    return { token, hash, record };
  }

  /** The record behind a hash (revoked and expired ones too); null when unknown. */
  async get(hash: string): Promise<UserTokenRecord | null> {
    return HASH.test(hash) ? this.read(hash) : null;
  }

  /**
   * The record of a well-formed, known, unexpired and unrevoked token, else null. `address`
   * (the client's, computed only on a cache miss) keys the budget for unknown tokens.
   */
  async lookup(token: string, address?: () => string | undefined): Promise<UserTokenRecord | null> {
    return (await this.find(token, address))?.record ?? null;
  }

  /** As lookup, with the token's hash (its non-secret id). */
  async find(token: string, address?: () => string | undefined): Promise<StoredUserToken | null> {
    if (!isUserToken(token)) return null;
    const hash = hashToken(token);
    const now = this.now();
    const cached = this.cache.get(hash) ?? this.unknown.get(hash);
    let record: UserTokenRecord | null;
    if (cached && now - cached.at < this.cacheTtlMs) {
      record = cached.record;
    } else {
      const client = this.limiter ? address?.() : undefined;
      if (this.limiter && !this.limiter.take(client)) return null;
      const revocations = this.revocations;
      record = await this.read(hash);
      if (record) this.limiter?.refund(client);
      if (this.cacheTtlMs > 0 && revocations === this.revocations) {
        this.remember(hash, record, now);
      }
    }
    return record && this.isActive(record) ? { hash, record } : null;
  }

  /** Marks a token revoked; true when it exists. */
  async revoke(hash: string): Promise<boolean> {
    if (!HASH.test(hash)) return false;
    const key = `${PREFIX}${hash}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const opened = this.storage.open ? await this.storage.open(key) : null;
      const info = opened ? { etag: opened.etag } : await this.storage.head(key);
      let record: UserTokenRecord | null;
      if (opened) {
        const bytes = await readLimited(
          opened.body,
          MAX_RECORD_BYTES,
          () => new Error('too large'),
        );
        record = parseRecord(bytes.toString('utf8'));
      } else {
        record = info ? await this.read(hash) : null;
      }
      if (!info || !record) return false;
      if (record.revoked) {
        this.revocations++;
        this.forget(hash);
        return true;
      }
      if (!info.etag) throw new Error('storage gave no etag for a token record');
      const next: UserTokenRecord = {
        ...record,
        revoked: true,
        revokedAt: new Date(this.now()).toISOString(),
      };
      if (await this.storage.putIfMatch(key, Buffer.from(JSON.stringify(next)), info.etag)) {
        // After the write: a lookup racing with it must not keep the old record, and one
        // that read it before the write must not cache it (see lookup).
        this.revocations++;
        this.forget(hash);
        return true;
      }
    }
    throw new Error('token record kept changing; revocation not applied');
  }

  /**
   * Active tokens of a user (through the index markers), at most `limit`. Markers of
   * missing, expired or revoked tokens are removed on the way, with the expired or revoked
   * record (a removed record answers like a revoked one).
   */
  async listActive(user: string, limit = 1000): Promise<StoredUserToken[]> {
    const out: StoredUserToken[] = [];
    const prefix = indexPrefix(user);
    let cursor: string | undefined;
    do {
      const page = await this.storage.list(prefix, cursor ? { cursor } : {});
      for (const e of page.entries) {
        const hash = e.key.slice(prefix.length);
        if (!HASH.test(hash)) continue;
        const record = await this.read(hash);
        if (record && record.user === user && this.isActive(record)) {
          out.push({ hash, record });
          if (out.length >= limit) return out;
        } else {
          await this.prune(e.key, hash, record, user);
        }
      }
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  private async prune(
    marker: string,
    hash: string,
    record: UserTokenRecord | null,
    user: string,
  ): Promise<void> {
    try {
      // Only the user's own records: a marker of another user's hash is just dropped.
      if (record && record.user === user) await this.storage.delete(`${PREFIX}${hash}`);
      await this.storage.delete(marker);
      this.forget(hash);
    } catch {
      // Best effort: the next listing tries again.
    }
  }

  private forget(hash: string): void {
    this.cache.delete(hash);
    this.unknown.delete(hash);
  }

  private async read(hash: string): Promise<UserTokenRecord | null> {
    const body = await this.storage.get(`${PREFIX}${hash}`);
    if (!body) return null;
    const bytes = await readLimited(
      body,
      MAX_RECORD_BYTES,
      () => new Error('token record too large'),
    );
    return parseRecord(bytes.toString('utf8'));
  }

  private remember(hash: string, record: UserTokenRecord | null, at: number): void {
    const map = record ? this.cache : this.unknown;
    const max = record ? this.maxEntries : Math.max(1, Math.floor(this.maxEntries / 10));
    map.delete(hash);
    map.set(hash, { record, at });
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
