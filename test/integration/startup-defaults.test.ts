// Insecure defaults are loud, and the management port can be bound to one address.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { captureLogs, type CapturedLogs } from '../../src/core/log.ts';
import { startCommunity, type RunningCache } from '../../src/main.ts';
import { startCache, withFreePorts, type TestCache } from '../helpers/cache.ts';

let cache: TestCache | null = null;
let logs: CapturedLogs | null = null;
let dir: string | null = null;

afterEach(async () => {
  logs?.restore();
  logs = null;
  await cache?.close();
  cache = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const noAuthWarning = (l: Record<string, unknown>): boolean =>
  l.level === 'warn' && typeof l.msg === 'string' && /auth is DISABLED/.test(l.msg);

describe('startup warnings', () => {
  it('warns loudly when no auth is configured', async () => {
    logs = captureLogs();
    cache = await startCache({ LOG_LEVEL: 'warn' });
    expect(logs.lines.some(noAuthWarning)).toBe(true);
  });

  it('does not warn when tokens are configured', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eyniq-startup-'));
    const tokens = join(dir, 'tokens.json');
    await writeFile(tokens, JSON.stringify({ ci: createHash('sha256').update('t').digest('hex') }));
    logs = captureLogs();
    cache = await startCache({ AUTH_TOKENS_PATH: tokens, LOG_LEVEL: 'warn' });
    expect(logs.lines.some(noAuthWarning)).toBe(false);
  });
});

/** A non-loopback IPv4 address of this machine, if it has one. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('MANAGEMENT_HOST', () => {
  const lan = lanAddress();

  it.skipIf(lan === undefined)('binds only the management port to that address', async () => {
    dir = await mkdtemp(join(tmpdir(), 'eyniq-startup-'));
    const root = dir;
    let running: RunningCache | null = null;
    try {
      const started = await withFreePorts(async (port, managementPort) => {
        const config = loadConfig({
          PORT: String(port),
          MANAGEMENT_PORT: String(managementPort),
          MANAGEMENT_HOST: '127.0.0.1',
          PUBLIC_URL: `http://127.0.0.1:${String(port)}`,
          UPSTREAM_URL: 'http://127.0.0.1:9',
          FS_ROOT: root,
          LOG_LEVEL: 'error',
          WORKERS: '1',
          STATS_HISTORY: 'false',
        });
        // No host for the registry port: it listens on every interface.
        return { running: await startCommunity(config), port };
      });
      running = started.running;
      expect(await reachable(lan!, started.port)).toBe(true);
      expect(await reachable('127.0.0.1', running.managementPort)).toBe(true);
      expect(await reachable(lan!, running.managementPort)).toBe(false);
    } finally {
      await running?.close();
    }
  });
});
