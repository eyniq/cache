// npm account endpoints (login, logout, tokens) as AccountRoutes, only for the actions an
// AccountProvider supports; everything else keeps the answers it always had.
import { describe, expect, it } from 'vitest';
import { npmAccountProtocol } from '../../src/adapters/npm/account.ts';
import { matchNpmPath } from '../../src/adapters/npm/routes.ts';
import type { AccountAction, AccountRoute } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';

const ALL: ReadonlySet<AccountAction> = new Set([
  'login-start',
  'login-poll',
  'user-login',
  'token-list',
  'token-create',
  'token-delete',
  'logout',
]);
const match = (method: string, path: string, actions: ReadonlySet<AccountAction> = ALL) =>
  matchNpmPath(method, path, '', false, actions);

const CASES: Array<[string, string]> = [
  ['POST', '/-/v1/login'],
  ['GET', '/-/v1/login/done/abc.def'],
  ['PUT', '/-/user/org.couchdb.user:alice'],
  ['DELETE', '/-/user/token/npm_secret'],
  ['GET', '/-/npm/v1/tokens'],
  ['POST', '/-/npm/v1/tokens'],
  ['DELETE', '/-/npm/v1/tokens/token/abc123'],
];

describe('npm account routes', () => {
  it.each(CASES)('keeps the old answer for %s %s without account actions', (method, path) => {
    const before = matchNpmPath(method, path, '', false);
    expect(match(method, path, new Set())).toEqual(before);
    expect(before.kind).toBe('reject');
  });

  it('maps every npm account endpoint to its action', () => {
    expect(CASES.map(([m, p]) => match(m, p))).toEqual([
      { kind: 'account', action: 'login-start', logPath: '/-/v1/login' },
      {
        kind: 'account',
        action: 'login-poll',
        session: 'done/abc.def',
        logPath: '/-/v1/login/[redacted]',
      },
      {
        kind: 'account',
        action: 'user-login',
        name: 'alice',
        // Never the name: people type passwords into the user field.
        logPath: '/-/user/org.couchdb.user:[redacted]',
      },
      {
        kind: 'account',
        action: 'logout',
        token: 'npm_secret',
        logPath: '/-/user/token/[redacted]',
      },
      { kind: 'account', action: 'token-list', logPath: '/-/npm/v1/tokens' },
      { kind: 'account', action: 'token-create', logPath: '/-/npm/v1/tokens' },
      {
        kind: 'account',
        action: 'token-delete',
        key: 'abc123',
        // npm token revoke sends the token itself when it is given one.
        logPath: '/-/npm/v1/tokens/token/[redacted]',
      },
    ]);
  });

  it('only claims the actions it was given', () => {
    const webOnly = new Set<AccountAction>(['login-start', 'login-poll']);
    expect(match('POST', '/-/v1/login', webOnly)).toMatchObject({ action: 'login-start' });
    expect(match('DELETE', '/-/user/token/x', webOnly)).toEqual(
      matchNpmPath('DELETE', '/-/user/token/x'),
    );
  });

  it('decodes names and tokens and refuses unusable ones with 400', () => {
    expect(match('PUT', '/-/user/org.couchdb.user:a%40example.com')).toMatchObject({
      name: 'a@example.com',
    });
    expect(match('DELETE', '/-/user/token/a%2Bb%3D')).toMatchObject({ token: 'a+b=' });
    for (const [method, path] of [
      ['PUT', '/-/user/org.couchdb.user:'],
      ['PUT', '/-/user/org.couchdb.user:a%0Ab'],
      ['DELETE', '/-/user/token/'],
      ['DELETE', '/-/user/token/a%20b'],
      ['DELETE', '/-/user/token/%E0%A4%A'],
      ['GET', '/-/v1/login/a%2F..%2Fb'],
      ['DELETE', '/-/npm/v1/tokens/token/'],
    ] as const) {
      expect(match(method, path), `${method} ${path}`).toMatchObject({
        kind: 'reject',
        status: 400,
      });
    }
  });

  it('refuses other methods on claimed paths without touching unrelated ones', () => {
    expect(match('GET', '/-/v1/login')).toMatchObject({ kind: 'reject', status: 405 });
    expect(match('PUT', '/-/npm/v1/tokens')).toMatchObject({ kind: 'reject', status: 405 });
    expect(match('GET', '/-/user/org.couchdb.user:alice')).toEqual(
      matchNpmPath('GET', '/-/user/org.couchdb.user:alice'),
    );
    expect(match('GET', '/-/whoami')).toEqual({ kind: 'whoami' });
  });

  it('keeps the old answer for an unclaimed token method', () => {
    const listOnly = new Set<AccountAction>(['token-list']);
    expect(match('POST', '/-/npm/v1/tokens', listOnly)).toEqual(
      matchNpmPath('POST', '/-/npm/v1/tokens'),
    );
    expect(match('GET', '/-/npm/v1/tokens', listOnly)).toMatchObject({ action: 'token-list' });
  });

  it('never logs a logout token, even without account actions', () => {
    expect(matchNpmPath('DELETE', '/-/user/token/npm_secret')).toMatchObject({
      kind: 'reject',
      status: 405,
      logPath: '/-/user/token/[redacted]',
    });
  });
});

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  return 0;
}

const route = (action: AccountRoute['action'], extra: Record<string, string> = {}): AccountRoute =>
  ({ kind: 'account', action, logPath: '/', ...extra }) as AccountRoute;

describe('npm account protocol', () => {
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));

  it('parses a couch login and its one-time password', () => {
    const r = route('user-login', { name: 'alice' });
    const req = npmAccountProtocol.parse(
      r,
      body({ _id: 'org.couchdb.user:alice', name: 'alice', password: 'pw', type: 'user' }),
      { 'npm-otp': '123456' },
    );
    expect(req).toEqual({ action: 'user-login', name: 'alice', password: 'pw', otp: '123456' });
    expect(
      status(() => npmAccountProtocol.parse(r, body({ name: 'bob', password: 'x' }), {})),
    ).toBe(400);
    expect(status(() => npmAccountProtocol.parse(r, body({ name: 'alice' }), {}))).toBe(400);
    expect(status(() => npmAccountProtocol.parse(r, Buffer.from('nope'), {}))).toBe(400);
  });

  it('parses token creation and refuses restrictions it cannot honour', () => {
    const r = route('token-create');
    expect(
      npmAccountProtocol.parse(
        r,
        body({ name: 'ci', password: 'pw', expires: 30, cidr_whitelist: ['10.0.0.0/8'] }),
        {},
      ),
    ).toEqual({
      action: 'token-create',
      name: 'ci',
      password: 'pw',
      readonly: false,
      cidrWhitelist: ['10.0.0.0/8'],
      expiresInDays: 30,
    });
    expect(npmAccountProtocol.parse(r, body({ readonly: true }), {})).toEqual({
      action: 'token-create',
      readonly: true,
      cidrWhitelist: [],
    });
    for (const bad of [
      { packages: ['@acme/lib'] },
      { scopes: ['@acme'] },
      { orgs: ['acme'] },
      { packages_and_scopes_permission: 'read-only' },
      { cidr_whitelist: ['not a cidr'] },
      { cidr_whitelist: ['999.1.1.1/8'] },
      { cidr_whitelist: ['10.0.0.0/33'] },
      { cidr_whitelist: ['::/999'] },
      { expires: -1 },
      { readonly: 'yes' },
    ]) {
      expect(
        status(() => npmAccountProtocol.parse(r, body(bad), {})),
        JSON.stringify(bad),
      ).toBe(400);
    }
  });

  it('carries path parameters into the request', () => {
    expect(npmAccountProtocol.parse(route('logout', { token: 't' }), Buffer.alloc(0), {})).toEqual({
      action: 'logout',
      token: 't',
    });
    expect(
      npmAccountProtocol.parse(route('login-poll', { session: 's' }), Buffer.alloc(0), {}),
    ).toEqual({ action: 'login-poll', session: 's' });
    expect(
      npmAccountProtocol.parse(route('token-delete', { key: 'k' }), Buffer.alloc(0), {}),
    ).toEqual({ action: 'token-delete', key: 'k' });
  });

  it('renders npm wire formats', () => {
    const render = (r: Parameters<typeof npmAccountProtocol.render>[0], result: never) => {
      const out = npmAccountProtocol.render(r, result);
      return {
        status: out.status,
        headers: out.headers ?? {},
        body: out.body.length ? (JSON.parse(out.body.toString()) as unknown) : null,
      };
    };
    expect(
      render(route('login-start'), {
        action: 'login-start',
        loginUrl: 'https://c/l',
        doneUrl: 'https://c/d',
      } as never),
    ).toEqual({
      status: 200,
      headers: {},
      body: { loginUrl: 'https://c/l', doneUrl: 'https://c/d' },
    });
    expect(
      render(route('login-poll'), {
        action: 'login-poll',
        status: 'pending',
        retryAfterSeconds: 2,
      } as never),
    ).toEqual({ status: 202, headers: { 'retry-after': '2' }, body: {} });
    expect(
      render(route('login-poll'), { action: 'login-poll', status: 'done', token: 't' } as never),
    ).toEqual({ status: 200, headers: {}, body: { token: 't' } });
    expect(
      render(route('user-login'), { action: 'user-login', name: 'alice', token: 't' } as never),
    ).toEqual({
      status: 201,
      headers: {},
      body: { ok: true, id: 'org.couchdb.user:alice', token: 't' },
    });
    const info = {
      key: 'k1',
      preview: 'abc123',
      name: 'ci',
      readonly: true,
      cidrWhitelist: [],
      created: '2026-01-01T00:00:00.000Z',
    };
    expect(render(route('token-list'), { action: 'token-list', tokens: [info] } as never)).toEqual({
      status: 200,
      headers: {},
      body: {
        objects: [
          {
            token: 'abc123',
            key: 'k1',
            name: 'ci',
            readonly: true,
            cidr_whitelist: null,
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
          },
        ],
        total: 1,
        urls: {},
      },
    });
    expect(
      render(route('token-create'), {
        action: 'token-create',
        token: 'secret',
        info: { ...info, cidrWhitelist: ['10.0.0.0/8'] },
      } as never),
    ).toMatchObject({
      status: 200,
      body: { token: 'secret', key: 'k1', cidr_whitelist: ['10.0.0.0/8'] },
    });
    expect(render(route('token-delete'), { action: 'token-delete' } as never)).toEqual({
      status: 204,
      headers: {},
      body: null,
    });
    expect(render(route('logout'), { action: 'logout' } as never)).toEqual({
      status: 200,
      headers: {},
      body: { ok: true },
    });
  });
});
