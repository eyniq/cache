// Account routes (login, logout, tokens) of an adapter's AccountProtocol, served by the
// optional AccountProvider. The authentication rules live here, not in the provider:
//   login-start, login-poll, user-login, logout: no credentials needed (even when registry
//     auth is required); the provider is never told about an identity
//   token-list, token-create, token-delete: an identity (401) and the authorizer's `account`
//     action (403) before the provider is called
// Responses are never cached (they carry tokens).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auditEvent } from '../../core/audit.ts';
import type {
  AccountAction,
  AccountToken,
  AccountContext,
  AccountProtocol,
  AccountProvider,
  AccountRequest,
  AccountResult,
  AccountRoute,
  AuditSink,
  AuthProvider,
  EcosystemAdapter,
  Identity,
} from '../../core/contracts.ts';
import { HttpError, isHttpError } from '../../core/errors.ts';
import { errorFields, log } from '../../core/log.ts';
import type { RequestContext } from '../../core/request.ts';
import { readLimited } from '../../core/streams.ts';

const PROVIDER_METHOD = {
  'login-start': 'startWebLogin',
  'login-poll': 'pollWebLogin',
  'user-login': 'login',
  'token-list': 'listTokens',
  'token-create': 'createToken',
  'token-delete': 'deleteToken',
  logout: 'logout',
} as const satisfies Record<AccountAction, keyof AccountProvider>;

const NEEDS_IDENTITY: Readonly<Record<AccountAction, boolean>> = {
  'login-start': false,
  'login-poll': false,
  'user-login': false,
  logout: false,
  'token-list': true,
  'token-create': true,
  'token-delete': true,
};

/** Actions `provider` implements; adapters claim routes for exactly these. */
export function accountActions(provider: AccountProvider | undefined): ReadonlySet<AccountAction> {
  const actions = new Set<AccountAction>();
  if (!provider) return actions;
  for (const [action, method] of Object.entries(PROVIDER_METHOD) as Array<
    [AccountAction, keyof AccountProvider]
  >) {
    if (typeof provider[method] === 'function') actions.add(action);
  }
  return actions;
}

export interface AccountHandlerDeps {
  provider: AccountProvider;
  auth: AuthProvider;
  audit: AuditSink;
  /** PUBLIC_URL plus the mount the client used, without a trailing slash. */
  registryUrl: string;
  /** Throws 403 unless the authorizer allows the `account` action. */
  authorize(identity: Identity, action: AccountAction): Promise<void>;
  /** A provider call that takes longer fails with 503. */
  timeoutMs: number;
  /** The client's address (AccountContext.clientAddress). */
  clientAddress?: string;
}

const unauthorized = (): HttpError =>
  new HttpError(
    401,
    'authentication required',
    { error: 'authentication required' },
    { 'www-authenticate': 'Bearer realm="eyniq-cache"' },
  );

const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** Provider answers end up in client configuration files: refuse anything unusable. */
function checkToken(token: unknown): string {
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new Error('account provider returned an invalid token');
  }
  return token;
}

/**
 * http(s) without credentials. With `origin`, the URL must be on it: the client sends the
 * token request there, so it must not leave the registry (or downgrade to http).
 */
function checkUrl(value: unknown, origin?: string): string {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : null;
  if (
    !url ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    (origin !== undefined && url.origin !== origin)
  ) {
    throw new Error('account provider returned an invalid login URL');
  }
  return url.href;
}

/** Printed by clients in terminals: no control characters, no bidi overrides or isolates. */
const UNPRINTABLE = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const NAME = /^[^\p{Cc}\p{Z}/\u202a-\u202e\u2066-\u2069]{1,256}$/u;

function checkText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error('account provider returned an invalid value');
  }
  if (UNPRINTABLE.test(value)) throw new Error('account provider returned an unprintable value');
  return value;
}

function checkName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new Error('account provider returned an invalid user name');
  }
  return value;
}

/** Copies only the documented fields, each checked. */
function checkTokenInfo(info: AccountToken): AccountToken {
  if (typeof info.readonly !== 'boolean' || !Array.isArray(info.cidrWhitelist)) {
    throw new Error('account provider returned an invalid token');
  }
  return {
    key: checkToken(info.key),
    preview: checkText(info.preview, 64),
    ...(info.name !== undefined ? { name: checkText(info.name, 256) } : {}),
    readonly: info.readonly,
    cidrWhitelist: info.cidrWhitelist.map((c) => checkText(c, 64)),
    created: checkText(info.created, 64),
    ...(info.updated !== undefined ? { updated: checkText(info.updated, 64) } : {}),
  };
}

/** A provider's OTP challenge (401 with `www-authenticate: OTP`) is the one failure it may send. */
function isOtpChallenge(err: unknown): boolean {
  return (
    isHttpError(err) && err.status === 401 && /\botp\b/i.test(err.headers['www-authenticate'] ?? '')
  );
}

/** 1..60 whole seconds; anything else a provider returns becomes 1. */
function retrySeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(60, Math.max(1, n));
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const tooLarge = (): HttpError => new HttpError(413, 'request body too large');
  if (Number(req.headers['content-length'] ?? 0) > max) {
    req.resume();
    throw tooLarge();
  }
  return readLimited(req, max, tooLarge);
}

export async function handleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: EcosystemAdapter,
  protocol: AccountProtocol,
  route: AccountRoute,
  ctx: RequestContext,
  deps: AccountHandlerDeps,
): Promise<void> {
  let identity: Identity | null = null;
  if (NEEDS_IDENTITY[route.action]) {
    identity = await deps.auth.authenticate(req);
    if (!identity) {
      req.resume();
      deps.audit.record(auditEvent('auth.denied', { path: ctx.path }, ctx));
      throw unauthorized();
    }
    ctx.identity = identity.name;
    try {
      await deps.authorize(identity, route.action);
    } catch (err) {
      req.resume(); // drain so a keep-alive client can read the 403
      throw err;
    }
  }
  const body = await readBody(req, protocol.maxBodyBytes);
  const request = protocol.parse(route, body, req.headers);
  if (request.action !== route.action) throw new Error('account request does not match its route');
  const accountCtx: AccountContext = {
    requestId: ctx.requestId,
    ecosystem: adapter.id,
    registryUrl: deps.registryUrl,
    ...(deps.clientAddress !== undefined ? { clientAddress: deps.clientAddress } : {}),
    audit: (type, fields = {}) => {
      deps.audit.record(auditEvent(type, fields, ctx));
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HttpError(503, 'account service unavailable'));
    }, deps.timeoutMs);
  });
  let result: AccountResult;
  try {
    result = await Promise.race([perform(request, identity, accountCtx, ctx, deps), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const out = protocol.render(route, result);
  res.writeHead(out.status, {
    ...out.headers,
    'content-type': out.contentType,
    'content-length': out.body.length,
    'cache-control': 'no-store',
  });
  res.end(out.body);
  ctx.bytes += out.body.length;
}

async function perform(
  request: AccountRequest,
  identity: Identity | null,
  accountCtx: AccountContext,
  ctx: RequestContext,
  deps: AccountHandlerDeps,
): Promise<AccountResult> {
  const p = deps.provider;
  const audit = (type: string, fields: Record<string, unknown> = {}): void => {
    deps.audit.record(auditEvent(type, fields, ctx));
  };
  // The adapter only claims routes for implemented methods; checked again for safety.
  const missing = (): never => {
    throw new Error(`account provider does not implement ${request.action}`);
  };
  switch (request.action) {
    case 'login-start': {
      if (!p.startWebLogin) return missing();
      const r = await p.startWebLogin(accountCtx);
      return {
        action: 'login-start',
        loginUrl: checkUrl(r.loginUrl),
        doneUrl: checkUrl(r.doneUrl, new URL(deps.registryUrl).origin),
      };
    }
    case 'login-poll': {
      if (!p.pollWebLogin) return missing();
      const r = await p.pollWebLogin(request.session, accountCtx);
      switch (r.status) {
        case 'pending':
          return {
            action: 'login-poll',
            status: 'pending',
            retryAfterSeconds: retrySeconds(r.retryAfterSeconds),
          };
        case 'done': {
          const token = checkToken(r.token);
          if (r.name !== undefined) ctx.identity = checkName(r.name);
          audit('auth.login', { method: 'web' });
          return { action: 'login-poll', status: 'done', token };
        }
        default:
          // A loosely typed provider: anything else is an error, never a token.
          throw new Error('account provider returned an invalid poll state');
      }
    }
    case 'user-login': {
      if (!p.login) return missing();
      let r: { name: string; token: string } | null;
      try {
        r = await p.login(request, accountCtx);
      } catch (err) {
        if (isOtpChallenge(err)) throw err;
        // A provider that is overloaded (e.g. its password-hash queue is full) says so with
        // a 503: that is about the server, not the user, and the client should retry.
        if (isHttpError(err) && err.status === 503) throw err;
        // Any other failure answers like a wrong password: no oracle for existing users.
        log.error('account provider login failed', errorFields(err));
        r = null;
      }
      if (!r) {
        // One answer for every failure: it must not tell whether the user exists.
        audit('auth.denied', { path: ctx.path, action: 'user-login' });
        throw new HttpError(401, 'invalid credentials');
      }
      const token = checkToken(r.token);
      const name = checkName(r.name);
      ctx.identity = name;
      audit('auth.login', { method: 'password' });
      return { action: 'user-login', name, token };
    }
    case 'token-list': {
      if (!identity) throw unauthorized();
      if (!p.listTokens) return missing();
      const tokens: unknown = await p.listTokens(identity, accountCtx);
      if (!Array.isArray(tokens)) throw new Error('account provider returned an invalid list');
      return { action: 'token-list', tokens: tokens.map((t) => checkTokenInfo(t as AccountToken)) };
    }
    case 'token-create': {
      if (!identity) throw unauthorized();
      if (!p.createToken) return missing();
      const r = await p.createToken(identity, request, accountCtx);
      const token = checkToken(r.token);
      const info = checkTokenInfo(r.info);
      // No key or token: providers may audit those through ctx.audit if they want to.
      audit('auth.token.created', {
        readonly: request.readonly,
        cidr: request.cidrWhitelist.length > 0,
        ...(request.expiresInDays !== undefined ? { expiresInDays: request.expiresInDays } : {}),
      });
      return { action: 'token-create', token, info };
    }
    case 'token-delete': {
      if (!identity) throw unauthorized();
      if (!p.deleteToken) return missing();
      // Only a literal true deletes: a loosely typed provider answering 1 or "no" does not.
      const deleted: unknown = await p.deleteToken(identity, request.key, accountCtx);
      if (deleted !== true) throw new HttpError(404, 'token not found');
      audit('auth.token.deleted');
      return { action: 'token-delete' };
    }
    case 'logout': {
      if (!p.logout) return missing();
      await p.logout(request.token, accountCtx);
      audit('auth.logout');
      return { action: 'logout' };
    }
  }
}
