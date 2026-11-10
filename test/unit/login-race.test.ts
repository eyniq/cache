import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoginLimiter } from '../../src/auth/login-limiter.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { UserAccounts } from '../../src/auth/user-accounts.ts';
import { UserTokenStore } from '../../src/auth/user-tokens.ts';
import { UsersFile } from '../../src/auth/users.ts';
import type { AccountContext } from '../../src/core/contracts.ts';
import { FsStorage } from '../../src/storage/fs.ts';

// Counts the scrypt verifications that actually run.
const counts = vi.hoisted(() => ({ verify: 0 }));
vi.mock('../../src/auth/password.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/password.ts')>();
  return {
    ...real,
    verifyPassword: (password: string, encoded: string) => {
      counts.verify++;
      return real.verifyPassword(password, encoded);
    },
  };
});

const PARAMS = { ln: 10, r: 8, p: 1 };
let dir: string;
let accounts: UserAccounts;

const ctx: AccountContext = {
  requestId: 'r',
  ecosystem: 'npm',
  registryUrl: 'http://localhost',
  clientAddress: '192.0.2.50',
  audit: () => undefined,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-login-race-'));
  const t = '2026-10-01T00:00:00.000Z';
  const password = await hashPassword('correct horse battery', PARAMS);
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({ version: 1, users: { alice: { password, created: t, changed: t } } }),
  );
  const users = await UsersFile.open(join(dir, 'users.json'), { reloadIntervalMs: 0 });
  const tokens = new UserTokenStore({ storage: new FsStorage(join(dir, 'data')), cacheTtlMs: 0 });
  accounts = new UserAccounts({
    users,
    tokens,
    limiter: new LoginLimiter(),
    tokenTtlMs: 86_400_000,
    registration: { enabled: false, maxUsers: 10 },
    stillValid: () => true,
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('concurrent password guesses', () => {
  it('66 concurrent wrong passwords for one user get at most the free budget of checks', async () => {
    counts.verify = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 66 }, (_, i) =>
        accounts.login({ action: 'user-login', name: 'alice', password: `guess number ${i}` }, ctx),
      ),
    );
    // Each is a failed login, or 503 beyond the checks one address may have in progress.
    expect(
      results.every(
        (r) =>
          (r.status === 'fulfilled' && r.value === null) ||
          (r.status === 'rejected' && (r.reason as { status?: number }).status === 503),
      ),
    ).toBe(true);
    expect(counts.verify).toBeLessThanOrEqual(5); // LoginLimiter's default free failures
    expect(counts.verify).toBeGreaterThan(0);
  });
});
