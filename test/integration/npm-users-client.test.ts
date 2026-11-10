// C3: the real npm CLI against the user store: npm login (web login is not offered, so npm
// falls back to the password flow), whoami, token list/create/revoke, logout.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientEnv } from '../helpers/client-env.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';

const hasNpm = spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0;
const PASSWORD = 'correct horse battery';

let cache: TestCache;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-npm-users-'));
  const t = '2026-10-01T00:00:00.000Z';
  const password = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({ version: 1, users: { alice: { password, created: t, changed: t } } }),
  );
  cache = await startCache({ USERS_FILE: join(dir, 'users.json') });
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

/** `answers` are typed one by one, each after the previous prompt appeared. */
function npm(args: string[], answers: string[] = []): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npm',
      [...args, '--registry', `${cache.url}/`, '--userconfig', join(dir, '.npmrc')],
      {
        cwd: dir,
        env: clientEnv({ npm_config_update_notifier: 'false', CI: 'true' }),
      },
    );
    let output = '';
    const pending = [...answers];
    const onOutput = (c: Buffer): void => {
      output += c.toString();
      // npm prompts "Username:" and "Password:"; answer each once it is shown.
      if (pending.length > 0 && /: $/.test(output)) child.stdin.write(`${pending.shift()}\n`);
      if (pending.length === 0) child.stdin.end();
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
    if (pending.length === 0) child.stdin.end();
  });
}

describe.skipIf(!hasNpm)('C3: real npm client against the user store', () => {
  it('logs in, manages tokens and logs out', async () => {
    const login = await npm(['login', '--auth-type=legacy'], ['alice', PASSWORD]);
    expect(login.code, login.output).toBe(0);
    const npmrc = await readFile(join(dir, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/_authToken=eyc_/);
    expect(login.output).not.toContain(PASSWORD);

    const who = await npm(['whoami']);
    expect(who.code, who.output).toBe(0);
    expect(who.output.trim()).toBe('alice');

    const list = await npm(['token', 'list', '--json']);
    expect(list.code, list.output).toBe(0);
    const tokens = JSON.parse(list.output) as Array<{ key: string; token: string }>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toMatch(/^eyc_/);

    const logout = await npm(['logout']);
    expect(logout.code, logout.output).toBe(0);
    const after = await npm(['whoami']);
    expect(after.code).not.toBe(0);
  });

  it('falls back to the password flow when npm tries web login first', async () => {
    const login = await npm(['login'], ['alice', PASSWORD]);
    expect(login.code, login.output).toBe(0);
    const who = await npm(['whoami']);
    expect(who.output.trim()).toBe('alice');
    await npm(['logout']);
  });
});
