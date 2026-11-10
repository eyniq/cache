import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupLimiter } from '../../src/auth/lookup-limiter.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { WebSessionStore } from '../../src/web/sessions.ts';

/** FsStorage that counts session reads and can hold one read after it happened. */
class ProbeStorage extends FsStorage {
  reads = 0;
  hold: Promise<void> | null = null;
  override async get(key: string): Promise<Readable | null> {
    const body = await super.get(key);
    if (!key.startsWith('auth/web-sessions/')) return body;
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

let root: string;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-web-sessions-'));
  now = Date.parse('2026-10-16T00:00:00.000Z');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const randomId = () =>
  `eyw_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;

describe('WebSessionStore', () => {
  it('keeps the stamp of the login with the session', async () => {
    const store = new WebSessionStore({
      storage: new FsStorage(root),
      ttlMs: 60_000,
      cacheTtlMs: 0,
      now: () => now,
    });
    const token = await store.create('alice', '1234');
    expect(await store.lookup(token)).toMatchObject({ user: 'alice', stamp: '1234' });
  });

  it('bounds storage reads for unknown session ids per client and globally', async () => {
    const storage = new ProbeStorage(root);
    const store = new WebSessionStore({
      storage,
      ttlMs: 600_000,
      cacheTtlMs: 30_000,
      now: () => now,
      lookupLimiter: new LookupLimiter({
        perAddressRate: 0.001,
        perAddressBurst: 2,
        globalRate: 0.001,
        globalBurst: 5,
        now: () => now,
      }),
    });
    const real = await store.create('alice');
    for (let i = 0; i < 10; i++)
      expect(await store.lookup(randomId(), () => '192.0.2.1')).toBeNull();
    expect(storage.reads).toBe(2);
    // A real session gives its budget back.
    for (let i = 0; i < 3; i++) {
      now += 31_000;
      expect(await store.lookup(real, () => '198.51.100.1')).not.toBeNull();
    }
    for (let i = 0; i < 10; i++) await store.lookup(randomId(), () => `203.0.113.${i}`);
    const before = storage.reads;
    expect(await store.lookup(randomId(), () => '203.0.113.99')).toBeNull();
    expect(storage.reads).toBe(before);
  });

  it('keeps unknown ids in a separate, smaller cache that cannot evict real sessions', async () => {
    const storage = new ProbeStorage(root);
    const store = new WebSessionStore({
      storage,
      ttlMs: 600_000,
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const real = await store.create('alice');
    expect(await store.lookup(real)).not.toBeNull();
    const unknown = randomId();
    expect(await store.lookup(unknown)).toBeNull();
    expect(await store.lookup(unknown)).toBeNull(); // cached: no second read
    expect(storage.reads).toBe(2);
    // More made-up ids than the whole cache holds (10,000).
    for (let i = 0; i < 10_001; i++) await store.lookup(randomId());
    const before = storage.reads;
    expect(await store.lookup(real)).not.toBeNull();
    expect(storage.reads).toBe(before); // still cached after the flood
  });

  it('a lookup that read a session before its logout does not cache it', async () => {
    const storage = new ProbeStorage(root);
    const store = new WebSessionStore({
      storage,
      ttlMs: 600_000,
      cacheTtlMs: 30_000,
      now: () => now,
    });
    const token = await store.create('alice');
    let resume!: () => void;
    storage.hold = new Promise<void>((r) => (resume = r));
    const racing = store.lookup(token);
    await new Promise((r) => setTimeout(r, 10));
    await store.delete(token);
    resume();
    await racing;
    expect(await store.lookup(token)).toBeNull();
  });
});
