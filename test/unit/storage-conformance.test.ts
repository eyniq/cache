// The shared Storage conformance suite, run against FsStorage. Any Storage implementation
// (including downstream ones) must pass the same cases.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isStorageAdmin } from '../../src/core/storage.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { storageConformance } from '../../src/testing/index.ts';

const roots: string[] = [];

async function fresh(): Promise<{ root: string; storage: FsStorage }> {
  const root = await mkdtemp(join(tmpdir(), 'eyniq-conformance-'));
  roots.push(root);
  return { root, storage: new FsStorage(root) };
}

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

describe('Storage conformance: FsStorage', () => {
  for (const c of storageConformance(async () => (await fresh()).storage)) {
    it(c.name, c.run);
  }
});

describe('FsStorage admin specifics (P7)', () => {
  it('implements StorageAdmin with conditional writes', async () => {
    const { storage } = await fresh();
    expect(isStorageAdmin(storage)).toBe(true);
    expect(await storage.capabilities()).toEqual({
      list: true,
      delete: true,
      conditionalWrites: true,
    });
  });

  it('breaks a lock left behind by a crashed writer', async () => {
    const { root, storage } = await fresh();
    const key = 'docs/locked';
    await storage.putIfAbsent(key, Buffer.from('v1'));
    const lockDir = join(root, '.locks');
    await mkdir(lockDir, { recursive: true });
    const lock = join(lockDir, createHash('sha256').update(key).digest('hex'));
    await writeFile(lock, 'crashed-writer');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const etag = (await storage.head(key))?.etag ?? '';
    expect(await storage.putIfMatch(key, Buffer.from('v2'), etag)).toBe(true);
  });

  it('rejects unsafe list prefixes', async () => {
    const { storage } = await fresh();
    await expect(storage.list('../')).rejects.toThrow();
    await expect(storage.list('a//b')).rejects.toThrow();
  });
});
