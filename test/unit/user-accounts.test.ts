import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginLimiter } from '../../src/auth/login-limiter.ts';
import { LookupLimiter } from '../../src/auth/lookup-limiter.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { UserAccounts } from '../../src/auth/user-accounts.ts';
import { UserAuth } from '../../src/auth/user-auth.ts';
import { UserTokenStore } from '../../src/auth/user-tokens.ts';
import { UsersFile, nextGeneration } from '../../src/auth/users.ts';
import type { AccountContext } from '../../src/core/contracts.ts';
import { isHttpError } from '../../src/core/errors.ts';
import { FsStorage } from '../../src/storage/fs.ts';

// Costly enough that a skipped hash is obvious (tens of ms), cheap enough for a unit test.
const PARAMS = { ln: 14, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';
let dir: string;
let users: UsersFile;
let tokens: UserTokenStore;
let auth: UserAuth;

const ctx: AccountContext = {
  requestId: 'r',
  ecosystem: 'npm',
  registryUrl: 'http://localhost',
  audit: () => undefined,
};

function accounts(
  limiter = new LoginLimiter(),
  extra: Partial<ConstructorParameters<typeof UserAccounts>[0]> = {},
): UserAccounts {
  return new UserAccounts({
    users,
    tokens,
    limiter,
    tokenTtlMs: 86_400_000,
    registration: { enabled: false, maxUsers: 10 },
    stillValid: (r) => auth.stillValid(r),
    ...extra,
  });
}

const bearer = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-user-accounts-'));
  const t = '2026-10-01T00:00:00.000Z';
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({
      version: 1,
      users: { alice: { password: await hashPassword(PASSWORD, PARAMS), created: t, changed: t } },
    }),
  );
  users = await UsersFile.open(join(dir, 'users.json'), { reloadIntervalMs: 0 });
  tokens = new UserTokenStore({ storage: new FsStorage(join(dir, 'data')), cacheTtlMs: 0 });
  auth = new UserAuth({ users, tokens, required: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function timed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

describe('UserAccounts', () => {
  it('spends the same hashing work on unknown users as on wrong passwords', async () => {
    const a = accounts(new LoginLimiter({ userFreeFailures: 100 }));
    const name = { action: 'user-login' as const };
    let wrong = 0;
    let unknown = 0;
    for (let i = 0; i < 3; i++) {
      wrong += await timed(() => a.login({ ...name, name: 'alice', password: 'nope nope' }, ctx));
      unknown += await timed(() => a.login({ ...name, name: `ghost${i}`, password: 'x' }, ctx));
    }
    expect(unknown).toBeGreaterThan(wrong * 0.5);
  });

  it('a throttled user fails without a password check', async () => {
    const a = accounts(new LoginLimiter({ userFreeFailures: 0 }));
    expect(
      await a.login({ action: 'user-login', name: 'alice', password: 'bad one' }, ctx),
    ).toBeNull();
    const t = await timed(async () => {
      expect(
        await a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx),
      ).toBeNull();
    });
    expect(t).toBeLessThan(20);
  });

  it('spends hashing work on refused registrations too', async () => {
    const a = accounts(new LoginLimiter({ userFreeFailures: 100 }), {
      registration: { enabled: true, maxUsers: 10 },
      hashParams: PARAMS,
    });
    let wrong = 0;
    let refused = 0;
    for (let i = 0; i < 3; i++) {
      wrong += await timed(() =>
        a.login({ action: 'user-login', name: 'alice', password: 'nope nope' }, ctx),
      );
      refused += await timed(async () => {
        expect(
          await a.login({ action: 'user-login', name: `newbie${i}`, password: 'short' }, ctx),
        ).toBeNull();
      });
    }
    expect(refused).toBeGreaterThan(wrong * 0.5);
  });

  it('answers 503 (not a failed login) when the password queue is full', async () => {
    const a = accounts(new LoginLimiter({ userFreeFailures: 1_000, addressMaxFailures: 1_000 }));
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, (_, i) =>
        a.login({ action: 'user-login', name: `crowd${i}`, password: 'whatever it is' }, ctx),
      ),
    );
    const busy = results.filter(
      (r) => r.status === 'rejected' && isHttpError(r.reason) && r.reason.status === 503,
    );
    expect(busy.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
    // A busy answer is not a failure: the name was not charged.
    expect(await a.checkPassword('alice', PASSWORD, undefined)).toBe(true);
  });

  it('answers 503 (not a failed login) beyond the checks one address may have in progress', async () => {
    const a = accounts(new LoginLimiter({ addressMaxPending: 2 }));
    const address = { ...ctx, clientAddress: '192.0.2.7' };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        a.login({ action: 'user-login', name: `nat${i}`, password: 'whatever it is' }, address),
      ),
    );
    const busy = results.filter(
      (r) =>
        r.status === 'rejected' &&
        isHttpError(r.reason) &&
        r.reason.status === 503 &&
        r.reason.headers['retry-after'] === '1',
    );
    expect(busy).toHaveLength(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });

  it('ties tokens to the user generation, not to clocks', async () => {
    const a = accounts();
    const r = await a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx);
    expect((await auth.authenticate(bearer(r!.token)))?.name).toBe('alice');
    // A change time far in the future without a new generation: the token stays valid.
    const current = users.get('alice')!;
    const generation = current.generation ?? Date.parse(current.changed);
    await users.update((d) => {
      d.users.alice!.generation = generation;
      d.users.alice!.changed = '2099-01-01T00:00:00.000Z';
      return d;
    });
    expect((await auth.authenticate(bearer(r!.token)))?.name).toBe('alice');
    // A new generation with a change time in the past (a skewed CLI clock): the token ends.
    await users.update((d) => {
      d.users.alice!.generation = nextGeneration(generation);
      d.users.alice!.changed = '2000-01-01T00:00:00.000Z';
      return d;
    });
    expect(await auth.authenticate(bearer(r!.token))).toBeNull();
    // A removed and re-added name never revives old tokens.
    const fresh = await a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx);
    const record = users.get('alice')!;
    await users.update((d) => {
      Reflect.deleteProperty(d.users, 'alice');
      return d;
    });
    await users.update((d) => {
      d.users.alice = { ...record, generation: nextGeneration() };
      return d;
    });
    expect(await auth.authenticate(bearer(fresh!.token))).toBeNull();
  });

  it('caps login tokens per user by revoking the oldest, and created tokens separately', async () => {
    const a = accounts(new LoginLimiter(), { maxTokensPerUser: 3 });
    const login = () => a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx);
    const issued: string[] = [];
    for (let i = 0; i < 5; i++) {
      issued.push((await login())!.token);
      await new Promise((r) => setTimeout(r, 2)); // distinct creation times
    }
    const logins = (await tokens.listActive('alice')).filter((t) => t.record.login === true);
    expect(logins).toHaveLength(3);
    expect(await auth.authenticate(bearer(issued[0]!))).toBeNull();
    expect(await auth.authenticate(bearer(issued[1]!))).toBeNull();
    const identity = (await auth.authenticate(bearer(issued[4]!)))!;
    expect(identity.name).toBe('alice');
    const create = () =>
      a.createToken(
        identity,
        { action: 'token-create', password: PASSWORD, readonly: false, cidrWhitelist: [] },
        ctx,
      );
    for (let i = 0; i < 3; i++) await create();
    await expect(create()).rejects.toMatchObject({ status: 429 });
  });

  it('bounds the storage reads of logouts of unknown tokens per client address', async () => {
    let reads = 0;
    class Counting extends FsStorage {
      override async open(key: string): ReturnType<FsStorage['open']> {
        if (key.startsWith('auth/user-tokens/')) reads++;
        return super.open(key);
      }
    }
    const limited = new UserTokenStore({
      storage: new Counting(join(dir, 'data')),
      cacheTtlMs: 0,
      lookupLimiter: new LookupLimiter({ perAddressRate: 0.001, perAddressBurst: 2 }),
    });
    const a = accounts(new LoginLimiter(), { tokens: limited });
    const from = { ...ctx, clientAddress: '192.0.2.44' };
    const made = () =>
      `eyc_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    // A real logout reads storage, revokes the token and gives the budget back.
    const r = await a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx);
    await a.logout(r!.token, from);
    expect(await limited.lookup(r!.token)).toBeNull();
    reads = 0;
    // A storm of made-up tokens from that client: only the budget (2) reaches storage.
    for (let i = 0; i < 10; i++) await a.logout(made(), from);
    expect(reads).toBe(2);
    // Another client still has its own budget.
    await a.logout(made(), { ...ctx, clientAddress: '198.51.100.44' });
    expect(reads).toBe(3);
  });

  it('ends tokens after a password change (new generation) or after the user is removed', async () => {
    const a = accounts();
    const r = await a.login({ action: 'user-login', name: 'alice', password: PASSWORD }, ctx);
    const req = { headers: { authorization: `Bearer ${r!.token}` } } as IncomingMessage;
    expect((await auth.authenticate(req))?.name).toBe('alice');
    await users.update((d) => {
      d.users.alice!.generation = nextGeneration(d.users.alice!.generation);
      d.users.alice!.changed = new Date().toISOString();
      return d;
    });
    expect(await auth.authenticate(req)).toBeNull();
    await users.update((d) => {
      Reflect.deleteProperty(d.users, 'alice');
      return d;
    });
    expect(await auth.authenticate(req)).toBeNull();
  });
});
