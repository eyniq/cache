// C5: the read-only web catalog (WEB_UI): static shell with a strict CSP, JSON endpoints for
// search, package detail and README, and a session login backed by the user store.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.ts';
import { captureLogs, setLogLevel } from '../../src/core/log.ts';
import { startCache, storedFiles, type TestCache } from '../helpers/cache.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';

const PASSWORD = 'correct horse battery';
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
let dir: string;
let hash: string;
const caches: TestCache[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-web-it-'));
  hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
});

afterEach(async () => {
  while (caches.length > 0) await caches.pop()?.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
let lastUsersFile = '';
async function start(env: Record<string, string> = {}, withUsers = false): Promise<TestCache> {
  const extra: Record<string, string> = {};
  if (withUsers) {
    const t = '2026-10-01T00:00:00.000Z';
    const file = join(dir, `users-${++n}.json`);
    await writeFile(
      file,
      JSON.stringify({ version: 1, users: { alice: { password: hash, created: t, changed: t } } }),
    );
    extra.USERS_FILE = file;
    lastUsersFile = file;
  }
  const cache = await startCache({ WEB_UI: 'true', ...extra, ...env });
  caches.push(cache);
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  cache.upstream.addPackage(
    'left-pad',
    [
      { version: '1.0.0', publishedAt: ago(30) },
      { version: '1.1.0', publishedAt: ago(10) },
      { version: '2.0.0', publishedAt: ago(0) },
    ],
    {
      distTags: { latest: '2.0.0' },
      extra: {
        description: 'Pads strings',
        readme:
          '# left-pad\n\n[docs](https://example.com/docs) [x](javascript:alert(1))\n\n<script>alert(1)</script>',
        repository: { type: 'git', url: 'git+https://github.com/x/left-pad.git' },
      },
    },
  );
  return cache;
}

const origin = (c: TestCache) => ({ origin: c.url });

function login(
  c: TestCache,
  password = PASSWORD,
  headers: Record<string, string> = origin(c),
): Promise<RawResponse> {
  return send(c.url, {
    method: 'POST',
    path: '/-/web/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ name: 'alice', password }).toString(),
  });
}

function cookieOf(r: RawResponse): string {
  const set = r.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  return (first ?? '').split(';')[0] ?? '';
}

describe('C5: web catalog', () => {
  it('is off by default', async () => {
    const cache = await startCache();
    caches.push(cache);
    expect((await send(cache.url, { path: '/-/web/' })).status).toBe(404);
    expect((await send(cache.url, { path: '/' })).status).not.toBe(302);
  });

  it('serves the shell with a strict CSP and security headers, no inline code', async () => {
    const cache = await start();
    const root = await send(cache.url, { path: '/' });
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/-/web/');
    const page = await send(cache.url, { path: '/-/web/' });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBe(CSP);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    // same-origin: browsers then send Origin on the sign-in form posts (no-referrer made it null).
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['strict-transport-security']).toBeUndefined(); // http PUBLIC_URL
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    const html = page.body.toString();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // only external scripts
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    for (const path of ['/-/web/package/left-pad', '/-/web/search', '/-/web/login']) {
      expect((await send(cache.url, { path })).body.toString()).toBe(html);
    }
    const js = await send(cache.url, { path: '/-/web/static/app.js' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    const css = await send(cache.url, { path: '/-/web/static/style.css' });
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect((await send(cache.url, { path: '/-/web/static/tsconfig.json' })).status).toBe(404);
    expect((await send(cache.url, { path: '/-/web/static/../../main.js' })).status).toBe(404);
    expect((await send(cache.url, { method: 'PUT', path: '/-/web/' })).status).toBe(405);
  });

  it('allows https images in the CSP only with WEB_UI_IMAGES', async () => {
    const cache = await start({ WEB_UI_IMAGES: 'true' });
    const page = await send(cache.url, { path: '/-/web/' });
    expect(page.headers['content-security-policy']).toContain("img-src 'self' https:;");
  });

  it('describes a package, shows blocked versions with the reason and no download', async () => {
    const cache = await start({ MIN_RELEASE_AGE: '3d' });
    const r = await send(cache.url, { path: '/-/web/api/package/left-pad' });
    expect(r.status, r.body.toString()).toBe(200);
    const d = json(r) as {
      distTags: Array<{ tag: string; version: string }>;
      versions: Array<{ version: string; blocked?: { reason: string } }>;
      selected: { version: string; download?: { url: string } };
      install: Array<{ command: string }>;
      links: { repository?: string };
    };
    expect(d.distTags).toEqual([{ tag: 'latest', version: '1.1.0' }]);
    expect(d.versions[0]).toMatchObject({
      version: '2.0.0',
      blocked: { reason: 'blocked by minimum release age' },
    });
    expect(d.selected.version).toBe('1.1.0');
    expect(d.selected.download?.url).toBe(`${cache.url}/left-pad/-/left-pad-1.1.0.tgz`);
    expect(d.links.repository).toBe('https://github.com/x/left-pad');
    const blocked = json(
      await send(cache.url, { path: '/-/web/api/package/left-pad?version=2.0.0' }),
    ) as typeof d;
    expect(blocked.selected.download).toBeUndefined();
    expect(blocked.install).toEqual([]);
    expect((await send(cache.url, { path: '/-/web/api/package/..%2f..%2fetc' })).status).toBe(400);
    expect((await send(cache.url, { path: '/-/web/api/package/does-not-exist' })).status).toBe(404);
  });

  it('renders the README to a safe node tree', async () => {
    const cache = await start();
    const r = await send(cache.url, { path: '/-/web/api/readme/left-pad' });
    expect(r.status).toBe(200);
    const text = r.body.toString();
    expect(text).toContain('https://example.com/docs');
    expect(text).not.toMatch(/javascript|<script|alert/);
  });

  it('hides packages the registry hides as a whole (package filter)', async () => {
    const rules = join(dir, `rules-${++n}.json`);
    await writeFile(rules, JSON.stringify({ block: [{ package: 'left-pad', reason: 'banned' }] }));
    const cache = await start({ FILTER_RULES_PATH: rules });
    for (const path of ['/-/web/api/package/left-pad', '/-/web/api/readme/left-pad']) {
      const r = await send(cache.url, { path });
      expect(r.status, path).toBe(404);
      expect(r.headers['content-security-policy']).toBe(CSP);
    }
  });

  it('gives web search its own upstream budget, apart from npm search', async () => {
    const cache = await start({ SEARCH_UPSTREAM_RPS: '1', SEARCH_UPSTREAM_BURST: '1' });
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ objects: [], total: 0 }));
      return true;
    };
    expect((await send(cache.url, { path: '/-/v1/search?text=one' })).status).toBe(200);
    expect((await send(cache.url, { path: '/-/v1/search?text=two' })).status).toBe(429);
    // The registry's budget is used up; the catalog's is not (and vice versa).
    expect((await send(cache.url, { path: '/-/web/api/search?text=three' })).status).toBe(200);
    const web = await send(cache.url, { path: '/-/web/api/search?text=four' });
    expect(web.status).toBe(429);
    expect(web.headers['content-security-policy']).toBe(CSP);
  });

  it('warns at startup when the catalog runs on an http PUBLIC_URL', async () => {
    const logs = captureLogs();
    setLogLevel('warn');
    try {
      await start({ LOG_LEVEL: 'warn' });
    } finally {
      setLogLevel('error');
      logs.restore();
    }
    expect(logs.lines.some((l) => l.level === 'warn' && /WEB_UI.*http/.test(String(l.msg)))).toBe(
      true,
    );
  });

  it('searches through the registry search', async () => {
    const cache = await start();
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          objects: [{ package: { name: 'left-pad', version: '1.1.0', description: 'Pads' } }],
          total: 1,
        }),
      );
      return true;
    };
    const r = await send(cache.url, { path: '/-/web/api/search?text=pad' });
    expect(r.status, r.body.toString()).toBe(200);
    expect(json(r)).toEqual({
      total: 1,
      results: [{ name: 'left-pad', version: '1.1.0', description: 'Pads' }],
    });
  });

  it('needs a session when auth is required; the session only works in the catalog', async () => {
    const cache = await start({}, true);
    expect((await send(cache.url, { path: '/-/web/api/package/left-pad' })).status).toBe(401);
    const session = json(await send(cache.url, { path: '/-/web/api/session' }));
    expect(session).toMatchObject({ user: null, authRequired: true, loginAvailable: true });

    // Cross-site or origin-less form posts are refused.
    expect((await login(cache, PASSWORD, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await login(cache, PASSWORD, {})).status).toBe(403);
    expect((await login(cache, PASSWORD, { origin: 'null' })).status).toBe(403);
    expect(
      (await login(cache, PASSWORD, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
    expect(
      (
        await login(cache, PASSWORD, {
          origin: 'https://evil.example',
          'sec-fetch-site': 'same-origin',
        })
      ).status,
    ).toBe(403);
    // A browser that sends no usable Origin but Sec-Fetch-Site: same-origin is accepted.
    expect((await login(cache, PASSWORD, { 'sec-fetch-site': 'same-origin' })).status).toBe(303);
    expect(
      (await login(cache, PASSWORD, { origin: 'null', 'sec-fetch-site': 'same-origin' })).status,
    ).toBe(303);
    const failed = await login(cache, 'wrong password!');
    expect(failed.status).toBe(303);
    expect(failed.headers.location).toBe('/-/web/login?failed=1');
    expect(failed.headers['set-cookie']).toBeUndefined();

    const ok = await login(cache);
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/-/web/');
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\/-\/web\//);
    expect(setCookie).not.toMatch(/Secure/); // PUBLIC_URL is http here
    const cookie = cookieOf(ok);

    const me = json(await send(cache.url, { path: '/-/web/api/session', headers: { cookie } }));
    expect(me.user).toBe('alice');
    expect(
      (await send(cache.url, { path: '/-/web/api/package/left-pad', headers: { cookie } })).status,
    ).toBe(200);
    // Not a registry credential.
    expect((await send(cache.url, { path: '/left-pad', headers: { cookie } })).status).toBe(401);
    const token = cookie.split('=')[1] ?? '';
    expect(
      (await send(cache.url, { path: '/left-pad', headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(401);

    // Logout needs the origin too, then ends the session.
    expect(
      (await send(cache.url, { method: 'POST', path: '/-/web/logout', headers: { cookie } }))
        .status,
    ).toBe(403);
    const out = await send(cache.url, {
      method: 'POST',
      path: '/-/web/logout',
      headers: { cookie, ...origin(cache) },
    });
    expect(out.status).toBe(303);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(
      (await send(cache.url, { path: '/-/web/api/package/left-pad', headers: { cookie } })).status,
    ).toBe(401);

    // Only the sha256 of a session is stored.
    for (const f of await storedFiles(cache)) expect(f.body.includes(token), f.path).toBe(false);
  });

  it('marks the session cookie Secure and sends HSTS when PUBLIC_URL is https', async () => {
    const cache = await start({ PUBLIC_URL: 'https://npm.example.com' }, true);
    const ok = await login(cache, PASSWORD, { origin: 'https://npm.example.com' });
    expect(ok.status).toBe(303);
    expect(String(ok.headers['set-cookie'])).toMatch(/; Secure/);
    expect(ok.headers['strict-transport-security']).toBe('max-age=31536000');
    const page = await send(cache.url, { path: '/-/web/' });
    expect(page.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('ends sessions on a password change by generation, not by clocks', async () => {
    const cache = await start({}, true);
    const cookie = cookieOf(await login(cache));
    const me = async () =>
      json(await send(cache.url, { path: '/-/web/api/session', headers: { cookie } })).user;
    expect(await me()).toBe('alice');
    // The users file is checked at most every 2 s, lazily: wait, touch it, let it re-read.
    const reloaded = async () => {
      await new Promise((r) => setTimeout(r, 2_100));
      await me();
      await new Promise((r) => setTimeout(r, 100));
    };
    const file = lastUsersFile;
    const data = JSON.parse(await readFile(file, 'utf8')) as {
      users: Record<string, Record<string, unknown>>;
    };
    const alice = data.users.alice!;
    // A change time far in the future without a new generation: the session stays.
    alice.generation = Date.parse(String(alice.changed));
    alice.changed = '2099-01-01T00:00:00.000Z';
    await writeFile(file, JSON.stringify(data));
    await reloaded();
    expect(await me()).toBe('alice');
    // A new generation with a change time in the past (a skewed clock): the session ends.
    alice.generation = Number(alice.generation) + 1;
    alice.changed = '2000-01-01T00:00:00.000Z';
    await writeFile(file, JSON.stringify(data));
    await reloaded();
    expect(await me()).toBeNull();
  });
});
