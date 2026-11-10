// node:http server: health and metrics, mount resolution, auth gate, request logging,
// error mapping and metrics.
import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { ArtifactService } from '../artifacts/service.ts';
import { DefaultAuthorizer } from '../auth/authorizer.ts';
import { auditEvent } from '../core/audit.ts';
import type {
  AccountAction,
  AdapterRoute,
  AuthorizationAction,
  AuthorizationResource,
  EcosystemAdapter,
  Extension,
  ExtensionServices,
  Identity,
  ServerDeps,
  Upstream,
  WriteRoute,
} from '../core/contracts.ts';
import { HttpError, isHttpError } from '../core/errors.ts';
import { errorFields, log } from '../core/log.ts';
import type { RequestContext } from '../core/request.ts';
import { InlineProcessor, type MetadataProcessor } from '../metadata/processor.ts';
import { MetadataService } from '../metadata/service.ts';
import { WriteLimiter } from '../core/write-limiter.ts';
import { LoopMonitor, ReadinessCheck } from './health.ts';
import { Metrics } from './metrics.ts';
import { sendError, sendJson } from './respond.ts';
import { clientAddress } from './client-address.ts';
import { accountActions, handleAccount } from './routes/account.ts';
import { createPublicUrls } from './public-url.ts';
import { MetadataCompressor } from './compress.ts';
import { createRegistryHandler } from './routes/registry.ts';
import { createSearchService } from './routes/search.ts';
import { createWebHandler, type WebHandler } from '../web/handler.ts';
import { WebSessionStore } from '../web/sessions.ts';
import { LookupLimiter } from '../auth/lookup-limiter.ts';
import { isStorageAdmin } from '../core/storage.ts';
import { handleWrite } from './routes/write.ts';
import { metricsSource } from './stats-source.ts';
import { StatsRecorder } from '../stats/recorder.ts';
import {
  STATS_STEPS,
  StatsBusyError,
  StatsReader,
  StatsUnavailableError,
  isStatsRange,
} from '../stats/reader.ts';

export interface CacheServer {
  server: Server;
  /** Serves /livez, /readyz, /metrics and /stats (plus management extensions). */
  management: Server;
  metrics: Metrics;
  /**
   * When the metadata of a package was last fetched from upstream (epoch ms), read from the
   * LRU or the stored sidecar without contacting upstream; null when never fetched or owned
   * by a PackageSource. For catalogs and consoles; the request path does not use it.
   */
  metadataFetchTimes(
    adapter: EcosystemAdapter,
    name: string,
  ): Promise<{ fetchedAt: number; originFetchedAt: number } | null>;
  listen(port: number, host?: string): Promise<number>;
  listenManagement(port: number, host?: string): Promise<number>;
  /** Wait for background storage writes (packuments); used by tests and shutdown. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** A processor with the optional gauges of WorkerPool. */
type ObservedProcessor = MetadataProcessor & {
  readonly queueLength?: number;
  readonly heapBytes?: number;
  readonly recycles?: number;
};

export interface ServerOptions {
  processor?: ObservedProcessor;
  /** An authorizer that takes longer than this fails the request closed (503). Default 5 s. */
  authorizeTimeoutMs?: number;
  /** An AccountProvider call that takes longer answers 503. Default 10 s. */
  accountTimeoutMs?: number;
}

interface Resolved {
  adapter: EcosystemAdapter;
  route: AdapterRoute;
  /** The mount the client used ("" for the root). */
  mount: string;
  /** Path to log instead of the request path (the route said it holds a secret). */
  logPath?: string;
}

/** A client that stops reading (or sending) for this long is disconnected. */
const SOCKET_IDLE_MS = 120_000;
/** Pass-through requests are uncached and relay bodies; cap them so they cannot crowd out installs. */
const MAX_PASSTHROUGH_IN_FLIGHT = 64;
/**
 * Write bodies are buffered (up to MAX_PUBLISH_BYTES each) and held several times over while
 * parsing (string, tree, decoded artifacts): bound how many are in memory at once.
 */
const MAX_WRITES_IN_FLIGHT = 2;
const READ_ONLY = 'method not allowed: this is a read-only cache';
/** Account calls run provider code, most of them unauthenticated: cap them. */
const MAX_ACCOUNTS_IN_FLIGHT = 64;

function isWrite(route: AdapterRoute): route is WriteRoute {
  return route.kind === 'publish' || route.kind === 'unpublish' || route.kind === 'dist-tag';
}

/**
 * What a route reads, for the authorizer; null for routes that expose nothing (ping, whoami,
 * rejected paths), which stay reachable whatever the authorizer says.
 */
function resourceOf(adapter: EcosystemAdapter, route: AdapterRoute): AuthorizationResource | null {
  switch (route.kind) {
    case 'metadata':
      return { ecosystem: adapter.id, route: route.kind, name: route.name };
    case 'artifact':
      return { ecosystem: adapter.id, route: route.kind, name: route.name, file: route.file };
    case 'passthrough':
      return { ecosystem: adapter.id, route: route.kind };
    case 'publish':
    case 'unpublish':
    case 'dist-tag':
      return { ecosystem: adapter.id, route: route.kind, name: route.name };
    case 'ping':
    case 'whoami':
    case 'reject':
      return null;
    case 'account':
      // Authenticated and authorized by the account handler, per action; never as a read.
      throw new Error('account routes have no read resource');
    default: {
      // A route kind this layer does not know must never skip authorization (fail closed).
      const unknown: never = route;
      throw new Error(`no authorization rule for route ${JSON.stringify(unknown)}`);
    }
  }
}

/** One path segment under /-/eyniq/: no package name starts with "-", so none can collide. */
const EXTENSION_PREFIX = /^\/-\/eyniq\/[a-z0-9][a-z0-9-]{0,63}$/;

const EXTENSION_AUTH = new Set(['none', 'authenticated', 'admin']);
/** A hanging extension close() must not block the rest of shutdown. */
const EXTENSION_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Validated at runtime too: a typo such as "Admin" must not silently turn an admin route
 * into one any authenticated identity can call.
 */
function checkExtensions(list: readonly Extension[], where: string): void {
  const seen = new Set<string>();
  for (const e of list) {
    if (!EXTENSION_AUTH.has(e.auth)) {
      throw new Error(
        `${where} extension ${e.prefix} has an invalid auth ${JSON.stringify(e.auth)}`,
      );
    }
    if (typeof e.handler !== 'function') {
      throw new Error(`${where} extension ${e.prefix} has no handler`);
    }
    if (!EXTENSION_PREFIX.test(e.prefix)) {
      throw new Error(
        `${where} extension prefix ${JSON.stringify(e.prefix)} must be /-/eyniq/<name>`,
      );
    }
    if (seen.has(e.prefix)) throw new Error(`duplicate ${where} extension prefix ${e.prefix}`);
    seen.add(e.prefix);
  }
}

function findExtension(list: readonly Extension[], path: string): Extension | undefined {
  return list.find((e) => path === e.prefix || path.startsWith(`${e.prefix}/`));
}

/** A client's X-Request-Id is reused only when it is short and plain (it ends up in logs). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function withAddress(address: string | undefined): { clientAddress?: string } {
  return address !== undefined ? { clientAddress: address } : {};
}

function requestIdOf(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Counts upstream requests, errors and time to response headers. */
function instrumentUpstream(upstream: Upstream, metrics: Metrics): Upstream {
  return {
    origin: upstream.origin,
    async request(req) {
      const started = performance.now();
      metrics.upstreamRequests.inc({ method: req.method ?? 'GET' });
      try {
        const res = await upstream.request(req);
        metrics.upstreamDuration.observe((performance.now() - started) / 1000);
        if (res.status >= 500) metrics.upstreamErrors.inc();
        return res;
      } catch (err) {
        metrics.upstreamErrors.inc();
        throw err;
      }
    },
  };
}

export function createServer(deps: ServerDeps, opts: ServerOptions = {}): CacheServer {
  const processor: ObservedProcessor = opts.processor ?? new InlineProcessor();
  const metrics = new Metrics();
  // Every upstream is instrumented once; adapters without their own entry share the default.
  const upstream = instrumentUpstream(deps.upstream, metrics);
  const perAdapter = new Map<string, Upstream>();
  for (const [id, u] of Object.entries(deps.upstreams ?? {})) {
    perAdapter.set(id, instrumentUpstream(u, metrics));
  }
  const upstreamFor = (adapter: EcosystemAdapter): Upstream =>
    perAdapter.get(adapter.id) ?? upstream;
  const sources = deps.packageSources ?? {};
  const writes = new WriteLimiter({
    storage: deps.storage,
    concurrency: deps.config.storageWriteConcurrency,
    maxQueue: deps.config.storageWriteQueueMax,
    maxQueueBytes: deps.config.storageWriteQueueBytes,
    maxStreamBytes: deps.config.storageStreamBytes,
    timeoutMs: deps.config.storageBackgroundTimeoutMs,
    observer: {
      duration: (kind, seconds) => {
        metrics.storageWriteDuration.observe(seconds, { kind });
      },
      failure: (kind, reason) => {
        metrics.storageWriteFailures.inc({ kind, reason });
      },
      dropped: (kind) => {
        metrics.storageWritesDropped.inc({ kind });
      },
      retry: (kind) => {
        metrics.storageWriteRetries.inc({ kind });
      },
    },
  });
  const metadata = new MetadataService({
    ...deps,
    upstreamFor,
    processor,
    metrics,
    sources,
    writes,
  });
  const artifacts = new ArtifactService({ ...deps, upstreamFor, metadata, metrics, writes });
  const search = createSearchService({ metadata, upstreamFor, config: deps.config });
  const publicUrls = createPublicUrls(
    deps.config.publicUrl.replace(/\/+$/, ''),
    deps.config.publicUrlAliases,
  );
  const compressor = deps.config.compressMetadata
    ? new MetadataCompressor({ maxCacheBytes: deps.config.compressCacheBytes })
    : undefined;
  const registry = createRegistryHandler({
    metadata,
    artifacts,
    upstreamFor,
    config: deps.config,
    search,
    publicUrls,
    compressor,
  });
  const authorizer = deps.authorizer ?? new DefaultAuthorizer(deps.auth);
  // Fixed at creation, like the extensions: the methods the provider has now.
  const accountProvider = deps.accounts;
  const actions: ReadonlySet<AccountAction> = accountActions(accountProvider);
  const publicUrl = deps.config.publicUrl.replace(/\/+$/, '');
  // Copied: a later push onto the caller's array must not bypass validation.
  const extensions = [...(deps.extensions ?? [])];
  const managementExtensions = [...(deps.managementExtensions ?? [])];
  checkExtensions(extensions, 'registry');
  checkExtensions(managementExtensions, 'management');
  const authorizeTimeoutMs = opts.authorizeTimeoutMs ?? 5_000;
  const monitor = new LoopMonitor();
  const readiness = new ReadinessCheck(
    deps.storage,
    monitor,
    deps.config.readyMaxLagMs,
    deps.readiness,
  );
  let passthroughInFlight = 0;
  let writesInFlight = 0;
  let accountsInFlight = 0;

  metrics.gauge(
    'storage_write_queue_length',
    'Background storage writes waiting for a slot.',
    () => writes.queueLength,
  );
  metrics.gauge(
    'storage_writes_in_flight',
    'Background storage writes running (limited ones plus streaming tarball writes).',
    () => writes.inFlight,
  );
  metrics.gauge('lru_bytes', 'Bytes held by the metadata LRU.', () => metadata.lruBytes);
  metrics.gauge(
    'compress_cache_bytes',
    'Bytes held by the gzip metadata cache.',
    () => compressor?.cacheBytes ?? 0,
  );
  metrics.gauge(
    'lru_evictions_total',
    'Metadata LRU evictions.',
    () => metadata.lruEvictions,
    'counter',
  );
  metrics.gauge(
    'lru_lookups_total',
    'Metadata lookups by LRU outcome: hit (fresh, from memory), expired (revalidated), miss.',
    () => {
      const l = metadata.lruLookups;
      return [
        [{ result: 'hit' }, l.hit],
        [{ result: 'expired' }, l.expired],
        [{ result: 'miss' }, l.miss],
      ];
    },
    'counter',
  );
  metrics.gauge(
    'worker_queue_length',
    'Packuments waiting for a worker.',
    () => processor.queueLength ?? 0,
  );
  // heap_used_bytes covers the main thread only; the worker isolates are counted here.
  metrics.gauge(
    'metadata_worker_heap_bytes',
    'Heap plus external memory of the metadata workers (refreshed every 15 s).',
    () => processor.heapBytes ?? 0,
  );
  metrics.gauge(
    'metadata_worker_recycles_total',
    'Metadata workers replaced after WORKER_RECYCLE_BYTES.',
    () => processor.recycles ?? 0,
    'counter',
  );
  metrics.gauge('event_loop_delay_seconds', 'Event-loop delay over the last 10-20 s.', () => [
    [{ quantile: '0.5' }, monitor.p50Ms() / 1000],
    [{ quantile: '0.99' }, monitor.p99Ms() / 1000],
  ]);
  metrics.gauge('heap_used_bytes', 'V8 heap in use.', () => process.memoryUsage().heapUsed);
  metrics.gauge(
    'process_resident_memory_bytes',
    'Resident set size of the process (all threads; excludes the page cache).',
    () => process.memoryUsage().rss,
  );

  // Statistics history (DESIGN.md section 17): recorded by this pod, read from all pods.
  const statsReader = deps.config.statsHistory ? new StatsReader(deps.storage) : null;
  let recorder: StatsRecorder | null = null;
  if (deps.config.statsHistory) {
    const writeErrors = metrics.counter(
      'stats_write_errors_total',
      'Statistics history writes that failed.',
    );
    log.info('statistics history enabled', { pod: deps.config.statsPod });
    recorder = new StatsRecorder({
      storage: deps.storage,
      pod: deps.config.statsPod,
      intervalMs: deps.config.statsIntervalMs,
      retention: {
        minuteMs: deps.config.statsRetentionMinuteMs,
        hourMs: deps.config.statsRetentionHourMs,
        dayMs: deps.config.statsRetentionDayMs,
      },
      onWriteError: () => {
        writeErrors.inc();
      },
      source: metricsSource(metrics, {
        lruBytes: () => metadata.lruBytes,
        workerQueue: () => processor.queueLength ?? 0,
        rss: () => process.memoryUsage().rss,
        heap: () => process.memoryUsage().heapUsed,
        loopP50Seconds: () => monitor.p50Ms() / 1000,
        loopP99Seconds: () => monitor.p99Ms() / 1000,
        lruEvictions: () => metadata.lruEvictions,
        writeQueue: () => writes.queueLength,
        writesInFlight: () => writes.inFlight,
      }),
    });
  }

  /** GET /stats?range=24h&step=auto on the management port (no auth, like /metrics). */
  async function handleStats(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
  ): Promise<void> {
    ctx.route = 'stats';
    // HEAD is refused: answering it would compute the whole result for nothing.
    if (req.method !== 'GET') {
      throw new HttpError(
        405,
        'method not allowed',
        { error: 'method not allowed' },
        { allow: 'GET' },
      );
    }
    if (!statsReader) {
      throw new HttpError(404, 'stats history is disabled', {
        error: 'stats history is disabled (STATS_HISTORY=false)',
      });
    }
    const params = new URL(req.url ?? '/', 'http://management').searchParams;
    const range = params.get('range') ?? '24h';
    const stepParam = params.get('step') ?? 'auto';
    const step = stepParam === 'auto' ? undefined : Number(stepParam);
    if (!isStatsRange(range)) {
      throw new HttpError(400, 'invalid range', {
        error: 'range must be 1h, 24h, 7d, 30d, 90d or 1y',
      });
    }
    if (step !== undefined && !STATS_STEPS.includes(step)) {
      throw new HttpError(400, 'invalid step', {
        error: `step must be auto or one of ${STATS_STEPS.join(', ')} (seconds)`,
      });
    }
    try {
      sendJson(res, 200, await statsReader.query(range, step), ctx);
    } catch (err) {
      if (err instanceof StatsUnavailableError) {
        throw new HttpError(501, 'stats unavailable', { error: err.message });
      }
      if (err instanceof StatsBusyError) {
        throw new HttpError(503, 'stats busy', { error: err.message }, { 'retry-after': '5' });
      }
      throw err;
    }
  }

  // The first adapter is also served at "/" for compatibility (npm's default layout).
  const rootAdapter = deps.adapters[0];

  function logPathOf(route: AdapterRoute, mount: string): string | undefined {
    if (route.kind !== 'reject' && route.kind !== 'account') return undefined;
    return route.logPath !== undefined ? `${mount}${route.logPath}` : undefined;
  }

  function resolve(req: IncomingMessage, url: string): Resolved | null {
    let redacted: string | undefined;
    for (const adapter of deps.adapters) {
      const mount = adapter.mountPath;
      if (url.startsWith(`${mount}/`) || url.startsWith(`${mount}?`)) {
        const route = adapter.match(req, url.slice(mount.length), matchContext(adapter));
        // `/npm/-/npm-10.0.0.tgz` is the root-mounted package "npm": if the mounted reading
        // is not a valid route, fall back to the root reading below (keeping its redaction).
        if (route && route.kind !== 'reject') {
          return withLogPath({ adapter, route, mount }, logPathOf(route, mount));
        }
        if (route) redacted ??= logPathOf(route, mount);
      }
    }
    if (!rootAdapter) return null;
    const route = rootAdapter.match(req, url, matchContext(rootAdapter));
    if (!route) return null;
    return withLogPath(
      { adapter: rootAdapter, route, mount: '' },
      logPathOf(route, '') ?? redacted,
    );
  }

  function withLogPath(r: Resolved, logPath: string | undefined): Resolved {
    return logPath === undefined ? r : { ...r, logPath };
  }

  function matchContext(adapter: EcosystemAdapter): {
    writable: boolean;
    accountActions?: ReadonlySet<AccountAction>;
  } {
    return {
      writable: Object.hasOwn(sources, adapter.id),
      ...(adapter.accounts && actions.size > 0 ? { accountActions: actions } : {}),
    };
  }

  async function write(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: EcosystemAdapter,
    route: WriteRoute,
    ctx: RequestContext,
    identity: Identity | null,
    resource: AuthorizationResource,
  ): Promise<void> {
    if (writesInFlight >= MAX_WRITES_IN_FLIGHT) {
      req.resume();
      throw new HttpError(503, 'too many writes in flight');
    }
    writesInFlight++;
    try {
      await handleWrite(req, res, adapter, route, ctx, identity, {
        metadata,
        processor,
        audit: deps.audit,
        maxPublishBytes: deps.config.maxPublishBytes,
        reauthorize: (kind) => authorize(identity, 'publish', { ...resource, route: kind }, ctx),
      });
    } finally {
      writesInFlight--;
    }
  }

  /** Account routes: own authentication rules (src/http/routes/account.ts), then the provider. */
  async function account(
    req: IncomingMessage,
    res: ServerResponse,
    resolved: Resolved,
    route: Extract<AdapterRoute, { kind: 'account' }>,
    ctx: RequestContext,
  ): Promise<void> {
    const protocol = resolved.adapter.accounts;
    // matchContext only offers account actions to adapters with a protocol and a provider.
    if (!protocol || !accountProvider || !actions.has(route.action)) {
      throw new Error('account route without a provider or protocol');
    }
    if (accountsInFlight >= MAX_ACCOUNTS_IN_FLIGHT) {
      req.resume();
      throw new HttpError(503, 'too many account requests in flight');
    }
    accountsInFlight++;
    try {
      await handleAccount(req, res, resolved.adapter, protocol, route, ctx, {
        provider: accountProvider,
        auth: deps.auth,
        audit: deps.audit,
        registryUrl: `${publicUrls.forHost(req.headers.host)?.base ?? publicUrl}${resolved.mount}`,
        timeoutMs: opts.accountTimeoutMs ?? 10_000,
        ...withAddress(clientAddress(req, deps.config.trustProxyHops)),
        authorize: (identity, action) =>
          authorize(
            identity,
            'account',
            { ecosystem: resolved.adapter.id, route: 'account', account: action },
            ctx,
          ),
      });
    } finally {
      accountsInFlight--;
    }
  }

  /**
   * 403 unless the authorizer allows the action; a throwing authorizer fails closed (500). An
   * authorizer may refuse on purpose by throwing HttpError 403 (e.g. an edition's licence
   * limit): that is a refusal like `false`, audited with its message as the reason.
   */
  async function authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
    ctx: RequestContext,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(503, 'authorization unavailable'));
      }, authorizeTimeoutMs);
    });
    let allowed: unknown;
    try {
      allowed = await Promise.race([authorizer.authorize(identity, action, resource), timeout]);
    } catch (err) {
      if (isHttpError(err) && err.status === 403) {
        recordForbidden(action, resource, ctx, err.message.slice(0, 256));
        throw err;
      }
      log.error('authorizer failed; request refused', { path: ctx.path, ...errorFields(err) });
      throw isHttpError(err) ? err : new HttpError(500, 'internal error');
    } finally {
      clearTimeout(timer);
    }
    // Only a literal true allows: a loosely typed authorizer answering "no" or 1 must not.
    if (allowed === true) return;
    recordForbidden(action, resource, ctx);
    throw new HttpError(403, 'forbidden');
  }

  function recordForbidden(
    action: AuthorizationAction,
    resource: AuthorizationResource,
    ctx: RequestContext,
    reason?: string,
  ): void {
    deps.audit.record(
      auditEvent(
        'auth.forbidden',
        {
          path: ctx.path,
          action,
          ecosystem: resource.ecosystem,
          route: resource.route,
          ...(resource.name !== undefined ? { name: resource.name } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
        ctx,
      ),
    );
  }

  /**
   * Health and metrics live on their own port: on the registry port `/metrics` would shadow
   * the real npm package "metrics". Never behind auth (section 5).
   */
  async function system(res: ServerResponse, ctx: RequestContext): Promise<boolean> {
    switch (ctx.path) {
      case '/livez':
        ctx.route = 'livez';
        sendJson(res, 200, { status: 'ok' }, ctx);
        return true;
      case '/readyz': {
        ctx.route = 'readyz';
        const r = await readiness.check();
        sendJson(
          res,
          r.ready ? 200 : 503,
          r.ready ? { status: 'ready' } : { status: 'not ready', reason: r.reason },
          ctx,
        );
        return true;
      }
      case '/metrics': {
        ctx.route = 'metrics';
        const body = Buffer.from(metrics.render());
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': body.length,
        });
        res.end(body);
        return true;
      }
      default:
        return false;
    }
  }

  /** Extension routes: declared auth first, then the extension's own handler. */
  async function runExtension(
    req: IncomingMessage,
    res: ServerResponse,
    ext: Extension,
    ctx: RequestContext,
  ): Promise<void> {
    ctx.route = 'extension';
    // For "none" routes (login flows) an identity is optional: a provider that fails on a
    // stale credential must not take the route down.
    const identity =
      ext.auth === 'none'
        ? await deps.auth.authenticate(req).catch((err: unknown) => {
            log.warn('authentication failed on an open extension route', errorFields(err));
            return null;
          })
        : await deps.auth.authenticate(req);
    if (identity) ctx.identity = identity.name;
    if (ext.auth !== 'none' && !identity) {
      deps.audit.record(auditEvent('auth.denied', { path: ctx.path }, ctx));
      throw new HttpError(
        401,
        'authentication required',
        { error: 'authentication required' },
        { 'www-authenticate': 'Bearer realm="eyniq-cache"' },
      );
    }
    if (ext.auth === 'admin') {
      await authorize(
        identity,
        'admin',
        { ecosystem: '*', route: 'extension', extension: ext.prefix },
        ctx,
      );
    }
    await ext.handler(req, res, {
      requestId: ctx.requestId,
      identity,
      path: ctx.path,
      audit: (type, fields = {}) => {
        deps.audit.record(auditEvent(type, fields, ctx));
      },
    });
  }

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
  ): Promise<void> {
    const ext = findExtension(extensions, ctx.path);
    if (ext) {
      await runExtension(req, res, ext, ctx);
      return;
    }
    if (web && (await web(req, res, ctx))) return;
    const resolved = resolve(req, req.url ?? '/');
    if (!resolved) throw new HttpError(404, 'not found');
    ctx.route = resolved.route.kind;
    // Before anything is logged or audited: the path may hold a token.
    if (resolved.logPath !== undefined) ctx.path = resolved.logPath;
    if (resolved.route.kind === 'account') {
      await account(req, res, resolved, resolved.route, ctx);
      return;
    }
    const resource = resourceOf(resolved.adapter, resolved.route);
    // Without required auth, only routes the authorizer sees are authenticated: an optional
    // identity can widen what it allows. Ping and rejected paths never call the provider.
    const identity =
      deps.auth.required || resource || resolved.route.kind === 'whoami'
        ? await deps.auth.authenticate(req)
        : null;
    if (!identity && deps.auth.required) {
      deps.audit.record(auditEvent('auth.denied', { path: ctx.path }, ctx));
      throw new HttpError(
        401,
        'authentication required',
        { error: 'authentication required' },
        { 'www-authenticate': 'Bearer realm="eyniq-cache"' },
      );
    }
    if (identity) ctx.identity = identity.name;
    const route = resolved.route;
    if (isWrite(route)) {
      // An adapter that returns write routes without a package source stays read-only.
      if (!Object.hasOwn(sources, resolved.adapter.id)) throw new HttpError(405, READ_ONLY);
      // Fail closed: a write route always names its resource.
      if (!resource) throw new Error('write route without an authorization resource');
      await authorize(identity, 'publish', resource, ctx);
      await write(req, res, resolved.adapter, route, ctx, identity, resource);
      return;
    }
    if (resource) await authorize(identity, 'read', resource, ctx);
    if (resolved.route.kind !== 'passthrough') {
      await registry(req, res, resolved.adapter, resolved.route, ctx, identity);
      return;
    }
    if (passthroughInFlight >= MAX_PASSTHROUGH_IN_FLIGHT) {
      req.resume();
      throw new HttpError(503, 'too many pass-through requests in flight');
    }
    passthroughInFlight++;
    try {
      await registry(req, res, resolved.adapter, resolved.route, ctx, identity);
    } finally {
      passthroughInFlight--;
    }
  }

  // Read-only web catalog (WEB_UI); default off. Sessions need compare-and-swap storage.
  let web: WebHandler | null = null;
  if (deps.config.webUi) {
    const sessions =
      deps.webLogin && isStorageAdmin(deps.storage)
        ? new WebSessionStore({
            storage: deps.storage,
            ttlMs: deps.config.webSessionTtlMs,
            cacheTtlMs: deps.config.userTokenCacheTtlMs,
            lookupLimiter: new LookupLimiter(),
          })
        : null;
    if (deps.config.publicUrl.startsWith('http:')) {
      log.warn(
        'WEB_UI is on with an http PUBLIC_URL: catalog passwords and session cookies travel unencrypted; use https',
      );
    }
    if (deps.webLogin && !sessions) {
      log.warn('WEB_UI sign-in needs storage with compare-and-swap; the catalog has no login');
    }
    web = createWebHandler({
      config: deps.config,
      adapters: deps.adapters,
      metadata,
      search,
      stats: deps.config.webStats ? statsReader : null,
      auth: deps.auth,
      audit: deps.audit,
      ...(deps.webLogin ? { webLogin: deps.webLogin } : {}),
      sessions,
      authorize,
      clientAddress: (req) => clientAddress(req, deps.config.trustProxyHops),
    });
  }

  const server = createHttpServer((req, res) => {
    const started = performance.now();
    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const ctx: RequestContext = {
      cache: 'none',
      bytes: 0,
      path: q === -1 ? rawUrl : rawUrl.slice(0, q),
      route: 'unknown',
      requestId: requestIdOf(req),
    };
    res.setHeader('x-request-id', ctx.requestId);
    // Slow or stalled clients must not pin sockets (or, through backpressure, an upstream
    // download) forever. A disconnected leader's download still completes for the cache.
    res.setTimeout(SOCKET_IDLE_MS, () => {
      res.destroy();
    });
    res.once('close', () => {
      const seconds = (performance.now() - started) / 1000;
      metrics.requests.inc({ route: ctx.route, status: String(res.statusCode) });
      metrics.requestDuration.observe(seconds, { route: ctx.route });
      if (ctx.cache !== 'none') metrics.cacheResults.inc({ result: ctx.cache });
      if (ctx.route === 'artifact') metrics.tarballBytes.inc({}, ctx.bytes);
      log.info('request', {
        method: req.method,
        path: ctx.path,
        status: res.statusCode,
        durationMs: Math.round(seconds * 10_000) / 10,
        cache: ctx.cache,
        bytes: ctx.bytes,
        requestId: ctx.requestId,
        ...(ctx.identity !== undefined ? { identity: ctx.identity } : {}),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
      // High volume: only for sinks that ask for it (the default sink does not). Guarded:
      // a throwing custom sink here would be an uncaught exception.
      try {
        if (
          ctx.artifact &&
          req.method === 'GET' &&
          res.statusCode === 200 &&
          res.writableFinished &&
          deps.audit.wants?.('artifact.served') === true
        ) {
          deps.audit.record(
            auditEvent(
              'artifact.served',
              { ...ctx.artifact, cache: ctx.cache, bytes: ctx.bytes },
              ctx,
            ),
          );
        }
      } catch (err) {
        log.error('audit sink failed', errorFields(err));
      }
    });
    dispatch(req, res, ctx).catch((err: unknown) => {
      sendError(res, err, ctx);
    });
  });
  const management = createHttpServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const ctx: RequestContext = {
      cache: 'none',
      bytes: 0,
      path: q === -1 ? rawUrl : rawUrl.slice(0, q),
      route: 'management',
      requestId: requestIdOf(req),
    };
    res.setHeader('x-request-id', ctx.requestId);
    (async () => {
      if (ctx.path === '/stats') {
        await handleStats(req, res, ctx);
        return;
      }
      if (await system(res, ctx)) return;
      const ext = findExtension(managementExtensions, ctx.path);
      if (ext) await runExtension(req, res, ext, ctx);
      else sendJson(res, 404, { error: 'not found' }, ctx);
    })().catch((err: unknown) => {
      sendError(res, err, ctx);
    });
  });

  // Extension lifecycle: started once, before the first listen; closed in reverse order.
  const services: ExtensionServices = {
    metrics,
    audit: deps.audit,
    storage: deps.storage,
    config: deps.config,
  };
  const startedExtensions: Extension[] = [];
  let starting: Promise<void> | null = null;

  async function closeExtensions(): Promise<void> {
    for (const e of startedExtensions.splice(0).reverse()) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve(e.close?.()),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('extension close timed out'));
            }, EXTENSION_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        log.error('extension close failed', { prefix: e.prefix, ...errorFields(err) });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Every extension whose start() was attempted is closed later, including the one that
   * failed (it may have opened resources before throwing). One object listed twice starts
   * once.
   */
  function startExtensions(): Promise<void> {
    starting ??= (async () => {
      try {
        for (const e of new Set([...extensions, ...managementExtensions])) {
          startedExtensions.push(e);
          await e.start?.(services);
        }
      } catch (err) {
        await closeExtensions();
        throw err;
      }
    })();
    return starting;
  }

  async function listenOn(srv: Server, port: number, host?: string): Promise<number> {
    await new Promise<void>((resolveListen, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.off('error', reject);
        resolveListen();
      });
    });
    return (srv.address() as AddressInfo).port;
  }

  management.requestTimeout = 5_000;
  management.headersTimeout = 5_000;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Time allowed to receive a complete request (headers and body), e.g. an audit POST.
  server.requestTimeout = 30_000;

  return {
    server,
    management,
    metrics,
    metadataFetchTimes: (adapter, name) => metadata.fetchTimes(adapter, name),
    async listen(port, host) {
      await startExtensions();
      recorder?.start();
      return listenOn(server, port, host);
    },
    async listenManagement(port, host) {
      await startExtensions();
      recorder?.start();
      return listenOn(management, port, host);
    },
    drain: () => metadata.drain(),
    async close() {
      // A close during a slow start waits for it, so late-starting extensions are closed too.
      await starting?.catch(() => undefined);
      const closed = new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, 10_000);
      await closed;
      clearTimeout(timer);
      if (management.listening) {
        management.closeAllConnections();
        await new Promise<void>((r) => {
          management.close(() => {
            r();
          });
        });
      }
      try {
        await closeExtensions();
      } finally {
        await recorder?.stop();
      }
      monitor.stop();
      metadata.close();
      await metadata.drain();
      await processor.close();
    },
  };
}
