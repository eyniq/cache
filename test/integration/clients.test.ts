import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientEnv } from '../helpers/client-env.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';

let cache: TestCache;
const dirs: string[] = [];

/** A fresh cache per client, so every client's first install really is cold. */
async function freshCache(): Promise<TestCache> {
  const c = await startCache();
  c.upstream.addPackage('lodash', [{ version: '4.17.20' }, { version: '4.17.21' }]);
  c.upstream.addPackage('@scope/thing', [
    { version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
  ]);
  c.upstream.addPackage('left-pad', [{ version: '1.3.0' }]);
  return c;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function available(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Run a client asynchronously; the cache runs in this process, so never block the loop. */
function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: clientEnv({
        npm_config_registry: `${cache.url}/`,
        npm_config_update_notifier: 'false',
        // pnpm and yarn read these as well; keep every client off the real registry.
        YARN_REGISTRY: `${cache.url}/`,
        CI: 'true',
      }),
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eyniq-client-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-project',
      version: '1.0.0',
      private: true,
      dependencies: { lodash: '^4.17.0', '@scope/thing': '^1.0.0', 'left-pad': '1.3.0' },
    }),
  );
  await writeFile(join(dir, '.npmrc'), `registry=${cache.url}/\n`);
  return dir;
}

async function installedVersion(dir: string, name: string): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

const tarballFetches = () => cache.upstream.count((r) => r.path.endsWith('.tgz'));

type Client = {
  name: string;
  cmd: string;
  args: (dir: string) => string[];
};

const clients: Client[] = [
  {
    name: 'npm',
    cmd: 'npm',
    args: (dir) => ['install', '--no-audit', '--no-fund', '--cache', join(dir, '.client-cache')],
  },
  {
    name: 'pnpm',
    cmd: 'pnpm',
    args: (dir) => [
      'install',
      '--store-dir',
      join(dir, '.client-cache'),
      '--registry',
      `${cache.url}/`,
      '--config.minimum-release-age=0',
    ],
  },
  {
    name: 'yarn',
    cmd: 'yarn',
    args: (dir) => [
      'install',
      '--non-interactive',
      '--no-lockfile',
      '--cache-folder',
      join(dir, '.client-cache'),
      '--registry',
      `${cache.url}/`,
    ],
  },
];

describe.each(clients)('real client: $name', (client) => {
  const present = available(client.cmd);

  beforeAll(async () => {
    cache = await freshCache();
  });

  afterAll(async () => {
    await cache.close();
  });

  it.skipIf(!present)('installs cold and warm through the cache', async () => {
    const cold = await project();
    const first = await run(client.cmd, client.args(cold), cold);
    expect(tarballFetches()).toBeGreaterThan(0);
    expect(first.code, first.output).toBe(0);
    expect(await installedVersion(cold, 'lodash')).toBe('4.17.21');
    expect(await installedVersion(cold, '@scope/thing')).toBe('1.0.0');
    expect(await installedVersion(cold, 'left-pad')).toBe('1.3.0');

    // Warm: a fresh project and client cache; every tarball must come from the cache.
    const before = tarballFetches();
    const warm = await project();
    const second = await run(client.cmd, client.args(warm), warm);
    expect(second.code, second.output).toBe(0);
    expect(await installedVersion(warm, 'lodash')).toBe('4.17.21');
    expect(tarballFetches()).toBe(before);
  });
});

it('runs every real client in CI', () => {
  // Locally a missing client is skipped; CI installs all three, so it must never skip there.
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const c of clients) expect(available(c.cmd), `${c.cmd} on PATH`).toBe(true);
  }
});
