import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/config.ts';
import { startCommunity, type RunningCache } from '../../src/main.ts';
import { FakeUpstream } from '../fake-upstream.ts';

export interface TestCache {
  url: string;
  /** Management port: /livez, /readyz, /metrics. */
  managementUrl: string;
  config: Config;
  root: string;
  upstream: FakeUpstream;
  running: RunningCache;
  close(): Promise<void>;
}

export async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    srv.close(() => {
      resolve();
    }),
  );
  return port;
}

/**
 * Runs `start` with two free ports, and again with fresh ones when a port was taken in the
 * meantime: freePort releases the port before the server binds it, so a test file running in
 * parallel can grab it (EADDRINUSE, seen in CI on eyniq/cache#7). `start` must release what it
 * opened before it throws.
 */
export async function withFreePorts<T>(
  start: (port: number, managementPort: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const managementPort = await freePort();
    try {
      return await start(port, managementPort);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 5) throw err;
    }
  }
}

/** Start a fake upstream (unless given) and a cache in front of it, on loopback. */
export async function startCache(
  env: Record<string, string> = {},
  existingUpstream?: FakeUpstream,
): Promise<TestCache> {
  const upstream = existingUpstream ?? new FakeUpstream();
  if (!upstream.origin) await upstream.start();
  const root = env.FS_ROOT ?? (await mkdtemp(join(tmpdir(), 'eyniq-cache-test-')));
  // startCommunity releases the first port and the workers when the second listen fails.
  const { port, config, running } = await withFreePorts(async (port, managementPort) => {
    const config = loadConfig({
      PORT: String(port),
      MANAGEMENT_PORT: String(managementPort),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      UPSTREAM_URL: upstream.origin,
      FS_ROOT: root,
      MIN_RELEASE_AGE: '0',
      LOG_LEVEL: 'error',
      WORKERS: '2',
      ...env,
    });
    const running = await startCommunity(config, { host: '127.0.0.1' });
    return { port, config, running };
  });
  return {
    url: `http://127.0.0.1:${port}`,
    managementUrl: `http://127.0.0.1:${running.managementPort}`,
    config,
    root,
    upstream,
    running,
    async close() {
      await running.close();
      if (!existingUpstream) await upstream.stop();
      if (!env.FS_ROOT) await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Every file stored under the cache root with its contents, for "this secret is never
 * stored" checks. Background writes (e.g. the packument persisted after a fetch) are drained
 * first: walking while one runs lists its `.tmp/*.part` file, which the write then renames
 * away before it is read (ENOENT; flaky on slow CI runners). A temp file that still vanishes
 * mid-walk belongs to a write drain() does not cover (a statistics flush) and is skipped.
 */
export async function storedFiles(cache: TestCache): Promise<{ path: string; body: Buffer }[]> {
  await cache.running.drain();
  const tmpDir = join(cache.root, '.tmp');
  const out: { path: string; body: Buffer }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(path);
        continue;
      }
      try {
        out.push({ path, body: await readFile(path) });
      } catch (err) {
        const vanishedTemp = dir === tmpDir && (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (!vanishedTemp) throw err;
      }
    }
  };
  await walk(cache.root);
  return out;
}
