import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityAuthorizer } from '../../src/auth/community-authorizer.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { UsersFile } from '../../src/auth/users.ts';
import type { AuthorizationResource, Identity } from '../../src/core/contracts.ts';

let dir: string;
let users: UsersFile;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-authz-'));
  const password = await hashPassword('correct horse battery', { ln: 10, r: 8, p: 1 });
  const t = '2026-10-01T00:00:00.000Z';
  await writeFile(
    join(dir, 'users.json'),
    JSON.stringify({
      version: 1,
      users: {
        alice: { password, created: t, changed: t },
        bob: { password, created: t, changed: t, packages: ['@acme/*', 'tool'] },
        carol: { password, created: t, changed: t, packages: [] },
      },
    }),
  );
  users = await UsersFile.open(join(dir, 'users.json'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const user = (name: string, readonly = false): Identity => ({
  name,
  claims: { via: 'user-token', readonly },
});
const res = (name?: string): AuthorizationResource => ({
  ecosystem: 'npm',
  route: 'publish',
  ...(name !== undefined ? { name } : {}),
});

describe('CommunityAuthorizer', () => {
  it('reads like the default authorizer', async () => {
    const open = new CommunityAuthorizer({ auth: { required: false }, users });
    const closed = new CommunityAuthorizer({ auth: { required: true }, users });
    expect(await open.authorize(null, 'read', res('x'))).toBe(true);
    expect(await closed.authorize(null, 'read', res('x'))).toBe(false);
    expect(await closed.authorize({ name: 'ci' }, 'read', res('x'))).toBe(true);
  });

  it('lets users publish, limited by their package patterns', async () => {
    const a = new CommunityAuthorizer({ auth: { required: true }, users });
    expect(await a.authorize(user('alice'), 'publish', res('@acme/lib'))).toBe(true);
    expect(await a.authorize(user('bob'), 'publish', res('@acme/lib'))).toBe(true);
    expect(await a.authorize(user('bob'), 'publish', res('@ACME/lib'))).toBe(true);
    expect(await a.authorize(user('bob'), 'publish', res('tool'))).toBe(true);
    expect(await a.authorize(user('bob'), 'publish', res('tool-x'))).toBe(false);
    expect(await a.authorize(user('bob'), 'publish', res('@other/lib'))).toBe(false);
    expect(await a.authorize(user('carol'), 'publish', res('@acme/lib'))).toBe(false);
    // A write always names its package; without one it is refused.
    expect(await a.authorize(user('alice'), 'publish', res())).toBe(false);
  });

  it('refuses publish to read-only tokens, static tokens, removed users and anonymous', async () => {
    const a = new CommunityAuthorizer({ auth: { required: false }, users });
    expect(await a.authorize(user('alice', true), 'publish', res('@acme/lib'))).toBe(false);
    expect(await a.authorize({ name: 'alice' }, 'publish', res('@acme/lib'))).toBe(false);
    expect(await a.authorize(user('dave'), 'publish', res('@acme/lib'))).toBe(false);
    expect(await a.authorize(null, 'publish', res('@acme/lib'))).toBe(false);
  });

  it('allows account management to users only and never grants admin', async () => {
    const a = new CommunityAuthorizer({ auth: { required: true }, users });
    const account: AuthorizationResource = { ecosystem: 'npm', route: 'account' };
    expect(await a.authorize(user('alice'), 'account', account)).toBe(true);
    expect(await a.authorize({ name: 'ci' }, 'account', account)).toBe(false);
    expect(await a.authorize(user('alice'), 'admin', account)).toBe(false);
  });
});
