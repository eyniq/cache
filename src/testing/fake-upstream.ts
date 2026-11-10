// Fake npm registry for tests and conformance suites (exported as @eyniq/cache/testing).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { makeTarball, sha1Hex, sha512Integrity } from './tarball.ts';

export interface FakeVersion {
  version: string;
  /** ISO publish time; defaults to 2020-01-01. null leaves the time entry out. */
  publishedAt?: string | null;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  /** Serve bytes that do not match the advertised integrity. */
  corrupt?: boolean;
  /** Only advertise the legacy sha1 shasum. */
  sha1Only?: boolean;
  /** Advertise no integrity data at all. */
  noIntegrity?: boolean;
  deprecated?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** Returning true means the hook fully handled the response. */
export type FakeHook = (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean;

export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  readonly packuments = new Map<string, Record<string, unknown>>();
  readonly tarballs = new Map<string, Buffer>();
  /** Extra latency for every response, in ms. */
  delayMs = 0;
  hook: FakeHook | null = null;
  private server: Server | null = null;
  origin = '';

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        this.requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body,
        });
        const run = (): void => {
          if (this.hook?.(req, res, body)) return;
          this.serve(req, res);
        };
        if (this.delayMs > 0) setTimeout(run, this.delayMs);
        else run();
      });
    });
    this.server = server;
    server.keepAliveTimeout = 1000;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    this.server = null;
  }

  count(predicate: (r: RecordedRequest) => boolean): number {
    return this.requests.filter(predicate).length;
  }

  countPath(path: string): number {
    return this.count((r) => r.path === path);
  }

  /** Register a synthetic package with real tarballs. */
  addPackage(
    name: string,
    versions: FakeVersion[],
    opts: { distTags?: Record<string, string>; extra?: Record<string, unknown> } = {},
  ): void {
    if (!this.origin) throw new Error('start() the fake upstream before adding packages');
    const base = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
    const docVersions: Record<string, unknown> = {};
    const time: Record<string, string> = {
      created: '2019-01-01T00:00:00.000Z',
      modified: '2020-06-01T00:00:00.000Z',
    };
    for (const v of versions) {
      const file = `${base}-${v.version}.tgz`;
      const pkgJson = { name, version: v.version, dependencies: v.dependencies ?? {} };
      const tgz = makeTarball({
        'package.json': JSON.stringify(pkgJson, null, 2),
        'index.js': `module.exports = ${JSON.stringify(`${name}@${v.version}`)};\n`,
      });
      const served = Buffer.from(tgz);
      const mid = served.length >> 1;
      if (v.corrupt) served[mid] = (served[mid] ?? 0) ^ 0xff;
      this.tarballs.set(`/${name}/-/${file}`, served);
      const dist: Record<string, unknown> = { tarball: `${this.origin}/${name}/-/${file}` };
      if (!v.noIntegrity) {
        dist.shasum = sha1Hex(tgz);
        if (!v.sha1Only) dist.integrity = sha512Integrity(tgz);
      }
      docVersions[v.version] = {
        name,
        version: v.version,
        description: `fixture ${name}`,
        main: 'index.js',
        dependencies: v.dependencies ?? {},
        ...(v.scripts ? { scripts: v.scripts } : {}),
        ...(v.deprecated ? { deprecated: v.deprecated } : {}),
        readme: 'large readme that the abbreviated document must drop',
        dist,
      };
      if (v.publishedAt !== null) time[v.version] = v.publishedAt ?? '2020-01-01T00:00:00.000Z';
    }
    const last = versions.at(-1)?.version;
    this.packuments.set(name, {
      _id: name,
      _rev: '1-abc',
      name,
      description: `fixture ${name}`,
      'dist-tags': opts.distTags ?? (last ? { latest: last } : {}),
      versions: docVersions,
      time,
      readme: 'top-level readme',
      maintainers: [{ name: 'fixture', email: 'fixture@example.invalid' }],
      ...opts.extra,
    });
  }

  /** Serve an arbitrary recorded packument (real fixtures). */
  setPackument(name: string, doc: Record<string, unknown>): void {
    this.packuments.set(name, doc);
  }

  /**
   * Serve a pre-encoded packument (large real fixtures): JSON and gzip are prepared once here,
   * so serving it later does no CPU work in the test process.
   */
  setRawPackument(name: string, json: Buffer): void {
    this.raw.set(name, {
      json,
      gzip: gzipSync(json),
      etag: `"${createHash('sha1').update(json).digest('hex')}"`,
    });
  }

  private readonly raw = new Map<string, { json: Buffer; gzip: Buffer; etag: string }>();

  /** The default behaviour; hooks call this to answer late (e.g. after a delay). */
  serve(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.origin);
    const tarball = this.tarballs.get(url.pathname);
    if (tarball) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': tarball.length,
      });
      res.end(req.method === 'HEAD' ? undefined : tarball);
      return;
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const pre = this.raw.get(name);
    const doc = this.packuments.get(name);
    if (!pre && !doc) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const json = pre?.json ?? Buffer.from(JSON.stringify(doc));
    const etag = pre?.etag ?? `"${createHash('sha1').update(json).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const body = gzip ? (pre?.gzip ?? gzipSync(json)) : json;
    res.writeHead(200, {
      'content-type': 'application/json',
      etag,
      'content-length': body.length,
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}
