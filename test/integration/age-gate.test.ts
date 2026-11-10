import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../src/core/log.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT, json, send } from '../helpers/http.ts';

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let cache: TestCache;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-gate-'));
  const allowlist = join(dir, 'allowlist.json');
  await writeFile(
    allowlist,
    JSON.stringify([
      { package: 'fixed', version: '1.0.1', reason: 'security fix', expires: ago(-24 * H) },
      { package: 'fixed', version: '1.0.2', reason: 'expired entry', expires: ago(24 * H) },
    ]),
  );
  cache = await startCache({ MIN_RELEASE_AGE: '3d', ALLOWLIST_PATH: allowlist });
  const up = cache.upstream;
  up.addPackage('gated', [
    { version: '1.0.0', publishedAt: ago(30 * 24 * H) },
    { version: '1.1.0', publishedAt: ago(10 * 24 * H) },
    { version: '2.0.0', publishedAt: ago(2 * H) },
  ]);
  up.addPackage('fixed', [
    { version: '1.0.0', publishedAt: ago(30 * 24 * H) },
    { version: '1.0.1', publishedAt: ago(H) },
    { version: '1.0.2', publishedAt: ago(H) },
  ]);
  up.addPackage('notime', [
    { version: '1.0.0', publishedAt: ago(30 * 24 * H) },
    { version: '1.1.0', publishedAt: null },
  ]);
  up.addPackage('allnew', [{ version: '1.0.0', publishedAt: ago(H) }]);
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

type Doc = { 'dist-tags': Record<string, string>; versions: Record<string, unknown> };

describe('slice 4: minimum release age gate', () => {
  it('filters young versions and repoints latest in full and abbreviated documents', async () => {
    for (const accept of ['application/json', ABBREVIATED_ACCEPT]) {
      const doc = json(await send(cache.url, { path: '/gated', headers: { accept } })) as Doc;
      expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.1.0']);
      expect(doc['dist-tags'].latest).toBe('1.1.0');
    }
  });

  it('blocks the tarball of a young version with a 403 explaining when it is allowed', async () => {
    const logs = captureLogs();
    try {
      const res = await send(cache.url, { path: '/gated/-/gated-2.0.0.tgz' });
      expect(res.status).toBe(403);
      const body = json(res);
      expect(body).toMatchObject({
        error: 'blocked by minimum release age',
        package: 'gated',
        version: '2.0.0',
      });
      const publishedAt = Date.parse(String(body.publishedAt));
      expect(Date.parse(String(body.allowedAfter)) - publishedAt).toBe(72 * H);
      expect(logs.lines.some((l) => l.msg === 'audit' && l.type === 'policy.blocked')).toBe(true);
    } finally {
      logs.restore();
    }
    // Lockfiles that pin a too-new version are stopped the same way, without an upstream fetch.
    expect(cache.upstream.countPath('/gated/-/gated-2.0.0.tgz')).toBe(0);
  });

  it('serves the tarball of an allowed version', async () => {
    expect((await send(cache.url, { path: '/gated/-/gated-1.1.0.tgz' })).status).toBe(200);
  });

  it('lets an allowlisted young version through and ignores expired entries', async () => {
    const doc = json(await send(cache.url, { path: '/fixed' })) as Doc;
    expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.0.1']);
    expect((await send(cache.url, { path: '/fixed/-/fixed-1.0.1.tgz' })).status).toBe(200);
    expect((await send(cache.url, { path: '/fixed/-/fixed-1.0.2.tgz' })).status).toBe(403);
  });

  it('blocks versions with an unknown publish time (fail closed)', async () => {
    const doc = json(await send(cache.url, { path: '/notime' })) as Doc;
    expect(Object.keys(doc.versions)).toEqual(['1.0.0']);
    expect((await send(cache.url, { path: '/notime/-/notime-1.1.0.tgz' })).status).toBe(403);
  });

  it('answers 404 naming the policy when no version is old enough', async () => {
    const res = await send(cache.url, { path: '/allnew' });
    expect(res.status).toBe(404);
    expect(String(json(res).error)).toMatch(/policy/);
  });
});

describe('slice 4: fail open and re-filtering', () => {
  it('allows unknown publish times with FAIL_CLOSED=false', async () => {
    const open = await startCache({ MIN_RELEASE_AGE: '3d', FAIL_CLOSED: 'false' });
    try {
      open.upstream.addPackage('notime', [
        { version: '1.0.0', publishedAt: ago(30 * 24 * H) },
        { version: '1.1.0', publishedAt: null },
      ]);
      const doc = json(await send(open.url, { path: '/notime' })) as Doc;
      expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.1.0']);
    } finally {
      await open.close();
    }
  });

  it('re-filters once a version passes the cutoff, without refetching upstream', async () => {
    const quick = await startCache({ MIN_RELEASE_AGE: '2s' });
    try {
      quick.upstream.addPackage('fresh', [
        { version: '1.0.0', publishedAt: ago(24 * H) },
        { version: '1.1.0', publishedAt: ago(0) },
      ]);
      let doc = json(await send(quick.url, { path: '/fresh' })) as Doc;
      expect(doc['dist-tags'].latest).toBe('1.0.0');
      await new Promise((r) => setTimeout(r, 2100));
      doc = json(await send(quick.url, { path: '/fresh' })) as Doc;
      expect(doc['dist-tags'].latest).toBe('1.1.0');
      expect(quick.upstream.countPath('/fresh')).toBe(1);
    } finally {
      await quick.close();
    }
  });
});
