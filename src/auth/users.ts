// The community user store (C3): a JSON file (USERS_FILE) managed with the `user` CLI.
//   { "version": 1, "users": { "<name>": { "password": "$scrypt$...", "created": "<ISO>",
//     "changed": "<ISO>", "generation": <integer>, "packages"?: ["@acme/*", "tool"] } } }
// `changed` is when the password last changed (shown by `user list`). `generation` changes with
// every password change (and differs for a removed and re-added name): every token carries
// the generation it was issued under and works only while that is still the user's
// generation, so no clock comparison between hosts is involved. Hand-written records without
// it use the `changed` time in milliseconds. `packages` limits what the user may publish (absent: every package this registry owns;
// []: nothing). The server re-reads the file when it changes (checked at most every few
// seconds, so CLI edits and Secret updates apply without a restart) and keeps the last good
// snapshot if a new version does not parse. Writers (CLI, self-registration) hold an O_EXCL
// lock file next to it, re-read it under the lock and replace it atomically (rename), so
// concurrent writers on one host or a shared volume do not lose each other's changes. The
// lock holds its owner's random id: a writer only removes its own lock, and a stale lock (a
// crashed writer) is broken under a second guard file and renamed aside first, so two
// writers breaking the same stale lock cannot remove each other's fresh one.
import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { errorFields, log } from '../core/log.ts';
import { isNamePattern } from '../core/patterns.ts';
import { isPasswordHash } from './password.ts';

export interface UserRecord {
  password: string;
  created: string;
  changed: string;
  /** See the header; absent in hand-written records (then the `changed` time). */
  generation?: number;
  packages?: string[];
}

export interface UsersData {
  version: 1;
  /** Null-prototype map: user names never reach Object.prototype. */
  users: Record<string, UserRecord>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const RECORD_KEYS = new Set(['password', 'created', 'changed', 'generation', 'packages']);
const MAX_USERS_IN_FILE = 100_000;
const MAX_PATTERNS = 1_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function isValidUserName(name: string): boolean {
  // "__proto__" and friends contain underscores at the start, which NAME refuses.
  return NAME.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The generation tokens of this user must carry (see the header). */
export function generationOf(record: UserRecord): number {
  return record.generation ?? Date.parse(record.changed);
}

/** A generation different from (and above) `previous`, for a new user or a new password. */
export function nextGeneration(previous?: number): number {
  return Math.max((previous ?? 0) + 1, Date.now());
}

export function emptyUsers(): UsersData {
  return { version: 1, users: Object.create(null) as Record<string, UserRecord> };
}

/** Throws an Error naming the problem (never file contents, hashes or passwords). */
export function parseUsers(text: string): UsersData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('users file is not valid JSON');
  }
  if (!isRecord(data) || data.version !== 1) {
    throw new Error('users file must be an object with "version": 1');
  }
  if (!isRecord(data.users)) throw new Error('users file needs a "users" object');
  const out = emptyUsers();
  const entries = Object.entries(data.users);
  if (entries.length > MAX_USERS_IN_FILE) throw new Error('users file holds too many users');
  for (const [name, value] of entries) {
    if (!isValidUserName(name)) throw new Error('users file contains an invalid user name');
    if (!isRecord(value)) throw new Error(`user "${name}" must be an object`);
    for (const key of Object.keys(value)) {
      if (!RECORD_KEYS.has(key)) throw new Error(`user "${name}" has an unknown member`);
    }
    if (typeof value.password !== 'string' || !isPasswordHash(value.password)) {
      throw new Error(`user "${name}" has no valid scrypt password hash`);
    }
    for (const key of ['created', 'changed'] as const) {
      const t = value[key];
      if (typeof t !== 'string' || !ISO.test(t) || Number.isNaN(Date.parse(t))) {
        throw new Error(`user "${name}" has an invalid ${key} time`);
      }
    }
    const record: UserRecord = {
      password: value.password,
      created: value.created as string,
      changed: value.changed as string,
    };
    if (value.generation !== undefined) {
      const g = value.generation;
      if (typeof g !== 'number' || !Number.isSafeInteger(g) || g < 0) {
        throw new Error(`user "${name}" has an invalid generation`);
      }
      record.generation = g;
    }
    if (value.packages !== undefined) {
      const p = value.packages;
      if (
        !Array.isArray(p) ||
        p.length > MAX_PATTERNS ||
        !p.every((x): x is string => typeof x === 'string' && isNamePattern(x))
      ) {
        throw new Error(`user "${name}" has invalid package patterns`);
      }
      record.packages = [...p];
    }
    out.users[name] = record;
  }
  return out;
}

export function serializeUsers(data: UsersData): string {
  const users: Record<string, UserRecord> = {};
  for (const name of Object.keys(data.users).sort()) {
    Object.defineProperty(users, name, {
      value: data.users[name],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return `${JSON.stringify({ version: 1, users }, null, 2)}\n`;
}

export interface UsersFileOptions {
  /** A missing file counts as empty (self-registration, CLI); otherwise it is an error. */
  allowMissing?: boolean;
  /** How often the server checks the file for changes. Default 2 s. */
  reloadIntervalMs?: number;
  /** A lock file older than this was left by a crashed writer and is removed. Default 30 s. */
  staleLockMs?: number;
  now?: () => number;
}

interface Snapshot {
  data: UsersData;
  mtimeMs: number;
  size: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class UsersFile {
  readonly path: string;
  private snapshot: Snapshot;
  private readonly reloadIntervalMs: number;
  private readonly staleLockMs: number;
  private readonly allowMissing: boolean;
  private readonly now: () => number;
  private checkedAt: number;
  private reloading: Promise<void> | null = null;

  private constructor(path: string, snapshot: Snapshot, opts: UsersFileOptions) {
    this.path = path;
    this.snapshot = snapshot;
    this.reloadIntervalMs = opts.reloadIntervalMs ?? 2_000;
    this.staleLockMs = opts.staleLockMs ?? 30_000;
    this.allowMissing = opts.allowMissing ?? false;
    this.now = opts.now ?? Date.now;
    this.checkedAt = this.now();
  }

  /** Reads the file once; throws an Error with a usable message when it cannot be used. */
  static async open(path: string, opts: UsersFileOptions = {}): Promise<UsersFile> {
    const snapshot = await UsersFile.read(path);
    if (!snapshot) {
      if (!opts.allowMissing) {
        throw new Error('users file does not exist (create it with the `user add` command)');
      }
      return new UsersFile(path, { data: emptyUsers(), mtimeMs: 0, size: 0 }, opts);
    }
    return new UsersFile(path, snapshot, opts);
  }

  private static async read(path: string): Promise<Snapshot | null> {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (info.size > MAX_FILE_BYTES) throw new Error('users file is too large');
    const text = await readFile(path, 'utf8');
    return { data: parseUsers(text), mtimeMs: info.mtimeMs, size: info.size };
  }

  /** The user's record from the current snapshot; schedules a change check when due. */
  get(name: string): UserRecord | undefined {
    this.maybeReload();
    if (!isValidUserName(name)) return undefined;
    return Object.hasOwn(this.snapshot.data.users, name)
      ? this.snapshot.data.users[name]
      : undefined;
  }

  count(): number {
    return Object.keys(this.snapshot.data.users).length;
  }

  /** Names and records (no copies of the hashes leave this module besides the record). */
  entries(): Array<[string, UserRecord]> {
    return Object.entries(this.snapshot.data.users);
  }

  private maybeReload(): void {
    if (this.reloading || this.now() - this.checkedAt < this.reloadIntervalMs) return;
    this.reloading = this.reload().finally(() => {
      this.reloading = null;
    });
  }

  /** Re-reads the file when its size or modification time changed. Never throws. */
  async reload(): Promise<void> {
    this.checkedAt = this.now();
    try {
      const info = await stat(this.path).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      });
      if (!info) {
        if (!this.allowMissing) log.error('users file disappeared; keeping the last users');
        return;
      }
      if (info.mtimeMs === this.snapshot.mtimeMs && info.size === this.snapshot.size) return;
      const next = await UsersFile.read(this.path);
      if (next) this.snapshot = next;
    } catch (err) {
      log.error('users file could not be reloaded; keeping the last users', errorFields(err));
    }
  }

  /**
   * Applies `change` to the current file contents under the lock and writes the result
   * atomically. `change` may throw to abort, or return null to leave the file unchanged.
   */
  async update(
    change: (data: UsersData) => UsersData | null | Promise<UsersData | null>,
  ): Promise<UsersData> {
    const lock = `${this.path}.lock`;
    const owner = await this.acquire(lock);
    try {
      const current = (await UsersFile.read(this.path)) ?? {
        data: emptyUsers(),
        mtimeMs: 0,
        size: 0,
      };
      const next = await change(current.data);
      if (next === null) {
        this.snapshot = current;
        return current.data;
      }
      const text = serializeUsers(next);
      parseUsers(text); // never write a file the server would refuse
      const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
        await rename(tmp, this.path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      const info = await stat(this.path);
      this.snapshot = { data: parseUsers(text), mtimeMs: info.mtimeMs, size: info.size };
      this.checkedAt = this.now();
      return this.snapshot.data;
    } finally {
      await this.release(lock, owner);
    }
  }

  /** Takes the lock; returns the owner id written into it. */
  private async acquire(lock: string): Promise<string> {
    const owner = randomBytes(12).toString('hex');
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const handle = await open(lock, 'wx', 0o600);
        try {
          await handle.writeFile(owner);
        } finally {
          await handle.close();
        }
        return owner;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const seen = await readLock(lock);
      if (seen && Date.now() - seen.mtimeMs > this.staleLockMs) {
        await this.breakStale(lock, seen.owner);
        continue;
      }
      if (Date.now() > deadline) throw new Error('users file is locked by another writer');
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }

  /**
   * Removes a stale lock left by a crashed writer. Breakers take turns through a second
   * O_EXCL guard file and re-check the lock under it, so two writers that both saw the same
   * stale lock never remove a fresh lock one of them took in the meantime. The lock is then
   * renamed aside and checked once more; a live lock moved by mistake (its owner was only
   * slow, and released and re-acquired in between) is put back.
   */
  private async breakStale(lock: string, staleOwner: string): Promise<void> {
    const guard = `${lock}.break`;
    try {
      const handle = await open(guard, 'wx', 0o600);
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another writer is breaking it; a guard left by a crashed breaker goes as well.
      const info = await stat(guard).catch(() => null);
      if (info && Date.now() - info.mtimeMs > this.staleLockMs) await rm(guard, { force: true });
      return;
    }
    try {
      const seen = await readLock(lock);
      if (!seen || seen.owner !== staleOwner || Date.now() - seen.mtimeMs <= this.staleLockMs) {
        return; // already broken (and maybe taken again) by someone else
      }
      const aside = `${lock}.stale-${randomBytes(6).toString('hex')}`;
      try {
        await rename(lock, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      const moved = await readLock(aside);
      if (moved?.owner !== staleOwner) {
        // Restore it unless a writer holds a new one (link never replaces a file).
        await link(aside, lock).catch((err: unknown) => {
          log.warn('a users file lock could not be restored', errorFields(err));
        });
      } else {
        log.warn('removed a stale users file lock');
      }
      await rm(aside, { force: true });
    } finally {
      await rm(guard, { force: true });
    }
  }

  /** Removes the lock only while it is still ours (a slow writer's lock may have been broken). */
  private async release(lock: string, owner: string): Promise<void> {
    const current = await readLock(lock);
    if (current?.owner === owner) {
      await rm(lock, { force: true });
    } else {
      log.warn('the users file lock was taken over by another writer while held');
    }
  }
}

async function readLock(path: string): Promise<{ owner: string; mtimeMs: number } | null> {
  try {
    const [owner, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { owner, mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
