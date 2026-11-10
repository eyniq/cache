// Starts createServer() with community defaults that a test can override one by one, the way
// a downstream build composes its own deps.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import { NoAuth } from '../../src/auth/none.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import type { ServerDeps } from '../../src/core/contracts.ts';
import { createUpstream } from '../../src/core/upstream.ts';
import { createServer, type CacheServer, type ServerOptions } from '../../src/http/server.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { RecordingAuditSink } from '../../src/testing/audit.ts';
import { FakeUpstream } from '../../src/testing/fake-upstream.ts';
import { withFreePorts } from './cache.ts';

export interface TestServer {
  url: string;
  managementUrl: string;
  config: Config;
  root: string;
  upstream: FakeUpstream;
  audit: RecordingAuditSink;
  deps: ServerDeps;
  app: CacheServer;
  close(): Promise<void>;
}

export interface StartServerOptions {
  deps?: Partial<ServerDeps>;
  env?: Record<string, string>;
  options?: ServerOptions;
}

export async function startServer(opts: StartServerOptions = {}): Promise<TestServer> {
  const upstream = new FakeUpstream();
  await upstream.start();
  const root = await mkdtemp(join(tmpdir(), 'eyniq-server-test-'));
  const started = await withFreePorts(async (port, mgmtPort) => {
    const config = loadConfig({
      PORT: String(port),
      MANAGEMENT_PORT: String(mgmtPort),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      UPSTREAM_URL: upstream.origin,
      FS_ROOT: root,
      MIN_RELEASE_AGE: '0',
      LOG_LEVEL: 'error',
      ...opts.env,
    });
    const audit = new RecordingAuditSink();
    const client = createUpstream({
      url: config.upstreamUrl,
      maxConnections: 16,
      timeoutMs: 5000,
    });
    const deps: ServerDeps = {
      storage: new FsStorage(root),
      auth: new NoAuth(),
      policy: new MinReleaseAgePolicy({
        minAgeMs: config.minReleaseAgeMs,
        failClosed: config.failClosed,
        allowlist: [],
      }),
      audit,
      adapters: [new NpmAdapter()],
      config,
      upstream: client,
      ...opts.deps,
    };
    const app = createServer(deps, opts.options);
    try {
      await app.listen(port, '127.0.0.1');
      const managementPort = await app.listenManagement(config.managementPort, '127.0.0.1');
      return { port, managementPort, config, audit, client, deps, app };
    } catch (err) {
      // Release this attempt before withFreePorts retries with fresh ports.
      await app.close();
      client.close();
      throw err;
    }
  });
  const { port, managementPort, config, audit, client, deps, app } = started;
  return {
    url: `http://127.0.0.1:${port}`,
    managementUrl: `http://127.0.0.1:${managementPort}`,
    config,
    root,
    upstream,
    audit,
    deps,
    app,
    async close() {
      await app.close();
      client.close();
      await upstream.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
