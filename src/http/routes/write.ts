// Write routes (publish, unpublish, dist-tags), only reachable when a PackageSource is
// configured for the adapter. The server has already authenticated the request and checked
// the `publish` permission; this handler enforces ownership, the body limit, parses the body
// (in a worker) and hands the generic request to the source.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuditSink,
  EcosystemAdapter,
  Identity,
  PackageSource,
  WriteBody,
  WriteRoute,
} from '../../core/contracts.ts';
import { auditEvent } from '../../core/audit.ts';
import { HttpError, badRequest, notFound } from '../../core/errors.ts';
import type { RequestContext } from '../../core/request.ts';
import { readLimited } from '../../core/streams.ts';
import type { MetadataProcessor } from '../../metadata/processor.ts';
import { parseWriteInline } from '../../metadata/processor.ts';
import type { MetadataService } from '../../metadata/service.ts';
import { sendJson } from '../respond.ts';

export interface WriteHandlerDeps {
  metadata: MetadataService;
  processor: MetadataProcessor;
  audit: AuditSink;
  maxPublishBytes: number;
  /**
   * Authorize the `publish` action again for a narrower route kind, when the body turns out
   * to be an unpublish (npm drops versions with a PUT) or a deprecate; throws 403 on deny.
   */
  reauthorize(routeKind: 'unpublish' | 'deprecate'): Promise<void>;
}

const tooLarge = (): HttpError => new HttpError(413, 'request body too large');

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) {
    req.resume(); // drain so the client can read the 413 instead of hitting a reset
    throw tooLarge();
  }
  return readLimited(req, max, tooLarge);
}

/** Refusals of a write that are recorded (bad bodies, conflicts, sizes). */
const AUDITED_REFUSALS = new Set([400, 409, 413]);

/** The credential id of the identity, for audit events (Identity.claims.tokenId). */
function credential(identity: Identity | null): { tokenId?: string } {
  const id = identity?.claims?.tokenId;
  return typeof id === 'string' ? { tokenId: id } : {};
}

export async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: EcosystemAdapter,
  route: WriteRoute,
  ctx: RequestContext,
  identity: Identity | null,
  deps: WriteHandlerDeps,
): Promise<void> {
  const source: PackageSource | null = deps.metadata.ownerOf(adapter, route.name);
  if (!source) {
    req.resume();
    throw new HttpError(403, 'this registry does not accept writes for this package');
  }
  try {
    await perform(req, res, adapter, route, ctx, identity, source, deps);
  } catch (err) {
    if (err instanceof HttpError && AUDITED_REFUSALS.has(err.status)) {
      deps.audit.record(
        auditEvent(
          'write.refused',
          {
            ecosystem: adapter.id,
            name: route.name,
            route: route.kind,
            status: err.status,
            reason: err.message.slice(0, 200),
            ...credential(identity),
          },
          ctx,
        ),
      );
    }
    throw err;
  } finally {
    // Also after a failure: a source may have committed part of the change before throwing.
    deps.metadata.invalidate(adapter, route.name);
  }
}

async function perform(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: EcosystemAdapter,
  route: WriteRoute,
  ctx: RequestContext,
  identity: Identity | null,
  source: PackageSource,
  deps: WriteHandlerDeps,
): Promise<void> {
  const base = { ecosystem: adapter.id, name: route.name, ...credential(identity) };

  if (route.kind === 'unpublish') {
    req.resume();
    const files = route.file !== undefined ? { files: [route.file] } : {};
    await source.unpublish(
      { ...base, ...files, ...(route.rev ? { rev: route.rev } : {}) },
      identity,
    );
    deps.audit.record(auditEvent('unpublish', { ...base, ...files }, ctx));
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  if (route.kind === 'dist-tag' && route.op === 'delete') {
    req.resume();
    await source.setDistTag({ ...base, tag: route.tag, version: null }, identity);
    deps.audit.record(auditEvent('dist-tag', { ...base, tag: route.tag, version: null }, ctx));
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  if (!adapter.parseWriteBody) {
    req.resume();
    throw new HttpError(405, 'method not allowed');
  }
  const body = await readBody(req, deps.maxPublishBytes);
  let parsed: WriteBody = deps.processor.parseWriteBody
    ? await deps.processor.parseWriteBody(adapter, route, body)
    : await parseWriteInline(adapter, route, body);

  if (route.kind === 'dist-tag') {
    if (parsed.type !== 'dist-tag') throw badRequest('unexpected body for a dist-tag');
    await source.setDistTag({ ...base, tag: route.tag, version: parsed.version }, identity);
    deps.audit.record(
      auditEvent('dist-tag', { ...base, tag: route.tag, version: parsed.version }, ctx),
    );
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  if (parsed.type === 'publish') {
    if (parsed.request.name !== route.name) throw badRequest('package name mismatch');
    await source.publish(parsed.request, identity);
    const integrity: Record<string, string> = {};
    for (const v of parsed.request.versions) {
      integrity[v.version] = `${v.artifact.integrity.algorithm}-${Buffer.from(
        v.artifact.integrity.hex,
        'hex',
      ).toString('base64')}`;
    }
    deps.audit.record(
      auditEvent(
        'publish',
        {
          ...base,
          versions: parsed.request.versions.map((v) => v.version),
          integrity,
          tags: parsed.request.distTags,
        },
        ctx,
      ),
    );
    sendJson(res, 201, { ok: true }, ctx);
    return;
  }
  if (parsed.type === 'deprecate') {
    const request = parsed.request;
    // A document that drops visible versions is an unpublish, even with deprecated fields.
    const { entry } = source.deprecate
      ? await deps.metadata.lookup(adapter, route.name)
      : { entry: null };
    const kept = new Set(parsed.versions);
    const dropsVersions = entry !== null && [...entry.allowed].some((v) => !kept.has(v));
    if (source.deprecate && !dropsVersions) {
      if (parsed.invalid !== undefined) throw badRequest(parsed.invalid);
      if (request.name !== route.name) throw badRequest('package name mismatch');
      await deps.reauthorize('deprecate');
      await source.deprecate(request, identity);
      deps.audit.record(
        auditEvent('deprecate', { ...base, versions: Object.keys(request.deprecations) }, ctx),
      );
      sendJson(res, 200, { ok: true }, ctx);
      return;
    }
    // A source without deprecate(), or a dropped version: the retain body it always was.
    parsed = {
      type: 'retain',
      versions: parsed.versions,
      ...(request.rev !== undefined ? { rev: request.rev } : {}),
    };
  }
  if (parsed.type !== 'retain') throw badRequest('unexpected body for a publish');

  // npm unpublishes one version by sending the document without it. The document the client
  // read was policy-filtered, so only versions it could see count as removed; a revision is
  // required so the source can refuse a change based on an outdated document (409).
  const rev = parsed.rev ?? route.rev;
  if (!rev) {
    throw badRequest('unsupported change: only publishing and unpublishing versions is supported');
  }
  await deps.reauthorize('unpublish');
  const { entry, cache } = await deps.metadata.lookup(adapter, route.name);
  if (!entry) throw notFound('package not found');
  if (cache === 'stale') throw new HttpError(503, 'package source unavailable');
  const visible = entry.allowed;
  const keep = new Set(parsed.versions);
  if ([...keep].some((v) => !visible.has(v))) {
    throw badRequest('cannot add versions without their artifacts');
  }
  const removed = [...visible].filter((v) => !keep.has(v));
  if (removed.length === 0) {
    throw badRequest('unsupported change: only publishing and unpublishing versions is supported');
  }
  await source.unpublish({ ...base, versions: removed, rev }, identity);
  deps.audit.record(auditEvent('unpublish', { ...base, versions: removed }, ctx));
  sendJson(res, 200, { ok: true }, ctx);
}
