import { request as httpRequest } from 'node:http';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** True when the body ended without a clean finish (or the connection failed). */
  aborted: boolean;
}

export interface RawRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/**
 * Raw HTTP client for tests. Uses the path verbatim: a URL object would normalise
 * `%2e%2e` and friends before they reach the server under test.
 */
export function send(base: string, req: RawRequest): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const r = httpRequest(
      { hostname, port, path: req.path, method: req.method ?? 'GET', headers: req.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('aborted', () => (aborted = true));
        res.on('error', () => (aborted = true));
        res.on('close', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            aborted: aborted || !res.complete,
          });
        });
      },
    );
    r.on('error', () => {
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true });
    });
    r.end(req.body);
  });
}

export function json(res: RawResponse): Record<string, unknown> {
  return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
}

export const ABBREVIATED_ACCEPT =
  'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
