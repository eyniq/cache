// P3: the real npm CLI against the write path: publish, dist-tag, install, unpublish. Proves
// the wire format (attachment keys, -rev routes, dist-tag bodies) rather than our reading of it.
import { spawn, spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientEnv } from '../helpers/client-env.ts';
import type { AuthProvider, Authorizer, Identity } from '../../src/core/contracts.ts';
import { MemorySource } from '../helpers/memory-source.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const hasNpm = spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0;
const TOKEN = 'publisher-token';

const auth: AuthProvider = {
  required: false,
  authenticate(req: IncomingMessage): Promise<Identity | null> {
    return Promise.resolve(
      req.headers.authorization === `Bearer ${TOKEN}` ? { name: 'publisher' } : null,
    );
  },
};
const authorizer: Authorizer = {
  authorize: (identity, action) =>
    Promise.resolve(action === 'read' || identity?.name === 'publisher'),
};

let server: TestServer;
let source: MemorySource;
const dirs: string[] = [];

beforeAll(async () => {
  source = new MemorySource((name) => name.startsWith('@acme/'));
  server = await startServer({ deps: { auth, authorizer, packageSources: { npm: source } } });
});

afterAll(async () => {
  await server.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'eyniq-publish-'));
  dirs.push(d);
  const host = server.url.replace(/^http:/, '');
  await writeFile(
    join(d, '.npmrc'),
    `registry=${server.url}/\n${host}/:_authToken=${TOKEN}\nupdate-notifier=false\n`,
  );
  return d;
}

function npm(args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', [...args, '--registry', `${server.url}/`], {
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

async function pkg(version: string): Promise<string> {
  const d = await dir();
  await writeFile(
    join(d, 'package.json'),
    JSON.stringify({ name: '@acme/lib', version, main: 'index.js' }),
  );
  await writeFile(join(d, 'index.js'), `module.exports = ${JSON.stringify(version)};\n`);
  return d;
}

describe.skipIf(!hasNpm)('P3: real npm client against the write path', () => {
  it('publishes, tags, installs, deprecates and unpublishes', async () => {
    for (const v of ['1.0.0', '1.1.0']) {
      const r = await npm(['publish', '--access', 'public'], await pkg(v));
      expect(r.code, r.output).toBe(0);
    }
    const tag = await npm(['dist-tag', 'add', '@acme/lib@1.0.0', 'stable'], await dir());
    expect(tag.code, tag.output).toBe(0);
    expect(source.docs.get('@acme/lib')?.distTags).toEqual({ latest: '1.1.0', stable: '1.0.0' });

    const project = await dir();
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }),
    );
    const install = await npm(['install', '@acme/lib@stable', '--no-audit', '--no-fund'], project);
    expect(install.code, install.output).toBe(0);
    const installed = JSON.parse(
      await readFile(join(project, 'node_modules', '@acme', 'lib', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe('1.0.0');

    const deprecate = await npm(['deprecate', '@acme/lib@1.0.0', 'use 1.1.0'], await dir());
    expect(deprecate.code, deprecate.output).toBe(0);
    expect(source.docs.get('@acme/lib')?.versions['1.0.0']?.deprecated).toBe('use 1.1.0');
    expect(source.calls.at(-1)).toMatchObject({
      op: 'deprecate',
      request: { deprecations: { '1.0.0': 'use 1.1.0' } },
    });
    const undeprecate = await npm(['deprecate', '@acme/lib@1.0.0', ''], await dir());
    expect(undeprecate.code, undeprecate.output).toBe(0);
    expect(source.docs.get('@acme/lib')?.versions['1.0.0']).not.toHaveProperty('deprecated');

    const unpublish = await npm(['unpublish', '@acme/lib@1.1.0', '--force'], await dir());
    expect(unpublish.code, unpublish.output).toBe(0);
    expect(Object.keys(source.docs.get('@acme/lib')?.versions ?? {})).toEqual(['1.0.0']);
    expect(server.upstream.requests).toHaveLength(0);
  });
});
