// Search endpoint (C2, DESIGN.md section 16). Unlike the other pass-through routes this one is
// answered by the cache: the upstream result is fetched with a deadline and a size cap,
// without any client header except a fixed Accept, parsed once by the adapter and kept in a
// small TTL cache (a result does not depend on who asks; filtering and local hits are applied
// per request, so a cache hit does no JSON.parse). Cache misses are rate limited (token
// bucket plus a concurrency cap) so search cannot be used to hammer the upstream: a stale
// entry is served when there is one, else 429. The adapter decides what the client may see
// (SearchProtocol.compose).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import type {
  AdapterRoute,
  EcosystemAdapter,
  Identity,
  PackageSource,
  SearchHit,
  SearchProtocol,
  SearchQuery,
  Upstream,
} from '../../core/contracts.ts';
import { Coalescer } from '../../core/coalescer.ts';
import { HttpError, badGateway, badRequest, gatewayTimeout } from '../../core/errors.ts';
import { TokenBucket } from '../../core/token-bucket.ts';
import { ByteLru } from '../../core/lru.ts';
import { errorFields, log } from '../../core/log.ts';
import type { RequestContext } from '../../core/request.ts';
import { readLimited } from '../../core/streams.ts';
import type { MetadataService } from '../../metadata/service.ts';

/** Largest upstream search response that is read (npm answers at most 250 hits, ~0.5 MB). */
export const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
/** A PackageSource that does not answer in time is skipped. */
const SOURCE_TIMEOUT_MS = 5_000;
/** Total size of cached upstream results (counted by their raw response size). */
const CACHE_BYTES = 16 * 1024 * 1024;
/** Upstream search requests in flight at once; more are treated like an exceeded rate. */
export const MAX_CONCURRENT_FETCHES = 4;

export interface SearchHandlerDeps {
  metadata: MetadataService;
  upstreamFor: (adapter: EcosystemAdapter) => Upstream;
  config: {
    searchTimeoutMs: number;
    searchCacheTtlMs: number;
    searchUpstreamRps: number;
    searchUpstreamBurst: number;
  };
}

type SearchRoute = Extract<AdapterRoute, { kind: 'passthrough' }>;

async function within<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => undefined); // a late failure after the deadline is not unhandled
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface CachedSearch {
  /** SearchProtocol.parseUpstream output; shared, never mutated. */
  parsed: unknown;
  at: number;
}

/**
 * The search itself, shared by the registry route and the web catalog (one cache). Each
 * channel has its own upstream token bucket (same SEARCH_UPSTREAM_RPS/BURST), so catalog
 * visitors cannot use up `npm search`'s budget or the other way round.
 */
export interface SearchService {
  /** `rawQuery` is the query string including "?" (or ""). Throws HttpError. */
  run(
    adapter: EcosystemAdapter,
    rawQuery: string,
    identity: Identity | null,
    channel?: SearchChannel,
  ): Promise<Buffer>;
}

export type SearchChannel = 'registry' | 'web';

export function createSearchHandler(deps: SearchHandlerDeps, service?: SearchService) {
  const search = service ?? createSearchService(deps);
  return async function handleSearch(
    _req: IncomingMessage,
    res: ServerResponse,
    adapter: EcosystemAdapter,
    route: SearchRoute,
    ctx: RequestContext,
    identity: Identity | null,
  ): Promise<void> {
    ctx.cache = 'passthrough';
    const q = route.upstreamPath.indexOf('?');
    const body = await search.run(adapter, q === -1 ? '' : route.upstreamPath.slice(q), identity);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
    });
    res.end(body);
    ctx.bytes += body.length;
  };
}

export function createSearchService(deps: SearchHandlerDeps): SearchService {
  const cache = new ByteLru<CachedSearch>(CACHE_BYTES);
  const inflight = new Coalescer<unknown>();
  const { searchUpstreamRps: rps, searchUpstreamBurst: burst } = deps.config;
  const buckets: Record<SearchChannel, TokenBucket | null> = {
    registry: rps > 0 ? new TokenBucket(rps, burst) : null,
    web: rps > 0 ? new TokenBucket(rps, burst) : null,
  };
  let active = 0;

  async function fetchBounded(upstream: Upstream, path: string): Promise<Buffer> {
    // The deadline aborts the request itself: a response head that never arrives must not
    // keep a socket (and an upstream connection slot) busy until the idle timeout.
    const controller = new AbortController();
    const work = (async (): Promise<Buffer> => {
      const up = await upstream.request({
        method: 'GET',
        path,
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (controller.signal.aborted || up.status !== 200) {
        up.body.destroy();
        throw badGateway(`upstream search answered ${up.status}`);
      }
      if (Number(up.headers['content-length'] ?? 0) > MAX_SEARCH_BYTES) {
        up.body.destroy();
        throw badGateway('upstream search response too large');
      }
      const raw = await readLimited(up.body, MAX_SEARCH_BYTES, () =>
        badGateway('upstream search response too large'),
      );
      const encoding = up.headers['content-encoding'] ?? 'identity';
      if (encoding === 'identity') return raw;
      if (encoding !== 'gzip') throw badGateway('upstream search response has an unknown encoding');
      try {
        return gunzipSync(raw, { maxOutputLength: MAX_SEARCH_BYTES });
      } catch {
        throw badGateway('upstream search response is not valid gzip');
      }
    })();
    return within(work, deps.config.searchTimeoutMs, () => {
      controller.abort();
      return gatewayTimeout('upstream search timed out');
    });
  }

  function throttled(bucket: TokenBucket | null): HttpError {
    const seconds = bucket?.retryAfterSeconds() ?? 1;
    return new HttpError(
      429,
      'search is rate limited, retry later',
      { error: 'search is rate limited, retry later' },
      { 'retry-after': String(seconds) },
    );
  }

  /** The parsed upstream result: from the cache, else fetched (one request per query). */
  async function upstreamResult(
    adapter: EcosystemAdapter,
    protocol: SearchProtocol,
    query: SearchQuery,
    channel: SearchChannel,
  ): Promise<unknown> {
    const bucket = buckets[channel];
    const ttl = deps.config.searchCacheTtlMs;
    const key = `${adapter.id}:${query.upstreamPath}`;
    const now = Date.now();
    const cached = ttl > 0 ? cache.get(key) : undefined;
    if (cached && now - cached.at < ttl) return cached.parsed;
    try {
      return await inflight.run(key, async () => {
        // Only a real upstream request costs a token; coalesced waiters share it.
        if (active >= MAX_CONCURRENT_FETCHES || (bucket && !bucket.tryTake())) {
          throw throttled(bucket);
        }
        active++;
        try {
          const body = await fetchBounded(deps.upstreamFor(adapter), query.upstreamPath);
          const parsed = protocol.parseUpstream(body);
          if (parsed === null || parsed === undefined) {
            throw badGateway('upstream search returned an unusable response');
          }
          if (ttl > 0) cache.set(key, { parsed, at: Date.now() }, body.length);
          return parsed;
        } finally {
          active--;
        }
      }).promise;
    } catch (err) {
      // Over the limit: an old result is better than none (it is what the TTL would allow
      // a moment later anyway).
      if (cached && err instanceof HttpError && err.status === 429) {
        log.debug('search rate limited; serving a stale result');
        return cached.parsed;
      }
      throw err;
    }
  }

  async function localHits(
    source: PackageSource | null,
    query: SearchQuery,
    identity: Identity | null,
  ): Promise<SearchHit[]> {
    if (!source?.search) return [];
    try {
      const hits = await within(source.search(query, identity), SOURCE_TIMEOUT_MS, () =>
        gatewayTimeout('package source search timed out'),
      );
      return Array.isArray(hits) ? hits.slice(0, query.size) : [];
    } catch (err) {
      log.warn('package source search failed', errorFields(err));
      return [];
    }
  }

  return {
    async run(adapter, rawQuery, identity, channel = 'registry') {
      const protocol = adapter.search;
      if (!protocol) throw new Error('search for an adapter without search support');
      const query = protocol.parseQuery(rawQuery);
      if (!query) throw badRequest('invalid search query');

      const source = deps.metadata.sourceFor(adapter);
      let failure: unknown = null;
      const [upstream, local] = await Promise.all([
        upstreamResult(adapter, protocol, query, channel).catch((err: unknown) => {
          failure = err;
          return null;
        }),
        localHits(source, query, identity),
      ]);
      const body = protocol.compose({
        query,
        upstream,
        local,
        view: (name) => {
          const entry = deps.metadata.peek(adapter, name);
          return entry ? { processed: entry.processed, allowed: entry.allowed } : null;
        },
        isOwned: (name) => deps.metadata.ownerOf(adapter, name) !== null,
        isBlocked: (name) => deps.metadata.blocksWholePackage(adapter, name),
      });
      if (!body) {
        if (failure instanceof HttpError) throw failure;
        if (failure !== null) log.warn('upstream search failed', errorFields(failure));
        throw badGateway('upstream search returned an unusable response');
      }
      if (failure !== null) log.warn('upstream search failed', errorFields(failure));
      return body;
    },
  };
}
