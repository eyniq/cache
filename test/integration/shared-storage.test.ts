import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsStorage } from '../../src/storage/fs.ts';
import { FakeUpstream } from '../fake-upstream.ts';
import { startCache } from '../helpers/cache.ts';
import { send } from '../helpers/http.ts';

let upstream: FakeUpstream;
let root: string;

beforeAll(async () => {
  upstream = new FakeUpstream();
  await upstream.start();
  upstream.addPackage('lodash', [{ version: '4.17.21' }]);
  upstream.addPackage('legacy', [{ version: '0.1.0', sha1Only: true }]);
  root = await mkdtemp(join(tmpdir(), 'eyniq-shared-'));
});

afterAll(async () => {
  await upstream.stop();
  await rm(root, { recursive: true, force: true });
});

describe('slice 5: content-addressed layout on a shared volume', () => {
  it('stores tarballs by digest with a name/version index', async () => {
    const cache = await startCache({ FS_ROOT: root }, upstream);
    try {
      const path = '/lodash/-/lodash-4.17.21.tgz';
      expect((await send(cache.url, { path })).status).toBe(200);
      const bytes = upstream.tarballs.get(path)!;
      const hex = createHash('sha512').update(bytes).digest('hex');
      expect((await stat(join(root, 'tarballs', 'sha512', hex))).size).toBe(bytes.length);
      // The index entry is a background write: it lands shortly after the response.
      await expect
        .poll(() => readFile(join(root, 'index', 'npm', 'lodash', '4.17.21'), 'utf8'))
        .toBe(`sha512-${hex}`);
      // Legacy packages are addressed by their advertised sha1.
      expect((await send(cache.url, { path: '/legacy/-/legacy-0.1.0.tgz' })).status).toBe(200);
      const legacy = upstream.tarballs.get('/legacy/-/legacy-0.1.0.tgz')!;
      const sha1 = createHash('sha1').update(legacy).digest('hex');
      expect((await stat(join(root, 'tarballs', 'sha1', sha1))).size).toBe(legacy.length);
    } finally {
      await cache.close();
    }
  });

  it('lets a second pod on the same volume serve the tarball without an upstream fetch', async () => {
    const podB = await startCache({ FS_ROOT: root }, upstream);
    try {
      const path = '/lodash/-/lodash-4.17.21.tgz';
      const before = upstream.countPath(path);
      const res = await send(podB.url, { path });
      expect(res.status).toBe(200);
      expect(res.body.equals(upstream.tarballs.get(path)!)).toBe(true);
      expect(upstream.countPath(path)).toBe(before);
    } finally {
      await podB.close();
    }
  });

  it('lets a second pod use a fresh stored packument instead of asking upstream', async () => {
    upstream.addPackage('sharedmeta', [{ version: '1.0.0' }]);
    const podA = await startCache({ FS_ROOT: root }, upstream);
    try {
      expect((await send(podA.url, { path: '/sharedmeta' })).status).toBe(200);
    } finally {
      await podA.close(); // drains the background packument write
    }
    const podB = await startCache({ FS_ROOT: root }, upstream);
    try {
      const res = await send(podB.url, { path: '/sharedmeta' });
      expect(res.status).toBe(200);
      expect(res.headers['x-eyniq-stale']).toBeUndefined();
      expect(upstream.countPath('/sharedmeta')).toBe(1);
    } finally {
      await podB.close();
    }
  });

  it('revalidates an expired stored packument with its upstream ETag', async () => {
    upstream.addPackage('reval-stored', [{ version: '1.0.0' }]);
    const podA = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      await send(podA.url, { path: '/reval-stored' });
    } finally {
      await podA.close();
    }
    await new Promise((r) => setTimeout(r, 1100));
    const podB = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      expect((await send(podB.url, { path: '/reval-stored' })).status).toBe(200);
      const hits = upstream.requests.filter((r) => r.path === '/reval-stored');
      expect(hits).toHaveLength(2);
      expect(hits[1]!.headers['if-none-match']).toMatch(/^"/);
    } finally {
      await podB.close();
    }
  });

  it('does not trust a stored fetch time from the future', async () => {
    upstream.addPackage('future-meta', [{ version: '1.0.0' }]);
    const podA = await startCache({ FS_ROOT: root }, upstream);
    try {
      await send(podA.url, { path: '/future-meta' });
    } finally {
      await podA.close();
    }
    const meta = join(root, 'npm', 'packuments', 'future-meta.json.gz.meta');
    await writeFile(meta, JSON.stringify({ fetchedAt: Date.parse('2100-01-01T00:00:00Z') }));
    const podB = await startCache({ FS_ROOT: root }, upstream);
    try {
      await send(podB.url, { path: '/future-meta' });
      expect(upstream.countPath('/future-meta')).toBe(2);
    } finally {
      await podB.close();
    }
  });

  it('re-downloads instead of revalidating once the last full fetch is over 24 h old', async () => {
    upstream.addPackage('old-origin', [{ version: '1.0.0' }]);
    const podA = await startCache({ FS_ROOT: root }, upstream);
    try {
      await send(podA.url, { path: '/old-origin' });
    } finally {
      await podA.close();
    }
    const meta = join(root, 'npm', 'packuments', 'old-origin.json.gz.meta');
    const day = 24 * 3_600_000;
    await writeFile(
      meta,
      JSON.stringify({
        fetchedAt: Date.now() - day,
        originFetchedAt: Date.now() - 2 * day,
        etag: '"x"',
      }),
    );
    const podB = await startCache({ FS_ROOT: root }, upstream);
    try {
      await send(podB.url, { path: '/old-origin' });
      const last = upstream.requests.filter((r) => r.path === '/old-origin').at(-1);
      expect(last?.headers['if-none-match']).toBeUndefined();
    } finally {
      await podB.close();
    }
  });

  it('survives concurrent writers of the same object from two pods', async () => {
    const a = new FsStorage(root);
    const b = new FsStorage(root);
    const body = Buffer.alloc(256 * 1024, 7);
    const key = 'tarballs/sha512/' + createHash('sha512').update(body).digest('hex');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).put(key, Readable.from([body.subarray(0, 1000), body.subarray(1000)])),
      ),
    );
    const read = await a.get(key);
    expect(Buffer.from(await text(read!), 'utf8').length).toBeGreaterThan(0);
    expect((await stat(join(root, key))).size).toBe(body.length);
  });

  it('serves the size of the object it actually opened', async () => {
    const s = new FsStorage(root);
    await s.put('k/size', Readable.from([Buffer.from('hello')]));
    const opened = await s.open('k/size');
    expect(opened?.size).toBe(5);
    expect(await text(opened!.body)).toBe('hello');
  });

  it('sweeps stale temp files at startup and leaves fresh ones', async () => {
    const tmp = join(root, '.tmp');
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'old.part'), 'x');
    await writeFile(join(tmp, 'new.part'), 'x');
    const old = new Date(Date.now() - 2 * 3_600_000);
    await utimes(join(tmp, 'old.part'), old, old);
    await new FsStorage(root).sweepTemp();
    expect((await readdir(tmp)).sort()).toEqual(['new.part']);
  });
});
