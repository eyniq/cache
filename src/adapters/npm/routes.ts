// npm registry path grammar (DESIGN.md section 5). Paths are relative to the adapter mount.
import type { AccountAction, AdapterRoute } from '../../core/contracts.ts';
import { accountLogPath, matchAccount } from './account.ts';
import { prefersAbbreviated } from './accept.ts';
import {
  isValidPackageName,
  isValidRev,
  isValidTag,
  isValidTarballFile,
  isValidVersion,
} from './names.ts';

const AUDIT_BODY_LIMIT = 10 * 1024 * 1024;
const READ_ONLY = 'method not allowed: this is a read-only cache';

// Exact paths only: anything else under /-/ is a 404, so pass-through can never be steered
// to another upstream path.
const AUDIT_ENDPOINTS = new Set([
  '/-/npm/v1/security/advisories/bulk',
  '/-/npm/v1/security/audits/quick',
  '/-/npm/v1/security/audits',
]);
const SEARCH_ENDPOINT = '/-/v1/search';
// Printable ASCII only; Node refuses to send anything else upstream anyway.
const SAFE_QUERY = /^[\x21-\x7e]*$/;

const reject = (status: number, message: string, logPath?: string): AdapterRoute => ({
  kind: 'reject',
  status,
  message,
  ...(logPath !== undefined ? { logPath } : {}),
});

const NO_ACCOUNTS: ReadonlySet<AccountAction> = new Set();

/** Decode each path segment once; any malformed escape rejects the whole path. */
function decodeSegments(path: string): string[] | null {
  const segments = path.slice(1).split('/');
  const out: string[] = [];
  for (const s of segments) {
    try {
      out.push(decodeURIComponent(s));
    } catch {
      return null;
    }
  }
  return out;
}

/** Splits `@scope%2fname/rest` or `@scope/name/rest` into the package name and the rest. */
function splitName(segments: string[]): { name: string; rest: string[] } {
  const [first = '', ...more] = segments;
  if (first.startsWith('@') && !first.includes('/')) {
    return { name: `${first}/${more[0] ?? ''}`, rest: more.slice(1) };
  }
  return { name: first, rest: more };
}

/** PUT/DELETE /-/package/:name/dist-tags/:tag (npm dist-tag add/rm). */
function matchDistTag(method: string, path: string): AdapterRoute | null {
  if (!path.startsWith('/-/package/')) return null;
  const segments = decodeSegments(path.slice('/-/package'.length));
  if (!segments) return reject(400, 'invalid path encoding');
  const { name, rest } = splitName(segments);
  if (rest.length === 1 && rest[0] === 'dist-tags' && (method === 'GET' || method === 'HEAD')) {
    // npm dist-tag ls / add read the current tags first.
    if (!isValidPackageName(name)) return reject(400, 'invalid package name');
    return { kind: 'metadata', name, view: 'dist-tags' };
  }
  if (rest.length !== 2 || rest[0] !== 'dist-tags') return null;
  if (method !== 'PUT' && method !== 'DELETE') return null;
  const tag = rest[1] ?? '';
  if (!isValidPackageName(name)) return reject(400, 'invalid package name');
  if (!isValidTag(tag)) return reject(400, 'invalid dist-tag');
  return { kind: 'dist-tag', name, tag, op: method === 'PUT' ? 'set' : 'delete' };
}

/** Write routes on a package path (only when a PackageSource makes the adapter writable). */
function matchWrite(method: string, name: string, rest: string[]): AdapterRoute {
  if (method === 'PUT' && rest.length === 0) return { kind: 'publish', name };
  const rev = rest.at(-1) ?? '';
  const isRev = rest.length >= 2 && rest.at(-2) === '-rev';
  if (isRev && !isValidRev(rev)) return reject(400, 'invalid revision');
  if (method === 'PUT' && isRev && rest.length === 2) return { kind: 'publish', name, rev };
  if (method === 'DELETE' && isRev && rest.length === 2) return { kind: 'unpublish', name, rev };
  if (method === 'DELETE' && isRev && rest.length === 4 && rest[0] === '-') {
    const file = rest[1] ?? '';
    if (!isValidTarballFile(file)) return reject(400, 'invalid tarball file name');
    return { kind: 'unpublish', name, file, rev };
  }
  return reject(405, 'method not allowed');
}

function matchSpecial(
  method: string,
  path: string,
  query: string,
  writable: boolean,
  accounts: ReadonlySet<AccountAction>,
): AdapterRoute {
  const read = method === 'GET' || method === 'HEAD';
  if (accounts.size > 0) {
    const account = matchAccount(method, path, accounts);
    if (account) return account;
  }
  if (writable) {
    const tag = matchDistTag(method, path);
    if (tag) return tag;
  }
  if (path === '/-/ping') return read ? { kind: 'ping' } : reject(405, READ_ONLY);
  if (path === '/-/whoami') return read ? { kind: 'whoami' } : reject(405, READ_ONLY);
  if (path === '/-/user' || path.startsWith('/-/user/')) {
    return reject(405, READ_ONLY, accountLogPath(path));
  }
  if (AUDIT_ENDPOINTS.has(path)) {
    if (method !== 'POST') return reject(405, 'method not allowed');
    return { kind: 'passthrough', upstreamPath: path, maxBodyBytes: AUDIT_BODY_LIMIT };
  }
  if (path === SEARCH_ENDPOINT) {
    if (!read) return reject(405, READ_ONLY);
    if (!SAFE_QUERY.test(query)) return reject(400, 'invalid query string');
    return { kind: 'passthrough', upstreamPath: `${path}${query}`, maxBodyBytes: 0, search: true };
  }
  return reject(404, 'not found', accountLogPath(path));
}

export function matchNpmPath(
  method: string,
  rawPath: string,
  accept = '',
  writable = false,
  accounts: ReadonlySet<AccountAction> = NO_ACCOUNTS,
): AdapterRoute {
  const q = rawPath.indexOf('?');
  const path = q === -1 ? rawPath : rawPath.slice(0, q);
  const query = q === -1 ? '' : rawPath.slice(q);
  if (!path.startsWith('/')) return reject(400, 'invalid path');
  if (path === '/') return reject(404, 'not found');
  if (path.startsWith('/-/')) return matchSpecial(method, path, query, writable, accounts);
  const read = method === 'GET' || method === 'HEAD';
  // Without a package source the cache is read-only: exactly the answer it always gave.
  if (!read && !(writable && (method === 'PUT' || method === 'DELETE'))) {
    return reject(405, READ_ONLY);
  }

  const segments = decodeSegments(path);
  if (!segments) return reject(400, 'invalid path encoding');

  // Scoped names arrive as `@scope%2fname` (one segment) or `@scope/name` (two segments).
  const { name, rest } = splitName(segments);
  if (!isValidPackageName(name)) return reject(400, 'invalid package name');
  if (!read) return matchWrite(method, name, rest);

  if (rest.length === 0) {
    return { kind: 'metadata', name, view: prefersAbbreviated(accept) ? 'abbreviated' : 'full' };
  }
  if (rest.length === 1) {
    const ref = rest[0] ?? '';
    if (!isValidVersion(ref) && !isValidTag(ref)) return reject(400, 'invalid version');
    return { kind: 'metadata', name, view: 'version', ref };
  }
  if (rest.length === 2 && rest[0] === '-') {
    const file = rest[1] ?? '';
    if (!isValidTarballFile(file)) return reject(400, 'invalid tarball file name');
    return { kind: 'artifact', name, file };
  }
  return reject(404, 'not found');
}
