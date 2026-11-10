// Read-only web catalog (C5, WEB_UI): a static shell (HTML, one ES module, one stylesheet)
// under /-/web/ and small JSON endpoints, served by the registry port. Every response carries
// a strict Content-Security-Policy (no inline code, same-origin only) and the usual hardening
// headers (HSTS too when PUBLIC_URL is https), also error answers. Reads use the registry's
// authentication and the same `read` authorization as the registry routes, and packages the
// registry hides as a whole (package filter) are hidden here too; a browser signs in with a
// password (ServerDeps.webLogin) and gets an HttpOnly, SameSite=Strict session cookie that only
// these read endpoints accept. The login and logout POSTs must come from PUBLIC_URL's origin
// (Origin header, or Sec-Fetch-Site: same-origin when a browser sends no usable Origin), and a
// sign-in body must arrive within a deadline. Nothing here writes packages.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auditEvent } from '../core/audit.ts';
import type {
  AuditSink,
  AuthorizationAction,
  AuthorizationResource,
  AuthProvider,
  CatalogInput,
  CatalogProtocol,
  EcosystemAdapter,
  Identity,
  WebLogin,
} from '../core/contracts.ts';
import { HttpError } from '../core/errors.ts';
import { errorFields, log } from '../core/log.ts';
import { ByteLru } from '../core/lru.ts';
import type { RequestContext } from '../core/request.ts';
import { readLimited } from '../core/streams.ts';
import type { SearchService } from '../http/routes/search.ts';
import type { MetadataService } from '../metadata/service.ts';
import {
  StatsBusyError,
  StatsUnavailableError,
  isStatsRange,
  type StatsReader,
} from '../stats/reader.ts';
import { renderMarkdown } from './markdown.ts';
import type { WebSessionStore } from './sessions.ts';

const PREFIX = '/-/web';
const COOKIE = 'eyniq_web_session';
const MAX_LOGIN_BODY = 8 * 1024;
const MAX_LOGINS_IN_FLIGHT = 16;
const LOGIN_BODY_TIMEOUT_MS = 10_000;
const README_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_STAMP = 128;

interface Asset {
  body: Buffer;
  type: string;
  etag: string;
}

const ASSET_TYPES: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
};

/** The shipped assets, read once (src/web/static in development, dist/web/static built). */
function loadAssets(): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const [file, type] of Object.entries(ASSET_TYPES)) {
    let body: Buffer;
    try {
      body = readFileSync(new URL(`./static/${file}`, import.meta.url));
    } catch {
      throw new Error(`WEB_UI: the catalog asset static/${file} is missing from this build`);
    }
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
    assets.set(file, { body, type, etag });
  }
  return assets;
}

export interface WebHandlerDeps {
  config: {
    publicUrl: string;
    webUiImages: boolean;
    trustProxyHops: number;
  };
  adapters: readonly EcosystemAdapter[];
  metadata: MetadataService;
  search: SearchService;
  /** The statistics history (STATS_HISTORY); null/absent hides the stats page. */
  stats?: StatsReader | null;
  auth: AuthProvider;
  audit: AuditSink;
  webLogin?: WebLogin;
  /** Null when there is no login (no webLogin, or storage without compare-and-swap). */
  sessions: WebSessionStore | null;
  /** Throws 403 (or 5xx) unless the authorizer allows the action. */
  authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
    ctx: RequestContext,
  ): Promise<void>;
  clientAddress(req: IncomingMessage): string | undefined;
  /** How long a sign-in body may take to arrive. Default 10 s. */
  loginBodyTimeoutMs?: number;
}

export type WebHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => Promise<boolean>;

function securityHeaders(images: boolean, secure: boolean): Record<string, string> {
  const img = images ? "img-src 'self' https:" : "img-src 'self'";
  return {
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; ${img}; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on the
    // sign-in form posts, and those must name this origin.
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createWebHandler(deps: WebHandlerDeps): WebHandler {
  const assets = loadAssets();
  const publicOrigin = new URL(deps.config.publicUrl).origin;
  const secure = publicOrigin.startsWith('https:');
  const headers = securityHeaders(deps.config.webUiImages, secure);
  const readmes = new ByteLru<Buffer>(README_CACHE_BYTES);
  let loginsInFlight = 0;
  const catalogAdapter = deps.adapters.find((a) => a.catalog !== undefined);

  function send(
    res: ServerResponse,
    ctx: RequestContext,
    status: number,
    body: Buffer,
    type: string,
    extra: Record<string, string | string[]> = {},
  ): void {
    res.writeHead(status, {
      ...headers,
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
      ...extra,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
    ctx.bytes += body.length;
  }

  function json(res: ServerResponse, ctx: RequestContext, status: number, value: unknown): void {
    send(res, ctx, status, Buffer.from(JSON.stringify(value)), 'application/json; charset=utf-8');
  }

  function redirect(
    res: ServerResponse,
    ctx: RequestContext,
    status: number,
    location: string,
    extra: Record<string, string> = {},
  ): void {
    send(res, ctx, status, Buffer.alloc(0), 'text/plain; charset=utf-8', { location, ...extra });
  }

  function asset(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    file: string,
  ): void {
    const a = assets.get(file);
    if (!a) {
      json(res, ctx, 404, { error: 'not found' });
      return;
    }
    if (file === 'index.html') {
      send(res, ctx, 200, a.body, a.type); // the page itself: never stored
      return;
    }
    // Revalidated every time (cheap, 304), so a new version is picked up at once.
    const cache = { etag: a.etag, 'cache-control': 'no-cache' };
    if (req.headers['if-none-match'] === a.etag) {
      res.writeHead(304, { ...headers, ...cache });
      res.end();
      return;
    }
    send(res, ctx, 200, a.body, a.type, cache);
  }

  /** The catalog identity: a session cookie, else the registry credentials (bearer). */
  async function identify(req: IncomingMessage): Promise<Identity | null> {
    const token = cookieValue(req, COOKIE);
    if (token !== undefined && deps.sessions) {
      const session = await deps.sessions.lookup(token, () => deps.clientAddress(req));
      if (
        session &&
        (deps.webLogin?.isValid?.(session.user, session.created, session.stamp) ?? true)
      ) {
        return { name: session.user, claims: { via: 'web-session' } };
      }
    }
    return deps.auth.authenticate(req);
  }

  /** Authenticated (when required) and authorized to read `resource`; else throws. */
  async function reader(
    req: IncomingMessage,
    ctx: RequestContext,
    resource: AuthorizationResource,
  ): Promise<Identity | null> {
    const identity = await identify(req);
    if (!identity && deps.auth.required) {
      deps.audit.record(auditEvent('auth.denied', { path: ctx.path }, ctx));
      throw new HttpError(401, 'authentication required');
    }
    if (identity) ctx.identity = identity.name;
    await deps.authorize(identity, 'read', resource, ctx);
    return identity;
  }

  function catalogOf(): { adapter: EcosystemAdapter; catalog: CatalogProtocol } {
    const catalog = catalogAdapter?.catalog;
    if (!catalogAdapter || !catalog) throw new HttpError(404, 'no catalog for this registry');
    return { adapter: catalogAdapter, catalog };
  }

  function nameOf(rest: string, catalog: CatalogProtocol): string {
    let name: string;
    try {
      name = decodeURIComponent(rest);
    } catch {
      throw new HttpError(400, 'invalid package name');
    }
    if (!catalog.isValidName(name)) throw new HttpError(400, 'invalid package name');
    return name;
  }

  async function catalogInput(
    adapter: EcosystemAdapter,
    name: string,
    version?: string,
  ): Promise<CatalogInput> {
    // Hidden as a whole by the policy (package filter): not found, as search hides it.
    if (deps.metadata.blocksWholePackage(adapter, name)) {
      throw new HttpError(404, 'package not found');
    }
    const { entry } = await deps.metadata.lookup(adapter, name);
    if (!entry || entry.processed.versions.length === 0) {
      throw new HttpError(404, 'package not found');
    }
    const blocked = new Map<string, { reason: string; allowedAfter?: number }>();
    for (const [v, d] of entry.blocked) {
      blocked.set(v, {
        reason: d.reason,
        ...(d.allowedAfter !== undefined ? { allowedAfter: d.allowedAfter } : {}),
      });
    }
    return {
      processed: entry.processed,
      allowed: entry.allowed,
      blocked,
      ...(version !== undefined ? { version } : {}),
    };
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    route: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      throw new HttpError(405, 'method not allowed');
    if (route === 'session') {
      const identity = await identify(req);
      json(res, ctx, 200, {
        user: identity?.name ?? null,
        authRequired: deps.auth.required,
        loginAvailable: deps.sessions !== null,
        images: deps.config.webUiImages,
        stats: deps.stats != null,
      });
      return;
    }
    if (route === 'stats') {
      // Its own route label keeps the page's polling out of the request statistics.
      ctx.route = 'web_stats';
      // Same read authorization as the catalog; the statistics are the pods' own numbers
      // (see DESIGN.md section 17), read through the same bounded, cached reader as /stats.
      const stats = deps.stats;
      if (!stats) throw new HttpError(404, 'statistics are not available');
      const range = query.get('range') ?? '24h';
      if (!isStatsRange(range)) throw new HttpError(400, 'invalid range');
      await reader(req, ctx, { ecosystem: '*', route: 'stats' });
      try {
        json(res, ctx, 200, await stats.query(range));
      } catch (err) {
        if (err instanceof StatsUnavailableError) {
          throw new HttpError(404, 'statistics are not available');
        }
        if (err instanceof StatsBusyError) {
          throw new HttpError(
            503,
            'statistics are busy',
            { error: err.message },
            { 'retry-after': '5' },
          );
        }
        throw err;
      }
      return;
    }
    const { adapter, catalog } = catalogOf();
    if (route === 'search') {
      const text = query.get('text') ?? '';
      if (text.trim() === '' || text.length > 512) throw new HttpError(400, 'invalid search text');
      const size = Math.min(100, Math.max(1, Number(query.get('size') ?? 20) || 20));
      const from = Math.min(10_000, Math.max(0, Number(query.get('from') ?? 0) || 0));
      const identity = await reader(req, ctx, { ecosystem: adapter.id, route: 'passthrough' });
      const qs = new URLSearchParams({ text, size: String(size), from: String(from) });
      const body = await deps.search.run(adapter, `?${qs.toString()}`, identity, 'web');
      json(res, ctx, 200, catalog.searchResults(body));
      return;
    }
    const slash = route.indexOf('/');
    const kind = slash === -1 ? route : route.slice(0, slash);
    if ((kind !== 'package' && kind !== 'readme') || slash === -1) {
      throw new HttpError(404, 'not found');
    }
    const name = nameOf(route.slice(slash + 1), catalog);
    await reader(req, ctx, { ecosystem: adapter.id, route: 'metadata', name });
    if (kind === 'package') {
      const version = query.get('version') ?? undefined;
      if (version !== undefined && (version.length > 256 || !/^[\x21-\x7e]+$/.test(version))) {
        throw new HttpError(400, 'invalid version');
      }
      json(res, ctx, 200, catalog.describe(await catalogInput(adapter, name, version)));
      return;
    }
    const input = await catalogInput(adapter, name);
    const key = `${adapter.id}:${name}:${input.processed.digest}`;
    // Check, render and store run without an await in between: concurrent requests for the
    // same README render it once (the render itself is bounded, see markdown.ts).
    let body = readmes.get(key);
    if (!body) {
      const source = catalog.readme(input);
      const rendered = source
        ? renderMarkdown(source, { images: deps.config.webUiImages })
        : { nodes: [], truncated: false };
      body = Buffer.from(JSON.stringify(rendered));
      readmes.set(key, body, body.length);
    }
    send(res, ctx, 200, body, 'application/json; charset=utf-8');
  }

  /**
   * Login and logout forms must come from this registry's own pages: the Origin header names
   * PUBLIC_URL's origin, or, when a browser sends none (or "null"), Sec-Fetch-Site says
   * same-origin. Without either the request is refused.
   */
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    const sameSite = req.headers['sec-fetch-site'] === 'same-origin';
    const ok = origin === publicOrigin || ((origin === undefined || origin === 'null') && sameSite);
    if (!ok) {
      req.resume();
      throw new HttpError(403, 'cross-origin request refused');
    }
  }

  /** The request body within the sign-in deadline (408 after it). */
  async function readLoginBody(req: IncomingMessage): Promise<Buffer> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(408, 'request body timeout'));
      }, deps.loginBodyTimeoutMs ?? LOGIN_BODY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        readLimited(req, MAX_LOGIN_BODY, () => new HttpError(413, 'request body too large')),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function sessionCookie(token: string, maxAge: number): string {
    return `${COOKIE}=${token}; Path=${PREFIX}/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  async function login(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
  ): Promise<void> {
    checkOrigin(req);
    const sessions = deps.sessions;
    const webLogin = deps.webLogin;
    if (!sessions || !webLogin) {
      req.resume();
      throw new HttpError(404, 'sign-in is not available');
    }
    // Counted once the body is in: slow bodies (bounded by size and LOGIN_BODY_TIMEOUT_MS)
    // must not use up the slots of the password checks.
    const body = await readLoginBody(req);
    if (loginsInFlight >= MAX_LOGINS_IN_FLIGHT) {
      throw new HttpError(503, 'too many sign-ins in progress');
    }
    loginsInFlight++;
    try {
      const form = new URLSearchParams(body.toString('utf8'));
      const name = form.get('name') ?? '';
      const password = form.get('password') ?? '';
      const address = deps.clientAddress(req);
      const identity =
        name !== '' && password !== '' && name.length <= 256 && password.length <= 1024
          ? await webLogin.login(name, password, {
              requestId: ctx.requestId,
              ...(address !== undefined ? { clientAddress: address } : {}),
            })
          : null;
      if (!identity) {
        deps.audit.record(auditEvent('auth.denied', { path: ctx.path, action: 'web-login' }, ctx));
        redirect(res, ctx, 303, `${PREFIX}/login?failed=1`);
        return;
      }
      const stamp = identity.claims?.stamp;
      const token = await sessions.create(
        identity.name,
        typeof stamp === 'string' && stamp.length <= MAX_STAMP ? stamp : undefined,
      );
      ctx.identity = identity.name;
      deps.audit.record(auditEvent('auth.login', { method: 'web-catalog' }, ctx));
      redirect(res, ctx, 303, `${PREFIX}/`, {
        'set-cookie': sessionCookie(token, sessions.maxAgeSeconds),
      });
    } finally {
      loginsInFlight--;
    }
  }

  async function logout(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
  ): Promise<void> {
    checkOrigin(req);
    req.resume();
    const token = cookieValue(req, COOKIE);
    if (token !== undefined && deps.sessions) {
      // The client address keys the unknown-id budget (LookupLimiter): without it every
      // made-up id would only draw on the global budget that everyone's lookups share.
      const session = await deps.sessions.lookup(token, () => deps.clientAddress(req));
      if (session) ctx.identity = session.user;
      await deps.sessions.delete(token);
      if (session) deps.audit.record(auditEvent('auth.logout', { method: 'web-catalog' }, ctx));
    }
    redirect(res, ctx, 303, `${PREFIX}/`, { 'set-cookie': sessionCookie('', 0) });
  }

  return async function handleWeb(req, res, ctx) {
    const path = ctx.path;
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    if (path === '/' && read) {
      ctx.route = 'web';
      req.resume();
      redirect(res, ctx, 302, `${PREFIX}/`);
      return true;
    }
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
    ctx.route = 'web';
    try {
      if (path === PREFIX) {
        if (!read) throw new HttpError(405, 'method not allowed');
        redirect(res, ctx, 302, `${PREFIX}/`);
        return true;
      }
      const rest = path.slice(PREFIX.length + 1);
      if (rest === 'login' && method === 'POST') {
        await login(req, res, ctx);
        return true;
      }
      if (rest === 'logout') {
        if (method !== 'POST') throw new HttpError(405, 'method not allowed');
        await logout(req, res, ctx);
        return true;
      }
      if (rest.startsWith('api/')) {
        const q = (req.url ?? '').indexOf('?');
        const query = new URLSearchParams(q === -1 ? '' : (req.url ?? '').slice(q + 1));
        await api(req, res, ctx, rest.slice(4), query);
        return true;
      }
      if (!read) throw new HttpError(405, 'method not allowed');
      req.resume();
      if (rest.startsWith('static/')) {
        asset(req, res, ctx, rest.slice(7));
        return true;
      }
      // The pages of the single-page app all load the same shell.
      if (
        rest === '' ||
        rest === 'search' ||
        rest === 'login' ||
        rest === 'stats' ||
        rest.startsWith('package/')
      ) {
        asset(req, res, ctx, 'index.html');
        return true;
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      // Every answer of the catalog carries its headers, also unexpected failures.
      if (!(err instanceof HttpError)) log.error('web catalog request failed', errorFields(err));
      const status = err instanceof HttpError ? err.status : 500;
      const body = err instanceof HttpError ? err.body : { error: 'internal error' };
      req.resume();
      if (res.headersSent) {
        res.destroy();
        return true;
      }
      json(res, ctx, status, body);
      return true;
    }
  };
}
