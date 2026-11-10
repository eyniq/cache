import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeUpstream } from '../fake-upstream.ts';
import { startCache } from '../helpers/cache.ts';
import { json, send } from '../helpers/http.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: FakeUpstream;
let root: string;

beforeAll(async () => {
  upstream = new FakeUpstream();
  await upstream.start();
  upstream.addPackage('staley', [{ version: '1.0.0' }]);
  upstream.addPackage('reval', [{ version: '1.0.0' }]);
  root = await mkdtemp(join(tmpdir(), 'eyniq-stale-'));
});

afterAll(async () => {
  await upstream.stop();
  await rm(root, { recursive: true, force: true });
});

const failPackuments = (
  req: { url?: string | undefined },
  res: import('node:http').ServerResponse,
) => {
  if ((req.url ?? '').includes('/-/')) return false;
  res.writeHead(500);
  res.end('boom');
  return true;
};

describe('slice 2: revalidation and stale-on-error', () => {
  it('revalidates with If-None-Match after METADATA_TTL', async () => {
    const cache = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      expect((await send(cache.url, { path: '/reval' })).status).toBe(200);
      await sleep(1100);
      const res = await send(cache.url, { path: '/reval' });
      expect(res.status).toBe(200);
      const hits = upstream.requests.filter((r) => r.path === '/reval');
      expect(hits).toHaveLength(2);
      expect(hits[1]!.headers['if-none-match']).toMatch(/^"/);
      expect(res.headers['x-eyniq-stale']).toBeUndefined();
    } finally {
      await cache.close();
    }
  });

  it('serves the in-memory copy with X-Eyniq-Stale when upstream fails', async () => {
    const cache = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      expect((await send(cache.url, { path: '/staley' })).status).toBe(200);
      await sleep(1100);
      upstream.hook = failPackuments;
      const res = await send(cache.url, { path: '/staley' });
      expect(res.status).toBe(200);
      expect(res.headers['x-eyniq-stale']).toBe('1');
      expect(json(res).name).toBe('staley');
      // Tarballs of a stale packument still work.
      const tgz = await send(cache.url, { path: '/staley/-/staley-1.0.0.tgz' });
      expect(tgz.status).toBe(200);
    } finally {
      upstream.hook = null;
      await cache.close();
    }
  });

  it('serves the stored copy after a restart when upstream fails', async () => {
    upstream.hook = failPackuments;
    // The stored copy must be older than METADATA_TTL, otherwise it is served as fresh.
    await sleep(1100);
    const cache = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      const res = await send(cache.url, { path: '/staley' });
      expect(res.status).toBe(200);
      expect(res.headers['x-eyniq-stale']).toBe('1');
    } finally {
      upstream.hook = null;
      await cache.close();
    }
  });

  it('serves the stored copy when upstream is unreachable', async () => {
    const cache = await startCache({
      FS_ROOT: root,
      METADATA_TTL: '1s',
      UPSTREAM_URL: 'http://127.0.0.1:1',
    });
    try {
      const res = await send(cache.url, { path: '/staley' });
      expect(res.status).toBe(200);
      expect(res.headers['x-eyniq-stale']).toBe('1');
      expect((await send(cache.url, { path: '/never-seen' })).status).toBe(502);
    } finally {
      await cache.close();
    }
  });

  it('does not hammer a failing upstream: stale answers are reused for a while', async () => {
    const cache = await startCache({ FS_ROOT: root, METADATA_TTL: '3s' }, upstream);
    try {
      await send(cache.url, { path: '/staley' });
      await sleep(3100);
      upstream.hook = failPackuments;
      const before = upstream.countPath('/staley');
      for (let i = 0; i < 5; i++) await send(cache.url, { path: '/staley' });
      expect(upstream.countPath('/staley') - before).toBe(1);
    } finally {
      upstream.hook = null;
      await cache.close();
    }
  });

  it('does not resurrect a package that upstream removed', async () => {
    upstream.addPackage('removed', [{ version: '1.0.0' }]);
    const first = await startCache({ FS_ROOT: root, METADATA_TTL: '1s' }, upstream);
    try {
      expect((await send(first.url, { path: '/removed' })).status).toBe(200);
      await sleep(1100);
      upstream.packuments.delete('removed');
      expect((await send(first.url, { path: '/removed' })).status).toBe(404);
    } finally {
      await first.close(); // drains the tombstone write
    }
    upstream.hook = failPackuments;
    const second = await startCache({ FS_ROOT: root }, upstream);
    try {
      expect((await send(second.url, { path: '/removed' })).status).toBe(502);
    } finally {
      upstream.hook = null;
      await second.close();
    }
  });
});
