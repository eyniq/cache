// The real npm CLI against the account routes: web login, whoami, token list and revoke,
// logout. Proves the wire format (login and doneUrl polling, token objects, logout path).
import { spawn, spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientEnv } from '../helpers/client-env.ts';
import type {
  AccountContext,
  AccountProvider,
  AccountToken,
  AuthProvider,
  Authorizer,
  Identity,
} from '../../src/core/contracts.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const hasNpm = spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0;
const ISSUED = 'npm_issued-by-web-login';

class Accounts implements AccountProvider {
  readonly valid = new Set<string>();
  readonly revoked: string[] = [];
  readonly deleted: string[] = [];
  private polls = 0;
  readonly tokens: AccountToken[] = [
    {
      key: 'a1b2c3d4e5',
      preview: 'npm_is',
      name: 'laptop',
      readonly: false,
      cidrWhitelist: [],
      created: '2026-01-01T00:00:00.000Z',
    },
  ];

  startWebLogin(ctx: AccountContext) {
    return Promise.resolve({
      loginUrl: `${ctx.registryUrl}/-/eyniq/sso/login?id=s1`,
      doneUrl: `${ctx.registryUrl}/-/v1/login/done/s1`,
    });
  }

  pollWebLogin(session: string) {
    if (session !== 'done/s1') return Promise.reject(new Error('unknown session'));
    if (++this.polls < 2)
      return Promise.resolve({ status: 'pending', retryAfterSeconds: 1 } as const);
    this.valid.add(ISSUED);
    return Promise.resolve({ status: 'done', token: ISSUED, name: 'alice' } as const);
  }

  listTokens() {
    return Promise.resolve(this.tokens);
  }

  deleteToken(_identity: Identity, key: string) {
    this.deleted.push(key);
    return Promise.resolve(this.tokens.some((t) => t.key === key));
  }

  logout(token: string) {
    this.revoked.push(token);
    this.valid.delete(token);
    return Promise.resolve();
  }
}

let server: TestServer;
let accounts: Accounts;
const dirs: string[] = [];

beforeAll(async () => {
  accounts = new Accounts();
  const auth: AuthProvider = {
    required: false,
    authenticate(req: IncomingMessage): Promise<Identity | null> {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      return Promise.resolve(m && accounts.valid.has(m[1]!) ? { name: 'alice' } : null);
    },
  };
  const authorizer: Authorizer = {
    authorize: (identity, action) =>
      Promise.resolve(action === 'read' || (action === 'account' && identity !== null)),
  };
  server = await startServer({ deps: { auth, authorizer, accounts } });
});

afterAll(async () => {
  await server.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function npm(args: string[], userconfig: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npm',
      [...args, '--registry', `${server.url}/`, '--userconfig', userconfig],
      {
        cwd: tmpdir(),
        env: clientEnv({ npm_config_update_notifier: 'false', CI: 'true' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr.on('data', (c: Buffer) => (output += c.toString()));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

describe.skipIf(!hasNpm)('real npm client against the account routes', () => {
  it('logs in on the web, lists and revokes tokens, and logs out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eyniq-account-'));
    dirs.push(dir);
    const rc = join(dir, '.npmrc');
    await writeFile(rc, '');

    const login = await npm(['login', '--auth-type=web'], rc);
    expect(login.code, login.output).toBe(0);
    expect(login.output).toContain('/-/eyniq/sso/login?id=s1');
    expect(await readFile(rc, 'utf8')).toContain(ISSUED);

    const whoami = await npm(['whoami'], rc);
    expect(whoami.code, whoami.output).toBe(0);
    expect(whoami.output.trim()).toBe('alice');

    const list = await npm(['token', 'list', '--json'], rc);
    expect(list.code, list.output).toBe(0);
    expect(JSON.parse(list.output)).toEqual([
      expect.objectContaining({ key: 'a1b2c3d4e5', token: 'npm_is', name: 'laptop' }),
    ]);

    const revoke = await npm(['token', 'revoke', 'a1b2c3'], rc);
    expect(revoke.code, revoke.output).toBe(0);
    expect(accounts.deleted).toEqual(['a1b2c3d4e5']);

    const logout = await npm(['logout'], rc);
    expect(logout.code, logout.output).toBe(0);
    expect(accounts.revoked).toEqual([ISSUED]);
    // npm removes the token (and an otherwise empty userconfig).
    expect(await readFile(rc, 'utf8').catch(() => '')).not.toContain(ISSUED);
  });
});
