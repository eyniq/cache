// A cold burst of misses must not turn into a burst of storage PUTs: background writes are
// bounded per pod, nothing is lost, and the new metrics show it.
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageTimeout } from '../../src/core/storage.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { S3Storage } from '../../src/storage/s3.ts';
import { send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FsStorage that answers puts slowly, like versitygw on an overloaded NFS volume. */
class SlowStorage extends FsStorage {
  inFlight = 0;
  maxInFlight = 0;
  puts = 0;
  readonly timeoutsSeen = new Set<number | undefined>();

  override async put(
    key: string,
    body: Readable,
    opts?: { contentType?: string; timeoutMs?: number },
  ): Promise<void> {
    this.puts++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.timeoutsSeen.add(opts?.timeoutMs);
    try {
      await sleep(15);
      await super.put(key, body);
    } finally {
      this.inFlight--;
    }
  }
}

let server: TestServer | undefined;
const roots: string[] = [];
async function slowStorage(): Promise<SlowStorage> {
  const root = await mkdtemp(join(tmpdir(), 'eyniq-slow-'));
  roots.push(root);
  return new SlowStorage(root);
}
afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('background storage writes', () => {
  it('stay within STORAGE_WRITE_CONCURRENCY under a burst of misses and lose nothing', async () => {
    const storage = await slowStorage();
    server = await startServer({
      deps: { storage },
      env: { STORAGE_WRITE_CONCURRENCY: '4', FS_ROOT: roots[0]! },
    });
    const N = 300;
    for (let i = 0; i < N; i++) server.upstream.addPackage(`burst-${i}`, [{ version: '1.0.0' }]);

    const statuses = await Promise.all(
      Array.from({ length: N }, (_, i) => send(server!.url, { path: `/burst-${i}` })),
    );
    expect(statuses.every((r) => r.status === 200)).toBe(true);
    await server.app.drain();

    // Two writes per miss (packument copy, then its sidecar), all of them stored.
    expect(storage.puts).toBe(N * 2);
    expect(storage.maxInFlight).toBeLessThanOrEqual(4);
    for (let i = 0; i < N; i++) {
      expect(await storage.head(`npm/packuments/burst-${i}.json.gz`)).not.toBeNull();
    }
    const metrics = (await send(server.managementUrl, { path: '/metrics' })).body.toString();
    expect(metrics).toMatch(/^eyniq_cache_storage_write_queue_length 0$/m);
    expect(metrics).toMatch(/^eyniq_cache_storage_writes_in_flight 0$/m);
    expect(metrics).toContain(
      `eyniq_cache_storage_write_duration_seconds_count{kind="metadata"} ${N}`,
    );
    expect(metrics).toContain(`eyniq_cache_storage_write_duration_seconds_count{kind="meta"} ${N}`);
    expect(metrics).toContain('# TYPE eyniq_cache_storage_write_failures_total counter');
    expect(metrics).toContain('# TYPE eyniq_cache_storage_writes_dropped_total counter');
    expect(metrics).toContain('# TYPE eyniq_cache_storage_write_retries_total counter');
    // Background writes get the longer timeout (default 120 s).
    expect([...storage.timeoutsSeen]).toEqual([120_000]);
  }, 60_000);

  it('drops writes (counted, responses unaffected) when the queue is tiny', async () => {
    const storage = await slowStorage();
    server = await startServer({
      deps: { storage },
      env: { STORAGE_WRITE_CONCURRENCY: '1', STORAGE_WRITE_QUEUE_MAX: '2', FS_ROOT: roots[0]! },
    });
    const N = 40;
    for (let i = 0; i < N; i++) server.upstream.addPackage(`tiny-${i}`, [{ version: '1.0.0' }]);
    const res = await Promise.all(
      Array.from({ length: N }, (_, i) => send(server!.url, { path: `/tiny-${i}` })),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    await server.app.drain();
    expect(storage.maxInFlight).toBe(1);
    const metrics = (await send(server.managementUrl, { path: '/metrics' })).body.toString();
    expect(metrics).toMatch(/eyniq_cache_storage_writes_dropped_total\{kind="metadata"\} [1-9]/);
  }, 60_000);

  it('still caches tarballs (streamed, outside the queue) and their index entries', async () => {
    const storage = await slowStorage();
    server = await startServer({
      deps: { storage },
      env: { STORAGE_WRITE_CONCURRENCY: '1', FS_ROOT: roots[0]! },
    });
    server.upstream.addPackage('tarpkg', [{ version: '1.0.0' }]);
    expect((await send(server.url, { path: '/tarpkg' })).status).toBe(200);
    const tgz = await send(server.url, { path: '/tarpkg/-/tarpkg-1.0.0.tgz' });
    expect(tgz.status).toBe(200);
    await server.app.drain();
    const before = server.upstream.count((r) => r.path.endsWith('.tgz'));
    expect((await send(server.url, { path: '/tarpkg/-/tarpkg-1.0.0.tgz' })).status).toBe(200);
    expect(server.upstream.count((r) => r.path.endsWith('.tgz'))).toBe(before);
    const metrics = (await send(server.managementUrl, { path: '/metrics' })).body.toString();
    expect(metrics).toContain('eyniq_cache_storage_write_duration_seconds_count{kind="tarball"} 1');
  });
});

describe('S3Storage background timeout', () => {
  it('uses the timeout passed to put() and reports a StorageTimeout', async () => {
    const hang = createHttpServer(() => undefined); // never answers
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const port = (hang.address() as AddressInfo).port;
    const s3 = new S3Storage({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'a',
      secretAccessKey: 's',
      forcePathStyle: true,
    });
    const { Readable: R } = await import('node:stream');
    const started = Date.now();
    try {
      await expect(s3.put('k', R.from([Buffer.from('x')]), { timeoutMs: 150 })).rejects.toSatisfy(
        (e: unknown) => e instanceof StorageTimeout && /S3 PUT timed out/.test(String(e)),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });
});
