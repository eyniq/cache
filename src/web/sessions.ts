// Web catalog sessions (C5): a random `eyw_` token in an HttpOnly cookie; storage keeps only
// its sha256 (auth/web-sessions/<hex>) with the user and expiry, so every pod sees a login
// and a logout. Sessions only open the catalog's read endpoints: the registry never reads
// this cookie or this key prefix. Lookups are cached per pod for a short TTL (a logout on
// another pod takes effect within it; a lookup that overlapped a logout on this pod does not
// cache what it read). Storage reads for unknown session ids are budgeted per client and
// globally (LookupLimiter), like unknown user tokens, and unknown ids are cached in a separate,
// smaller map so a flood of made-up ids cannot evict real sessions. A session carries the `stamp` its login
// returned (the community build: the user's generation), so a password change ends it.
// Expired records are not purged automatically: they are tiny; an S3 lifecycle rule on the
// prefix can remove them.
import { createHash, randomBytes } from 'node:crypto';
import type { LookupLimiter } from '../auth/lookup-limiter.ts';
import type { Storage, StorageAdmin } from '../core/contracts.ts';
import { readLimited } from '../core/streams.ts';

const TOKEN = /^eyw_[A-Za-z0-9_-]{43}$/;
const PREFIX = 'auth/web-sessions/';
const MAX_ENTRIES = 10_000;
/** Cached unknown ids (a tenth of the sessions). */
const MAX_UNKNOWN = 1_000;
const MAX_STAMP = 128;

export interface WebSession {
  user: string;
  /** Epoch ms. */
  created: number;
  expires: number;
  /** Opaque value from the login (WebLogin), checked by WebLogin.isValid. */
  stamp?: string;
}

export function isSessionToken(token: string): boolean {
  return TOKEN.test(token);
}

const keyOf = (token: string): string =>
  `${PREFIX}${createHash('sha256').update(token, 'utf8').digest('hex')}`;

export class WebSessionStore {
  private readonly storage: Storage & StorageAdmin;
  private readonly ttlMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { session: WebSession | null; at: number }>();
  private readonly unknown = new Map<string, { session: WebSession | null; at: number }>();
  private readonly limiter: LookupLimiter | undefined;
  /** Counts deletions: a lookup that overlapped one does not cache what it read. */
  private deletions = 0;

  constructor(opts: {
    storage: Storage & StorageAdmin;
    ttlMs: number;
    cacheTtlMs: number;
    now?: () => number;
    /** Bounds storage reads for unknown session ids; absent: unbounded (tests). */
    lookupLimiter?: LookupLimiter;
  }) {
    this.storage = opts.storage;
    this.ttlMs = opts.ttlMs;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.now = opts.now ?? Date.now;
    this.limiter = opts.lookupLimiter;
  }

  get maxAgeSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  async create(user: string, stamp?: string): Promise<string> {
    const token = `eyw_${randomBytes(32).toString('base64url')}`;
    const created = this.now();
    const session: WebSession = {
      user,
      created,
      expires: created + this.ttlMs,
      ...(stamp !== undefined && stamp.length <= MAX_STAMP ? { stamp } : {}),
    };
    const ok = await this.storage.putIfAbsent(keyOf(token), Buffer.from(JSON.stringify(session)), {
      contentType: 'application/json',
    });
    if (!ok) throw new Error('session collision'); // 256 random bits: never in practice
    return token;
  }

  /** `address` (the client's, computed only on a cache miss) keys the unknown-id budget. */
  async lookup(token: string, address?: () => string | undefined): Promise<WebSession | null> {
    if (!isSessionToken(token)) return null;
    const key = keyOf(token);
    const now = this.now();
    const cached = this.cache.get(key) ?? this.unknown.get(key);
    let session: WebSession | null;
    if (cached && now - cached.at < this.cacheTtlMs) {
      session = cached.session;
    } else {
      const client = this.limiter ? address?.() : undefined;
      if (this.limiter && !this.limiter.take(client)) return null;
      const deletions = this.deletions;
      session = await this.read(key);
      if (session) this.limiter?.refund(client);
      if (this.cacheTtlMs > 0 && deletions === this.deletions) {
        this.cache.delete(key);
        this.unknown.delete(key);
        const map = session ? this.cache : this.unknown;
        map.set(key, { session, at: now });
        const max = session ? MAX_ENTRIES : MAX_UNKNOWN;
        while (map.size > max) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) break;
          map.delete(oldest);
        }
      }
    }
    return session && now < session.expires ? session : null;
  }

  async delete(token: string): Promise<void> {
    if (!isSessionToken(token)) return;
    const key = keyOf(token);
    await this.storage.delete(key);
    this.deletions++;
    this.cache.delete(key);
    this.unknown.delete(key);
  }

  private async read(key: string): Promise<WebSession | null> {
    const body = await this.storage.get(key);
    if (!body) return null;
    const bytes = await readLimited(body, 4096, () => new Error('session record too large'));
    try {
      const v = JSON.parse(bytes.toString('utf8')) as Partial<WebSession>;
      if (
        typeof v.user !== 'string' ||
        typeof v.created !== 'number' ||
        typeof v.expires !== 'number' ||
        (v.stamp !== undefined && typeof v.stamp !== 'string')
      ) {
        return null;
      }
      return {
        user: v.user,
        created: v.created,
        expires: v.expires,
        ...(v.stamp !== undefined ? { stamp: v.stamp } : {}),
      };
    } catch {
      return null;
    }
  }
}
