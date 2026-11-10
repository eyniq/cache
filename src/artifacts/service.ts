// Ecosystem-agnostic artifact serving. A miss streams upstream bytes to the client and to a
// temp object at the same time; the object is committed only after integrity verification.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.ts';
import type {
  AdapterRoute,
  ArtifactIntegrity,
  ArtifactRef,
  ArtifactVerifier,
  OpenedObject,
  AuditSink,
  EcosystemAdapter,
  Storage,
  Upstream,
} from '../core/contracts.ts';
import { Coalescer } from '../core/coalescer.ts';
import { HttpError, badGateway, gatewayTimeout, notFound } from '../core/errors.ts';
import { errorFields, log } from '../core/log.ts';
import type { RequestContext } from '../core/request.ts';
import { WriteDropped, WriteLimiter } from '../core/write-limiter.ts';
import type { Metrics } from '../http/metrics.ts';
import type { MetadataService } from '../metadata/service.ts';
import { auditEvent } from '../core/audit.ts';
import { createVerifier, isBuiltinDigest } from './integrity.ts';
import { etagMatches } from '../http/etag.ts';

interface Deps {
  metadata: MetadataService;
  storage: Storage;
  /** The upstream of an adapter (ServerDeps.upstreams, else ServerDeps.upstream). */
  upstreamFor: (adapter: EcosystemAdapter) => Upstream;
  audit: AuditSink;
  config: Config;
  metrics?: Metrics;
  /** Limiter for background writes; a default one is made when absent (tests). */
  writes?: WriteLimiter;
}

type ArtifactRoute = Extract<AdapterRoute, { kind: 'artifact' }>;
type OkRef = Extract<ArtifactRef, { status: 'ok' }>;

/** Upper bound for one artifact download, whatever the upstream's pace. */
const DOWNLOAD_DEADLINE_MS = 10 * 60_000;
const AUDIT_DEDUPE_MS = 60_000;
/** How long a client may block a shared download through backpressure. */
const STALLED_CLIENT_MS = 10_000;
/** Upper bound for an adapter verifier (EcosystemAdapter.createVerifier) after the last byte. */
const VERIFY_DEADLINE_MS = 2 * 60_000;
const DIGEST_ALGORITHM = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DIGEST_HEX = /^[0-9a-f]{16,512}$/;

/** An adapter verifier must not be able to stop the core from cleaning up. */
function safeAbort(verifier: ArtifactVerifier | null): void {
  try {
    verifier?.abort();
  } catch (err) {
    log.warn('artifact verifier abort failed', errorFields(err));
  }
}

export class ArtifactService {
  private readonly deps: Deps;
  private readonly downloads = new Coalescer<boolean>();
  private readonly audited = new Map<string, number>();

  private readonly writes: WriteLimiter;

  constructor(deps: Deps) {
    this.deps = deps;
    this.writes = deps.writes ?? new WriteLimiter({ storage: deps.storage });
  }

  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: EcosystemAdapter,
    route: ArtifactRoute,
    ctx: RequestContext,
  ): Promise<void> {
    const { entry } = await this.deps.metadata.lookup(adapter, route.name);
    if (!entry) throw notFound('package not found');
    const ref = adapter.artifactKey(route, entry.processed);
    if (ref.status !== 'ok') throw notFound('version not found');
    // Adapters with per-version lookup keys name the package itself for policies and audit.
    const name = entry.processed.packageName ?? route.name;

    const blocked = entry.blocked.get(ref.version);
    if (blocked) {
      // Also stops lockfiles that pin a too-new version (DESIGN.md section 8).
      this.deps.metrics?.blockedVersions.inc();
      if (this.shouldAudit(`${adapter.id}:${name}@${ref.version}`))
        this.deps.audit.record(
          auditEvent(
            'policy.blocked',
            {
              ecosystem: adapter.id,
              name: name,
              version: ref.version,
              reason: blocked.reason,
            },
            ctx,
          ),
        );
      const publishedAt = entry.processed.versions.find(
        (v) => v.version === ref.version,
      )?.publishedAt;
      throw new HttpError(403, blocked.reason, {
        error: blocked.reason,
        package: name,
        version: ref.version,
        ...(publishedAt != null ? { publishedAt: new Date(publishedAt).toISOString() } : {}),
        ...(blocked.allowedAfter !== undefined
          ? { allowedAfter: new Date(blocked.allowedAfter).toISOString() }
          : {}),
      });
    }

    ctx.artifact = {
      ecosystem: adapter.id,
      name: name,
      version: ref.version,
      file: ref.artifact.file,
    };
    const exception = entry.allowlisted.get(ref.version);
    if (
      exception !== undefined &&
      req.method === 'GET' &&
      this.shouldAudit(`allowlisted:${adapter.id}:${name}@${ref.version}`)
    ) {
      this.deps.audit.record(
        auditEvent(
          'policy.allowlisted',
          { ecosystem: adapter.id, name: name, version: ref.version, reason: exception },
          ctx,
        ),
      );
    }

    if (entry.origin === 'local') {
      await this.serveLocal(req, res, adapter, route, ref, ctx);
      return;
    }

    const integrity = ref.artifact.integrity;
    if (!integrity) throw badGateway('registry advertises no integrity for this artifact');
    // The digest goes into headers and must name the stored bytes: an adapter-chosen key that
    // does not end in the digest could serve bytes verified against another digest.
    if (
      !DIGEST_ALGORITHM.test(integrity.algorithm) ||
      !DIGEST_HEX.test(integrity.hex) ||
      !ref.storageKey.endsWith(`/${integrity.hex}`)
    ) {
      throw badGateway('registry advertises an unusable artifact digest');
    }

    // The bytes are identified by their digest, so the ETag is the same on every pod and a
    // revalidation can be answered without touching storage or upstream.
    const etag = `"${integrity.algorithm}-${integrity.hex}"`;
    if (etagMatches(req.headers['if-none-match'], etag)) {
      ctx.cache = 'hit';
      res.writeHead(304, { etag });
      res.end();
      return;
    }

    const head = req.method === 'HEAD';
    const stored = await this.deps.storage.head(ref.storageKey);
    if (stored && head) {
      ctx.cache = 'hit';
      res.writeHead(200, { 'content-type': ref.contentType, 'content-length': stored.size, etag });
      res.end();
      return;
    }
    // Set before streaming: the response's close event (access log, metrics, audit) can fire
    // before the awaited pipeline returns here.
    if (stored) {
      ctx.cache = 'hit';
      if (await this.serveStored(res, ref, etag)) return;
    }

    ctx.cache = 'miss';
    if (head) {
      // HEAD on an uncached artifact: ask upstream for headers only; nothing is downloaded.
      const up = await this.deps.upstreamFor(adapter).request({
        method: 'HEAD',
        path: ref.artifact.upstreamPath,
      });
      up.body.resume();
      if (up.status !== 200) throw up.status === 404 ? notFound() : badGateway('upstream error');
      const length = up.headers['content-length'];
      res.writeHead(200, {
        'content-type': ref.contentType,
        etag,
        ...(length ? { 'content-length': length } : {}),
      });
      res.end();
      return;
    }

    // One upstream download per artifact (section 7.1). The leader streams to its own client;
    // concurrent requests wait for the commit and are then served from storage.
    const run = this.downloads.run(ref.storageKey, () =>
      this.download(res, adapter, name, ref, integrity, etag, ctx),
    );
    if (run.leader) {
      await run.promise;
      return;
    }
    ctx.cache = 'coalesced';
    this.deps.metrics?.coalescedWaiters.inc();
    const committed = await run.promise;
    if (committed && (await this.serveStored(res, ref, etag))) return;
    // The leader served its client but did not commit (storage write failed, or over the
    // STORAGE_STREAM_BYTES budget), or the object vanished. Nothing was sent to this client yet,
    // so fetch it ourselves instead of failing it; this download may still cache it. Upstream
    // errors of the leader (404, bad gateway) rejected run.promise above and stay as they are.
    ctx.cache = 'miss';
    await this.download(res, adapter, name, ref, integrity, etag, ctx);
  }

  /**
   * An artifact of a package owned by a PackageSource: streamed from the source, never from
   * upstream or the shared cache (the source is its own storage and verified it on publish).
   */
  private async serveLocal(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: EcosystemAdapter,
    route: ArtifactRoute,
    ref: OkRef,
    ctx: RequestContext,
  ): Promise<void> {
    const source = this.deps.metadata.ownerOf(adapter, route.name);
    if (!source) throw notFound('package not found');
    const integrity = ref.artifact.integrity;
    const etag = integrity ? `"${integrity.algorithm}-${integrity.hex}"` : undefined;
    ctx.cache = 'hit';
    if (etag && etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    const opened = await source.getArtifact(route.name, ref.artifact.file);
    if (!opened) throw notFound('artifact not found');
    const headers = {
      'content-type': ref.contentType,
      'content-length': opened.size,
      ...(etag ? { etag } : {}),
    };
    if (req.method === 'HEAD') {
      opened.body.destroy();
      res.writeHead(200, headers);
      res.end();
      return;
    }
    try {
      res.writeHead(200, headers);
    } catch (err) {
      opened.body.destroy();
      throw err;
    }
    let size = 0;
    opened.body.on('data', (chunk: Buffer) => {
      size += chunk.length;
      ctx.bytes += chunk.length;
    });
    await pipeline(opened.body, res);
    if (size !== opened.size)
      log.warn('local artifact size changed while streaming', { name: route.name });
  }

  /** One audit record per blocked version per minute: retries must not flood the audit log. */
  private shouldAudit(key: string): boolean {
    const now = Date.now();
    const last = this.audited.get(key);
    if (last !== undefined && now - last < AUDIT_DEDUPE_MS) return false;
    if (this.audited.size >= 10_000) this.audited.clear();
    this.audited.set(key, now);
    return true;
  }

  /** Streams a stored artifact; false if it vanished between head() and get(). */
  private async serveStored(res: ServerResponse, ref: OkRef, etag: string): Promise<boolean> {
    const { storage } = this.deps;
    let opened: OpenedObject | null;
    if (storage.open) {
      opened = await storage.open(ref.storageKey);
    } else {
      const info = await storage.head(ref.storageKey);
      const body = info ? await storage.get(ref.storageKey) : null;
      opened = info && body ? { body, size: info.size } : null;
    }
    if (!opened) return false;
    try {
      res.writeHead(200, { 'content-type': ref.contentType, 'content-length': opened.size, etag });
    } catch (err) {
      opened.body.destroy(); // do not leak the file handle or S3 socket
      throw err;
    }
    await pipeline(opened.body, res);
    return true;
  }

  /**
   * Write-once `name/version -> digest` index next to the content-addressed bytes. Runs in the
   * background through the write limiter: the client response never waits for it. A dropped or
   * failed entry is rewritten by the next miss of that version.
   */
  private writeIndex(ref: OkRef, integrity: ArtifactIntegrity): void {
    const key = ref.indexKey;
    if (!key) return;
    void this.deps.storage
      .head(key)
      .then(async (existing) => {
        if (existing) return;
        await this.writes.write({
          kind: 'index',
          key,
          body: Buffer.from(`${integrity.algorithm}-${integrity.hex}`),
          contentType: 'text/plain',
        });
      })
      .catch((err: unknown) => {
        if (err instanceof WriteDropped) return;
        log.warn('artifact index not written', { key, ...errorFields(err) });
      });
  }

  /** Resolves true when the verified artifact was committed to storage. */
  private async download(
    res: ServerResponse,
    adapter: EcosystemAdapter,
    name: string,
    ref: OkRef,
    integrity: ArtifactIntegrity,
    etag: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    // Adapter-defined digests are checked by the adapter; nothing else can verify them.
    let custom: ArtifactVerifier | null = null;
    if (!isBuiltinDigest(integrity.algorithm)) {
      custom = adapter.createVerifier?.(integrity) ?? null;
      if (!custom) throw badGateway('no verifier for the advertised artifact digest');
    }
    let up;
    try {
      up = await this.deps.upstreamFor(adapter).request({
        path: ref.artifact.upstreamPath,
        headers: { accept: 'application/octet-stream' },
      });
    } catch (err) {
      safeAbort(custom);
      throw err;
    }
    const max = this.deps.config.maxTarballBytes;
    let verifier: ReturnType<typeof createVerifier> | null = null;
    let toStore: PassThrough;
    let stored$: Promise<boolean>;
    try {
      if (up.status === 404) throw notFound('artifact not found upstream');
      if (up.status !== 200) throw badGateway(`upstream returned ${up.status}`);
      if (Number(up.headers['content-length'] ?? 0) > max) {
        throw badGateway('artifact exceeds MAX_TARBALL_BYTES');
      }
      // No Content-Length on a miss: chunked encoding lets us withhold the final chunk, so a
      // client never sees a complete response for bytes that fail verification.
      res.writeHead(200, { 'content-type': ref.contentType, etag });
      if (!custom) verifier = createVerifier(integrity);
      const pass = new PassThrough();
      toStore = pass;
      // storage.put may not have attached its own listeners yet (it awaits mkdir first); its
      // promise still rejects with the error, so swallowing the event here loses nothing.
      pass.on('error', () => undefined);
      // The handler is attached immediately: a storage failure mid-download (ENOSPC, EIO) must
      // degrade to an uncached pass-through, never become an unhandled rejection.
      const length = Number(up.headers['content-length'] ?? 0);
      stored$ = this.writes
        .stream('tarball', ref.storageKey, pass, ref.contentType, length > 0 ? length : 1_048_576)
        .then(
          () => {
            this.writeIndex(ref, integrity);
            return true;
          },
          (err: unknown) => {
            if (err instanceof WriteDropped) return false; // budget full: counted and logged
            log.warn('artifact not cached', {
              name,
              version: ref.version,
              ...errorFields(err),
            });
            return false;
          },
        );
    } catch (err) {
      up.body.resume();
      safeAbort(custom);
      throw err;
    }
    let size = 0;

    await new Promise<void>((resolve) => {
      let settled = false;
      let verifyDeadline: NodeJS.Timeout | undefined;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(verifyDeadline);
        log.warn('artifact download aborted', {
          name,
          version: ref.version,
          ...errorFields(err),
        });
        toStore.destroy(err); // storage.put rejects and removes its temp object
        res.destroy(); // no error argument: pipe() would re-emit it as an unhandled event
        resolve();
        safeAbort(custom);
      };
      // Defence in depth: a body that closes without 'end' or 'error' must not hang the request.
      up.body.on('close', () => {
        if (!up.body.readableEnded) fail(badGateway('upstream closed the artifact stream early'));
      });
      up.body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          up.body.destroy();
          fail(badGateway('artifact exceeds MAX_TARBALL_BYTES'));
          return;
        }
        if (custom) {
          try {
            custom.update(chunk);
          } catch (err) {
            // Hostile bytes must not crash the process through an adapter's parser.
            up.body.destroy();
            fail(err instanceof Error ? err : badGateway('artifact verifier failed'));
            return;
          }
        } else {
          verifier?.update(chunk);
        }
        ctx.bytes += chunk.length;
      });
      up.body.on('error', (err) => {
        fail(err);
      });
      const finish = (ok: boolean): void => {
        if (settled) return;
        if (!ok) {
          this.deps.audit.record(
            auditEvent(
              'integrity.mismatch',
              { ecosystem: adapter.id, name, version: ref.version },
              ctx,
            ),
          );
          fail(badGateway('artifact failed integrity verification'));
          return;
        }
        settled = true;
        toStore.end();
        // Finish the response only once the object is committed (or failed to commit), so a
        // client that saw a complete download can rely on the next request being a hit.
        void stored$.finally(() => {
          res.end();
          resolve();
        });
      };
      up.body.on('end', () => {
        if (settled) return;
        if (!custom) {
          finish(verifier?.matches() === true);
          return;
        }
        // The adapter verifier may need the whole artifact (e.g. a hash over archive entries).
        const v = custom;
        verifyDeadline = setTimeout(() => {
          log.warn('artifact verification timed out', { name, version: ref.version });
          fail(gatewayTimeout('artifact verification exceeded its deadline'));
        }, VERIFY_DEADLINE_MS);
        verifyDeadline.unref();
        Promise.resolve()
          .then(() => v.verify())
          .then(
            (ok) => {
              clearTimeout(verifyDeadline);
              // Only a literal true: a loosely typed verifier answering 1 or "yes" must not pass.
              const answer: unknown = ok;
              finish(answer === true);
            },
            (err: unknown) => {
              // A verifier error is not evidence of tampering: no integrity.mismatch event.
              log.warn('artifact verifier failed', { name, ...errorFields(err) });
              fail(badGateway('artifact could not be verified'));
            },
          )
          .catch((err: unknown) => {
            fail(err instanceof Error ? err : badGateway('artifact could not be verified'));
          });
      });
      // A drip-feeding upstream must not hold a socket (and every waiter) forever.
      const deadline = setTimeout(() => {
        fail(gatewayTimeout('artifact download exceeded its deadline'));
        up.body.destroy();
      }, DOWNLOAD_DEADLINE_MS);
      deadline.unref();
      up.body.once('close', () => {
        clearTimeout(deadline);
      });
      // A client that stops reading must not throttle the shared download (every waiter and
      // the cache) through backpressure: after STALLED_CLIENT_MS it is cut off.
      let stalledSince = 0;
      const watchdog = setInterval(() => {
        if (!res.writableNeedDrain) {
          stalledSince = 0;
        } else if (stalledSince === 0) {
          stalledSince = Date.now();
        } else if (Date.now() - stalledSince > STALLED_CLIENT_MS) {
          log.warn('disconnecting a stalled client', { name, version: ref.version });
          res.destroy();
        }
      }, 1000);
      watchdog.unref();
      up.body.once('close', () => {
        clearInterval(watchdog);
      });
      // If the client disconnects, pipe() unpipes `res` and the download continues for the cache.
      up.body.pipe(res, { end: false });
      up.body.pipe(toStore, { end: false });
    });
    return stored$;
  }
}
