import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { ABBREVIATED_ACCEPT, json, send } from '../helpers/http.ts';

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Doc = { 'dist-tags': Record<string, string>; versions: Record<string, unknown> };

let cache: TestCache;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-filter-'));
  const rules = join(dir, 'rules.json');
  await writeFile(
    rules,
    JSON.stringify({
      block: [
        { id: 'bad-range', package: 'ranged', versions: '>=2.0.0', reason: 'regression' },
        { id: 'evil-scope', package: '@evil/*' },
        { id: 'gone', package: 'gone' },
        { id: 'blk', package: 'overridden', versions: '<2.0.0' },
      ],
      allow: [
        { id: 'keep', package: 'overridden', versions: '1.5.0', reason: 'reviewed' },
        { id: 'hotfix', package: 'young', versions: '1.1.0', reason: 'urgent fix' },
      ],
    }),
  );
  cache = await startCache({ MIN_RELEASE_AGE: '3d', FILTER_RULES_PATH: rules });
  const old = ago(30 * 24 * H);
  const up = cache.upstream;
  up.addPackage('ranged', [
    { version: '1.0.0', publishedAt: old },
    { version: '1.9.0', publishedAt: old },
    { version: '2.0.0', publishedAt: old },
    { version: '2.1.0', publishedAt: old },
  ]);
  up.addPackage('@evil/one', [{ version: '1.0.0', publishedAt: old }]);
  up.addPackage('gone', [{ version: '1.0.0', publishedAt: old }]);
  up.addPackage('overridden', [
    { version: '1.4.0', publishedAt: old },
    { version: '1.5.0', publishedAt: old },
  ]);
  up.addPackage('young', [
    { version: '1.0.0', publishedAt: old },
    { version: '1.1.0', publishedAt: ago(H) },
    { version: '1.2.0', publishedAt: ago(H) },
  ]);
  up.addPackage('clean', [{ version: '1.0.0', publishedAt: old }]);
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

describe('package filter', () => {
  it('removes blocked versions and repoints latest, in full and abbreviated documents', async () => {
    for (const accept of ['application/json', ABBREVIATED_ACCEPT]) {
      const doc = json(await send(cache.url, { path: '/ranged', headers: { accept } })) as Doc;
      expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.9.0']);
      expect(doc['dist-tags'].latest).toBe('1.9.0');
    }
  });

  it('answers 403 naming the rule for a blocked tarball, without fetching upstream', async () => {
    const res = await send(cache.url, { path: '/ranged/-/ranged-2.0.0.tgz' });
    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({
      error: 'blocked by package filter rule "bad-range": regression',
      package: 'ranged',
      version: '2.0.0',
    });
    expect(cache.upstream.countPath('/ranged/-/ranged-2.0.0.tgz')).toBe(0);
    expect((await send(cache.url, { path: '/ranged/-/ranged-1.9.0.tgz' })).status).toBe(200);
  });

  it('blocks a whole scope and a whole package with 404 naming the policy', async () => {
    for (const path of ['/@evil%2fone', '/gone']) {
      const res = await send(cache.url, { path });
      expect(res.status).toBe(404);
      expect(String(json(res).error)).toMatch(/policy/);
    }
    const tar = await send(cache.url, { path: '/gone/-/gone-1.0.0.tgz' });
    expect(tar.status).toBe(403);
    expect(String(json(tar).error)).toContain('"gone"');
  });

  it('an allow rule beats a block rule', async () => {
    const doc = json(await send(cache.url, { path: '/overridden' })) as Doc;
    expect(Object.keys(doc.versions)).toEqual(['1.5.0']);
    expect((await send(cache.url, { path: '/overridden/-/overridden-1.5.0.tgz' })).status).toBe(
      200,
    );
    expect((await send(cache.url, { path: '/overridden/-/overridden-1.4.0.tgz' })).status).toBe(
      403,
    );
  });

  it('an allow rule beats the minimum release age gate for that version only', async () => {
    const doc = json(await send(cache.url, { path: '/young' })) as Doc;
    expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.1.0']);
    expect(doc['dist-tags'].latest).toBe('1.1.0');
    expect((await send(cache.url, { path: '/young/-/young-1.1.0.tgz' })).status).toBe(200);
    const res = await send(cache.url, { path: '/young/-/young-1.2.0.tgz' });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('blocked by minimum release age');
  });

  it('leaves unrelated packages alone', async () => {
    expect((await send(cache.url, { path: '/clean' })).status).toBe(200);
  });
});

describe('package filter startup validation', () => {
  it('fails fast on an invalid rules file and on a missing one', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ block: [{ package: 'a', versions: 'nope' }] }));
    const err: unknown = await startCache({ FILTER_RULES_PATH: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toMatch(/FILTER_RULES_PATH.*block rule 1.*versions/);
    await expect(startCache({ FILTER_RULES_PATH: join(dir, 'missing.json') })).rejects.toThrow(
      /FILTER_RULES_PATH/,
    );
  });
});
