// Storage conformance suite: the behaviour every Storage implementation must have (DESIGN.md
// sections 6.1 and 7.6). Each case uses its own random key prefix, so the suite can share a
// bucket or volume with other data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Storage, StorageAdmin } from '../core/contracts.ts';
import { ConditionalWritesUnsupported } from '../core/errors.ts';
import { isStorageAdmin } from '../core/storage.ts';
import type { ConformanceCase } from './conformance.ts';

/** Returns a ready-to-use storage; may return the same instance for every case. */
export type StorageFactory = () => Promise<Storage>;

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

async function getBytes(storage: Storage, key: string): Promise<Buffer | null> {
  const body = await storage.get(key);
  return body ? readAll(body) : null;
}

function failingBody(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.alloc(1024, 1));
      this.destroy(new Error('source failed'));
    },
  });
}

const prefix = (): string => `conformance/${randomUUID()}`;

export function storageConformance(create: StorageFactory): ConformanceCase[] {
  const cases: ConformanceCase[] = [
    {
      name: 'put then get returns the same bytes and head reports the size',
      run: async () => {
        const storage = await create();
        const key = `${prefix()}/object`;
        const data = Buffer.from('hello conformance');
        await storage.put(key, Readable.from([data.subarray(0, 5), data.subarray(5)]));
        assert.deepEqual(await getBytes(storage, key), data);
        const info = await storage.head(key);
        assert.ok(info, 'head returned null for a stored object');
        assert.equal(info.size, data.length);
      },
    },
    {
      name: 'get and head return null for a missing key',
      run: async () => {
        const storage = await create();
        const key = `${prefix()}/missing`;
        assert.equal(await storage.get(key), null);
        assert.equal(await storage.head(key), null);
        if (storage.open) assert.equal(await storage.open(key), null);
      },
    },
    {
      name: 'stores empty objects',
      run: async () => {
        const storage = await create();
        const key = `${prefix()}/empty`;
        await storage.put(key, Readable.from([]));
        assert.equal((await storage.head(key))?.size, 0);
        assert.deepEqual(await getBytes(storage, key), Buffer.alloc(0));
      },
    },
    {
      name: 'a second put replaces the object',
      run: async () => {
        const storage = await create();
        const key = `${prefix()}/replaced`;
        await storage.put(key, Readable.from([Buffer.from('first version')]));
        await storage.put(key, Readable.from([Buffer.from('second')]));
        assert.deepEqual(await getBytes(storage, key), Buffer.from('second'));
        assert.equal((await storage.head(key))?.size, 6);
      },
    },
    {
      name: 'a failing body stores nothing and keeps the previous object intact',
      run: async () => {
        const storage = await create();
        const fresh = `${prefix()}/fresh`;
        await assert.rejects(storage.put(fresh, failingBody()));
        assert.equal(await storage.head(fresh), null);
        const existing = `${prefix()}/existing`;
        await storage.put(existing, Readable.from([Buffer.from('kept')]));
        await assert.rejects(storage.put(existing, failingBody()));
        assert.deepEqual(await getBytes(storage, existing), Buffer.from('kept'));
      },
    },
    {
      name: 'open returns a body whose size matches the streamed bytes',
      run: async () => {
        const storage = await create();
        if (!storage.open) return;
        const key = `${prefix()}/opened`;
        const data = Buffer.alloc(100_000, 7);
        await storage.put(key, Readable.from([data]));
        const opened = await storage.open(key);
        assert.ok(opened);
        assert.equal(opened.size, data.length);
        assert.deepEqual(await readAll(opened.body), data);
      },
    },
    {
      name: 'concurrent puts of one key leave exactly one complete object',
      run: async () => {
        const storage = await create();
        const key = `${prefix()}/raced`;
        const bodies = Array.from({ length: 8 }, (_, i) => Buffer.alloc(64 * 1024, i));
        await Promise.all(bodies.map((b) => storage.put(key, Readable.from([b]))));
        const stored = await getBytes(storage, key);
        assert.ok(stored);
        assert.ok(
          bodies.some((b) => b.equals(stored)),
          'stored object is not one of the written bodies (torn write)',
        );
      },
    },
    {
      name: 'keys with scoped names and every allowed character round-trip',
      run: async () => {
        const storage = await create();
        const base = prefix();
        const keys = [
          `${base}/npm/packuments/@types/node.json.gz`,
          `${base}/index/npm/@scope/pkg/1.0.0-rc.1+build.7`,
          `${base}/odd/a~b'c!d(e)f*g_h.i-j`,
        ];
        for (const key of keys) {
          await storage.put(key, Readable.from([Buffer.from(key)]));
          assert.deepEqual(await getBytes(storage, key), Buffer.from(key), key);
        }
      },
    },
    {
      name: 'rejects unsafe keys (traversal, empty segments, encoded separators)',
      run: async () => {
        const storage = await create();
        for (const key of ['../escape', 'a/../../b', 'a//b', './a', 'a/%2e%2e/b', 'a\0b', '']) {
          await assert.rejects(
            storage.put(key, Readable.from([Buffer.from('x')])),
            `put accepted ${JSON.stringify(key)}`,
          );
          await assert.rejects(storage.head(key), `head accepted ${JSON.stringify(key)}`);
          await assert.rejects(storage.get(key), `get accepted ${JSON.stringify(key)}`);
        }
      },
    },
    {
      name: 'check() resolves for usable storage',
      run: async () => {
        const storage = await create();
        await storage.check();
      },
    },
  ];
  return [...cases, ...adminCases(create)];
}

type AdminStorage = Storage & StorageAdmin;

/** StorageAdmin cases; they pass trivially for a Storage without admin operations. */
function adminCases(create: StorageFactory): ConformanceCase[] {
  const admin = async (): Promise<AdminStorage | null> => {
    const storage = await create();
    return isStorageAdmin(storage) ? storage : null;
  };
  /** Runs `fn` only when the backend enforces conditional writes; otherwise checks it says so. */
  const conditional = async (
    storage: AdminStorage,
    key: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    if ((await storage.capabilities()).conditionalWrites) {
      await fn();
      return;
    }
    await assert.rejects(storage.putIfAbsent(key, Buffer.from('x')), ConditionalWritesUnsupported);
    await assert.rejects(
      storage.putIfMatch(key, Buffer.from('x'), '"any"'),
      ConditionalWritesUnsupported,
    );
  };
  const put = (storage: Storage, key: string, text: string): Promise<void> =>
    storage.put(key, Readable.from([Buffer.from(text)]));

  return [
    {
      name: 'admin: capabilities() describes the backend',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const caps = await storage.capabilities();
        for (const k of ['list', 'delete', 'conditionalWrites'] as const) {
          assert.equal(typeof caps[k], 'boolean', k);
        }
      },
    },
    {
      name: 'admin: list returns the keys under a prefix in order, with sizes',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const base = prefix();
        // '-' sorts before '/', so a sibling file must come before a directory's contents.
        const keys = [`${base}/a/x`, `${base}/a-b`, `${base}/a/y/z`, `${base}/b`, `${base}x/out`];
        for (const k of keys) await put(storage, k, k);
        const page = await storage.list(`${base}/`);
        assert.deepEqual(
          page.entries.map((e) => e.key),
          [`${base}/a-b`, `${base}/a/x`, `${base}/a/y/z`, `${base}/b`],
        );
        assert.equal(page.cursor, undefined);
        assert.equal(page.entries[0]?.size, `${base}/a-b`.length);
        const partial = await storage.list(`${base}/a`);
        assert.equal(partial.entries.length, 3);
      },
    },
    {
      name: 'admin: list pages through a prefix with the cursor, each key exactly once',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const base = prefix();
        const keys = Array.from({ length: 7 }, (_, i) => `${base}/k${i}`);
        for (const k of keys) await put(storage, k, 'v');
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const page = await storage.list(`${base}/`, {
            limit: 3,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          assert.ok(page.entries.length <= 3);
          seen.push(...page.entries.map((e) => e.key));
          cursor = page.cursor;
          if (cursor === undefined) break;
        }
        assert.deepEqual(seen, keys);
      },
    },
    {
      name: 'admin: list never exposes internal temp or lock objects',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/locked`;
        await conditional(storage, key, async () => {
          await storage.putIfAbsent(key, Buffer.from('1'));
          const etag = (await storage.head(key))?.etag ?? '';
          await storage.putIfMatch(key, Buffer.from('2'), etag);
        });
        await assert.rejects(storage.put(`${prefix()}/failed`, failingBody()));
        const all = await storage.list('', { limit: 1000 });
        for (const e of all.entries) {
          assert.ok(!e.key.startsWith('.'), `internal key listed: ${e.key}`);
        }
      },
    },
    {
      name: 'admin: keys starting with "." are reserved for the implementation',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        for (const key of ['.locks/x', '.tmp/y.part', '.eyniq-probe/z']) {
          await assert.rejects(storage.put(key, Readable.from([Buffer.from('x')])), key);
          await assert.rejects(storage.head(key), key);
          await assert.rejects(storage.delete(key), key);
        }
      },
    },
    {
      name: 'admin: the cursor resumes correctly across nested directories',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const base = prefix();
        const keys = [`${base}/a-b`, `${base}/a/x`, `${base}/a/y/z`, `${base}/a/y/zz`, `${base}/b`];
        for (const k of keys) await put(storage, k, 'v');
        for (let i = 0; i < keys.length - 1; i++) {
          const page = await storage.list(`${base}/`, { cursor: keys[i] ?? '', limit: 1 });
          assert.deepEqual(
            page.entries.map((e) => e.key),
            [keys[i + 1]],
            `after ${keys[i] ?? ''}`,
          );
        }
        const all = await storage.list(`${base}/`, { limit: Number.NaN });
        assert.equal(all.entries.length, keys.length, 'a NaN limit falls back to the default');
      },
    },
    {
      name: 'admin: delete removes an object and is idempotent',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/gone`;
        await put(storage, key, 'bye');
        await storage.delete(key);
        assert.equal(await storage.head(key), null);
        await storage.delete(key);
        await assert.rejects(storage.delete('../escape'));
      },
    },
    {
      name: 'admin: putIfAbsent writes once',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/once`;
        await conditional(storage, key, async () => {
          assert.equal(await storage.putIfAbsent(key, Buffer.from('first')), true);
          assert.equal(await storage.putIfAbsent(key, Buffer.from('second')), false);
          assert.deepEqual(await getBytes(storage, key), Buffer.from('first'));
        });
      },
    },
    {
      name: 'admin: exactly one of many concurrent putIfAbsent calls wins',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/race`;
        await conditional(storage, key, async () => {
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => storage.putIfAbsent(key, Buffer.from(`w${i}`))),
          );
          assert.equal(results.filter(Boolean).length, 1);
          const winner = results.indexOf(true);
          assert.deepEqual(await getBytes(storage, key), Buffer.from(`w${winner}`));
        });
      },
    },
    {
      name: 'admin: putIfMatch replaces only while the etag matches',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/cas`;
        await conditional(storage, key, async () => {
          assert.equal(await storage.putIfMatch(key, Buffer.from('x'), '"nope"'), false);
          assert.equal(await storage.head(key), null);
          await storage.putIfAbsent(key, Buffer.from('v1'));
          const v1 = (await storage.head(key))?.etag;
          assert.ok(v1, 'head() must return an etag for conditional writes');
          assert.equal(await storage.putIfMatch(key, Buffer.from('v2'), v1), true);
          assert.deepEqual(await getBytes(storage, key), Buffer.from('v2'));
          assert.equal(await storage.putIfMatch(key, Buffer.from('v3'), v1), false);
          assert.deepEqual(await getBytes(storage, key), Buffer.from('v2'));
          if (storage.open) {
            const opened = await storage.open(key);
            opened?.body.destroy();
            assert.equal(opened?.etag, (await storage.head(key))?.etag);
          }
          const listed = await storage.list(key);
          assert.equal(listed.entries[0]?.etag, (await storage.head(key))?.etag);
        });
      },
    },
    {
      name: 'admin: exactly one of many concurrent putIfMatch calls on one etag wins',
      run: async () => {
        const storage = await admin();
        if (!storage) return;
        const key = `${prefix()}/cas-race`;
        await conditional(storage, key, async () => {
          await storage.putIfAbsent(key, Buffer.from('base'));
          const etag = (await storage.head(key))?.etag ?? '';
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
              storage.putIfMatch(key, Buffer.from(`same-size-${i}`), etag),
            ),
          );
          assert.equal(results.filter(Boolean).length, 1);
        });
      },
    },
  ];
}
