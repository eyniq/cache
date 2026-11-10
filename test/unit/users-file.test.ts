import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.ts';
import {
  UsersFile,
  generationOf,
  isValidUserName,
  nextGeneration,
  parseUsers,
  serializeUsers,
} from '../../src/auth/users.ts';

const FAST = { ln: 10, r: 8, p: 1 };
let dir: string;
let path: string;
let hash: string;

beforeAll(async () => {
  hash = await hashPassword('correct horse battery', FAST);
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-users-'));
  path = join(dir, 'users.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const user = (extra: Record<string, unknown> = {}) => ({
  password: hash,
  created: '2026-10-01T00:00:00.000Z',
  changed: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('user names', () => {
  it.each(['alice', 'a', 'ci-bot', 'first.last', 'u_1', 'x'.repeat(64)])('accepts %s', (n) => {
    expect(isValidUserName(n)).toBe(true);
  });
  it.each(['', 'Alice', '-x', '.x', 'a b', 'a/b', 'a:b', '__proto__', 'x'.repeat(65), 'é'])(
    'refuses %j',
    (n) => {
      expect(isValidUserName(n)).toBe(false);
    },
  );
});

describe('parseUsers', () => {
  it('parses a valid file', () => {
    const data = parseUsers(
      JSON.stringify({ version: 1, users: { alice: user({ packages: ['@acme/*'] }) } }),
    );
    expect(data.users.alice?.packages).toEqual(['@acme/*']);
  });

  it.each([
    ['not JSON', '{'],
    ['no version', JSON.stringify({ users: {} })],
    ['wrong version', JSON.stringify({ version: 2, users: {} })],
    ['users not an object', JSON.stringify({ version: 1, users: [] })],
    ['bad name', JSON.stringify({ version: 1, users: { Alice: {} } })],
    ['plain-text password', JSON.stringify({ version: 1, users: { a: user({ password: 'x' }) } })],
    ['unknown member', JSON.stringify({ version: 1, users: { a: user({ admin: true }) } })],
    ['bad packages', JSON.stringify({ version: 1, users: { a: user({ packages: 'x' }) } })],
    ['bad pattern', JSON.stringify({ version: 1, users: { a: user({ packages: ['a b'] }) } })],
    ['bad time', JSON.stringify({ version: 1, users: { a: user({ changed: 'yesterday' }) } })],
  ])('refuses %s', (_label, text) => {
    expect(() => parseUsers(text)).toThrow();
  });

  it('never echoes hashes or file contents in errors', () => {
    try {
      parseUsers(
        JSON.stringify({ version: 1, users: { a: user({ password: 'hunter2hunter2' }) } }),
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('keeps a "__proto__" key from reaching the prototype', () => {
    const text = `{"version":1,"users":{"__proto__":${JSON.stringify(user())}}}`;
    expect(() => parseUsers(text)).toThrow();
  });

  it('round-trips through serializeUsers', () => {
    const data = parseUsers(JSON.stringify({ version: 1, users: { alice: user() } }));
    expect(parseUsers(serializeUsers(data))).toEqual(data);
  });
});

describe('UsersFile', () => {
  it('loads users and reports a missing file', async () => {
    await expect(UsersFile.open(path)).rejects.toThrow(/does not exist/);
    const empty = await UsersFile.open(path, { allowMissing: true });
    expect(empty.count()).toBe(0);
    await writeFile(path, JSON.stringify({ version: 1, users: { alice: user() } }));
    const file = await UsersFile.open(path);
    expect(file.get('alice')?.password).toBe(hash);
    expect(file.get('bob')).toBeUndefined();
    expect(file.get('__proto__')).toBeUndefined();
  });

  it('writes atomically with mode 0600 under a lock, re-reading before every change', async () => {
    const a = await UsersFile.open(path, { allowMissing: true });
    const b = await UsersFile.open(path, { allowMissing: true });
    // Two writers that both started from an empty snapshot: neither change is lost.
    await Promise.all([
      a.update((d) => {
        d.users.alice = user();
        return d;
      }),
      b.update((d) => {
        d.users.bob = user();
        return d;
      }),
    ]);
    const final = parseUsers(await readFile(path, 'utf8'));
    expect(Object.keys(final.users).sort()).toEqual(['alice', 'bob']);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it('picks up changes made by another process', async () => {
    let now = 0;
    await writeFile(path, JSON.stringify({ version: 1, users: { alice: user() } }));
    const file = await UsersFile.open(path, { reloadIntervalMs: 1000, now: () => now });
    await writeFile(path, JSON.stringify({ version: 1, users: { bob: user() } }));
    expect(file.get('alice')).toBeDefined(); // within the interval: old snapshot
    now = 2000;
    await file.reload();
    expect(file.get('alice')).toBeUndefined();
    expect(file.get('bob')).toBeDefined();
  });

  it('keeps the last good snapshot when the file turns invalid', async () => {
    await writeFile(path, JSON.stringify({ version: 1, users: { alice: user() } }));
    const file = await UsersFile.open(path, { reloadIntervalMs: 0 });
    await writeFile(path, '{ broken');
    await file.reload();
    expect(file.get('alice')).toBeDefined();
  });

  it('breaks a stale lock left by a crashed writer', async () => {
    const file = await UsersFile.open(path, { allowMissing: true, staleLockMs: 50 });
    await writeFile(`${path}.lock`, '');
    await new Promise((r) => setTimeout(r, 80));
    await file.update((d) => {
      d.users.alice = user();
      return d;
    });
    expect(file.get('alice')).toBeDefined();
  });

  it('a writer never removes a lock that was taken over from it', async () => {
    const a = await UsersFile.open(path, { allowMissing: true, staleLockMs: 1_000 });
    const b = await UsersFile.open(path, { allowMissing: true, staleLockMs: 1_000 });
    let releaseA!: () => void;
    let releaseB!: () => void;
    let aHolds!: () => void;
    let bHolds!: () => void;
    const aHolding = new Promise<void>((r) => (aHolds = r));
    const bHolding = new Promise<void>((r) => (bHolds = r));
    const aDone = a.update(async (d) => {
      aHolds();
      await new Promise<void>((r) => (releaseA = r));
      d.users.alice = user();
      return d;
    });
    await aHolding;
    // A stalls past the stale age: B breaks its lock and takes its own.
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const bDone = b.update(async (d) => {
      bHolds();
      await new Promise<void>((r) => (releaseB = r));
      d.users.bob = user();
      return d;
    });
    await bHolding;
    const bLock = await readFile(`${path}.lock`, 'utf8');
    releaseA();
    await aDone;
    // A finished while B holds the lock: B's lock must still be there.
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(bLock);
    releaseB();
    await bDone;
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it('writers racing to break the same stale lock lose no change', async () => {
    await writeFile(`${path}.lock`, 'crashed-writer');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const names = Array.from({ length: 12 }, (_, i) => `user${i}`);
    const files = await Promise.all(
      names.map(() => UsersFile.open(path, { allowMissing: true, staleLockMs: 5_000 })),
    );
    await Promise.all(
      files.map((f, i) =>
        f.update(async (d) => {
          // Hold the lock across a few ticks so racing breakers overlap with the holder.
          await new Promise((r) => setTimeout(r, 2));
          d.users[names[i]!] = user();
          return d;
        }),
      ),
    );
    const final = parseUsers(await readFile(path, 'utf8'));
    expect(Object.keys(final.users).sort()).toEqual([...names].sort());
    expect((await readdir(dir)).filter((f) => f.includes('.lock'))).toEqual([]);
  });

  it('parses generations and derives one for records without it', () => {
    const data = parseUsers(
      JSON.stringify({ version: 1, users: { alice: user({ generation: 7 }), bob: user() } }),
    );
    expect(generationOf(data.users.alice!)).toBe(7);
    expect(generationOf(data.users.bob!)).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    for (const generation of [-1, 1.5, '3', null]) {
      expect(() =>
        parseUsers(JSON.stringify({ version: 1, users: { alice: user({ generation }) } })),
      ).toThrow(/generation/);
    }
    expect(nextGeneration(5)).toBeGreaterThan(5);
    const far = Date.now() + 1e9;
    expect(nextGeneration(far)).toBe(far + 1);
  });
});
