// npm account endpoints: web login (POST /-/v1/login, then polling the doneUrl), the couch
// password login (PUT /-/user/org.couchdb.user:<name>), logout (DELETE /-/user/token/<token>)
// and token management (/-/npm/v1/tokens). Routes are claimed only for the actions the
// AccountProvider implements; the core applies the authentication rules and calls it.
import type { IncomingHttpHeaders } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import type {
  AccountAction,
  AccountProtocol,
  AccountRequest,
  AccountResponse,
  AccountResult,
  AccountRoute,
  AccountToken,
  AdapterRoute,
} from '../../core/contracts.ts';
import { HttpError } from '../../core/errors.ts';

const LOGIN = '/-/v1/login';
const USER_PREFIX = '/-/user/org.couchdb.user:';
const LOGOUT_PREFIX = '/-/user/token/';
const TOKENS = '/-/npm/v1/tokens';
const TOKEN_PREFIX = '/-/npm/v1/tokens/token/';
const REDACTED = '[redacted]';

/** Session paths are opaque to the core: a few plain segments, nothing that can traverse. */
const SESSION =
  /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,255}(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,255}){0,3}$/;
/** Tokens and keys are printable ASCII without spaces (they travel in URLs and headers). */
const OPAQUE = /^[\x21-\x7e]{1,4096}$/;
/** User names: printable, no separators or control characters. */
const USER = /^[^\p{Cc}\p{Z}/]{1,256}$/u;
const OTP = /^[\x21-\x7e]{1,64}$/;
const MAX_PASSWORD = 1024;
const MAX_TEXT = 256;
const MAX_CIDRS = 64;
/** Token options npm can ask for that this protocol cannot honour: refused, never ignored. */
const UNSUPPORTED_TOKEN_OPTIONS = [
  'packages',
  'packages_all',
  'scopes',
  'orgs',
  'packages_and_scopes_permission',
  'orgs_permission',
] as const;

const reject = (status: number, message: string, logPath?: string): AdapterRoute => ({
  kind: 'reject',
  status,
  message,
  ...(logPath !== undefined ? { logPath } : {}),
});

const bad = (message: string): HttpError => new HttpError(400, message);

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Account routes for the claimed `actions`, or null to let the regular grammar answer (as it
 * always did). `npm logout` puts the token in the path, so its log path is redacted even when
 * nothing is claimed.
 */
export function matchAccount(
  method: string,
  path: string,
  actions: ReadonlySet<AccountAction>,
): AdapterRoute | null {
  const has = (a: AccountAction): boolean => actions.has(a);
  if (path === LOGIN && has('login-start')) {
    return method === 'POST'
      ? { kind: 'account', action: 'login-start', logPath: LOGIN }
      : reject(405, 'method not allowed');
  }
  if (path.startsWith(`${LOGIN}/`) && has('login-poll')) {
    const logPath = `${LOGIN}/${REDACTED}`;
    if (method !== 'GET') return reject(405, 'method not allowed', logPath);
    const session = path.slice(LOGIN.length + 1);
    if (!SESSION.test(session) || session.split('/').some((s) => s === '.' || s === '..')) {
      return reject(400, 'invalid login session', logPath);
    }
    return { kind: 'account', action: 'login-poll', session, logPath };
  }
  if (path.startsWith(USER_PREFIX) && has('user-login') && method === 'PUT') {
    const logPath = `${USER_PREFIX}${REDACTED}`;
    const name = decode(path.slice(USER_PREFIX.length));
    if (name === null || !USER.test(name)) return reject(400, 'invalid user name', logPath);
    return { kind: 'account', action: 'user-login', name, logPath };
  }
  if (path.startsWith(LOGOUT_PREFIX)) {
    const logPath = `${LOGOUT_PREFIX}${REDACTED}`;
    if (!has('logout') || method !== 'DELETE') return null;
    const token = decode(path.slice(LOGOUT_PREFIX.length));
    if (token === null || !OPAQUE.test(token)) return reject(400, 'invalid token', logPath);
    return { kind: 'account', action: 'logout', token, logPath };
  }
  if (path === TOKENS && (has('token-list') || has('token-create'))) {
    if (method === 'GET' && has('token-list')) {
      return { kind: 'account', action: 'token-list', logPath: TOKENS };
    }
    if (method === 'POST' && has('token-create')) {
      return { kind: 'account', action: 'token-create', logPath: TOKENS };
    }
    // The other of list and create is not claimed: it keeps its old answer.
    if (method === 'GET' || method === 'POST') return null;
    return reject(405, 'method not allowed');
  }
  if (path.startsWith(TOKEN_PREFIX) && has('token-delete')) {
    // npm token revoke sends the token itself when it is given one: never log it.
    const logPath = `${TOKEN_PREFIX}${REDACTED}`;
    if (method !== 'DELETE') return reject(405, 'method not allowed', logPath);
    const key = decode(path.slice(TOKEN_PREFIX.length));
    if (key === null || !OPAQUE.test(key)) return reject(400, 'invalid token key', logPath);
    return { kind: 'account', action: 'token-delete', key, logPath };
  }
  return null;
}

/**
 * The log path of an account endpoint whatever answers it (claimed or not): tokens, login
 * sessions and user names (people type passwords into them) are never logged.
 */
export function accountLogPath(path: string): string | undefined {
  for (const prefix of [LOGOUT_PREFIX, USER_PREFIX, TOKEN_PREFIX, `${LOGIN}/`]) {
    if (path.startsWith(prefix)) return `${prefix}${REDACTED}`;
  }
  return undefined;
}

/** IPv4 or IPv6 range with a prefix length that fits the address family. */
function isCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (isIPv4(address)) return bits <= 32;
  return isIPv6(address) && bits <= 128;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonBody(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw bad('request body is not valid JSON');
  }
  if (!isRecord(parsed)) throw bad('request body must be a JSON object');
  return parsed;
}

function otpOf(headers: IncomingHttpHeaders): { otp?: string } {
  const otp = headers['npm-otp'];
  if (otp === undefined) return {};
  if (typeof otp !== 'string' || !OTP.test(otp)) throw bad('invalid npm-otp header');
  return { otp };
}

function optionalText(doc: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = doc[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max || /\p{Cc}/u.test(v)) throw bad(`invalid ${key}`);
  return v;
}

function parseUserLogin(
  route: Extract<AccountRoute, { action: 'user-login' }>,
  body: Buffer,
  headers: IncomingHttpHeaders,
): AccountRequest {
  const doc = jsonBody(body);
  if (doc.name !== route.name) throw bad('name does not match the user in the URL');
  const password = doc.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD) {
    throw bad('password is required');
  }
  return { action: 'user-login', name: route.name, password, ...otpOf(headers) };
}

function parseTokenCreate(body: Buffer, headers: IncomingHttpHeaders): AccountRequest {
  const doc = jsonBody(body);
  for (const key of UNSUPPORTED_TOKEN_OPTIONS) {
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== false) {
      throw bad(`unsupported token option: ${key}`);
    }
  }
  const readonly = doc.readonly ?? false;
  if (typeof readonly !== 'boolean') throw bad('readonly must be a boolean');
  const cidrs = doc.cidr_whitelist ?? [];
  if (
    !Array.isArray(cidrs) ||
    cidrs.length > MAX_CIDRS ||
    !cidrs.every((c): c is string => typeof c === 'string' && c.length <= 64 && isCidr(c))
  ) {
    throw bad('cidr_whitelist must be a list of CIDR ranges');
  }
  const expires = doc.expires;
  if (
    expires !== undefined &&
    expires !== null &&
    (typeof expires !== 'number' || !Number.isInteger(expires) || expires < 1 || expires > 36_500)
  ) {
    throw bad('expires must be a number of days');
  }
  const name = optionalText(doc, 'name', MAX_TEXT);
  const description = optionalText(doc, 'description', MAX_TEXT);
  const password = optionalText(doc, 'password', MAX_PASSWORD);
  return {
    action: 'token-create',
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(password !== undefined ? { password } : {}),
    readonly,
    cidrWhitelist: cidrs,
    ...(typeof expires === 'number' ? { expiresInDays: expires } : {}),
    ...otpOf(headers),
  };
}

function send(status: number, body: unknown, headers?: Record<string, string>): AccountResponse {
  return {
    status,
    body: Buffer.from(JSON.stringify(body)),
    contentType: 'application/json',
    ...(headers ? { headers } : {}),
  };
}

function tokenObject(info: AccountToken, token: string): Record<string, unknown> {
  return {
    token,
    key: info.key,
    ...(info.name !== undefined ? { name: info.name } : {}),
    readonly: info.readonly,
    // npm prints a whitelist whenever the field is truthy, so "none" is null, not [].
    cidr_whitelist: info.cidrWhitelist.length > 0 ? info.cidrWhitelist : null,
    created: info.created,
    updated: info.updated ?? info.created,
  };
}

export const npmAccountProtocol: AccountProtocol = {
  maxBodyBytes: 64 * 1024,

  parse(route, body, headers) {
    switch (route.action) {
      case 'login-start':
      case 'token-list':
        return { action: route.action };
      case 'login-poll':
        return { action: 'login-poll', session: route.session };
      case 'logout':
        return { action: 'logout', token: route.token };
      case 'token-delete':
        return { action: 'token-delete', key: route.key };
      case 'user-login':
        return parseUserLogin(route, body, headers);
      case 'token-create':
        return parseTokenCreate(body, headers);
    }
  },

  render(_route, result: AccountResult) {
    switch (result.action) {
      case 'login-start':
        return send(200, { loginUrl: result.loginUrl, doneUrl: result.doneUrl });
      case 'login-poll':
        return result.status === 'pending'
          ? send(202, {}, { 'retry-after': String(result.retryAfterSeconds) })
          : send(200, { token: result.token });
      case 'user-login':
        return send(201, { ok: true, id: `org.couchdb.user:${result.name}`, token: result.token });
      case 'token-list':
        return send(200, {
          objects: result.tokens.map((t) => tokenObject(t, t.preview)),
          total: result.tokens.length,
          urls: {},
        });
      case 'token-create':
        return send(200, tokenObject(result.info, result.token));
      case 'token-delete':
        return { status: 204, body: Buffer.alloc(0), contentType: 'application/json' };
      case 'logout':
        return send(200, { ok: true });
    }
  },
};
