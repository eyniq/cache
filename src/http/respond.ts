import type { ServerResponse } from 'node:http';
import { isHttpError } from '../core/errors.ts';
import { errorFields, log } from '../core/log.ts';
import type { RequestContext } from '../core/request.ts';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  ctx: RequestContext,
  headers: Record<string, string> = {},
): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
  ctx.bytes += buf.length;
}

export function sendError(res: ServerResponse, err: unknown, ctx: RequestContext): void {
  if (res.headersSent) {
    // Mid-stream failure: the only honest signal left is an aborted connection.
    log.warn('response aborted mid-stream', errorFields(err));
    res.destroy();
    return;
  }
  if (isHttpError(err)) {
    sendJson(res, err.status, err.body, ctx, err.headers);
    return;
  }
  log.error('unhandled error', errorFields(err));
  sendJson(res, 500, { error: 'internal error' }, ctx);
}
