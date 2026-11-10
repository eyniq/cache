// Composition root of the community build (parts in src/compose.ts). Downstream builds
// compose their own deps, usually composeCommunity(config, overrides), and call
// createServer(deps) directly.
import { pathToFileURL } from 'node:url';
import { runUserCli } from './auth/users-cli.ts';
import { composeCommunity } from './compose.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { errorFields, log, setLogLevel } from './core/log.ts';
import { createServer } from './http/server.ts';
import { runStatsCli } from './stats/cli.ts';
import { WorkerPool } from './metadata/worker-pool.ts';

export interface RunningCache {
  port: number;
  managementPort: number;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function startCommunity(
  config: Config,
  opts: { host?: string } = {},
): Promise<RunningCache> {
  setLogLevel(config.logLevel);
  const deps = await composeCommunity(config);
  const pool = new WorkerPool({
    size: config.workers,
    recycleBytes: config.workerRecycleBytes,
    maxQueuedBytes: config.metadataQueueBytes,
  });
  const app = createServer(deps, { processor: pool });
  if (config.minReleaseAgeMs === 0) {
    log.warn('MIN_RELEASE_AGE is 0: the minimum release age gate is DISABLED');
  }
  if (config.authTokensPath === null && config.usersFile === null) {
    log.warn(
      'no AUTH_TOKENS_PATH or USERS_FILE: auth is DISABLED, anyone who can reach PORT can ' +
        'read every package through this cache (an open proxy); keep it on a private network',
    );
  }
  let port: number;
  let managementPort: number;
  try {
    port = await app.listen(config.port, opts.host);
    managementPort = await app.listenManagement(
      config.managementPort,
      config.managementHost ?? opts.host,
    );
  } catch (err) {
    // e.g. EADDRINUSE on the second port: release the first one and the worker threads.
    await app.close();
    deps.dispose();
    throw err;
  }
  return {
    port,
    managementPort,
    drain: () => app.drain(),
    async close() {
      await app.close();
      deps.dispose();
    },
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  let running: RunningCache;
  try {
    running = await startCommunity(config);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  log.info('listening', { port: running.port, upstream: config.upstreamUrl });
  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', errorFields(err));
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'user') {
    // `node dist/main.js user add <name>`: manage USERS_FILE, then exit (no server).
    runUserCli(process.argv.slice(3), {
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    }).then(
      (code) => process.exit(code),
      (err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
  } else if (process.argv[2] === 'stats') {
    // `node dist/main.js stats [--range 24h]`: summary of the recorded statistics history.
    runStatsCli(process.argv.slice(3), {
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    }).then(
      (code) => process.exit(code),
      (err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
  } else {
    main().catch((err: unknown) => {
      log.error('fatal', errorFields(err));
      process.exit(1);
    });
  }
}
