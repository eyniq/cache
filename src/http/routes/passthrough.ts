// Transparent, uncached pass-through (audit, search). The upstream client applies the
// request-header allowlist; only a small set of response headers is copied back.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { errorFields, log } from '../../core/log.ts';
import type { AdapterRoute, Upstream } from '../../core/contracts.ts';
import { HttpError, badGateway, badRequest, notFound } from '../../core/errors.ts';
import type { RequestContext } from '../../core/request.ts';
import { readLimited } from '../../core/streams.ts';

const RESPONSE_HEADERS = ['content-type', 'content-encoding', 'content-length'] as const;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

type PassthroughRoute = Extract<AdapterRoute, { kind: 'passthrough' }>;

const tooLarge = (): HttpError => new HttpError(413, 'request body too large');

/** Rewrites a decoded request body before it goes upstream; null refuses the request. */
export type PassthroughRedactor = (body: Buffer) => Buffer | null;

function decodeBody(req: IncomingMessage, body: Buffer, max: number): Buffer {
  const encoding = req.headers['content-encoding'] ?? 'identity';
  if (encoding === 'identity') return body;
  if (encoding !== 'gzip') throw new HttpError(415, 'unsupported content-encoding');
  try {
    return gunzipSync(body, { maxOutputLength: max });
  } catch {
    throw badRequest('invalid gzip body');
  }
}

export async function handlePassthrough(
  req: IncomingMessage,
  res: ServerResponse,
  route: PassthroughRoute,
  upstream: Upstream,
  ctx: RequestContext,
  redact?: PassthroughRedactor,
): Promise<void> {
  ctx.cache = 'passthrough';
  const method = req.method === 'POST' ? 'POST' : req.method === 'HEAD' ? 'HEAD' : 'GET';
  let body: Buffer | undefined;
  if (method === 'POST') {
    if (Number(req.headers['content-length'] ?? 0) > route.maxBodyBytes) {
      req.resume(); // drain so the client can read the 413 instead of hitting a reset
      throw tooLarge();
    }
    body = await readLimited(req, route.maxBodyBytes, tooLarge);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }
  if (redact && body) {
    // Private names must not reach the public registry (PackageSource configured).
    const redacted = redact(decodeBody(req, body, route.maxBodyBytes));
    if (!redacted) throw notFound('not available while this registry hosts packages');
    body = redacted;
    delete headers['content-encoding'];
  }
  const up = await upstream.request({
    method,
    path: route.upstreamPath,
    headers,
    ...(body ? { body } : {}),
  });

  const out: Record<string, string> = {};
  for (const h of RESPONSE_HEADERS) {
    const v = up.headers[h];
    if (typeof v === 'string') out[h] = v;
  }
  if (Number(out['content-length'] ?? 0) > MAX_RESPONSE_BYTES) {
    up.body.resume();
    throw badGateway('upstream response too large');
  }
  res.writeHead(up.status, out);
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      ctx.bytes += chunk.length;
      done(size > MAX_RESPONSE_BYTES ? badGateway('upstream response too large') : null, chunk);
    },
  });
  // pipeline() tears down the upstream socket when the client disconnects or the cap trips.
  await pipeline(up.body, limit, res).catch((err: unknown) => {
    log.debug('pass-through ended early', errorFields(err));
  });
}
