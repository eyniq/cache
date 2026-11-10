import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, type CapturedLogs } from '../../src/core/log.ts';
import { FakeUpstream } from '../fake-upstream.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';

let cache: TestCache;
let logs: CapturedLogs;

beforeAll(async () => {
  cache = await startCache({ LOG_LEVEL: 'info' });
  const up = cache.upstream;
  up.addPackage('lodash', [{ version: '4.17.20' }, { version: '4.17.21' }]);
  up.addPackage('corrupt', [{ version: '1.0.0', corrupt: true }]);
  up.addPackage('legacy', [{ version: '0.1.0', sha1Only: true }]);
  up.addPackage('nointegrity', [{ version: '1.0.0', noIntegrity: true }]);
});

afterAll(async () => {
  await cache.close();
});

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  aborted: boolean;
}

/** Low-level GET that reports aborted bodies instead of throwing. */
function get(
  path: string,
  headers: Record<string, string> = {},
  base: string = cache.url,
): Promise<RawResponse> {
  return new Promise((resolve) => {
    // Raw path on purpose: a URL object would normalise %2e%2e before it reaches the cache.
    const { hostname, port } = new URL(base);
    const req = httpRequest({ hostname, port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      let aborted = false;
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('aborted', () => (aborted = true));
      res.on('error', () => (aborted = true));
      res.on('close', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          aborted: aborted || !res.complete,
        });
      });
    });
    // A connection cut before the response arrives is also an aborted download.
    req.on('error', () => {
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true });
    });
    req.end();
  });
}

describe('slice 1: proxy one unscoped package', () => {
  it('serves the full packument with tarball URLs rewritten to PUBLIC_URL', async () => {
    const res = await get('/lodash');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const doc = JSON.parse(res.body.toString()) as {
      versions: Record<string, { dist: { tarball: string } }>;
    };
    expect(doc.versions['4.17.21']!.dist.tarball).toBe(`${cache.url}/lodash/-/lodash-4.17.21.tgz`);
  });

  it('streams the tarball byte-for-byte and serves the second request from storage', async () => {
    const path = '/lodash/-/lodash-4.17.21.tgz';
    const expected = cache.upstream.tarballs.get(path)!;
    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.aborted).toBe(false);
    expect(first.body.equals(expected)).toBe(true);
    const second = await get(path);
    expect(second.status).toBe(200);
    expect(second.body.equals(expected)).toBe(true);
    expect(second.headers['content-length']).toBe(String(expected.length));
    expect(cache.upstream.countPath(path)).toBe(1);
  });

  it('never fetches a tarball from the host named in the packument', async () => {
    // A second server stands in for a foreign host; it must never receive a request.
    const foreign = new FakeUpstream();
    await foreign.start();
    try {
      cache.upstream.addPackage('foreignhost', [{ version: '1.0.0' }]);
      const doc = cache.upstream.packuments.get('foreignhost') as {
        versions: Record<string, { dist: { tarball: string } }>;
      };
      doc.versions['1.0.0']!.dist.tarball = `${foreign.origin}/foreignhost/-/foreignhost-1.0.0.tgz`;
      const res = await get('/foreignhost/-/foreignhost-1.0.0.tgz');
      expect(res.status).toBe(200);
      expect(res.aborted).toBe(false);
      expect(foreign.requests).toHaveLength(0);
      expect(cache.upstream.countPath('/foreignhost/-/foreignhost-1.0.0.tgz')).toBe(1);
    } finally {
      await foreign.stop();
    }
  });

  it('finishes and caches a download when the client disconnects halfway', async () => {
    cache.upstream.addPackage('slowpkg', [{ version: '1.0.0' }]);
    const path = '/slowpkg/-/slowpkg-1.0.0.tgz';
    const bytes = cache.upstream.tarballs.get(path)!;
    cache.upstream.hook = (req, res) => {
      if (req.url !== path) return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(bytes.subarray(0, bytes.length >> 1));
      setTimeout(() => res.end(bytes.subarray(bytes.length >> 1)), 300);
      return true;
    };
    try {
      const { hostname, port } = new URL(cache.url);
      await new Promise<void>((resolve) => {
        const req = httpRequest({ hostname, port, path }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => undefined);
        req.end();
      });
      const hex = createHash('sha512').update(bytes).digest('hex');
      const file = join(cache.root, 'tarballs', 'sha512', hex);
      await waitFor(async () => (await stat(file).catch(() => null)) !== null);
      const second = await get(path);
      expect(second.body.equals(bytes)).toBe(true);
      expect(cache.upstream.countPath(path)).toBe(1);
    } finally {
      cache.upstream.hook = null;
    }
  });

  it('aborts a tarball whose bytes do not match the integrity and does not cache it', async () => {
    const path = '/corrupt/-/corrupt-1.0.0.tgz';
    const first = await get(path);
    // The cache commits to 200 before verification ends, so failure must show as an abort.
    expect(first.aborted).toBe(true);
    // Let the failed download settle (temp object removed, coalescer key released) first.
    await new Promise((r) => setTimeout(r, 100));
    const second = await get(path);
    expect(second.aborted).toBe(true);
    // Not cached: the second request went upstream again.
    expect(cache.upstream.countPath(path)).toBe(2);
  });

  it('verifies legacy sha1-only tarballs', async () => {
    const res = await get('/legacy/-/legacy-0.1.0.tgz');
    expect(res.status).toBe(200);
    expect(res.aborted).toBe(false);
  });

  it('refuses tarballs without integrity data with 502', async () => {
    const res = await get('/nointegrity/-/nointegrity-1.0.0.tgz');
    expect(res.status).toBe(502);
  });

  it('returns 404 for unknown packages and unknown versions', async () => {
    expect((await get('/does-not-exist')).status).toBe(404);
    expect((await get('/lodash/-/lodash-9.9.9.tgz')).status).toBe(404);
  });

  it('rejects traversal attempts with 400 before touching upstream', async () => {
    const before = cache.upstream.requests.length;
    for (const p of [
      '/..%2f..%2fetc%2fpasswd',
      '/lodash/-/..%2f..%2fsecret.tgz',
      '/%2e%2e',
      '/a%00b',
    ]) {
      expect((await get(p)).status).toBe(400);
    }
    expect(cache.upstream.requests.length).toBe(before);
  });

  it('writes one JSON log line per request without tokens or bodies', async () => {
    await get('/lodash', { authorization: 'Bearer do-not-log-me' });
    const line = logs.lines.find((l) => l.msg === 'request' && l.path === '/lodash');
    expect(line).toMatchObject({
      method: 'GET',
      status: 200,
      cache: expect.any(String) as unknown,
    });
    expect(typeof line?.durationMs).toBe('number');
    expect(typeof line?.bytes).toBe('number');
    expect(JSON.stringify(logs.lines)).not.toContain('do-not-log-me');
  });
});

describe('slice 1: failure modes with their own cache instance', () => {
  it('serves the full download uncached when storage fails, without crashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eyniq-broken-'));
    // A regular file where FsStorage wants its temp directory makes every put fail.
    await writeFile(join(root, '.tmp'), 'not a directory');
    const broken = await startCache({ FS_ROOT: root });
    try {
      broken.upstream.addPackage('pkg', [{ version: '1.0.0' }]);
      const path = '/pkg/-/pkg-1.0.0.tgz';
      const expected = broken.upstream.tarballs.get(path)!;
      const first = await get(path, {}, broken.url);
      expect(first.aborted).toBe(false);
      expect(first.body.equals(expected)).toBe(true);
      await get(path, {}, broken.url);
      expect(broken.upstream.countPath(path)).toBe(2);
    } finally {
      await broken.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aborts and does not cache a chunked tarball above MAX_TARBALL_BYTES', async () => {
    const small = await startCache({ MAX_TARBALL_BYTES: '64' });
    try {
      small.upstream.addPackage('big', [{ version: '1.0.0' }]);
      const path = '/big/-/big-1.0.0.tgz';
      const bytes = small.upstream.tarballs.get(path)!;
      expect(bytes.length).toBeGreaterThan(64);
      small.upstream.hook = (req, res) => {
        if (req.url !== path) return false;
        res.writeHead(200); // chunked: no content-length to reject up front
        res.end(bytes);
        return true;
      };
      expect((await get(path, {}, small.url)).aborted).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      await get(path, {}, small.url);
      expect(small.upstream.countPath(path)).toBe(2);
    } finally {
      await small.close();
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
