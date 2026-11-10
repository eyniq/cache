// Private npm packages of the community build (C4): a PackageSource over object storage for
// the names PRIVATE_PACKAGES claims.
//   private/npm/packuments/<name>.json   the package document, changed only by compare-and-
//                                        swap (putIfAbsent / putIfMatch) with retries, so
//                                        concurrent publishes on several pods never lose a
//                                        version
//   tarballs/sha512/<hex>                tarball bytes in the core's content-addressed layout
// The layout and document format are those that downstream sources also use, so
// a registry can move between builds without migrating packages.
// The core has already checked the publish permission, ownership, the name, the digests and
// the body size; this source enforces the rest: the tarball must be a valid package archive
// for exactly this name and version (tarball-check.ts), versions are immutable (also after an
// unpublish), revisions, the unpublish window (only the user who published a version may
// unpublish it), dist-tags, deprecations and size limits (MAX_UNPACKED_BYTES covers all
// tarballs of one publish together). Tarballs this call wrote are deleted again when the
// document update fails, unless the document references them by then.
// Owned names are never fetched upstream (core), even when they do not exist here.
// Provenance bundles and attestations are not stored or verified: the npm adapter drops them
// before they reach this source.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  DeprecateRequest,
  DistTagRequest,
  Identity,
  MetadataFetchOptions,
  MetadataFetchResult,
  OpenedObject,
  PackageSource,
  PublishRequest,
  SearchHit,
  SearchQuery,
  Storage,
  StorageAdmin,
  UnpublishRequest,
} from '../../core/contracts.ts';
import { HttpError } from '../../core/errors.ts';
import { errorFields, log } from '../../core/log.ts';
import { contentKey } from '../../core/names.ts';
import { matchesAnyPattern } from '../../core/patterns.ts';
import { isStorageAdmin } from '../../core/storage.ts';
import { readLimited } from '../../core/streams.ts';
import { unscopedName } from './names.ts';
import { compareVersions } from './semver.ts';
import { inspectTarball, withTarballFields } from './tarball-check.ts';

export const PRIVATE_DOCUMENT_PREFIX = 'private/npm/packuments/';
const PREFIX = PRIVATE_DOCUMENT_PREFIX;
const MAX_ATTEMPTS = 200;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const DEFAULT_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** How long the search index of one pod may be behind other pods' publishes. */
const INDEX_TTL_MS = 10_000;
const MAX_INDEXED = 10_000;
/** Document bytes one index refresh reads at most; the rest follows on the next search. */
const DEFAULT_INDEX_BYTES_PER_PASS = 64 * 1024 * 1024;
/** Search results are printed in terminals: control characters and bidi controls go. */
const CONTROL = /\p{Cc}+/gu;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function printable(text: string): string {
  return text.replace(CONTROL, ' ').replace(BIDI, '');
}

export interface StoredDoc {
  name: string;
  /** Monotonic per document; part of `_rev`. */
  rev: number;
  /** Random per document, so `_rev` values are not guessable across registries. */
  epoch: string;
  versions: Record<string, Record<string, unknown>>;
  time: Record<string, string>;
  'dist-tags': Record<string, string>;
  /** Package-level fields of the latest publish (description, readme, ...). */
  document: Record<string, unknown>;
  /** Unpublished versions and when: their numbers can never be published again. */
  unpublished: Record<string, string>;
}

export interface NpmPrivateSourceOptions {
  storage: Storage;
  /** Owned names: exact names, `@scope/*`, `prefix*` (src/core/patterns.ts). */
  packages: readonly string[];
  /** Versions can be unpublished this long after their publish; 0 never. */
  unpublishWindowMs: number;
  /** Largest stored package document (JSON bytes). Default 16 MiB. */
  maxDocumentBytes?: number;
  /** Largest unpacked size of the tarballs of one publish together. Default 256 MiB. */
  maxUnpackedBytes?: number;
  maxVersions?: number;
  /** Document bytes one search index refresh reads at most. Default 64 MiB. */
  indexBytesPerPass?: number;
  now?: () => number;
}

interface IndexEntry {
  etag: string;
  hit: SearchHit;
  /** Lowercase name, description and keywords, for matching. */
  haystack: string;
  keywords: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDoc(v: unknown, name: string): StoredDoc {
  if (
    !isRecord(v) ||
    v.name !== name ||
    typeof v.rev !== 'number' ||
    typeof v.epoch !== 'string' ||
    !isRecord(v.versions) ||
    !isRecord(v.time) ||
    !isRecord(v['dist-tags']) ||
    !isRecord(v.document) ||
    !isRecord(v.unpublished)
  ) {
    throw new HttpError(500, 'corrupt private package document');
  }
  return v as unknown as StoredDoc;
}

const conflict = (message: string): HttpError => new HttpError(409, message);

/** Highest stable version (else highest of all), for repointing `latest`. */
function newest(versions: string[]): string | undefined {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));
  return sorted.find((v) => !v.includes('-')) ?? sorted[0];
}

/** Tags of removed versions: `latest` moves to the newest remaining version, others go. */
function fixDistTags(doc: StoredDoc): void {
  for (const [tag, v] of Object.entries(doc['dist-tags'])) {
    if (!Object.hasOwn(doc.versions, v)) Reflect.deleteProperty(doc['dist-tags'], tag);
  }
  if (!doc['dist-tags'].latest) {
    const latest = newest(Object.keys(doc.versions));
    if (latest) doc['dist-tags'].latest = latest;
  }
}

export class NpmPrivateSource implements PackageSource {
  readonly metadataTtlMs = 0;
  private readonly storage: Storage & StorageAdmin;
  private readonly packages: readonly string[];
  private readonly opts: NpmPrivateSourceOptions;
  private readonly now: () => number;
  private readonly maxDocumentBytes: number;
  private readonly index = new Map<string, IndexEntry>();
  /** Packages this pod changed since the index saw them: re-read on the next search. */
  private readonly dirty = new Set<string>();
  private indexedAt = Number.NEGATIVE_INFINITY;
  private indexing: Promise<void> | null = null;

  constructor(opts: NpmPrivateSourceOptions) {
    if (!isStorageAdmin(opts.storage)) {
      throw new Error('private packages need storage with compare-and-swap (fs or s3)');
    }
    this.storage = opts.storage;
    this.packages = [...opts.packages];
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.maxDocumentBytes = opts.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  }

  /** Case-insensitive: every spelling of an owned name stays away from upstream. */
  owns(name: string): boolean {
    return matchesAnyPattern(this.packages, name);
  }

  private key(name: string): string {
    return `${PREFIX}${name}.json`;
  }

  private async load(
    name: string,
  ): Promise<{ doc: StoredDoc; etag: string; bytes: number } | null> {
    // Owned packages are lowercase; other spellings have no document of their own.
    if (name !== name.toLowerCase()) return null;
    const key = this.key(name);
    const opened = this.storage.open ? await this.storage.open(key) : null;
    let body: Readable | null = opened?.body ?? null;
    let etag = opened?.etag;
    if (!this.storage.open) {
      // Without open(), head and get can race; putIfMatch still refuses a stale etag.
      const info = await this.storage.head(key);
      body = info ? await this.storage.get(key) : null;
      etag = info?.etag;
    }
    if (!body) return null;
    if (!etag) {
      body.resume();
      throw new Error(`storage gave no etag for ${key}`);
    }
    const bytes = await readLimited(
      body,
      this.maxDocumentBytes,
      () => new HttpError(500, 'private package document too large'),
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new HttpError(500, 'corrupt private package document');
    }
    return { doc: parseDoc(value, name), etag, bytes: bytes.length };
  }

  async getMetadata(name: string, opts: MetadataFetchOptions): Promise<MetadataFetchResult> {
    if (name !== name.toLowerCase()) return { status: 'not-found' };
    const info = await this.storage.head(this.key(name));
    if (!info) return { status: 'not-found' };
    if (info.etag && opts.etag === info.etag) return { status: 'not-modified' };
    const found = await this.load(name);
    if (!found || Object.keys(found.doc.versions).length === 0) return { status: 'not-found' };
    const d = found.doc;
    const body = Buffer.from(
      JSON.stringify({
        ...d.document,
        _id: d.name,
        _rev: `${d.rev}-${d.epoch}`,
        name: d.name,
        'dist-tags': d['dist-tags'],
        versions: d.versions,
        time: d.time,
      }),
    );
    if (body.length > opts.maxBytes) throw new HttpError(502, 'private package document too large');
    return { status: 'ok', raw: { body, encoding: 'identity', etag: found.etag } };
  }

  async getArtifact(name: string, file: string): Promise<OpenedObject | null> {
    const found = await this.load(name);
    if (!found) return null;
    const manifest = Object.values(found.doc.versions).find((m) => {
      const dist = isRecord(m.dist) ? m.dist : {};
      return typeof dist.tarball === 'string' && dist.tarball.endsWith(`/-/${file}`);
    });
    const integrity = isRecord(manifest?.dist) ? manifest.dist.integrity : undefined;
    if (typeof integrity !== 'string' || !SHA512_INTEGRITY.test(integrity)) return null;
    const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
    const key = contentKey({ algorithm: 'sha512', hex });
    if (this.storage.open) return this.storage.open(key);
    const info = await this.storage.head(key);
    const body = info ? await this.storage.get(key) : null;
    return info && body ? { body, size: info.size } : null;
  }

  /** Every write names its author (`_npmUser`, audit) and must be for an owned name. */
  private requireWriter(name: string, identity: Identity | null): void {
    if (identity === null) throw new HttpError(403, 'writes need an authenticated identity');
    if (!this.owns(name)) throw new HttpError(403, 'this registry does not own this package');
    if (name !== name.toLowerCase()) throw new HttpError(400, 'package names must be lowercase');
  }

  /**
   * Read-modify-write with compare-and-swap; `change` throws HttpError to refuse, or returns
   * the next document (null writes nothing).
   */
  private async update(
    name: string,
    change: (doc: StoredDoc | null) => StoredDoc | null,
  ): Promise<StoredDoc | null> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.load(name);
      const next = change(current?.doc ?? null);
      if (next === null) return current?.doc ?? null;
      const body = Buffer.from(JSON.stringify(next));
      if (body.length > this.maxDocumentBytes) {
        throw new HttpError(413, 'package document would exceed the size limit');
      }
      const opts = { contentType: 'application/json' };
      const written = current
        ? await this.storage.putIfMatch(this.key(name), body, current.etag, opts)
        : await this.storage.putIfAbsent(this.key(name), body, opts);
      if (written) {
        this.markDirty(name); // this pod's search sees the change at once
        return next;
      }
      // Lost the race: another writer changed the document. Back off a little and retry.
      await new Promise((r) =>
        setTimeout(r, Math.floor(Math.random() * Math.min(50, 2 + attempt * 2))),
      );
    }
    throw new HttpError(503, 'package document is busy, try again');
  }

  private checkRev(doc: StoredDoc | null, rev: string | undefined): void {
    if (rev === undefined) return;
    if (!doc || `${doc.rev}-${doc.epoch}` !== rev) {
      throw conflict('the document changed since it was read (stale revision)');
    }
  }

  /** New versions must not exist and must never have existed. */
  private checkNew(doc: StoredDoc, versions: readonly string[]): void {
    for (const v of versions) {
      if (Object.hasOwn(doc.versions, v)) throw conflict(`version ${v} already exists`);
      if (Object.hasOwn(doc.unpublished, v)) {
        throw conflict(`version ${v} was unpublished and cannot be published again`);
      }
    }
  }

  async publish(req: PublishRequest, identity: Identity | null): Promise<void> {
    this.requireWriter(req.name, identity);
    if (req.versions.length === 0 || req.versions.length > 10) {
      throw new HttpError(400, 'a publish carries one to ten versions');
    }
    // One decompression budget for all tarballs of this publish.
    let unpackBudget = this.opts.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES;
    for (const v of req.versions) {
      // 1.0.0+build equals 1.0.0 for semver: build metadata would let a publisher replace a
      // released version without a new number.
      if (v.version.includes('+')) {
        throw new HttpError(400, 'build metadata in versions is not supported');
      }
      // Defence in depth: the bytes must match the digest the adapter computed and the manifest.
      const digest = createHash('sha512').update(v.artifact.data).digest();
      const claimed = Buffer.from(v.artifact.integrity.hex, 'hex');
      const dist = isRecord(v.manifest.dist) ? v.manifest.dist : {};
      if (
        v.artifact.integrity.algorithm !== 'sha512' ||
        claimed.length !== digest.length ||
        !timingSafeEqual(claimed, digest) ||
        dist.integrity !== `sha512-${digest.toString('base64')}`
      ) {
        throw new HttpError(400, `version ${v.version} does not match its integrity`);
      }
      const inside = await inspectTarball(v.artifact.data, { maxUnpackedBytes: unpackBudget });
      unpackBudget -= inside.unpackedBytes;
      if (inside.name !== req.name || inside.version !== v.version) {
        throw new HttpError(
          400,
          `the tarball of ${v.version} contains a package.json for another name or version`,
        );
      }
      // What installs run and pull in is what the tarball says, not what the body claims.
      v.manifest = withTarballFields(v.manifest, inside);
    }
    // Cheap checks before any tarball is written, so refused publishes leave no orphan bytes.
    const existing = await this.load(req.name);
    if (existing) {
      this.checkRev(existing.doc, req.rev);
      this.checkNew(
        existing.doc,
        req.versions.map((v) => v.version),
      );
    }
    // Tarballs first (content-addressed, write-once): a document never names missing bytes.
    const written: string[] = [];
    try {
      for (const v of req.versions) {
        const key = contentKey(v.artifact.integrity);
        if (!(await this.storage.head(key))) {
          await this.storage.put(key, Readable.from([v.artifact.data]), {
            contentType: 'application/octet-stream',
          });
          written.push(key);
        }
      }
      await this.writeVersions(req, identity);
    } catch (err) {
      await this.removeOrphans(req, written);
      throw err;
    }
  }

  /**
   * Deletes tarballs a failed publish wrote, except those the document references by now
   * (an identical concurrent publish of the same version that won).
   */
  private async removeOrphans(req: PublishRequest, written: readonly string[]): Promise<void> {
    if (written.length === 0) return;
    try {
      const current = await this.load(req.name);
      const referenced = new Set<string>();
      for (const m of Object.values(current?.doc.versions ?? {})) {
        const integrity = isRecord(m.dist) ? m.dist.integrity : undefined;
        if (typeof integrity === 'string' && SHA512_INTEGRITY.test(integrity)) {
          const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
          referenced.add(contentKey({ algorithm: 'sha512', hex }));
        }
      }
      for (const key of written) {
        if (!referenced.has(key)) await this.storage.delete(key);
      }
    } catch (err) {
      log.warn('tarballs of a failed publish could not be removed', errorFields(err));
    }
  }

  private async writeVersions(req: PublishRequest, identity: Identity | null): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const publisher = identity?.name ?? '';
    await this.update(req.name, (doc) => {
      this.checkRev(doc, req.rev);
      const next: StoredDoc = doc ?? {
        name: req.name,
        rev: 0,
        epoch: randomBytes(6).toString('hex'),
        versions: {},
        time: { created: now },
        'dist-tags': {},
        document: {},
        unpublished: {},
      };
      this.checkNew(
        next,
        req.versions.map((v) => v.version),
      );
      if (
        Object.keys(next.versions).length + req.versions.length >
        (this.opts.maxVersions ?? 10_000)
      ) {
        throw new HttpError(413, 'too many versions');
      }
      for (const v of req.versions) {
        // The registry sets the publisher (a policy fact); clients cannot (adapter parser).
        next.versions[v.version] = { ...v.manifest, _npmUser: { name: publisher } };
        next.time[v.version] = now;
      }
      Object.assign(next['dist-tags'], req.distTags);
      if (!next['dist-tags'].latest) {
        const latest = newest(Object.keys(next.versions));
        if (latest) next['dist-tags'].latest = latest;
      }
      next.document = { ...req.document };
      next.time.modified = now;
      next.rev++;
      return next;
    });
  }

  async deprecate(req: DeprecateRequest, identity: Identity | null): Promise<void> {
    this.requireWriter(req.name, identity);
    await this.update(req.name, (doc) => {
      if (!doc || Object.keys(doc.versions).length === 0) {
        throw new HttpError(404, 'package not found');
      }
      this.checkRev(doc, req.rev);
      let changed = false;
      for (const [version, message] of Object.entries(req.deprecations)) {
        const manifest = Object.hasOwn(doc.versions, version) ? doc.versions[version] : undefined;
        if (!manifest) throw new HttpError(404, `version ${version} does not exist`);
        const before = typeof manifest.deprecated === 'string' ? manifest.deprecated : '';
        if (before === message) continue;
        if (message === '') Reflect.deleteProperty(manifest, 'deprecated');
        else manifest.deprecated = message;
        changed = true;
      }
      if (!changed) return null;
      doc.time.modified = new Date(this.now()).toISOString();
      doc.rev++;
      return doc;
    });
  }

  async unpublish(req: UnpublishRequest, identity: Identity | null): Promise<void> {
    this.requireWriter(req.name, identity);
    const now = this.now();
    const windowMs = this.opts.unpublishWindowMs;
    const inWindow = (doc: StoredDoc, v: string): boolean => {
      const at = Date.parse(doc.time[v] ?? '');
      return windowMs > 0 && Number.isFinite(at) && now - at < windowMs;
    };
    if (req.files && !req.versions) {
      // npm's second call: the tarball of a version removed a moment ago. The bytes are
      // content-addressed (possibly shared), so nothing is deleted; the file must belong to
      // this package, though.
      const found = await this.load(req.name);
      if (!found) throw new HttpError(404, 'package not found');
      const base = unscopedName(req.name);
      const known = new Set(
        [...Object.keys(found.doc.versions), ...Object.keys(found.doc.unpublished)].map(
          (v) => `${base}-${v}.tgz`,
        ),
      );
      for (const f of req.files) {
        if (!known.has(f)) throw new HttpError(404, 'that file does not belong to this package');
      }
      return;
    }
    await this.update(req.name, (doc) => {
      if (!doc) {
        if (req.versions) return null; // already gone: idempotent
        throw new HttpError(404, 'package not found');
      }
      const remove = req.versions ?? Object.keys(doc.versions);
      const present = remove.filter((v) => Object.hasOwn(doc.versions, v));
      // Idempotent: a retry of an applied unpublish is a no-op, whatever its revision.
      if (present.length === 0) return null;
      this.checkRev(doc, req.rev);
      // Only the user who published a version may take it back (an operator can still edit
      // the document in storage, see OPERATIONS.md).
      const foreign = present.filter((v) => {
        const user = doc.versions[v]?._npmUser;
        return !isRecord(user) || user.name !== identity?.name;
      });
      if (foreign.length > 0) {
        throw new HttpError(
          403,
          `only the user who published a version can unpublish it: ${foreign.slice(0, 5).join(', ')}`,
        );
      }
      const late = present.filter((v) => !inWindow(doc, v));
      if (late.length > 0) {
        throw new HttpError(
          403,
          windowMs > 0
            ? `versions older than the unpublish window cannot be unpublished: ${late.slice(0, 5).join(', ')}`
            : 'unpublishing is disabled on this registry',
        );
      }
      const at = new Date(now).toISOString();
      for (const v of present) {
        Reflect.deleteProperty(doc.versions, v);
        Reflect.deleteProperty(doc.time, v);
        doc.unpublished[v] = at;
      }
      fixDistTags(doc);
      doc.time.modified = at;
      doc.rev++;
      return doc;
    });
  }

  async setDistTag(req: DistTagRequest, identity: Identity | null): Promise<void> {
    this.requireWriter(req.name, identity);
    await this.update(req.name, (doc) => {
      if (!doc || Object.keys(doc.versions).length === 0) {
        throw new HttpError(404, 'package not found');
      }
      if (req.version === null) {
        if (req.tag === 'latest') throw new HttpError(400, 'the latest tag cannot be removed');
        if (!Object.hasOwn(doc['dist-tags'], req.tag)) return null;
        Reflect.deleteProperty(doc['dist-tags'], req.tag);
      } else {
        if (!Object.hasOwn(doc.versions, req.version)) {
          throw new HttpError(404, `version ${req.version} not found`);
        }
        if (doc['dist-tags'][req.tag] === req.version) return null;
        doc['dist-tags'][req.tag] = req.version;
      }
      doc.time.modified = new Date(this.now()).toISOString();
      doc.rev++;
      return doc;
    });
  }

  // ---- Search ---------------------------------------------------------------------------

  /**
   * Packages matching every term of the query: plain words match the name, description or
   * keywords; `keywords:a,b`, `scope:acme` and `author:`/`maintainer:` (the publisher) are
   * understood, other qualifiers are ignored. Exact name matches come first.
   */
  async search(query: SearchQuery, _identity: Identity | null): Promise<SearchHit[]> {
    await this.refreshIndex();
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ entry: IndexEntry; exact: boolean }> = [];
    for (const entry of this.index.values()) {
      if (terms.length === 0) continue;
      if (terms.every((t) => this.matches(entry, t))) {
        matches.push({ entry, exact: terms.includes(entry.hit.name.toLowerCase()) });
      }
    }
    matches.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) || a.entry.hit.name.localeCompare(b.entry.hit.name),
    );
    return matches.slice(0, query.size).map((m) => m.entry.hit);
  }

  private matches(entry: IndexEntry, term: string): boolean {
    const colon = term.indexOf(':');
    if (colon > 0) {
      const key = term.slice(0, colon);
      const value = term.slice(colon + 1);
      switch (key) {
        case 'keywords':
          return value.split(',').some((k) => entry.keywords.includes(k));
        case 'scope':
          return entry.hit.name.startsWith(`@${value.replace(/^@/, '')}/`);
        case 'author':
        case 'maintainer':
          return (entry.hit.publisher ?? '').toLowerCase() === value;
        default:
          if (/^[a-z-]+$/.test(key)) return true; // not:, is:, boost-exact: ...
      }
    }
    return entry.haystack.includes(term);
  }

  private markDirty(name: string): void {
    if (this.dirty.size >= MAX_INDEXED) {
      this.dirty.clear();
      this.indexedAt = Number.NEGATIVE_INFINITY; // too many: the next search lists everything
      return;
    }
    this.dirty.add(name);
  }

  private refreshIndex(): Promise<void> {
    const due = this.now() - this.indexedAt >= INDEX_TTL_MS;
    if (!due && this.dirty.size === 0) return Promise.resolve();
    this.indexing ??= (due ? this.rebuildIndex() : this.refreshDirty()).finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  private get bytesPerPass(): number {
    return this.opts.indexBytesPerPass ?? DEFAULT_INDEX_BYTES_PER_PASS;
  }

  /** Re-reads the packages this pod changed (within the byte budget; the rest stays dirty). */
  private async refreshDirty(): Promise<void> {
    let read = 0;
    for (const name of [...this.dirty]) {
      if (read >= this.bytesPerPass) break;
      this.dirty.delete(name);
      const entry = await this.indexEntry(name);
      read += entry?.bytes ?? 0;
      if (entry) this.index.set(name, entry.entry);
      else this.index.delete(name);
    }
  }

  /**
   * Lists every document and re-reads those whose etag changed since the last pass, up to
   * the byte budget; when it runs out, the next search continues.
   */
  private async rebuildIndex(): Promise<void> {
    const started = this.now();
    const seen = new Set<string>();
    let read = 0;
    let complete = true;
    let cursor: string | undefined;
    try {
      do {
        const page = await this.storage.list(PREFIX, cursor ? { cursor } : {});
        for (const e of page.entries) {
          if (!e.key.endsWith('.json') || seen.size >= MAX_INDEXED) continue;
          const name = e.key.slice(PREFIX.length, -'.json'.length);
          seen.add(name);
          const known = this.index.get(name);
          if (known && e.etag !== undefined && known.etag === e.etag) continue;
          if (read > 0 && read + e.size > this.bytesPerPass) {
            complete = false; // keeps its old entry (if any) until a later pass
            continue;
          }
          this.dirty.delete(name);
          const entry = await this.indexEntry(name);
          read += entry?.bytes ?? e.size;
          if (entry) this.index.set(name, entry.entry);
          else this.index.delete(name);
        }
        cursor = page.cursor;
      } while (cursor);
      for (const name of this.index.keys()) if (!seen.has(name)) this.index.delete(name);
      this.indexedAt = complete ? started : Number.NEGATIVE_INFINITY;
    } catch (err) {
      log.warn('private package search index could not be refreshed', errorFields(err));
    }
  }

  private async indexEntry(name: string): Promise<{ entry: IndexEntry; bytes: number } | null> {
    const found = await this.load(name).catch(() => null);
    if (!found) return null;
    const d = found.doc;
    const latest = d['dist-tags'].latest ?? newest(Object.keys(d.versions));
    const manifest = latest !== undefined ? d.versions[latest] : undefined;
    if (latest === undefined || !manifest) return null;
    const rawDescription =
      typeof d.document.description === 'string'
        ? d.document.description
        : typeof manifest.description === 'string'
          ? manifest.description
          : undefined;
    const description =
      rawDescription !== undefined ? printable(rawDescription.slice(0, 1000)) : undefined;
    const rawKeywords = Array.isArray(d.document.keywords)
      ? d.document.keywords
      : Array.isArray(manifest.keywords)
        ? manifest.keywords
        : [];
    const keywords = rawKeywords
      .filter((k): k is string => typeof k === 'string')
      .slice(0, 50)
      .map((k) => printable(k.slice(0, 100)));
    const user = isRecord(manifest._npmUser) ? manifest._npmUser.name : undefined;
    const hit: SearchHit = {
      name,
      version: latest,
      ...(description !== undefined ? { description } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(d.time[latest] !== undefined ? { date: d.time[latest] } : {}),
      ...(typeof user === 'string' ? { publisher: user } : {}),
    };
    return {
      entry: {
        etag: found.etag,
        hit,
        haystack: [name, description ?? '', ...keywords].join(' ').toLowerCase(),
        keywords: keywords.map((k) => k.toLowerCase()),
      },
      bytes: found.bytes,
    };
  }
}
