// In-memory PackageSource that stores npm packuments, for write-path tests. A real source
// (downstream) keeps the same shape in object storage.
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
  UnpublishRequest,
} from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';

interface Doc {
  name: string;
  rev: number;
  versions: Record<string, Record<string, unknown>>;
  distTags: Record<string, string>;
  time: Record<string, string>;
}

export interface SourceCall {
  op: 'publish' | 'unpublish' | 'dist-tag' | 'deprecate';
  identity: string | null;
  request: PublishRequest | UnpublishRequest | DistTagRequest | DeprecateRequest;
}

export class MemorySource implements PackageSource {
  readonly docs = new Map<string, Doc>();
  readonly files = new Map<string, Buffer>();
  readonly calls: SourceCall[] = [];
  metadataTtlMs?: number;
  private readonly owned: (name: string) => boolean;

  constructor(owned: (name: string) => boolean, opts: { metadataTtlMs?: number } = {}) {
    this.owned = owned;
    if (opts.metadataTtlMs !== undefined) this.metadataTtlMs = opts.metadataTtlMs;
  }

  owns(name: string): boolean {
    return this.owned(name);
  }

  /** Make getMetadata fail (source outage). */
  failing = false;
  metadataCalls = 0;

  getMetadata(name: string, opts: MetadataFetchOptions): Promise<MetadataFetchResult> {
    this.metadataCalls++;
    if (this.failing) return Promise.reject(new Error('source down'));
    const doc = this.docs.get(name);
    if (!doc) return Promise.resolve({ status: 'not-found' });
    const etag = `"${doc.rev}"`;
    if (opts.etag === etag) return Promise.resolve({ status: 'not-modified' });
    const body = Buffer.from(
      JSON.stringify({
        _id: name,
        _rev: `${doc.rev}-mem`,
        name,
        'dist-tags': doc.distTags,
        versions: doc.versions,
        time: doc.time,
      }),
    );
    return Promise.resolve({ status: 'ok', raw: { body, encoding: 'identity', etag } });
  }

  getArtifact(name: string, file: string): Promise<OpenedObject | null> {
    const data = this.files.get(`${name}/${file}`);
    return Promise.resolve(data ? { body: Readable.from([data]), size: data.length } : null);
  }

  publish(req: PublishRequest, identity: Identity | null): Promise<void> {
    this.calls.push({ op: 'publish', identity: identity?.name ?? null, request: req });
    const doc = this.docs.get(req.name) ?? {
      name: req.name,
      rev: 0,
      versions: {},
      distTags: {},
      time: {},
    };
    for (const v of req.versions) {
      if (doc.versions[v.version]) throw new HttpError(409, 'version already exists');
    }
    for (const v of req.versions) {
      doc.versions[v.version] = {
        ...v.manifest,
        ...(identity ? { _npmUser: { name: identity.name } } : {}),
      };
      doc.time[v.version] = new Date().toISOString();
      this.files.set(`${req.name}/${v.artifact.file}`, Buffer.from(v.artifact.data));
    }
    Object.assign(doc.distTags, req.distTags);
    doc.rev++;
    this.docs.set(req.name, doc);
    return Promise.resolve();
  }

  unpublish(req: UnpublishRequest, identity: Identity | null): Promise<void> {
    this.calls.push({ op: 'unpublish', identity: identity?.name ?? null, request: req });
    const doc = this.docs.get(req.name);
    if (!doc) throw new HttpError(404, 'package not found');
    if (!req.versions && !req.files) {
      this.docs.delete(req.name);
      return Promise.resolve();
    }
    for (const v of req.versions ?? []) {
      Reflect.deleteProperty(doc.versions, v);
      Reflect.deleteProperty(doc.time, v);
    }
    for (const f of req.files ?? []) this.files.delete(`${req.name}/${f}`);
    doc.rev++;
    return Promise.resolve();
  }

  setDistTag(req: DistTagRequest, identity: Identity | null): Promise<void> {
    this.calls.push({ op: 'dist-tag', identity: identity?.name ?? null, request: req });
    const doc = this.docs.get(req.name);
    if (!doc) throw new HttpError(404, 'package not found');
    if (req.version === null) Reflect.deleteProperty(doc.distTags, req.tag);
    else doc.distTags[req.tag] = req.version;
    doc.rev++;
    return Promise.resolve();
  }

  deprecate(req: DeprecateRequest, identity: Identity | null): Promise<void> {
    this.calls.push({ op: 'deprecate', identity: identity?.name ?? null, request: req });
    const doc = this.docs.get(req.name);
    if (!doc) throw new HttpError(404, 'package not found');
    for (const version of Object.keys(req.deprecations)) {
      if (!doc.versions[version]) throw new HttpError(404, `no version ${version}`);
    }
    for (const [version, message] of Object.entries(req.deprecations)) {
      const manifest = doc.versions[version]!;
      if (message === '') Reflect.deleteProperty(manifest, 'deprecated');
      else manifest.deprecated = message;
    }
    doc.rev++;
    return Promise.resolve();
  }
}
