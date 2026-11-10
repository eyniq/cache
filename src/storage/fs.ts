// Filesystem storage, safe on a shared RWX volume: objects are written to a unique temp file
// in the same filesystem and renamed into place, so readers never see a partial object.
//
// StorageAdmin semantics on shared volumes (honest limits):
// - putIfAbsent uses link(), which fails atomically when the target exists, on local
//   filesystems and NFSv3+. A retransmitted NFS LINK can report EEXIST for its own success;
//   that case is detected by comparing inodes.
// - putIfMatch and delete take a per-key lock file created with O_EXCL (atomic on local
//   filesystems and NFSv3+, NOT on NFSv2 or some FUSE/SMB mounts), compare the etag and rename.
//   A lock older than 30 s (by the volume's clock) is treated as left behind by a crashed
//   writer and broken, only if it still holds the owner token seen as stale. A writer stalled
//   that long inside the few-millisecond critical section, or a three-way race at the moment
//   of breaking, could still let two writers in.
// - capabilities() probes link() semantics once; O_EXCL atomicity cannot be probed.
// - etags are inode, size and nanosecond mtime: on filesystems with coarse timestamps that
//   reuse inodes immediately, two same-size writes in one tick could share an etag.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type BigIntStats } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  OpenedObject,
  Storage,
  StorageAdmin,
  StorageCapabilities,
  StorageListEntry,
  StorageListPage,
  StorageObjectInfo,
} from '../core/contracts.ts';
import { ConditionalWritesUnsupported } from '../core/errors.ts';
import { assertSafeKey, isSafeKey } from '../core/names.ts';
import { clampLimit } from '../core/storage.ts';

const TMP_DIR = '.tmp';
const LOCK_DIR = '.locks';
/** Temp files older than this are leftovers of a killed process. */
const STALE_TMP_MS = 60 * 60_000;
const LOCK_STALE_MS = 30_000;
/** Longer than LOCK_STALE_MS, so waiters outlast a lock left by a crashed writer. */
const LOCK_WAIT_MS = 40_000;

function etagOf(s: BigIntStats): string {
  return `"${s.ino.toString(16)}-${s.size.toString(16)}-${s.mtimeNs.toString(16)}"`;
}

/** Keys sort by UTF-16 code units, which for the safe key alphabet equals S3's byte order. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class FsStorage implements Storage, StorageAdmin {
  private readonly root: string;
  private caps: Promise<StorageCapabilities> | null = null;

  constructor(root: string) {
    this.root = root;
  }

  /** Keys starting with "." are this class's own (.tmp, .locks): never reachable by callers. */
  private path(key: string): string {
    if (key.startsWith('.')) throw new Error('unsafe storage key');
    return join(this.root, assertSafeKey(key));
  }

  async get(key: string): Promise<Readable | null> {
    const path = this.path(key);
    try {
      const handle = await open(path, 'r');
      return handle.createReadStream();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Size and etag from the opened handle, so they always match the bytes streamed. */
  async open(key: string): Promise<OpenedObject | null> {
    const path = this.path(key);
    try {
      const handle = await open(path, 'r');
      try {
        const s = await handle.stat({ bigint: true });
        return { body: handle.createReadStream(), size: Number(s.size), etag: etagOf(s) };
      } catch (err) {
        await handle.close();
        throw err;
      }
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Remove temp files left behind by a killed process; run at startup. */
  async sweepTemp(now = Date.now()): Promise<number> {
    const dir = join(this.root, TMP_DIR);
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const file = join(dir, name);
      const s = await stat(file).catch(() => null);
      if (s && now - s.mtimeMs > STALE_TMP_MS) {
        await unlink(file).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }

  async head(key: string): Promise<StorageObjectInfo | null> {
    const path = this.path(key);
    try {
      const s = await stat(path, { bigint: true });
      return { size: Number(s.size), etag: etagOf(s) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, body: Readable): Promise<void> {
    const target = this.path(key);
    const tmpDir = join(this.root, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx', flush: true }));
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  // ---- StorageAdmin ---------------------------------------------------------------------

  /**
   * conditionalWrites is probed once on the volume: some FUSE/SMB mounts refuse link() or do
   * not fail it for an existing target. (O_EXCL cannot be probed for atomicity; see header.)
   */
  capabilities(): Promise<StorageCapabilities> {
    this.caps ??= this.probeLinks()
      .then((conditionalWrites) => ({ list: true, delete: true, conditionalWrites }))
      .catch((err: unknown) => {
        this.caps = null;
        throw err;
      });
    return this.caps;
  }

  private async probeLinks(): Promise<boolean> {
    const a = await this.writeTemp(Buffer.from('probe'));
    const b = `${a}.link`;
    try {
      await link(a, b);
      try {
        await link(a, b);
        return false; // a second link over an existing name must fail
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EEXIST';
      }
    } catch {
      return false;
    } finally {
      await unlink(b).catch(() => undefined);
      await unlink(a).catch(() => undefined);
    }
  }

  private async requireConditionalWrites(): Promise<void> {
    if (!(await this.capabilities()).conditionalWrites) throw new ConditionalWritesUnsupported();
  }

  /**
   * Walks the tree in key order, skipping subtrees outside the prefix or before the cursor.
   * Internal entries (.tmp, .locks, .ready-*) are never listed.
   */
  async list(
    prefix: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<StorageListPage> {
    if (prefix !== '') assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const limit = clampLimit(opts.limit);
    const cursor = opts.cursor;
    if (cursor !== undefined && cursor.length > 1024) throw new Error('invalid cursor');
    const entries: StorageListEntry[] = [];
    const page = { more: false }; // set inside walk()

    const walk = async (dirKey: string): Promise<boolean> => {
      let dirents;
      try {
        dirents = await readdir(join(this.root, dirKey), { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw err;
      }
      const items = dirents
        .filter((d) => d.isFile() || d.isDirectory())
        .map((d) => ({ key: dirKey ? `${dirKey}/${d.name}` : d.name, dir: d.isDirectory() }))
        .filter((it) => !it.key.startsWith('.'))
        // A directory sorts as "name/": "a-b" < "a/x" in key order although "a" < "a-b".
        .sort((a, b) => compareKeys(a.key + (a.dir ? '/' : ''), b.key + (b.dir ? '/' : '')));
      for (const it of items) {
        if (it.dir) {
          const sub = `${it.key}/`;
          if (!sub.startsWith(prefix) && !prefix.startsWith(sub)) continue;
          // Every key below `sub` sorts before the cursor unless the cursor is inside it.
          if (cursor !== undefined && sub <= cursor && !cursor.startsWith(sub)) continue;
          if (await walk(it.key)) return true;
          continue;
        }
        if (!it.key.startsWith(prefix) || !isSafeKey(it.key)) continue;
        if (cursor !== undefined && it.key <= cursor) continue;
        if (entries.length === limit) {
          page.more = true;
          return true;
        }
        const s = await stat(join(this.root, it.key), { bigint: true }).catch(() => null);
        if (s) entries.push({ key: it.key, size: Number(s.size), etag: etagOf(s) });
      }
      return false;
    };

    const slash = prefix.lastIndexOf('/');
    await walk(slash === -1 ? '' : prefix.slice(0, slash));
    const last = entries.at(-1);
    return { entries, ...(page.more && last ? { cursor: last.key } : {}) };
  }

  async delete(key: string): Promise<void> {
    const target = this.path(key);
    const release = await this.lock(key);
    try {
      await unlink(target);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    } finally {
      await release();
    }
  }

  async putIfAbsent(key: string, body: Buffer): Promise<boolean> {
    const target = this.path(key);
    await this.requireConditionalWrites();
    const tmp = await this.writeTemp(body);
    try {
      await mkdir(dirname(target), { recursive: true });
      try {
        await link(tmp, target);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // NFS: a retransmitted LINK reports EEXIST although the first attempt created it.
        const [mine, theirs] = await Promise.all([
          stat(tmp, { bigint: true }),
          stat(target, { bigint: true }).catch(() => null),
        ]);
        return theirs !== null && mine.ino === theirs.ino && mine.dev === theirs.dev;
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async putIfMatch(key: string, body: Buffer, etag: string): Promise<boolean> {
    const target = this.path(key);
    await this.requireConditionalWrites();
    const tmp = await this.writeTemp(body);
    try {
      const release = await this.lock(key);
      try {
        const current = await stat(target, { bigint: true }).catch((err: unknown) => {
          if (isNotFound(err)) return null;
          throw err;
        });
        if (!current || etagOf(current) !== etag) return false;
        await rename(tmp, target);
        return true;
      } finally {
        await release();
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private async writeTemp(body: Buffer): Promise<string> {
    const tmpDir = join(this.root, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    try {
      await writeFile(tmp, body, { flag: 'wx', flush: true });
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return tmp;
  }

  /** Per-key lock file (O_EXCL); returns the release function. */
  private async lock(key: string): Promise<() => Promise<void>> {
    const dir = join(this.root, LOCK_DIR);
    await mkdir(dir, { recursive: true });
    const file = join(dir, createHash('sha256').update(key).digest('hex'));
    const owner = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    let skew: number | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(file, owner, { flag: 'wx' });
        return async () => {
          // Only remove the lock while it is still ours (it may have been broken as stale).
          const holder = await readFile(file, 'utf8').catch(() => null);
          if (holder === owner) await unlink(file).catch(() => undefined);
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const holder = await readFile(file, 'utf8').catch(() => null);
      const s = await stat(file).catch(() => null);
      // Age is measured against the volume's clock (mtimes come from the file server), so
      // clock skew between pods cannot make a live lock look stale.
      skew ??= await this.volumeSkew(dir);
      if (holder !== null && s && Date.now() + skew - s.mtimeMs > LOCK_STALE_MS) {
        await this.breakLock(file, holder);
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for a storage lock');
      await sleep(Math.min(50, 2 ** Math.min(attempt, 5)) + Math.random() * 5);
    }
  }

  /**
   * Removes a lock left by a crashed writer, but only the one judged stale: if another waiter
   * broke it first and a live writer took a new lock, the moved file holds another owner and
   * is put back. (A third writer locking in that instant could still race; see the header.)
   */
  private async breakLock(file: string, staleOwner: string): Promise<void> {
    const moved = `${file}.${randomUUID()}.stale`;
    try {
      await rename(file, moved);
    } catch {
      return; // someone else broke or released it
    }
    const owner = await readFile(moved, 'utf8').catch(() => null);
    if (owner !== staleOwner) await link(moved, file).catch(() => undefined);
    await unlink(moved).catch(() => undefined);
  }

  /** Volume clock minus local clock, from the mtime of a file written just now. */
  private async volumeSkew(dir: string): Promise<number> {
    const probe = join(dir, `clock-${randomUUID()}`);
    try {
      const before = Date.now();
      await writeFile(probe, '');
      const s = await stat(probe);
      return s.mtimeMs - (before + Date.now()) / 2;
    } catch {
      return 0;
    } finally {
      await unlink(probe).catch(() => undefined);
    }
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = join(this.root, `.ready-${randomUUID()}`);
    await writeFile(probe, '');
    await unlink(probe);
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
