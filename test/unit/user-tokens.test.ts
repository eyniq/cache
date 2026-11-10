import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupLimiter } from '../../src/auth/lookup-limiter.ts';
import { UserTokenStore, hashToken, isUserToken } from '../../src/auth/user-tokens.ts';
import { FsStorage } from '../../src/storage/fs.ts';

let root: string;
let now: number;
let store: UserTokenStore;
const G = { generation: 1 };

/** FsStorage that counts reads of token records and can hold one read after it happened. */
class ProbeStorage extends FsStorage {
  reads = 0;
  hold: Promise<void> | null = null;
  override async get(key: string): Promise<Readable | null> {
    const body = await super.get(key);
    if (!key.startsWith('auth/user-tokens/')) return body;
    this.reads++;
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    const hold = this.hold;
    this.hold = null;
    if (hold) await hold;
    return Readable.from([Buffer.concat(chunks)]);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-user-tokens-'));
  now = Date.parse('2026-10-16T00:00:00.000Z');
  store = new UserTokenStore({ storage: new FsStorage(root), cacheTtlMs: 0, now: () => now });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(full)));
    else out.push(full);
  }
  return out;
}

describe('UserTokenStore', () => {
  it('issues random eyc_ tokens and stores only their sha256', async () => {
    const { token, record } = await store.create('alice', now + 60_000, {
      label: 'laptop',
      generation: 1,
    });
    expect(isUserToken(token)).toBe(true);
    expect(record).toMatchObject({ user: 'alice', revoked: false, label: 'laptop' });
    const files = await allFiles(root);
    expect(files.some((f) => f.endsWith(hashToken(token)))).toBe(true);
    for (const f of files) {
      expect(f).not.toContain(token);
      expect(await readFile(f, 'utf8')).not.toContain(token);
    }
    const second = await store.create('alice', now + 60_000, G);
    expect(second.token).not.toBe(token);
  });

  it('looks up valid tokens only', async () => {
    const { token } = await store.create('alice', now + 60_000, G);
    expect((await store.lookup(token))?.user).toBe('alice');
    expect(await store.lookup('eyc_' + 'A'.repeat(43))).toBeNull();
    expect(await store.lookup('not-a-token')).toBeNull();
    now += 60_000;
    expect(await store.lookup(token)).toBeNull(); // expired
  });

  it('revokes and lists tokens per user', async () => {
    const a = await store.create('alice', now + 60_000, G);
    const b = await store.create('alice', now + 60_000, { readonly: true, generation: 1 });
    await store.create('bob', now + 60_000, G);
    expect((await store.listActive('alice')).map((t) => t.hash).sort()).toEqual(
      [a.hash, b.hash].sort(),
    );
    expect(await store.revoke(a.hash)).toBe(true);
    expect(await store.lookup(a.token)).toBeNull();
    expect((await store.listActive('alice')).map((t) => t.hash)).toEqual([b.hash]);
    expect(await store.revoke('f'.repeat(64))).toBe(false);
    expect(await store.revoke('../../etc')).toBe(false);
  });

  it('caches lookups for the TTL; a revocation on the same pod applies at once', async () => {
    const cached = new UserTokenStore({
      storage: new FsStorage(root),
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const { token, hash } = await cached.create('alice', now + 600_000, G);
    expect(await cached.lookup(token)).not.toBeNull();
    expect(await cached.revoke(hash)).toBe(true);
    expect(await cached.lookup(token)).toBeNull();
  });

  it('a revocation on another pod applies within the cache TTL', async () => {
    const podA = new UserTokenStore({
      storage: new FsStorage(root),
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const podB = new UserTokenStore({
      storage: new FsStorage(root),
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const { token, hash } = await podA.create('alice', now + 600_000, G);
    expect(await podB.lookup(token)).not.toBeNull();
    await podA.revoke(hash);
    expect(await podB.lookup(token)).not.toBeNull(); // cached
    now += 30_000;
    expect(await podB.lookup(token)).toBeNull();
  });

  it('a lookup that read a record before its revocation does not cache it', async () => {
    const storage = new ProbeStorage(root);
    const pod = new UserTokenStore({ storage, cacheTtlMs: 30_000, now: () => now });
    const { token, hash } = await pod.create('alice', now + 600_000, G);
    let resume!: () => void;
    storage.hold = new Promise<void>((r) => (resume = r));
    const racing = pod.lookup(token); // reads the unrevoked record, then waits
    await new Promise((r) => setTimeout(r, 10));
    expect(await pod.revoke(hash)).toBe(true);
    resume();
    await racing;
    expect(await pod.lookup(token)).toBeNull();
  });

  it('bounds storage reads for unknown tokens per client and globally', async () => {
    const storage = new ProbeStorage(root);
    const limiter = new LookupLimiter({
      perAddressRate: 0.001,
      perAddressBurst: 3,
      globalRate: 0.001,
      globalBurst: 8,
      now: () => now,
    });
    const pod = new UserTokenStore({
      storage,
      cacheTtlMs: 30_000,
      now: () => now,
      lookupLimiter: limiter,
    });
    const { token } = await pod.create('alice', now + 600_000, G);
    const random = () =>
      `eyc_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    for (let i = 0; i < 20; i++) expect(await pod.lookup(random(), () => '192.0.2.1')).toBeNull();
    expect(storage.reads).toBe(3);
    // IPv6 clients share one budget per /64, whatever address in it they use.
    for (let i = 0; i < 5; i++) await pod.lookup(random(), () => `2001:db8::${i + 1}`);
    expect(storage.reads).toBe(6);
    // Real tokens give their budget back: they keep working from that address.
    for (let i = 0; i < 5; i++) {
      now += 31_000; // past the cache TTL: every lookup reads storage
      expect(await pod.lookup(token, () => '198.51.100.1')).not.toBeNull();
    }
    // The global budget (8) is used up by unknown tokens from many clients.
    for (let i = 0; i < 10; i++) await pod.lookup(random(), () => `203.0.113.${i}`);
    const before = storage.reads;
    expect(await pod.lookup(random(), () => '203.0.113.200')).toBeNull();
    expect(storage.reads).toBe(before);
  });

  it('removes markers and records of expired and revoked tokens while listing', async () => {
    const storage = new ProbeStorage(root);
    const pod = new UserTokenStore({ storage, cacheTtlMs: 0, now: () => now });
    const short = await pod.create('alice', now + 1_000, G);
    const revoked = await pod.create('alice', now + 600_000, G);
    const kept = await pod.create('alice', now + 600_000, G);
    await pod.revoke(revoked.hash);
    now += 2_000;
    expect((await pod.listActive('alice')).map((t) => t.hash)).toEqual([kept.hash]);
    const files = (await allFiles(root)).join('\n');
    expect(files).not.toContain(short.hash);
    expect(files).not.toContain(revoked.hash);
    expect(files).toContain(kept.hash);
    expect(await pod.get(revoked.hash)).toBeNull();
  });

  it('stores the generation and the login flag', async () => {
    const { record } = await store.create('alice', now + 60_000, { generation: 42, login: true });
    expect(record).toMatchObject({ generation: 42, login: true });
    expect(await store.get(hashToken('x'))).toBeNull();
  });
});
