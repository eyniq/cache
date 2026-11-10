// Validation of a published npm tarball (C4): it must be a gzip-compressed tar whose
// package/package.json names exactly the package and version being published. Bounded: the
// gzip stream is decompressed asynchronously (zlib on the libuv pool) and stopped once the
// unpacked size passes the limit (gzip bombs), the number of entries is capped, only tar
// headers are parsed (file contents are skipped) and package.json is read up to 1 MiB.
// Refused because consumers may extract them unsafely or ambiguously: paths outside
// package/, absolute paths, "..", "." and empty segments (only one trailing slash is
// allowed), links and special files, a second package/package.json in any spelling that an
// extractor could map to the same file (extractors keep the last, validators often check the
// first), checksum errors, truncation and data after the end-of-archive marker. Pax extended
// headers may only carry what npm's own packer writes: `path`, the times and a `size` equal
// to the entry's own; anything else (linkpath, charset, vendor records, a size that would make
// extractors read the archive differently, global path or size records) is refused, as are
// malformed records and extended headers that describe no entry. Header fields are read the
// way npm's extractor (node-tar) reads them: the ustar prefix counts only with magic "ustar\0"
// and version "00"; GNU headers ("ustar  \0") must leave the prefix area empty; any other
// magic (old v7 headers included) is refused, as are name, prefix and long-name fields with
// bytes after their NUL terminator (node-tar keeps text after a NUL once a newline follows)
// and file entries whose path ends in a slash (node-tar extracts them as directories), and
// directory entries with a size (node-tar forces it to 0 and reads the "body" as headers). The
// walk yields to the event loop every few MiB, so a large archive does not hold the main
// thread.
import { setImmediate as yieldNow } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { HttpError } from '../../core/errors.ts';

export interface TarballLimits {
  /** Largest total size of the decompressed archive. */
  maxUnpackedBytes: number;
  /** Largest package/package.json. Default 1 MiB. */
  maxManifestBytes?: number;
  /** Most entries (headers). Default 100,000. */
  maxEntries?: number;
}

export interface TarballManifest {
  name: string;
  version: string;
  /** Size of the decompressed archive. */
  unpackedBytes: number;
  /** The parsed package/package.json. */
  packageJson: Record<string, unknown>;
  /** The archive has package/binding.gyp (npm then runs node-gyp rebuild at install). */
  hasBindingGyp: boolean;
  /** The archive has package/npm-shrinkwrap.json (npm then installs its locked tree). */
  hasShrinkwrap: boolean;
}

/**
 * Version fields that decide what an install runs and pulls in, or that policies judge. The
 * tarball's package.json is what gets installed, so these come from it and never from the
 * publish body ("manifest confusion"): a field the tarball lacks is dropped.
 */
export const TARBALL_FIELDS = [
  'scripts',
  'license',
  'os',
  'cpu',
  'engines',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
] as const;

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** A relative path without "./", "." or ".." segments, or null. */
function plainPath(p: string): string | null {
  const segments = p
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..') ? segments.join('/') : null;
}

/**
 * True when `bin` is what npm derives from `directories.bin` (package.json without `bin`):
 * entries named after a file under that directory, pointing at it.
 */
function binFromDirectory(bin: unknown, directory: string): boolean {
  const dir = plainPath(directory);
  if (dir === null || !isRecord(bin)) return false;
  return Object.entries(bin).every(([name, target]) => {
    const path = typeof target === 'string' ? plainPath(target) : null;
    return (
      path !== null && path.startsWith(`${dir}/`) && path.slice(path.lastIndexOf('/') + 1) === name
    );
  });
}

/**
 * `manifest` (a version from the publish body) with TARBALL_FIELDS taken from the tarball,
 * `bin` from it too (or, without one, only what npm derives from `directories.bin`), and
 * hasInstallScript and _hasShrinkwrap derived from it: install scripts, or a binding.gyp that
 * npm builds unless package.json says `"gypfile": false`; a package/npm-shrinkwrap.json.
 */
export function withTarballFields(
  manifest: Record<string, unknown>,
  inside: TarballManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  const pkg = inside.packageJson;
  for (const field of TARBALL_FIELDS) {
    if (Object.hasOwn(pkg, field)) out[field] = pkg[field];
    else Reflect.deleteProperty(out, field);
  }
  const directories = isRecord(pkg.directories) ? pkg.directories : {};
  if (Object.hasOwn(pkg, 'bin')) {
    out.bin = pkg.bin;
  } else if (
    typeof directories.bin !== 'string' ||
    !binFromDirectory(manifest.bin, directories.bin)
  ) {
    Reflect.deleteProperty(out, 'bin');
  }
  out._hasShrinkwrap = inside.hasShrinkwrap;
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  const install =
    INSTALL_SCRIPTS.some((s) => typeof scripts[s] === 'string') ||
    (inside.hasBindingGyp && pkg.gypfile !== false);
  if (install) out.hasInstallScript = true;
  else Reflect.deleteProperty(out, 'hasInstallScript');
  return out;
}

const BLOCK = 512;
const MANIFEST = 'package/package.json';
/** Decompressed bytes between two turns of the event loop. */
const YIELD_EVERY = 4 * 1024 * 1024;
const PAX_TIME = /^-?\d{1,12}(\.\d{1,9})?$/;

const bad = (why: string): HttpError => new HttpError(400, `invalid tarball: ${why}`);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

/**
 * A NUL-terminated text field, strictly: everything after the first NUL must be NUL too.
 * node-tar decodes fields with `.replace(/\0.*\/, '')`, which stops at a newline, so text
 * after the terminator could make it read a different path than this checker.
 */
function strictString(buf: Buffer, start: number, length: number, what: string): string {
  const field = buf.subarray(start, start + length);
  const nul = field.indexOf(0);
  if (nul === -1) return field.toString('utf8');
  if (field.subarray(nul).some((b) => b !== 0)) throw bad(`${what} has data after its end`);
  return field.subarray(0, nul).toString('utf8');
}

const POSIX_MAGIC = 'ustar\u000000';
const GNU_MAGIC = 'ustar  \u0000';

/**
 * The ustar prefix as node-tar applies it: only for magic "ustar\0" plus version "00" (155
 * bytes when byte 475 is set, else 130: star keeps times after it). GNU headers keep other
 * data there, which node-tar ignores; it must be empty. Other formats are refused.
 */
function ustarPrefix(block: Buffer): string {
  const magic = block.subarray(257, 265).toString('latin1');
  if (magic === POSIX_MAGIC) {
    return strictString(block, 345, block[475] !== 0 ? 155 : 130, 'the ustar prefix');
  }
  if (magic === GNU_MAGIC) {
    if (block.subarray(345, 500).some((b) => b !== 0))
      throw bad('a GNU header uses the prefix area');
    return '';
  }
  throw bad('unsupported tar header format');
}

function octal(buf: Buffer, start: number, length: number, what: string): number {
  const field = buf.subarray(start, start + length);
  // Base-256 (high bit set) encodes sizes above 8 GiB: never needed for a package.
  if (((field[0] ?? 0) & 0x80) !== 0) throw bad(`${what} uses an unsupported encoding`);
  const text = cString(buf, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]{1,12}$/.test(text)) throw bad(`${what} is not an octal number`);
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8, 'header checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === stored;
}

interface PaxRecords {
  path?: string;
  size?: number;
}

/**
 * The records of a pax extended header ("<len> <key>=<value>\n" ...), strictly: canonical
 * lengths that end exactly on a newline, each key once, only the keys npm's packer writes.
 */
function parsePax(data: Buffer, global: boolean): PaxRecords {
  const out: PaxRecords = {};
  const seen = new Set<string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const digits = space === -1 ? '' : data.subarray(pos, space).toString('latin1');
    if (!/^[1-9][0-9]{0,5}$/.test(digits)) throw bad('malformed pax header');
    const len = Number(digits);
    if (pos + len > data.length || len < digits.length + 4 || data[pos + len - 1] !== 0x0a) {
      throw bad('malformed pax header');
    }
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq <= 0) throw bad('malformed pax header');
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (seen.has(key)) throw bad('a pax header repeats a record');
    seen.add(key);
    switch (key) {
      case 'path':
        if (global || value === '') throw bad('unsupported pax path record');
        out.path = value;
        break;
      case 'size':
        if (global || !/^[0-9]{1,12}$/.test(value)) throw bad('unsupported pax size record');
        out.size = Number(value);
        break;
      case 'mtime':
      case 'atime':
      case 'ctime':
        if (!PAX_TIME.test(value)) throw bad('malformed pax time record');
        break;
      default:
        throw bad('unsupported pax record');
    }
    pos += len;
  }
  return out;
}

/**
 * How a case-insensitive file system that drops trailing dots and spaces (Windows) sees a
 * canonical path: what it could be extracted over.
 */
function folded(p: string): string {
  return p
    .split('/')
    .map((s) => s.replace(/[. ]+$/, ''))
    .filter((s) => s !== '')
    .join('/')
    .toLowerCase();
}

/**
 * The canonical entry path, or a refusal: one optional leading "./" and one trailing slash
 * (directories) are allowed; nothing an extractor would normalise to another path is.
 */
function checkPath(path: string): string {
  let p = path.startsWith('./') ? path.slice(2) : path;
  if (p.includes('\0') || p.includes('\\')) throw bad('entry path has forbidden characters');
  if (p.startsWith('/')) throw bad('entry path is absolute');
  if (p.endsWith('/')) p = p.slice(0, -1);
  const segments = p.split('/');
  if (segments.includes('..')) throw bad('entry path leaves the package');
  if (segments.some((s) => s === '' || s === '.')) throw bad('entry path is not canonical');
  if (segments[0] !== 'package') throw bad('entries must be inside package/');
  // Case-insensitive file systems would extract it over package/package.json, and Windows
  // drops trailing dots and spaces from each segment.
  if (p !== MANIFEST && folded(p) === MANIFEST) {
    throw bad('entry path is another spelling of package/package.json');
  }
  return p;
}

/** Streaming tar header walker over decompressed chunks. */
class TarWalker {
  private pending = Buffer.alloc(0);
  /** Bytes of the current entry's data (plus padding) still to skip or capture. */
  private remaining = 0;
  private padding = 0;
  private capture: {
    kind: 'manifest' | 'pax' | 'global' | 'longname';
    chunks: Buffer[];
    size: number;
  } | null = null;
  private nextPath: string | undefined;
  private nextSize: number | undefined;
  /** An extended header (x or L) was read and waits for its entry. */
  private extended = false;
  private entries = 0;
  private ended = false;
  manifest: Buffer | null = null;
  hasBindingGyp = false;
  hasShrinkwrap = false;
  private readonly maxManifest: number;
  private readonly maxEntries: number;

  constructor(maxManifest: number, maxEntries: number) {
    this.maxManifest = maxManifest;
    this.maxEntries = maxEntries;
  }

  push(chunk: Buffer): void {
    let buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, buf.length);
        if (this.capture) this.capture.chunks.push(buf.subarray(0, take));
        this.remaining -= take;
        buf = buf.subarray(take);
        if (this.remaining > 0) break;
        this.finishData();
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, buf.length);
        this.padding -= take;
        buf = buf.subarray(take);
        if (this.padding > 0) break;
        continue;
      }
      if (buf.length < BLOCK) break;
      this.header(buf.subarray(0, BLOCK));
      buf = buf.subarray(BLOCK);
    }
    this.pending = Buffer.from(buf);
  }

  private header(block: Buffer): void {
    if (block.every((b) => b === 0)) {
      this.ended = true;
      return;
    }
    if (this.ended) throw bad('data after the end of the archive');
    if (++this.entries > this.maxEntries) throw bad('too many entries');
    if (!checksumOk(block)) throw bad('header checksum mismatch');
    const type = String.fromCharCode(block[156] ?? 0);
    const size = octal(block, 124, 12, 'entry size');
    const name = strictString(block, 0, 100, 'the entry name');
    const prefix = ustarPrefix(block);
    const headerPath = prefix ? `${prefix}/${name}` : name;

    if (type === 'x' || type === 'L' || type === 'g') {
      if (this.extended) throw bad('extended headers in a row');
      if (size > 64 * 1024) throw bad('extended header too large');
      const kind = type === 'x' ? 'pax' : type === 'g' ? 'global' : 'longname';
      this.extended = type !== 'g';
      this.startData(size, { kind, chunks: [], size });
      return;
    }
    const rawPath = this.nextPath ?? headerPath;
    if (type !== '5' && rawPath.endsWith('/')) {
      throw bad('a file entry path ends in a slash');
    }
    const path = checkPath(rawPath);
    if (this.nextSize !== undefined && this.nextSize !== size) {
      throw bad('pax size differs from the entry');
    }
    this.nextPath = undefined;
    this.nextSize = undefined;
    this.extended = false;
    if (type === '5') {
      // node-tar sets a directory's size to 0 and parses what follows as headers.
      if (size !== 0) throw bad('a directory entry has data');
      return;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      throw bad('links and special files are not allowed');
    }
    const key = folded(path);
    if (key === 'package/binding.gyp') this.hasBindingGyp = true;
    if (key === 'package/npm-shrinkwrap.json') this.hasShrinkwrap = true;
    if (path === MANIFEST) {
      if (this.manifest !== null) throw bad('more than one package/package.json');
      if (size > this.maxManifest) throw bad('package.json is too large');
      this.startData(size, { kind: 'manifest', chunks: [], size });
      return;
    }
    this.startData(size, null);
  }

  private startData(size: number, capture: TarWalker['capture']): void {
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.capture = capture;
    if (size === 0) this.finishData();
  }

  private finishData(): void {
    const c = this.capture;
    this.capture = null;
    if (!c) return;
    const data = Buffer.concat(c.chunks);
    if (c.kind === 'manifest') {
      this.manifest = data;
    } else if (c.kind === 'pax') {
      const pax = parsePax(data, false);
      this.nextPath = pax.path;
      this.nextSize = pax.size;
    } else if (c.kind === 'global') {
      parsePax(data, true); // validated only: no global record changes how entries are read
    } else {
      this.nextPath = strictString(data, 0, data.length, 'a long name');
    }
  }

  finish(): void {
    if (this.remaining > 0 || this.padding > 0 || this.pending.some((b) => b !== 0)) {
      throw bad('the archive is truncated');
    }
    if (this.entries === 0) throw bad('the archive is empty');
    if (this.extended) throw bad('an extended header describes no entry');
  }
}

/** Strips what npm itself strips from a version before comparing ("v1.0.0", " 1.0.0"). */
function cleanVersion(v: string): string {
  return v.trim().replace(/^[=v]+/, '');
}

/**
 * Validates `data` and returns the name and version of its package.json. Throws
 * HttpError(400) for anything that is not a well-formed package archive.
 */
export async function inspectTarball(
  data: Buffer,
  limits: TarballLimits,
): Promise<TarballManifest> {
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b) throw bad('not gzip data');
  const walker = new TarWalker(
    limits.maxManifestBytes ?? 1024 * 1024,
    limits.maxEntries ?? 100_000,
  );
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip();
    let sinceYield = 0;
    let failed = false;
    const fail = (err: unknown): void => {
      if (failed) return;
      failed = true;
      gunzip.destroy();
      reject(err instanceof HttpError ? err : bad('not valid gzip data'));
    };
    gunzip.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > limits.maxUnpackedBytes) {
        fail(bad('the unpacked size exceeds the limit'));
        return;
      }
      try {
        walker.push(chunk);
      } catch (err) {
        fail(err);
        return;
      }
      sinceYield += chunk.length;
      if (sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        gunzip.pause();
        void yieldNow().then(() => {
          if (!failed) gunzip.resume();
        });
      }
    });
    gunzip.on('error', fail);
    gunzip.on('end', () => {
      if (failed) return;
      try {
        walker.finish();
        resolve();
      } catch (err) {
        fail(err);
      }
    });
    gunzip.end(data);
  });
  if (!walker.manifest) throw bad('package/package.json is missing');
  let manifest: unknown;
  try {
    manifest = JSON.parse(walker.manifest.toString('utf8'));
  } catch {
    throw bad('package/package.json is not valid JSON');
  }
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string'
  ) {
    throw bad('package/package.json needs a name and a version');
  }
  return {
    name: manifest.name,
    version: cleanVersion(manifest.version),
    unpackedBytes: total,
    packageJson: manifest,
    hasBindingGyp: walker.hasBindingGyp,
    hasShrinkwrap: walker.hasShrinkwrap,
  };
}
