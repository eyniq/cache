// C3: the community user store end to end (composeCommunity with USERS_FILE): npm password
// login, tokens kept as sha256 in storage, logout, token management, brute-force limits,
// optional self-registration, static tokens side by side.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.ts';
import { parseUsers } from '../../src/auth/users.ts';
import { captureLogs, setLogLevel } from '../../src/core/log.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';
import { startCache, storedFiles, type TestCache } from '../helpers/cache.ts';

const FAST = { ln: 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
const STATIC = 'static-ci-token';
let dir: string;
let hash: string;
const caches: TestCache[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-users-it-'));
  hash = await hashPassword(PASSWORD, FAST);
});

afterEach(async () => {
  while (caches.length > 0) await caches.pop()?.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function start(env: Record<string, string> = {}, names = ['alice', 'bob']) {
  const t = '2026-10-01T00:00:00.000Z';
  const usersFile = join(dir, `users-${++counter}.json`);
  const users = Object.fromEntries(
    names.map((n) => [n, { password: hash, created: t, changed: t }]),
  );
  await writeFile(usersFile, JSON.stringify({ version: 1, users }));
  const tokensFile = join(dir, `tokens-${counter}.json`);
  await writeFile(
    tokensFile,
    JSON.stringify({ ci: createHash('sha256').update(STATIC).digest('hex') }),
  );
  const cache = await startCache({ USERS_FILE: usersFile, AUTH_TOKENS_PATH: tokensFile, ...env });
  caches.push(cache);
  cache.upstream.addPackage('left-pad', [{ version: '1.0.0' }]);
  return { cache, usersFile };
}

function login(cache: TestCache, name: string, password: string): Promise<RawResponse> {
  return send(cache.url, {
    method: 'PUT',
    path: `/-/user/org.couchdb.user:${encodeURIComponent(name)}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _id: `org.couchdb.user:${name}`, name, password, type: 'user' }),
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenOf(cache: TestCache, name = 'alice'): Promise<string> {
  const r = await login(cache, name, PASSWORD);
  expect(r.status, r.body.toString()).toBe(201);
  return json(r).token as string;
}

describe('C3: users and npm login', () => {
  it('logs in with a password and hands out a token that authenticates', async () => {
    const { cache } = await start();
    const r = await login(cache, 'alice', PASSWORD);
    expect(r.status).toBe(201);
    const body = json(r);
    expect(body).toMatchObject({ ok: true, id: 'org.couchdb.user:alice' });
    const token = body.token as string;
    expect(token).toMatch(/^eyc_[A-Za-z0-9_-]{43}$/);

    const who = await send(cache.url, { path: '/-/whoami', headers: bearer(token) });
    expect(json(who)).toEqual({ username: 'alice' });
    expect((await send(cache.url, { path: '/left-pad' })).status).toBe(401);
    expect((await send(cache.url, { path: '/left-pad', headers: bearer(token) })).status).toBe(200);
    // Static tokens keep working next to user tokens.
    const ci = await send(cache.url, { path: '/-/whoami', headers: bearer(STATIC) });
    expect(json(ci)).toEqual({ username: 'ci' });

    // Only the sha256 of the token is stored.
    for (const f of await storedFiles(cache)) {
      expect(f.path).not.toContain(token);
      expect(f.body.includes(token), f.path).toBe(false);
    }
  });

  it('answers a wrong password and an unknown user identically', async () => {
    const { cache } = await start();
    const wrong = await login(cache, 'alice', 'not the password');
    const unknown = await login(cache, 'mallory', PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.toString()).toBe(unknown.body.toString());
    expect(wrong.headers['www-authenticate']).toBe(unknown.headers['www-authenticate']);
  });

  it('throttles repeated failures per user without locking out others', async () => {
    const { cache } = await start();
    for (let i = 0; i < 6; i++) expect((await login(cache, 'alice', 'nope nope')).status).toBe(401);
    // The right password is refused while alice is backed off, with the same answer.
    const throttled = await login(cache, 'alice', PASSWORD);
    expect(throttled.status).toBe(401);
    expect(json(throttled)).toEqual(json(await login(cache, 'mallory', 'x')));
    expect((await login(cache, 'bob', PASSWORD)).status).toBe(201);
  });

  it('logout revokes the token', async () => {
    const { cache } = await start();
    const token = await tokenOf(cache);
    const out = await send(cache.url, {
      method: 'DELETE',
      path: `/-/user/token/${encodeURIComponent(token)}`,
    });
    expect(out.status).toBe(200);
    expect((await send(cache.url, { path: '/-/whoami', headers: bearer(token) })).status).toBe(401);
  });

  it('refuses a logout storm of made-up tokens with 429 and Retry-After, not a false 200', async () => {
    const { cache } = await start();
    const made = () =>
      `eyc_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    let out: RawResponse | undefined;
    // The per-client budget is 60 lookups of unknown tokens (refilling 2/s).
    for (let i = 0; i < 100; i++) {
      out = await send(cache.url, { method: 'DELETE', path: `/-/user/token/${made()}` });
      if (out.status !== 200) break;
    }
    expect(out?.status).toBe(429);
    expect(out?.headers['retry-after']).toBe('1');
    expect(json(out!)).toEqual({ error: 'logout is rate limited, retry later' });
  });

  it('lists, creates and revokes tokens (npm token)', async () => {
    const { cache } = await start();
    const token = await tokenOf(cache);
    const created = await send(cache.url, {
      method: 'POST',
      path: '/-/npm/v1/tokens',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, readonly: true, cidr_whitelist: [] }),
    });
    expect(created.status, created.body.toString()).toBe(200);
    const readonlyToken = json(created).token as string;
    expect(json(created).readonly).toBe(true);

    const list = await send(cache.url, { path: '/-/npm/v1/tokens', headers: bearer(token) });
    const objects = json(list).objects as Array<{ key: string; token: string; readonly: boolean }>;
    expect(objects).toHaveLength(2);
    for (const o of objects) {
      expect(o.token).not.toBe(token);
      expect(o.token).not.toBe(readonlyToken);
    }

    // A read-only token cannot mint a publishing token.
    const escalate = await send(cache.url, {
      method: 'POST',
      path: '/-/npm/v1/tokens',
      headers: { ...bearer(readonlyToken), 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, readonly: false, cidr_whitelist: [] }),
    });
    expect(escalate.status).toBe(403);

    // A wrong password is refused.
    const wrong = await send(cache.url, {
      method: 'POST',
      path: '/-/npm/v1/tokens',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong password!', readonly: true, cidr_whitelist: [] }),
    });
    expect(wrong.status).toBe(401);

    const key = objects.find((o) => o.readonly)!.key;
    const del = await send(cache.url, {
      method: 'DELETE',
      path: `/-/npm/v1/tokens/token/${key}`,
      headers: bearer(token),
    });
    expect(del.status).toBe(204);
    expect(
      (await send(cache.url, { path: '/-/whoami', headers: bearer(readonlyToken) })).status,
    ).toBe(401);

    // Static token identities have no tokens to manage.
    const ci = await send(cache.url, { path: '/-/npm/v1/tokens', headers: bearer(STATIC) });
    expect(ci.status).toBe(403);
  });

  it("refuses another user's token key", async () => {
    const { cache } = await start();
    const alice = await tokenOf(cache, 'alice');
    const bob = await tokenOf(cache, 'bob');
    const list = await send(cache.url, { path: '/-/npm/v1/tokens', headers: bearer(bob) });
    const bobKey = (json(list).objects as Array<{ key: string }>)[0]!.key;
    const del = await send(cache.url, {
      method: 'DELETE',
      path: `/-/npm/v1/tokens/token/${bobKey}`,
      headers: bearer(alice),
    });
    expect(del.status).toBe(404);
    expect((await send(cache.url, { path: '/-/whoami', headers: bearer(bob) })).status).toBe(200);
  });

  it('does not register unknown users by default', async () => {
    const { cache, usersFile } = await start();
    expect((await login(cache, 'newbie', 'a long enough password')).status).toBe(401);
    expect(parseUsers(await readFile(usersFile, 'utf8')).users.newbie).toBeUndefined();
  });

  it('registers users when enabled, read-only by default, up to MAX_USERS', async () => {
    const { cache, usersFile } = await start({ USER_REGISTRATION: 'true', MAX_USERS: '3' });
    const weak = await login(cache, 'newbie', 'short');
    expect(weak.status).toBe(401);
    const r = await login(cache, 'newbie', 'a long enough password');
    expect(r.status, r.body.toString()).toBe(201);
    const stored = parseUsers(await readFile(usersFile, 'utf8')).users.newbie;
    expect(stored?.packages).toEqual([]);
    expect(await readFile(usersFile, 'utf8')).not.toContain('a long enough password');
    // The same password logs in again; a different one is a failed login, not a re-registration.
    expect((await login(cache, 'newbie', 'a long enough password')).status).toBe(201);
    expect((await login(cache, 'newbie', 'another long password')).status).toBe(401);
    // Cap: alice, bob, newbie = 3.
    expect((await login(cache, 'another', 'a long enough password')).status).toBe(401);
    expect(cache.running).toBeDefined();
  });

  it('serves reads without a token with ANONYMOUS_READ, but whoami still needs one', async () => {
    const { cache } = await start({ ANONYMOUS_READ: 'true' });
    expect((await send(cache.url, { path: '/left-pad' })).status).toBe(200);
    expect((await send(cache.url, { path: '/-/whoami' })).status).toBe(401);
  });

  it('never logs passwords or tokens', async () => {
    const { cache } = await start({ LOG_LEVEL: 'debug' });
    setLogLevel('debug');
    const logs = captureLogs();
    try {
      const token = await tokenOf(cache);
      await send(cache.url, { method: 'DELETE', path: `/-/user/token/${token}` });
      await login(cache, 'alice', 'wrong password here');
      const all = JSON.stringify(logs.lines);
      expect(all).toContain('auth.login');
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain(token);
      expect(all).not.toContain('wrong password here');
    } finally {
      logs.restore();
      setLogLevel('error');
    }
  });
});
