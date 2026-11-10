// C4: the real npm CLI against the community build with private packages: login, publish
// (scoped and unscoped), dist-tag add/rm, install, deprecate, unpublish, search.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientEnv } from '../helpers/client-env.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { send } from '../helpers/http.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';

const hasNpm = spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0;
const PASSWORD = 'correct horse battery';

let cache: TestCache;
let dir: string;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-npm-private-'));
  const t = '2026-10-01T00:00:00.000Z';
  const password = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({ version: 1, users: { alice: { password, created: t, changed: t } } }),
  );
  cache = await startCache({
    USERS_FILE: join(dir, 'users.json'),
    PRIVATE_PACKAGES: '@acme/*,acme-cli',
    MIN_RELEASE_AGE: '3d',
  });
  const r = await send(cache.url, {
    method: 'PUT',
    path: '/-/user/org.couchdb.user:alice',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: PASSWORD }),
  });
  token = (JSON.parse(r.body.toString()) as { token: string }).token;
  const host = cache.url.replace(/^http:/, '');
  await writeFile(
    join(dir, '.npmrc'),
    `registry=${cache.url}/\n${host}/:_authToken=${token}\nupdate-notifier=false\n`,
  );
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

function npm(args: string[], cwd = dir): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', [...args, '--userconfig', join(dir, '.npmrc')], {
      cwd,
      env: clientEnv({ npm_config_update_notifier: 'false', CI: 'true' }),
    });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function pkg(name: string, version: string): Promise<string> {
  const d = await mkdtemp(join(dir, 'pkg-'));
  await writeFile(
    join(d, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js', description: `${name} for tests` }),
  );
  await writeFile(join(d, 'index.js'), `module.exports = ${JSON.stringify(version)};\n`);
  await writeFile(join(d, 'README.md'), `# ${name}\n`);
  return d;
}

describe.skipIf(!hasNpm)('C4: real npm client against private packages', () => {
  it('publishes, tags, installs, searches, deprecates and unpublishes', async () => {
    for (const v of ['1.0.0', '1.1.0']) {
      const r = await npm(['publish', '--access', 'restricted'], await pkg('@acme/lib', v));
      expect(r.code, r.output).toBe(0);
    }
    const cli = await npm(['publish'], await pkg('acme-cli', '0.1.0'));
    expect(cli.code, cli.output).toBe(0);
    const again = await npm(['publish'], await pkg('acme-cli', '0.1.0'));
    expect(again.code).not.toBe(0);

    const tag = await npm(['dist-tag', 'add', '@acme/lib@1.0.0', 'stable']);
    expect(tag.code, tag.output).toBe(0);
    const tags = await npm(['dist-tag', 'ls', '@acme/lib']);
    expect(tags.output).toContain('stable: 1.0.0');
    const rmTag = await npm(['dist-tag', 'rm', '@acme/lib', 'stable']);
    expect(rmTag.code, rmTag.output).toBe(0);

    const project = await mkdtemp(join(dir, 'consumer-'));
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }),
    );
    // Published a moment ago and MIN_RELEASE_AGE=3d: own packages are not held back.
    const install = await npm(
      ['install', '@acme/lib@1.0.0', 'acme-cli', '--no-audit', '--no-fund'],
      project,
    );
    expect(install.code, install.output).toBe(0);
    const installed = JSON.parse(
      await readFile(join(project, 'node_modules', '@acme', 'lib', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe('1.0.0');

    const search = await npm(['search', 'acme', '--json']);
    expect(search.code, search.output).toBe(0);
    const found = (JSON.parse(search.output) as Array<{ name: string }>).map((p) => p.name);
    expect(found).toEqual(expect.arrayContaining(['@acme/lib', 'acme-cli']));

    const deprecate = await npm(['deprecate', '@acme/lib@1.0.0', 'use 1.1.0']);
    expect(deprecate.code, deprecate.output).toBe(0);
    const view = await npm(['view', '@acme/lib@1.0.0', 'deprecated']);
    expect(view.output.trim()).toBe('use 1.1.0');

    const unpublish = await npm(['unpublish', '@acme/lib@1.1.0', '--force']);
    expect(unpublish.code, unpublish.output).toBe(0);
    const versions = await npm(['view', '@acme/lib', 'versions', '--json']);
    expect(JSON.parse(versions.output)).toEqual(['1.0.0']);
    const republish = await npm(['publish'], await pkg('@acme/lib', '1.1.0'));
    expect(republish.code).not.toBe(0);

    const fetched = cache.upstream.requests.filter(
      (q) => q.path.includes('acme') && !q.path.startsWith('/-/v1/search'),
    );
    expect(fetched).toEqual([]);
  });
});
