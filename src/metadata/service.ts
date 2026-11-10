// Ecosystem-agnostic metadata cache: fetch, process, apply policy, render, cache.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import type { Config } from '../config.ts';
import type {
  AuditSink,
  EcosystemAdapter,
  PackageSource,
  Policy,
  PolicyDecision,
  ProcessedMetadata,
  RawMetadata,
  Storage,
  Upstream,
} from '../core/contracts.ts';
import { Coalescer } from '../core/coalescer.ts';
import { badGateway, isHttpError, overloaded } from '../core/errors.ts';
import { ByteLru } from '../core/lru.ts';
import { errorFields, log } from '../core/log.ts';
import { readLimited } from '../core/streams.ts';
import { WriteDropped, WriteLimiter } from '../core/write-limiter.ts';
import type { Metrics } from '../http/metrics.ts';
import type { MetadataProcessor } from './processor.ts';

const gzip = promisify(gzipCb);

export type CacheStatus = 'hit' | 'miss' | 'stale' | 'coalesced' | 'revalidated';

export interface Rendered {
  status: number;
  body: Buffer;
  etag: string;
  contentType: string;
}

export type BlockedDecision = Extract<PolicyDecision, { allow: false }>;

export interface MetadataEntry {
  readonly adapter: EcosystemAdapter;
  readonly name: string;
  /** upstream: the proxied registry; local: a PackageSource (never mixed, see lookup). */
  readonly origin: 'upstream' | 'local';
  processed: ProcessedMetadata;
  allowed: Set<string>;
  blocked: Map<string, BlockedDecision>;
  /** Versions allowed only by an exception (version to reason), for policy.allowlisted. */
  allowlisted: Map<string, string>;
  /** Epoch ms after which policy decisions must be re-evaluated. */
  policyValidUntil: number;
  /** Service policy generation (bumped by Policy.onChange) these decisions were made in. */
  policyGeneration: number;
  /** Policy.revision these decisions were made with (checked when revalidating). */
  policyRevision: number | undefined;
  renders: Map<string, Rendered>;
  fetchedAt: number;
  upstreamEtag: string | undefined;
  /** Time of the last full (200) upstream fetch of this content. */
  originFetchedAt: number;
  /** Hash of the upstream digest and the allowed versions; base of every ETag. */
  allowedSignature: string;
  /** Served from a copy because upstream failed; cleared by the next successful fetch. */
  stale: boolean;
}

/**
 * ProcessedMetadata.packageName must be the lookup name itself or its leading part before an
 * "@", ":" or "/" (per-version keys such as "module@version"), in printable ASCII.
 */
function isPackageNameOf(packageName: unknown, lookup: string): boolean {
  if (typeof packageName !== 'string' || packageName.length === 0) return false;
  if (packageName.length > 512 || !/^[\x21-\x7e]+$/.test(packageName)) return false;
  if (packageName === lookup) return true;
  return lookup.startsWith(packageName) && '@:/'.includes(lookup.charAt(packageName.length));
}

/** How long a stale copy is reused before upstream is tried again (capped by METADATA_TTL). */
const STALE_RETRY_MS = 30_000;
/**
 * Stored packuments read (and buffered, up to MAX_PACKUMENT_BYTES each) at once; more misses
 * wait their turn without holding a body. Keeps a burst of distinct cold names from loading
 * every stored copy into memory at once (the worker pool's byte limit covers what follows).
 */
const MAX_STORAGE_LOADS = 16;

/** Sidecar of a stored raw packument: when it was fetched and its upstream validator. */
interface StoredMeta {
  fetchedAt: number;
  /** Time of the last full (200) upstream fetch; 304 revalidations do not move it. */
  originFetchedAt: number;
  etag?: string;
}

/** Tolerated clock difference between pods writing the shared .meta sidecars. */
const MAX_CLOCK_SKEW_MS = 30_000;
/**
 * After this long without a full upstream fetch, the stored ETag is ignored: a stored copy
 * (which only the cache should be able to write) is re-downloaded at least once a day instead
 * of living on through 304 revalidations forever.
 */
const MAX_REVALIDATED_AGE_MS = 24 * 3_600_000;

export interface MetadataLookup {
  entry: MetadataEntry | null;
  cache: CacheStatus;
}

interface Deps {
  /** The upstream of an adapter (ServerDeps.upstreams, else ServerDeps.upstream). */
  upstreamFor: (adapter: EcosystemAdapter) => Upstream;
  storage: Storage;
  policy: Policy;
  audit: AuditSink;
  config: Config;
  processor: MetadataProcessor;
  metrics?: Metrics;
  /** Limiter for background writes; a default one is made when absent (tests). */
  writes?: WriteLimiter;
  /** Adapter id to PackageSource (write path); owned names never reach upstream. */
  sources?: Readonly<Record<string, PackageSource>>;
}

/** Map, object and key overhead of one cached render, on top of its body bytes. */
const RENDER_OVERHEAD_BYTES = 256;
const MAX_RENDERS_PER_ENTRY = 32;

function entrySize(entry: MetadataEntry): number {
  let size = entry.processed.byteSize;
  for (const r of entry.renders.values()) size += r.body.length + RENDER_OVERHEAD_BYTES;
  return size;
}

export class MetadataService {
  // Bytes-capped and per pod (DESIGN.md sections 7.4 and 7.9); storage holds the durable copy.
  private readonly entries: ByteLru<MetadataEntry>;
  private readonly lookups = { hit: 0, expired: 0, miss: 0 };
  private readonly inflight = new Coalescer<MetadataLookup>();
  private readonly pending = new Set<Promise<void>>();
  private readonly chains = new Map<string, Promise<void>>();
  private storageLoads = 0;
  private readonly storageLoadWaiters: (() => void)[] = [];
  private readonly deps: Deps;
  /** Bumped by Policy.onChange; a cached entry from an older generation is re-filtered. */
  private policyGeneration = 0;
  /** Bumped by invalidate(): a local fetch that overlapped a write must not be cached. */
  private localWrites = 0;
  private readonly unsubscribe: (() => void) | undefined;

  private readonly writes: WriteLimiter;

  constructor(deps: Deps) {
    this.deps = deps;
    this.writes = deps.writes ?? new WriteLimiter({ storage: deps.storage });
    this.entries = new ByteLru(deps.config.lruMaxBytes);
    // Push, not poll: the hot path compares two numbers and never calls policy code.
    this.unsubscribe = deps.policy.onChange?.(() => {
      this.policyGeneration++;
    });
  }

  /** Stop listening for policy changes (server shutdown). */
  close(): void {
    this.unsubscribe?.();
  }

  get lruBytes(): number {
    return this.entries.bytes;
  }

  get lruEvictions(): number {
    return this.entries.evictions;
  }

  /**
   * Metadata lookups by LRU outcome: `hit` (fresh entry, served from memory), `expired` (in
   * the LRU but older than the TTL, so revalidated) and `miss` (not in the LRU).
   */
  get lruLookups(): Readonly<Record<'hit' | 'expired' | 'miss', number>> {
    return this.lookups;
  }

  /** The PackageSource configured for an adapter (write path enabled), if any. */
  sourceFor(adapter: EcosystemAdapter): PackageSource | null {
    const sources = this.deps.sources;
    return sources && Object.hasOwn(sources, adapter.id) ? (sources[adapter.id] ?? null) : null;
  }

  /** The source that owns `name`, if any: its packages must never come from upstream. */
  ownerOf(adapter: EcosystemAdapter, name: string): PackageSource | null {
    const source = this.sourceFor(adapter);
    return source?.owns(name) === true ? source : null;
  }

  /** Cache key; local entries live in their own key space so ownership changes cannot mix. */
  private keyOf(adapter: EcosystemAdapter, name: string, local: boolean): string {
    return local ? `local:${adapter.id}:${name}` : `${adapter.id}:${name}`;
  }

  /** Drop this pod's copy of a local package after a write (other pods: metadataTtlMs). */
  invalidate(adapter: EcosystemAdapter, name: string): void {
    this.localWrites++;
    this.entries.delete(this.keyOf(adapter, name, true));
  }

  /**
   * The in-memory entry of a package, or null on an LRU miss: no I/O, never an upstream
   * fetch. Search uses it to avoid advertising versions the policy blocks.
   */
  blocksWholePackage(adapter: EcosystemAdapter, name: string): boolean {
    return this.deps.policy.blocksWholePackage?.(adapter.id, name) === true;
  }

  peek(adapter: EcosystemAdapter, name: string): MetadataEntry | null {
    const entry = this.entries.get(this.keyOf(adapter, name, this.ownerOf(adapter, name) !== null));
    if (!entry) return null;
    this.refreshPolicy(entry, Date.now());
    return entry;
  }

  /**
   * When this package's metadata was last fetched from upstream (epoch ms), without any
   * upstream request: from the LRU entry, else the stored `.meta` sidecar, else null (never
   * fetched, or a name a PackageSource owns). `fetchedAt` is the last fetch or 304
   * revalidation, `originFetchedAt` the last full (200) fetch.
   */
  async fetchTimes(
    adapter: EcosystemAdapter,
    name: string,
  ): Promise<{ fetchedAt: number; originFetchedAt: number } | null> {
    if (this.ownerOf(adapter, name) !== null) return null;
    const cached = this.entries.get(this.keyOf(adapter, name, false));
    if (cached) return { fetchedAt: cached.fetchedAt, originFetchedAt: cached.originFetchedAt };
    const meta = await this.readMeta(adapter, name, Date.now());
    return meta ? { fetchedAt: meta.fetchedAt, originFetchedAt: meta.originFetchedAt } : null;
  }

  async lookup(adapter: EcosystemAdapter, name: string): Promise<MetadataLookup> {
    const source = this.ownerOf(adapter, name);
    const key = this.keyOf(adapter, name, source !== null);
    const ttl = source ? (source.metadataTtlMs ?? 0) : this.deps.config.metadataTtlMs;
    const now = Date.now();
    const cached = this.entries.get(key);
    // Hot path: a fresh entry is returned without any I/O or parsing.
    if (cached && now - cached.fetchedAt < ttl) {
      this.lookups.hit++;
      this.refreshPolicy(cached, now);
      return { entry: cached, cache: cached.stale ? 'stale' : 'hit' };
    }
    if (cached) this.lookups.expired++;
    else this.lookups.miss++;
    // One upstream fetch per package, however many requests arrive meanwhile (section 7.1).
    const run = this.inflight.run(key, () =>
      source
        ? this.refreshLocal(adapter, source, name, key, cached)
        : this.refresh(adapter, name, key, cached),
    );
    const result = await run.promise;
    if (run.leader) return result;
    this.deps.metrics?.coalescedWaiters.inc();
    return { entry: result.entry, cache: result.cache === 'stale' ? 'stale' : 'coalesced' };
  }

  private async refresh(
    adapter: EcosystemAdapter,
    name: string,
    key: string,
    inMemory: MetadataEntry | undefined,
  ): Promise<MetadataLookup> {
    const now = Date.now();
    const ttl = this.deps.config.metadataTtlMs;
    let cached = inMemory;
    // LRU miss: the copy in shared storage, written by any pod, may still be fresh. Using it
    // keeps a burst across replicas (or a small LRU) from turning into upstream fetches.
    if (!cached) {
      const fromStorage = await this.loadFresh(adapter, name, now);
      if (fromStorage && now - fromStorage.fetchedAt < ttl) {
        this.store(key, fromStorage);
        return { entry: fromStorage, cache: 'hit' };
      }
      cached = fromStorage ?? undefined; // expired: revalidate it below with its ETag
    }
    // Nothing to serve if processing is refused: do not fetch a document that cannot be used.
    if (!cached) this.assertCapacity();
    try {
      const result = await adapter.fetchMetadata(name, this.deps.upstreamFor(adapter), {
        maxBytes: this.deps.config.maxPackumentBytes,
        // Revalidate (304) only while the content's last full fetch is recent enough.
        ...(cached?.upstreamEtag && now - cached.originFetchedAt < MAX_REVALIDATED_AGE_MS
          ? { etag: cached.upstreamEtag }
          : {}),
      });
      if (result.status === 'not-modified' && cached) {
        cached.fetchedAt = now;
        cached.stale = false;
        this.refreshPolicy(cached, now, true);
        this.store(key, cached);
        this.writeMeta(adapter, name, {
          fetchedAt: now,
          originFetchedAt: cached.originFetchedAt,
          ...(cached.upstreamEtag ? { etag: cached.upstreamEtag } : {}),
        });
        return { entry: cached, cache: 'revalidated' };
      }
      if (result.status !== 'ok') {
        this.entries.delete(key);
        this.tombstone(adapter, name);
        return { entry: null, cache: 'miss' };
      }
      const entry = await this.build(adapter, name, result.raw, now, 'upstream');
      this.store(key, entry);
      this.persist(adapter, name, result.raw, now);
      return { entry, cache: 'miss' };
    } catch (err) {
      // Stale on error (DESIGN.md section 7.8): clients have no fallback registry, so a
      // failing or garbled upstream must not fail installs that the cache can still serve.
      const fallback = cached ?? (await this.loadStored(adapter, name, now));
      if (!fallback) throw err;
      log.warn('serving stale metadata', { name, ...errorFields(err) });
      fallback.stale = true;
      // Back off: reuse the stale copy for a while instead of waiting on upstream every time.
      fallback.fetchedAt = now - ttl + Math.min(ttl, STALE_RETRY_MS);
      this.refreshPolicy(fallback, now);
      this.store(key, fallback);
      return { entry: fallback, cache: 'stale' };
    }
  }

  /**
   * A package owned by a PackageSource: only the source is asked, and nothing is persisted to
   * or read from the stale copies in storage (those are upstream documents). If the source
   * fails, this pod's last copy is served stale.
   */
  private async refreshLocal(
    adapter: EcosystemAdapter,
    source: PackageSource,
    name: string,
    key: string,
    cached: MetadataEntry | undefined,
  ): Promise<MetadataLookup> {
    const now = Date.now();
    const writes = this.localWrites;
    // A document fetched while a write was in progress may predate it: serve it once, but
    // do not cache it.
    const keep = (entry: MetadataEntry): void => {
      if (this.localWrites === writes) this.store(key, entry);
    };
    if (!cached) this.assertCapacity();
    try {
      const result = await source.getMetadata(name, {
        maxBytes: this.deps.config.maxPackumentBytes,
        ...(cached?.upstreamEtag ? { etag: cached.upstreamEtag } : {}),
      });
      if (result.status === 'not-modified' && cached) {
        cached.fetchedAt = now;
        cached.stale = false;
        this.refreshPolicy(cached, now, true);
        keep(cached);
        return { entry: cached, cache: 'hit' };
      }
      if (result.status !== 'ok') {
        this.entries.delete(key);
        return { entry: null, cache: 'miss' };
      }
      const entry = await this.build(adapter, name, result.raw, now, 'local');
      keep(entry);
      return { entry, cache: 'miss' };
    } catch (err) {
      if (!cached) throw err;
      log.warn('serving stale local metadata', { name, ...errorFields(err) });
      cached.stale = true;
      cached.fetchedAt = now;
      this.refreshPolicy(cached, now);
      keep(cached);
      return { entry: cached, cache: 'stale' };
    }
  }

  private store(key: string, entry: MetadataEntry): void {
    this.entries.set(key, entry, entrySize(entry));
  }

  /** Stored copy plus its fetch time and upstream ETag, or null when there is none. */
  private async loadFresh(
    adapter: EcosystemAdapter,
    name: string,
    now: number,
  ): Promise<MetadataEntry | null> {
    const meta = await this.readMeta(adapter, name, now);
    if (!meta) return null;
    const entry = await this.loadStored(adapter, name, now);
    if (!entry) return null;
    entry.fetchedAt = meta.fetchedAt;
    entry.upstreamEtag = meta.etag;
    entry.originFetchedAt = meta.originFetchedAt;
    return entry;
  }

  private metaKey(adapter: EcosystemAdapter, name: string): string {
    return `${adapter.metadataKey(name)}.meta`;
  }

  /**
   * The sidecar is trusted only within bounds: a time in the future (forged, or another pod's
   * fast clock) would otherwise pin a stored copy as fresh forever.
   */
  private async readMeta(
    adapter: EcosystemAdapter,
    name: string,
    now: number,
  ): Promise<StoredMeta | null> {
    try {
      const body = await this.deps.storage.get(this.metaKey(adapter, name));
      if (!body) return null;
      const data = JSON.parse(
        (await readLimited(body, 4096, () => new Error('meta too large'))).toString('utf8'),
      ) as Record<string, unknown>;
      const valid = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now + MAX_CLOCK_SKEW_MS;
      if (!valid(data.fetchedAt)) return null;
      const origin = valid(data.originFetchedAt) ? data.originFetchedAt : data.fetchedAt;
      const meta: StoredMeta = {
        fetchedAt: Math.min(data.fetchedAt, now),
        originFetchedAt: Math.min(origin, now),
      };
      if (typeof data.etag === 'string' && now - meta.originFetchedAt < MAX_REVALIDATED_AGE_MS) {
        meta.etag = data.etag;
      }
      return meta;
    } catch {
      return null;
    }
  }

  private writeMeta(adapter: EcosystemAdapter, name: string, meta: StoredMeta): void {
    this.track(adapter, name, () =>
      this.writes.write({
        kind: 'meta',
        key: this.metaKey(adapter, name),
        body: Buffer.from(JSON.stringify(meta)),
        contentType: 'application/json',
      }),
    );
  }

  /**
   * Background writes for one package run strictly in call order: otherwise a slow persist of
   * an older document could land after a tombstone and resurrect a removed package. (Writers on
   * other pods can still interleave; storage writes are last-writer-wins.)
   */
  private track(adapter: EcosystemAdapter, name: string, work: () => Promise<unknown>): void {
    const key = `${adapter.id}:${name}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(work)
      .then(() => undefined)
      .catch((err: unknown) => {
        // A dropped write is counted by the limiter (and logged there, rate limited).
        if (err instanceof WriteDropped) return;
        log.warn('background metadata write failed', { name, ...errorFields(err) });
      });
    this.chains.set(key, next);
    const tracked: Promise<void> = next.finally(() => {
      this.pending.delete(tracked);
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    this.pending.add(tracked);
  }

  /** The raw copy persisted after the last successful fetch, re-processed and re-filtered. */
  private async loadStored(
    adapter: EcosystemAdapter,
    name: string,
    now: number,
  ): Promise<MetadataEntry | null> {
    await this.acquireStorageLoad();
    let loading = true;
    const done = (): void => {
      if (loading) this.releaseStorageLoad();
      loading = false;
    };
    try {
      this.assertCapacity();
      const body = await this.deps.storage.get(adapter.metadataKey(name));
      if (!body) return null;
      const raw = await readLimited(body, this.deps.config.maxPackumentBytes, () =>
        badGateway('stored packument too large'),
      );
      done(); // the body is read: processing is bounded by the pool, not by this slot
      return await this.build(adapter, name, { body: raw, encoding: 'gzip' }, now, 'upstream');
    } catch (err) {
      // Overload is not a broken copy: answer it, never fall back to an upstream fetch.
      if (isHttpError(err) && err.status === 503) throw err;
      log.warn('stored metadata unusable', { name, ...errorFields(err) });
      return null;
    } finally {
      done();
    }
  }

  /** 503 with Retry-After while the processor refuses new documents. */
  private assertCapacity(): void {
    if (this.deps.processor.overloaded === true) {
      this.deps.metrics?.metadataOverloaded.inc();
      throw overloaded('metadata processing is busy');
    }
  }

  private async acquireStorageLoad(): Promise<void> {
    if (this.storageLoads < MAX_STORAGE_LOADS) {
      this.storageLoads++;
      return;
    }
    await new Promise<void>((resolve) => this.storageLoadWaiters.push(resolve));
  }

  private releaseStorageLoad(): void {
    const next = this.storageLoadWaiters.shift();
    if (next)
      next(); // hands its slot over
    else this.storageLoads--;
  }

  render(entry: MetadataEntry, view: string, ref?: string): Rendered {
    const key = `${view}|${ref ?? ''}`;
    const cached = entry.renders.get(key);
    if (cached) return cached;
    const out = entry.adapter.renderMetadata({
      processed: entry.processed,
      allowed: entry.allowed,
      view,
      ...(ref !== undefined ? { ref } : {}),
    });
    const etag = this.etag(entry, key);
    const rendered: Rendered =
      out.status === 200
        ? { status: 200, body: out.body, etag, contentType: out.contentType }
        : {
            status: 404,
            body: Buffer.from(JSON.stringify({ error: out.error })),
            etag,
            contentType: 'application/json',
          };
    // Bounded per entry: arbitrary version/tag refs from clients must not grow the heap.
    if (entry.renders.size < MAX_RENDERS_PER_ENTRY) {
      entry.renders.set(key, rendered);
      // Renders count towards the LRU budget of their entry (if it is still the cached one).
      this.entries.resize(
        this.keyOf(entry.adapter, entry.name, entry.origin === 'local'),
        entrySize(entry),
        entry,
      );
    }
    return rendered;
  }

  private async build(
    adapter: EcosystemAdapter,
    name: string,
    raw: RawMetadata,
    now: number,
    origin: MetadataEntry['origin'],
  ): Promise<MetadataEntry> {
    const processed = await this.deps.processor.process(adapter, raw, {
      name,
      publicBaseUrl: this.deps.config.publicUrl,
      upstreamOrigin: this.deps.upstreamFor(adapter).origin,
      maxBytes: this.deps.config.maxPackumentBytes,
      options: adapter.processOptions,
    });
    if (processed.packageName !== undefined && !isPackageNameOf(processed.packageName, name)) {
      // Policies and allowlists match on it: it must name the package that was looked up.
      throw badGateway('adapter returned a package name that does not match the lookup');
    }
    const entry: MetadataEntry = {
      adapter,
      name,
      origin,
      processed,
      allowed: new Set(),
      blocked: new Map(),
      allowlisted: new Map(),
      policyValidUntil: 0,
      policyGeneration: this.policyGeneration,
      policyRevision: undefined,
      renders: new Map(),
      fetchedAt: now,
      upstreamEtag: raw.etag,
      originFetchedAt: now,
      allowedSignature: '',
      stale: false,
    };
    this.applyPolicy(entry, now);
    return entry;
  }

  /**
   * Re-filter only when a decision can have changed (DESIGN.md section 7.3): a validUntil has
   * passed, or the policy announced a change (onChange). Policy.revision is read only when
   * revalidating, so the hot path never calls into policy code.
   */
  private refreshPolicy(entry: MetadataEntry, now: number, checkRevision = false): void {
    if (
      now >= entry.policyValidUntil ||
      entry.policyGeneration !== this.policyGeneration ||
      (checkRevision && entry.policyRevision !== this.deps.policy.revision)
    ) {
      this.applyPolicy(entry, now);
    }
  }

  private applyPolicy(entry: MetadataEntry, now: number): void {
    const allowed = new Set<string>();
    const blocked = new Map<string, BlockedDecision>();
    const allowlisted = new Map<string, string>();
    let validUntil = Number.POSITIVE_INFINITY;
    const name = entry.processed.packageName ?? entry.name;
    for (const v of entry.processed.versions) {
      const decision = this.deps.policy.evaluate({
        ecosystem: entry.adapter.id,
        name,
        version: v.version,
        publishedAt: v.publishedAt,
        now,
        origin: entry.origin,
        ...(v.facts !== undefined ? { facts: v.facts } : {}),
      });
      if (decision.allow) {
        allowed.add(v.version);
        if (decision.allowlisted === true) {
          allowlisted.set(v.version, decision.reason ?? 'allowlisted');
        }
      } else {
        blocked.set(v.version, decision);
      }
      if (decision.validUntil !== undefined && decision.validUntil < validUntil) {
        validUntil = decision.validUntil;
      }
    }
    entry.allowed = allowed;
    entry.blocked = blocked;
    entry.allowlisted = allowlisted;
    entry.policyValidUntil = validUntil;
    entry.policyGeneration = this.policyGeneration;
    entry.policyRevision = this.deps.policy.revision;
    entry.renders.clear();
    // Computed once per policy change, so per-render ETags cost O(1), not O(versions).
    const h = createHash('sha256').update(entry.processed.digest);
    for (const v of entry.processed.versions)
      if (allowed.has(v.version)) h.update('\0').update(v.version);
    entry.allowedSignature = h.digest('base64url');
  }

  // ETags derive from the upstream digest, the view and the allowed set, so they are stable
  // across pods and restarts without hashing the (possibly 20 MB) rendered body.
  private etag(entry: MetadataEntry, renderKey: string): string {
    const h = createHash('sha256').update(entry.allowedSignature).update('\0').update(renderKey);
    return `"${h.digest('base64url').slice(0, 32)}"`;
  }

  /** Wait for background writes; called on shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.writes.drain();
  }

  /**
   * Upstream says the package does not exist (removed, e.g. for malware): overwrite any stored
   * copy so a later upstream outage cannot resurrect it through stale-on-error. The tombstone
   * is not a valid packument, so loadStored treats it as unusable.
   */
  private tombstone(adapter: EcosystemAdapter, name: string): void {
    const key = adapter.metadataKey(name);
    this.track(adapter, name, () =>
      this.deps.storage.head(key).then(async (existing) => {
        if (!existing) return;
        const body = await gzip(Buffer.from('{"eyniq":"tombstone"}'));
        await this.writes.write({
          kind: 'metadata',
          key,
          body,
          contentType: 'application/gzip',
          critical: true,
        });
        // The sidecar too: no freshness claim may outlive the document it described.
        await this.writes.write({
          kind: 'meta',
          key: this.metaKey(adapter, name),
          body: Buffer.from('{}'),
          contentType: 'application/json',
          critical: true,
        });
      }),
    );
  }

  /** Keep the raw document as the stale copy; never blocks or fails the request. */
  private persist(
    adapter: EcosystemAdapter,
    name: string,
    raw: RawMetadata,
    fetchedAt: number,
  ): void {
    this.track(adapter, name, async () => {
      const body = raw.encoding === 'gzip' ? raw.body : await gzip(raw.body);
      await this.writes.write({
        kind: 'metadata',
        key: adapter.metadataKey(name),
        body,
        contentType: 'application/gzip',
      });
      // The sidecar is written after the raw copy, so it never describes a missing document.
      const meta: StoredMeta = {
        fetchedAt,
        originFetchedAt: fetchedAt,
        ...(raw.etag ? { etag: raw.etag } : {}),
      };
      await this.writes.write({
        kind: 'meta',
        key: this.metaKey(adapter, name),
        body: Buffer.from(JSON.stringify(meta)),
        contentType: 'application/json',
      });
    });
  }
}
