// C4: private packages in the community build (PRIVATE_PACKAGES + USERS_FILE): publish over
// HTTP, owned names never reach upstream, search merges local packages and hides upstream
// ones of owned names, the age gate spares own packages by default, writes are audited.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.ts';
import { captureLogs } from '../../src/core/log.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';
import { makeTarball, sha512Integrity } from '../helpers/tarball.ts';

const PASSWORD = 'correct horse battery';
let dir: string;
let hash: string;
const caches: TestCache[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-private-it-'));
  hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
});

afterEach(async () => {
  while (caches.length > 0) await caches.pop()?.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function start(env: Record<string, string> = {}) {
  const t = '2026-10-01T00:00:00.000Z';
  const usersFile = join(dir, `users-${++n}.json`);
  await writeFile(
    usersFile,
    JSON.stringify({
      version: 1,
      users: {
        alice: { password: hash, created: t, changed: t },
        bob: { password: hash, created: t, changed: t, packages: ['@acme/tools-*'] },
      },
    }),
  );
  const cache = await startCache({
    USERS_FILE: usersFile,
    PRIVATE_PACKAGES: '@acme/*,internal-cli',
    ANONYMOUS_READ: 'true',
    ALLOW_ANONYMOUS_PRIVATE_READ: 'true',
    ...env,
  });
  caches.push(cache);
  return cache;
}

async function tokenOf(cache: TestCache, name = 'alice', readonly = false): Promise<string> {
  const r = await send(cache.url, {
    method: 'PUT',
    path: `/-/user/org.couchdb.user:${name}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: PASSWORD }),
  });
  const token = json(r).token as string;
  if (!readonly) return token;
  const created = await send(cache.url, {
    method: 'POST',
    path: '/-/npm/v1/tokens',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, readonly: true }),
  });
  return json(created).token as string;
}

function publishBody(name: string, version: string, extra: Record<string, unknown> = {}) {
  const tgz = makeTarball({ 'package.json': JSON.stringify({ name, version }), 'index.js': '1' });
  return JSON.stringify({
    _id: name,
    name,
    description: `${name} description`,
    readme: `# ${name}`,
    'dist-tags': { latest: version },
    versions: { [version]: { name, version, dist: { integrity: sha512Integrity(tgz) } } },
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: 'application/octet-stream',
        data: tgz.toString('base64'),
        length: tgz.length,
      },
    },
    ...extra,
  });
}

function publish(
  cache: TestCache,
  token: string | null,
  name: string,
  version: string,
): Promise<RawResponse> {
  return send(cache.url, {
    method: 'PUT',
    path: `/${name.replace('/', '%2f')}`,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: publishBody(name, version),
  });
}

describe('C4: private packages', () => {
  it('publishes and serves a private package without asking upstream', async () => {
    const cache = await start({ MIN_RELEASE_AGE: '3d' });
    // Upstream has a public package of the same name: it must never be fetched.
    cache.upstream.addPackage('@acme/lib', [{ version: '9.9.9' }]);
    const token = await tokenOf(cache);
    const r = await publish(cache, token, '@acme/lib', '1.0.0');
    expect(r.status, r.body.toString()).toBe(201);

    // Just published, yet installable: own packages are exempt from the age gate by default.
    const doc = json(await send(cache.url, { path: '/@acme%2flib' }));
    expect(doc['dist-tags']).toEqual({ latest: '1.0.0' });
    const versions = doc.versions as Record<string, { dist: { tarball: string } }>;
    expect(Object.keys(versions)).toEqual(['1.0.0']);
    const tarball = new URL(versions['1.0.0']!.dist.tarball);
    const tgz = await send(cache.url, { path: tarball.pathname });
    expect(tgz.status).toBe(200);
    expect(sha512Integrity(tgz.body)).toBe(
      (doc.versions as Record<string, { dist: { integrity: string } }>)['1.0.0']!.dist.integrity,
    );
    expect((await send(cache.url, { path: '/@acme%2fmissing' })).status).toBe(404);
    expect(cache.upstream.requests.filter((q) => q.path.includes('acme'))).toEqual([]);
  });

  it('gates own packages too with MIN_RELEASE_AGE_LOCAL=true', async () => {
    const cache = await start({ MIN_RELEASE_AGE: '3d', MIN_RELEASE_AGE_LOCAL: 'true' });
    const token = await tokenOf(cache);
    expect((await publish(cache, token, '@acme/lib', '1.0.0')).status).toBe(201);
    expect((await send(cache.url, { path: '/@acme%2flib' })).status).toBe(404);
  });

  it('refuses writes from anonymous, static, read-only and out-of-scope identities', async () => {
    const tokensFile = join(dir, 'static.json');
    await writeFile(
      tokensFile,
      JSON.stringify({ ci: createHash('sha256').update('static-ci').digest('hex') }),
    );
    const cache = await start({ AUTH_TOKENS_PATH: tokensFile });
    // ANONYMOUS_READ: an anonymous write is not unauthenticated but unauthorized.
    expect((await publish(cache, null, '@acme/lib', '1.0.0')).status).toBe(403);
    expect((await publish(cache, 'static-ci', '@acme/lib', '1.0.0')).status).toBe(403);
    expect(
      (await publish(cache, await tokenOf(cache, 'alice', true), '@acme/lib', '1.0.0')).status,
    ).toBe(403);
    const bob = await tokenOf(cache, 'bob');
    expect((await publish(cache, bob, '@acme/lib', '1.0.0')).status).toBe(403);
    expect((await publish(cache, bob, '@acme/tools-x', '1.0.0')).status).toBe(201);
    // Names the registry does not own stay read-only, whoever asks.
    expect((await publish(cache, await tokenOf(cache), 'left-pad', '1.0.0')).status).toBe(403);
  });

  it('refuses a tarball that does not match the version and a re-publish', async () => {
    const cache = await start();
    const token = await tokenOf(cache);
    const tgz = makeTarball({
      'package.json': JSON.stringify({ name: '@acme/lib', version: '6.6.6' }),
    });
    const body = JSON.stringify({
      name: '@acme/lib',
      versions: { '1.0.0': { name: '@acme/lib', version: '1.0.0', dist: {} } },
      'dist-tags': { latest: '1.0.0' },
      _attachments: { '@acme/lib-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length } },
    });
    const bad = await send(cache.url, {
      method: 'PUT',
      path: '/@acme%2flib',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(bad.status).toBe(400);
    expect((await publish(cache, token, '@acme/lib', '1.0.0')).status).toBe(201);
    const logs = captureLogs();
    try {
      expect((await publish(cache, token, '@acme/lib', '1.0.0')).status).toBe(409);
    } finally {
      logs.restore();
    }
    // Refused publishes are audited, with the token used (its sha256, as `npm token list`).
    const tokenId = createHash('sha256').update(token).digest('hex');
    expect(logs.lines.find((l) => l.msg === 'audit' && l.type === 'write.refused')).toMatchObject({
      identity: 'alice',
      name: '@acme/lib',
      status: 409,
      tokenId,
    });
  });

  it('merges private packages into search and hides upstream hits of owned names', async () => {
    const cache = await start();
    cache.upstream.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          objects: [
            {
              package: { name: '@acme/lib', version: '6.6.6' },
              score: { final: 1 },
              searchScore: 1,
            },
            {
              package: { name: 'lib-public', version: '1.0.0' },
              score: { final: 1 },
              searchScore: 1,
            },
          ],
          total: 2,
          time: 'now',
        }),
      );
      return true;
    };
    const token = await tokenOf(cache);
    await publish(cache, token, '@acme/lib', '1.0.0');
    const r = json(await send(cache.url, { path: '/-/v1/search?text=lib' }));
    const names = (r.objects as Array<{ package: { name: string; version: string } }>).map(
      (o) => `${o.package.name}@${o.package.version}`,
    );
    expect(names).toEqual(['@acme/lib@1.0.0', 'lib-public@1.0.0']);
  });

  it('supports dist-tags, deprecate and unpublish over HTTP, audited with request id and identity', async () => {
    const cache = await start();
    const token = await tokenOf(cache);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await publish(cache, token, '@acme/lib', '1.0.0');
    await publish(cache, token, '@acme/lib', '1.1.0');
    const logs = captureLogs();
    try {
      const tag = await send(cache.url, {
        method: 'PUT',
        path: '/-/package/@acme%2flib/dist-tags/stable',
        headers: { ...auth, 'x-request-id': 'req-tag-1' },
        body: '"1.0.0"',
      });
      expect(tag.status, tag.body.toString()).toBe(200);
      const doc = json(await send(cache.url, { path: '/@acme%2flib' }));
      expect(doc['dist-tags']).toEqual({ latest: '1.1.0', stable: '1.0.0' });

      const versions = doc.versions as Record<string, Record<string, unknown>>;
      versions['1.0.0']!.deprecated = 'use 1.1.0';
      const dep = await send(cache.url, {
        method: 'PUT',
        path: '/@acme%2flib',
        headers: auth,
        body: JSON.stringify({ ...doc, versions }),
      });
      expect(dep.status, dep.body.toString()).toBe(200);

      const after = json(await send(cache.url, { path: '/@acme%2flib' }));
      const keep = after.versions as Record<string, unknown>;
      Reflect.deleteProperty(keep, '1.1.0');
      const unpub = await send(cache.url, {
        method: 'PUT',
        path: `/@acme%2flib/-rev/${String(after._rev)}`,
        headers: auth,
        body: JSON.stringify({ ...after, versions: keep }),
      });
      expect(unpub.status, unpub.body.toString()).toBe(200);
      const final = json(await send(cache.url, { path: '/@acme%2flib' }));
      expect(Object.keys(final.versions as object)).toEqual(['1.0.0']);
      expect((final.versions as Record<string, { deprecated?: string }>)['1.0.0']?.deprecated).toBe(
        'use 1.1.0',
      );
      expect(final['dist-tags']).toEqual({ latest: '1.0.0', stable: '1.0.0' });
    } finally {
      logs.restore();
    }
    const audits = logs.lines.filter((l) => l.msg === 'audit');
    const tagEvent = audits.find((a) => a.type === 'dist-tag');
    expect(tagEvent).toMatchObject({
      requestId: 'req-tag-1',
      identity: 'alice',
      name: '@acme/lib',
      tag: 'stable',
    });
    expect(audits.find((a) => a.type === 'deprecate')).toMatchObject({ identity: 'alice' });
    expect(audits.find((a) => a.type === 'unpublish')).toMatchObject({
      identity: 'alice',
      versions: ['1.1.0'],
      tokenId: createHash('sha256').update(token).digest('hex'),
    });
  });
});
