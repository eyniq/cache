// S3Storage.check() backs /readyz. During a CI burst every data socket can be busy (tarball
// streams hold theirs while the client reads), and a readiness HEAD queued behind them misses
// the 2 s probe timeout: both pods then report "storage unreachable" at once although the
// bucket answers fine. The probe has its own socket, so a saturated pool does not fail it.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/storage/s3.ts';

const POOL_SIZE = 64;

let server: Server | null = null;
const held: ServerResponse[] = [];

afterEach(async () => {
  for (const res of held.splice(0)) res.destroy();
  const s = server;
  server = null;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((r) => {
      s.close(() => {
        r();
      });
    });
  }
});

/**
 * Bucket HEAD answers 200 at once. The first POOL_SIZE object GETs never answer, so they keep
 * their sockets; later ones (the queued GETs, once the held ones are released) get a 404.
 */
async function stub(): Promise<{ storage: S3Storage; gets: () => number }> {
  let gets = 0;
  server = createServer((req, res) => {
    if (req.method === 'HEAD' && req.url === '/b') {
      res.writeHead(200).end();
      return;
    }
    if (++gets > POOL_SIZE) {
      res.writeHead(404).end();
      return;
    }
    held.push(res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const storage = new S3Storage({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    bucket: 'b',
    forcePathStyle: true,
    accessKeyId: 'id',
    secretAccessKey: 'not-a-real-key',
  });
  return { storage, gets: () => gets };
}

describe('S3Storage.check', () => {
  it('answers while every data socket is busy', async () => {
    const { storage, gets } = await stub();
    // More GETs than sockets: the extra ones wait in the pool's queue, like the probe used to.
    const pending = Array.from({ length: POOL_SIZE + 4 }, (_, i) =>
      storage.get(`npm/packuments/p${i}.json.gz`).catch(() => null),
    );
    // Wait until the pool is full: the stub has seen every socket's request.
    await expect.poll(gets, { timeout: 5_000 }).toBe(POOL_SIZE);

    const started = Date.now();
    await expect(storage.check()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);

    for (const res of held.splice(0)) res.destroy();
    await Promise.all(pending);
  });
});
