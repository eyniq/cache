import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStorage } from '../../src/storage/fs.ts';

let root: string;
let storage: FsStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-fs-'));
  storage = new FsStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name).slice(dir.length + 1));
  }
  return out.sort();
}

describe('FsStorage', () => {
  it('round-trips an object', async () => {
    await storage.put('npm/packuments/@types/node.json', Readable.from([Buffer.from('{"a":1}')]));
    const body = await storage.get('npm/packuments/@types/node.json');
    expect(body).not.toBeNull();
    expect(await text(body!)).toBe('{"a":1}');
    expect(await storage.head('npm/packuments/@types/node.json')).toMatchObject({ size: 7 });
  });

  it('returns null for missing objects', async () => {
    expect(await storage.get('npm/packuments/missing.json')).toBeNull();
    expect(await storage.head('npm/packuments/missing.json')).toBeNull();
  });

  it('stores nothing when the body stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('upstream broke'));
      },
    });
    await expect(storage.put('npm/tarballs/x/x-1.0.0.tgz', failing)).rejects.toThrow(
      'upstream broke',
    );
    expect(await storage.get('npm/tarballs/x/x-1.0.0.tgz')).toBeNull();
    expect(await listAll(root)).toEqual([]);
  });

  it('refuses unsafe keys', async () => {
    await expect(storage.put('../escape', Readable.from(['x']))).rejects.toThrow();
    await expect(storage.get('a/../../b')).rejects.toThrow();
  });

  it('replaces an existing object atomically', async () => {
    await storage.put('k/v', Readable.from([Buffer.from('one')]));
    await storage.put('k/v', Readable.from([Buffer.from('two')]));
    expect(await text((await storage.get('k/v'))!)).toBe('two');
  });

  it('passes the readiness check on a writable root', async () => {
    await expect(storage.check()).resolves.toBeUndefined();
  });
});
