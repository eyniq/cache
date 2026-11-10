// Account endpoints (npm login, logout, tokens) dispatched to an optional AccountProvider.
// Without one (or for actions it does not implement) every answer stays what it was.
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AccountContext,
  AccountProvider,
  AccountToken,
  AuthProvider,
  Authorizer,
  Identity,
} from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';
import { captureLogs } from '../../src/core/log.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';
import { startServer, type StartServerOptions, type TestServer } from '../helpers/server.ts';

const TOKEN = 'npm_valid-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** Requires auth: an open account route must not depend on it. */
const tokenAuth: AuthProvider = {
  required: true,
  authenticate: (req: IncomingMessage): Promise<Identity | null> =>
    Promise.resolve(req.headers.authorization === `Bearer ${TOKEN}` ? { name: 'alice' } : null),
};

interface Call {
  method: string;
  args: unknown[];
  ctx: AccountContext;
}

class FakeAccounts implements AccountProvider {
  readonly calls: Call[] = [];
  polls = 0;
  readonly tokens: AccountToken[] = [
    {
      key: 'key-1',
      preview: 'npm_va',
      name: 'laptop',
      readonly: false,
      cidrWhitelist: [],
      created: '2026-01-01T00:00:00.000Z',
    },
  ];

  private record(method: string, ctx: AccountContext, ...args: unknown[]): void {
    this.calls.push({ method, args, ctx });
  }

  startWebLogin(ctx: AccountContext) {
    this.record('startWebLogin', ctx);
    return Promise.resolve({
      loginUrl: `${ctx.registryUrl}/-/eyniq/sso/login?id=1`,
      doneUrl: `${ctx.registryUrl}/-/v1/login/done/1.secret`,
    });
  }

  pollWebLogin(session: string, ctx: AccountContext) {
    this.record('pollWebLogin', ctx, session);
    this.polls++;
    return Promise.resolve(
      this.polls < 2
        ? ({ status: 'pending', retryAfterSeconds: 1 } as const)
        : ({ status: 'done', token: TOKEN, name: 'alice' } as const),
    );
  }

  login(credentials: { name: string; password: string; otp?: string }, ctx: AccountContext) {
    this.record('login', ctx, credentials);
    return Promise.resolve(
      credentials.name === 'alice' && credentials.password === 'right'
        ? { name: 'alice', token: TOKEN }
        : null,
    );
  }

  listTokens(identity: Identity, ctx: AccountContext) {
    this.record('listTokens', ctx, identity);
    return Promise.resolve(this.tokens);
  }

  createToken(identity: Identity, request: unknown, ctx: AccountContext) {
    this.record('createToken', ctx, identity, request);
    return Promise.resolve({ token: 'npm_new', info: { ...this.tokens[0]!, key: 'key-2' } });
  }

  deleteToken(identity: Identity, key: string, ctx: AccountContext) {
    this.record('deleteToken', ctx, identity, key);
    return Promise.resolve(key === 'key-1');
  }

  logout(token: string, ctx: AccountContext) {
    this.record('logout', ctx, token);
    return Promise.resolve();
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(opts: StartServerOptions['deps'] = {}): Promise<TestServer> {
  server = await startServer({ deps: opts });
  return server;
}

function call(
  s: TestServer,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return send(s.url, {
    method,
    path,
    headers: { 'content-type': 'application/json', ...opts.headers },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const READ_ONLY = { error: 'method not allowed: this is a read-only cache' };
const NOT_FOUND = { error: 'not found' };
const UNCHANGED: Array<[string, string, number, unknown]> = [
  ['POST', '/-/v1/login', 404, NOT_FOUND],
  ['GET', '/-/v1/login/done/1.secret', 404, NOT_FOUND],
  ['PUT', '/-/user/org.couchdb.user:alice', 405, READ_ONLY],
  ['DELETE', '/-/user/token/npm_valid-token', 405, READ_ONLY],
  ['GET', '/-/npm/v1/tokens', 404, NOT_FOUND],
  ['POST', '/-/npm/v1/tokens', 404, NOT_FOUND],
  ['DELETE', '/-/npm/v1/tokens/token/key-1', 404, NOT_FOUND],
  ['POST', '/npm/-/v1/login', 405, READ_ONLY],
];

describe('account routes without a provider', () => {
  it.each([
    ['no provider', undefined],
    ['a provider without methods', {}],
  ])('answers exactly as before with %s', async (_label, accounts) => {
    const s = await start(accounts ? { accounts } : {});
    for (const [method, path, status, body] of UNCHANGED) {
      const withBody = method === 'POST' || method === 'PUT';
      const res = await call(s, method, path, withBody ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(status);
      expect(json(res), `${method} ${path}`).toEqual(body);
      expect(res.headers['content-type']).toBe('application/json');
    }
  });

  it('keeps a logout token out of the request log', async () => {
    const s = await start();
    const logs = captureLogs();
    try {
      await call(s, 'DELETE', '/-/user/token/npm_secret-value');
      // Mounted spelling: answered by the root reading (package "npm"), still redacted.
      await call(s, 'DELETE', '/npm/-/user/token/npm_secret-value');
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logs.restore();
    }
    expect(JSON.stringify(logs.lines)).not.toContain('npm_secret-value');
    expect(logs.lines.some((l) => l.path === '/-/user/token/[redacted]')).toBe(true);
    expect(logs.lines.some((l) => l.path === '/npm/-/user/token/[redacted]')).toBe(true);
  });
});

describe('account routes with a provider', () => {
  it('runs npm web login without credentials, even when auth is required', async () => {
    const accounts = new FakeAccounts();
    const s = await start({ accounts, auth: tokenAuth });
    const started = await call(s, 'POST', '/-/v1/login', { body: {} });
    expect(started.status).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const { doneUrl } = json(started) as { doneUrl: string };
    expect(doneUrl).toBe(`${s.url}/-/v1/login/done/1.secret`);
    const pending = await call(s, 'GET', new URL(doneUrl).pathname);
    expect(pending.status).toBe(202);
    expect(pending.headers['retry-after']).toBe('1');
    const done = await call(s, 'GET', new URL(doneUrl).pathname);
    expect(done.status).toBe(200);
    expect(json(done)).toEqual({ token: TOKEN });
    expect(accounts.calls.map((c) => [c.method, ...c.args])).toEqual([
      ['startWebLogin'],
      ['pollWebLogin', 'done/1.secret'],
      ['pollWebLogin', 'done/1.secret'],
    ]);
    expect(accounts.calls[0]?.ctx).toMatchObject({ ecosystem: 'npm', registryUrl: s.url });
    expect(s.audit.ofType('auth.login')).toEqual([
      expect.objectContaining({ method: 'web', identity: 'alice' }),
    ]);
  });

  it('tells the provider which mount the client used', async () => {
    const accounts = new FakeAccounts();
    const s = await start({ accounts });
    const res = await call(s, 'POST', '/npm/-/v1/login', { body: {} });
    expect(json(res)).toMatchObject({ doneUrl: `${s.url}/npm/-/v1/login/done/1.secret` });
  });

  it('logs in with a password, answering the same 401 for unknown users and bad passwords', async () => {
    const accounts = new FakeAccounts();
    const s = await start({ accounts, auth: tokenAuth });
    const login = (name: string, password: string) =>
      call(s, 'PUT', `/-/user/org.couchdb.user:${name}`, {
        body: { _id: `org.couchdb.user:${name}`, name, password, type: 'user', roles: [] },
        headers: { 'npm-otp': '123456' },
      });
    const ok = await login('alice', 'right');
    expect(ok.status).toBe(201);
    expect(json(ok)).toEqual({ ok: true, id: 'org.couchdb.user:alice', token: TOKEN });
    expect(accounts.calls[0]?.args[0]).toEqual({
      action: 'user-login',
      name: 'alice',
      password: 'right',
      otp: '123456',
    });
    const wrong = await login('alice', 'wrong');
    const unknown = await login('nobody', 'right');
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.equals(unknown.body)).toBe(true);
    expect(wrong.headers['www-authenticate']).toBeUndefined();
    expect(s.audit.ofType('auth.login')).toEqual([
      expect.objectContaining({ method: 'password', identity: 'alice' }),
    ]);
    const denied = s.audit.ofType('auth.denied');
    expect(denied).toHaveLength(2);
    // Never the attempted name: people type passwords into the user field.
    expect(JSON.stringify(denied)).not.toContain('nobody');
    expect(
      (
        await call(s, 'PUT', '/-/user/org.couchdb.user:alice', {
          body: { name: 'bob', password: 'x' },
        })
      ).status,
    ).toBe(400);
  });

  it('requires an identity for token management and scopes calls to it', async () => {
    const accounts = new FakeAccounts();
    // DefaultAuthorizer refuses `account` like publish: a build with accounts brings its own.
    const selfService: Authorizer = {
      authorize: (identity, action) =>
        Promise.resolve(action === 'read' || (action === 'account' && identity !== null)),
    };
    const s = await start({
      accounts,
      auth: { ...tokenAuth, required: false },
      authorizer: selfService,
    });
    for (const [method, path] of [
      ['GET', '/-/npm/v1/tokens'],
      ['POST', '/-/npm/v1/tokens'],
      ['DELETE', '/-/npm/v1/tokens/token/key-1'],
    ] as const) {
      const res = await call(s, method, path, method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(accounts.calls).toEqual([]);

    const list = await call(s, 'GET', '/-/npm/v1/tokens', { headers: AUTH });
    expect(list.status).toBe(200);
    expect(json(list)).toMatchObject({ total: 1, urls: {}, objects: [{ key: 'key-1' }] });
    const created = await call(s, 'POST', '/-/npm/v1/tokens', {
      headers: AUTH,
      body: { password: 'pw', name: 'ci' },
    });
    expect(created.status).toBe(200);
    expect(json(created)).toMatchObject({ token: 'npm_new', key: 'key-2' });
    expect(created.headers['cache-control']).toBe('no-store');
    expect(
      (await call(s, 'DELETE', '/-/npm/v1/tokens/token/key-1', { headers: AUTH })).status,
    ).toBe(204);
    expect((await call(s, 'DELETE', '/-/npm/v1/tokens/token/nope', { headers: AUTH })).status).toBe(
      404,
    );
    expect(accounts.calls.map((c) => [c.method, (c.args[0] as Identity).name])).toEqual([
      ['listTokens', 'alice'],
      ['createToken', 'alice'],
      ['deleteToken', 'alice'],
      ['deleteToken', 'alice'],
    ]);
    const createdEvents = s.audit.ofType('auth.token.created');
    expect(createdEvents).toEqual([
      expect.objectContaining({ identity: 'alice', readonly: false }),
    ]);
    // Neither the key nor the token: npm token revoke may send the token as the key.
    expect(JSON.stringify(createdEvents)).not.toMatch(/key-2|npm_new/);
    expect(s.audit.ofType('auth.token.deleted')).toHaveLength(1);
  });

  it('refuses token management with the DefaultAuthorizer (fail closed)', async () => {
    const accounts = new FakeAccounts();
    const s = await start({ accounts, auth: tokenAuth });
    expect((await call(s, 'GET', '/-/npm/v1/tokens', { headers: AUTH })).status).toBe(403);
    expect(accounts.calls).toEqual([]);
  });

  it('asks the authorizer for the "account" action on token management', async () => {
    const accounts = new FakeAccounts();
    const seen: unknown[] = [];
    const authorizer: Authorizer = {
      authorize: (_identity, action, resource) => {
        seen.push([action, resource]);
        return Promise.resolve(action === 'read');
      },
    };
    const s = await start({ accounts, auth: tokenAuth, authorizer });
    const res = await call(s, 'POST', '/-/npm/v1/tokens', { headers: AUTH, body: {} });
    expect(res.status).toBe(403);
    expect(seen).toEqual([
      ['account', { ecosystem: 'npm', route: 'account', account: 'token-create' }],
    ]);
    expect(accounts.calls).toEqual([]);
    // Login and logout never consult the authorizer: they work before there is an identity.
    expect((await call(s, 'POST', '/-/v1/login', { body: {} })).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('logs out by the token in the path, without credentials and without logging it', async () => {
    const accounts = new FakeAccounts();
    const s = await start({ accounts, auth: tokenAuth });
    const logs = captureLogs();
    let res: RawResponse;
    try {
      res = await call(s, 'DELETE', '/-/user/token/npm_secret-value');
      await call(s, 'GET', '/-/v1/login/done/1.secret');
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logs.restore();
    }
    expect(res.status).toBe(200);
    expect(accounts.calls.find((c) => c.method === 'logout')?.args).toEqual(['npm_secret-value']);
    const text = JSON.stringify(logs.lines);
    expect(text).not.toContain('npm_secret-value');
    expect(text).not.toContain('1.secret');
    expect(s.audit.ofType('auth.logout')).toHaveLength(1);
  });

  it('keeps old answers for actions the provider does not implement', async () => {
    const s = await start({
      accounts: { startWebLogin: () => Promise.resolve({ loginUrl: 'x', doneUrl: 'y' }) },
    });
    const res = await call(s, 'DELETE', '/-/user/token/abc');
    expect(res.status).toBe(405);
    expect(json(res)).toEqual(READ_ONLY);
  });

  it('answers every password-login failure with the same 401, except an OTP challenge', async () => {
    const failures: Array<() => Promise<never>> = [
      () => Promise.reject(new Error('directory at 10.0.0.5 down')),
      () => Promise.reject(new HttpError(404, 'no such user')),
    ];
    const bodies: string[] = [];
    for (const fail of failures) {
      const s = await start({ accounts: { login: fail } });
      const res = await call(s, 'PUT', '/-/user/org.couchdb.user:alice', {
        body: { name: 'alice', password: 'x' },
      });
      expect(res.status).toBe(401);
      bodies.push(res.body.toString());
      await s.close();
      server = null;
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain('10.0.0.5');
    const otp = await start({
      accounts: {
        login: () =>
          Promise.reject(
            new HttpError(
              401,
              'otp required',
              { error: 'otp required' },
              { 'www-authenticate': 'OTP' },
            ),
          ),
      },
    });
    const challenged = await call(otp, 'PUT', '/-/user/org.couchdb.user:alice', {
      body: { name: 'alice', password: 'x' },
    });
    expect(challenged.headers['www-authenticate']).toBe('OTP');
    await otp.close();
    server = null;
    // An overloaded provider (full password-hash queue) says so: 503, not a wrong password.
    const busy = await start({
      accounts: {
        login: () =>
          Promise.reject(new HttpError(503, 'busy', { error: 'busy' }, { 'retry-after': '1' })),
      },
    });
    const refused = await call(busy, 'PUT', '/-/user/org.couchdb.user:alice', {
      body: { name: 'alice', password: 'x' },
    });
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');
  });

  it('turns provider failures into a generic 500 and refuses oversized bodies', async () => {
    const s = await start({
      accounts: {
        logout: () => Promise.reject(new Error('directory at 10.0.0.5 down')),
        login: () => Promise.resolve(null),
      },
    });
    const res = await call(s, 'DELETE', '/-/user/token/abc');
    expect(res.status).toBe(500);
    expect(res.body.toString()).not.toContain('10.0.0.5');
    const big = await call(s, 'PUT', '/-/user/org.couchdb.user:alice', {
      body: { name: 'alice', password: 'x'.repeat(100_000) },
    });
    expect(big.status).toBe(413);
  });

  it('answers 503 when the provider hangs', async () => {
    server = await startServer({
      deps: { accounts: { logout: () => new Promise<never>(() => undefined) } },
      options: { accountTimeoutMs: 50 },
    });
    expect((await call(server, 'DELETE', '/-/user/token/abc')).status).toBe(503);
  });

  it('refuses unprintable or malformed provider values', async () => {
    const tokens = {
      listTokens: () =>
        Promise.resolve([
          {
            key: 'k',
            preview: 'x\u001b]0;pwned\u0007',
            readonly: false,
            cidrWhitelist: [],
            created: '2026-01-01',
          },
        ]),
    };
    const allow: Authorizer = { authorize: () => Promise.resolve(true) };
    const s = await start({ accounts: tokens, auth: tokenAuth, authorizer: allow });
    expect((await call(s, 'GET', '/-/npm/v1/tokens', { headers: AUTH })).status).toBe(500);
    await s.close();
    server = null;
    const login = await start({
      accounts: { login: () => Promise.resolve({ name: 'evil\u202e', token: 't' }) },
    });
    const res = await call(login, 'PUT', '/-/user/org.couchdb.user:alice', {
      body: { name: 'alice', password: 'x' },
    });
    expect(res.status).toBe(500);
  });

  it('keeps a token key and a user name out of the log when nothing claims them', async () => {
    const s = await start({
      accounts: { startWebLogin: () => Promise.resolve({ loginUrl: 'x', doneUrl: 'y' }) },
    });
    const logs = captureLogs();
    try {
      await call(s, 'DELETE', '/-/npm/v1/tokens/token/npm_secret-key');
      await call(s, 'GET', '/-/user/org.couchdb.user:hunter2');
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logs.restore();
    }
    const text = JSON.stringify(logs.lines);
    expect(text).not.toContain('npm_secret-key');
    expect(text).not.toContain('hunter2');
  });

  it('keeps the old answer for the token method the provider does not implement', async () => {
    const allow: Authorizer = { authorize: () => Promise.resolve(true) };
    const s = await start({
      accounts: { listTokens: () => Promise.resolve([]) },
      auth: tokenAuth,
      authorizer: allow,
    });
    const res = await call(s, 'POST', '/-/npm/v1/tokens', { headers: AUTH, body: {} });
    expect(res.status).toBe(404);
    expect(json(res)).toEqual(NOT_FOUND);
  });

  it('refuses provider answers that are not usable URLs', async () => {
    const s = await start({
      accounts: {
        startWebLogin: () =>
          Promise.resolve({ loginUrl: 'javascript:alert(1)', doneUrl: 'https://ok.example/d' }),
      },
    });
    expect((await call(s, 'POST', '/-/v1/login', { body: {} })).status).toBe(500);
    await s.close();
    server = null;
    // The token comes back from doneUrl: it must stay on the registry's origin.
    for (const doneUrl of [
      'https://elsewhere.example/-/v1/login/x',
      'URL/-/v1/login/x'.replace('URL', 'http://u:p@127.0.0.1:1'),
    ]) {
      const t = await start({
        accounts: {
          startWebLogin: (ctx) => Promise.resolve({ loginUrl: `${ctx.registryUrl}/l`, doneUrl }),
        },
      });
      expect((await call(t, 'POST', '/-/v1/login', { body: {} })).status, doneUrl).toBe(500);
      await t.close();
      server = null;
    }
  });
});
