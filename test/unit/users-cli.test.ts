import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.ts';
import { runUserCli } from '../../src/auth/users-cli.ts';
import { parseUsers } from '../../src/auth/users.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-users-cli-'));
  path = join(dir, 'users.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[], input = '', env: Record<string, string> = {}) {
  const stdin = new PassThrough();
  stdin.end(input);
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (c: Buffer) => out.push(c.toString()));
  stderr.on('data', (c: Buffer) => err.push(c.toString()));
  const code = await runUserCli(args, {
    env: { USERS_FILE: path, ...env },
    stdin,
    stdout,
    stderr,
    hashParams: { ln: 10, r: 8, p: 1 },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const users = async () => parseUsers(await readFile(path, 'utf8')).users;

describe('user CLI', () => {
  it('adds a user with the password read from stdin', async () => {
    const r = await run(['add', 'alice', '--packages', ''], 'correct horse battery\n');
    expect(r.code, r.stderr).toBe(0);
    const alice = (await users()).alice;
    expect(alice).toBeDefined();
    expect(await verifyPassword('correct horse battery', alice!.password)).toBe(true);
    expect(await readFile(path, 'utf8')).not.toContain('correct horse');
    expect(r.stdout + r.stderr).not.toContain('correct horse');
  });

  it('needs an explicit --packages on add ("*" for every owned package, "" for none)', async () => {
    const missing = await run(['add', 'alice'], 'correct horse battery\n');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--packages/);
    const all = await run(['add', 'alice', '--packages', '*'], 'correct horse battery\n');
    expect(all.code, all.stderr).toBe(0);
    expect((await users()).alice?.packages).toEqual(['*']);
    const none = await run(['add', 'bob', '--packages', ''], 'correct horse battery\n');
    expect(none.code, none.stderr).toBe(0);
    expect((await users()).bob?.packages).toEqual([]);
  });

  it('records publish patterns given with --packages', async () => {
    const r = await run(['add', 'ci', '--packages', '@acme/*,tool'], 'correct horse battery\n');
    expect(r.code, r.stderr).toBe(0);
    expect((await users()).ci?.packages).toEqual(['@acme/*', 'tool']);
  });

  it('never takes a password from the command line', async () => {
    const r = await run(['add', 'alice', '--packages', '', 'correct horse battery']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/usage/i);
    expect(r.stderr).not.toContain('correct horse');
  });

  it('refuses invalid names, weak passwords, duplicates and unknown users', async () => {
    expect(
      (await run(['add', 'Alice', '--packages', ''], 'correct horse battery\n')).code,
    ).not.toBe(0);
    expect((await run(['add', 'alice', '--packages', ''], 'short\n')).code).not.toBe(0);
    expect((await run(['add', 'alice', '--packages', ''], '\n')).code).not.toBe(0);
    expect((await run(['add', 'alice', '--packages', ''], 'correct horse battery\n')).code).toBe(0);
    expect(
      (await run(['add', 'alice', '--packages', ''], 'another long password\n')).code,
    ).not.toBe(0);
    expect((await run(['passwd', 'bob'], 'another long password\n')).code).not.toBe(0);
    expect((await run(['remove', 'bob'])).code).not.toBe(0);
  });

  it('changes a password (and the change time) and removes users', async () => {
    await run(['add', 'alice', '--packages', ''], 'correct horse battery\n');
    const before = (await users()).alice!;
    await new Promise((r) => setTimeout(r, 5));
    const r = await run(['passwd', 'alice'], 'another long password\n');
    expect(r.code, r.stderr).toBe(0);
    const after = (await users()).alice!;
    expect(await verifyPassword('another long password', after.password)).toBe(true);
    expect(Date.parse(after.changed)).toBeGreaterThan(Date.parse(before.changed));
    expect(after.generation).toBeGreaterThan(before.generation!);
    expect((await run(['remove', 'alice'])).code).toBe(0);
    expect((await users()).alice).toBeUndefined();
  });

  it('lists users without hashes', async () => {
    await run(['add', 'alice', '--packages', ''], 'correct horse battery\n');
    await run(['add', 'bob', '--packages', '@acme/*'], 'correct horse battery\n');
    const r = await run(['list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('alice');
    expect(r.stdout).toContain('@acme/*');
    expect(r.stdout).not.toContain('$scrypt$');
  });

  it('needs USERS_FILE or --file', async () => {
    const stdin = new PassThrough();
    stdin.end();
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (c: Buffer) => (err += c.toString()));
    const code = await runUserCli(['list'], { env: {}, stdin, stdout: new PassThrough(), stderr });
    expect(code).not.toBe(0);
    expect(err).toMatch(/USERS_FILE/);
    const viaFlag = await run(
      ['--file', path, 'add', 'alice', '--packages', '*'],
      'correct horse battery\n',
      {
        USERS_FILE: '',
      },
    );
    expect(viaFlag.code, viaFlag.stderr).toBe(0);
  });
});
