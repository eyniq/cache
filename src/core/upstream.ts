// Upstream registry client. Node's bundled undici `Agent` is not exposed without the npm
// `undici` package (a runtime dependency), so this uses node:http(s) with a keep-alive agent
// capped at UPSTREAM_MAX_CONNECTIONS. Security rules (DESIGN.md sections 5 and 11):
// fixed origin, at most 2 same-origin redirects, and only allowlisted request headers.
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { USER_AGENT } from '../constants.ts';
import type { Upstream, UpstreamRequest, UpstreamResponse } from './contracts.ts';
import { HttpError, badGateway, gatewayTimeout } from './errors.ts';

const MAX_REDIRECTS = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Everything else (Authorization, Cookie, X-Forwarded-*, client identifiers) is dropped.
// Adapters may add ecosystem-specific headers through UpstreamOptions.extraHeaders.
const FORWARDED_HEADERS = [
  'accept',
  'accept-encoding',
  'content-type',
  'content-encoding',
  'if-none-match',
  'if-modified-since',
];

export interface UpstreamOptions {
  url: string;
  maxConnections: number;
  /** Socket idle timeout: applies while waiting for headers and between body chunks. */
  timeoutMs: number;
  /** Additional request headers allowed through (lowercase). */
  extraHeaders?: readonly string[];
}

export interface ClosableUpstream extends Upstream {
  close(): void;
}

export function createUpstream(opts: UpstreamOptions): ClosableUpstream {
  const base = new URL(opts.url);
  const origin = base.origin;
  const basePath = base.pathname.replace(/\/+$/, '');
  const https = base.protocol === 'https:';
  const agentOpts = {
    keepAlive: true,
    maxSockets: opts.maxConnections,
    maxFreeSockets: opts.maxConnections,
    scheduling: 'lifo' as const,
  };
  const agent = https ? new HttpsAgent(agentOpts) : new HttpAgent(agentOpts);
  const send = https ? httpsRequest : httpRequest;
  const forwarded = new Set([...FORWARDED_HEADERS, ...(opts.extraHeaders ?? [])]);

  function once(url: URL, req: UpstreamRequest, method: string): Promise<IncomingMessage> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const key = k.toLowerCase();
      if (forwarded.has(key)) headers[key] = v;
    }
    if (req.body && method === 'POST') headers['content-length'] = String(req.body.length);
    return new Promise((resolve, reject) => {
      const outgoing = send(url, { method, headers, agent, timeout: opts.timeoutMs }, resolve);
      // An abort destroys the request whatever state it is in (connecting, waiting for the
      // head, streaming the body), so no socket outlives a caller that gave up.
      const { signal } = req;
      if (signal) {
        const abort = (): void => {
          outgoing.destroy(gatewayTimeout('upstream request aborted'));
        };
        if (signal.aborted) abort();
        else {
          signal.addEventListener('abort', abort, { once: true });
          outgoing.on('close', () => {
            signal.removeEventListener('abort', abort);
          });
        }
      }
      outgoing.on('timeout', () => {
        outgoing.destroy(gatewayTimeout('upstream timed out'));
      });
      outgoing.on('error', (err) => {
        reject(err instanceof HttpError ? err : badGateway('upstream request failed'));
      });
      outgoing.end(method === 'POST' ? req.body : undefined);
    });
  }

  async function request(req: UpstreamRequest): Promise<UpstreamResponse> {
    if (!req.path.startsWith('/')) throw new Error('upstream path must start with /');
    let url = new URL(`${origin}${basePath}${req.path}`);
    if (url.origin !== origin) throw badGateway('refusing to leave the upstream origin');
    let method: string = req.method ?? 'GET';
    for (let redirects = 0; ; redirects++) {
      const res = await once(url, req, method);
      const status = res.statusCode ?? 502;
      const location = res.headers.location;
      if (!REDIRECTS.has(status) || !location) {
        return { status, headers: res.headers, body: res };
      }
      res.resume();
      if (redirects >= MAX_REDIRECTS) throw badGateway('too many upstream redirects');
      const next = new URL(location, url);
      if (next.origin !== origin) throw badGateway('upstream redirected to a foreign host');
      if (status === 303) method = 'GET';
      url = next;
    }
  }

  return {
    origin,
    request,
    close() {
      agent.destroy();
    },
  };
}
