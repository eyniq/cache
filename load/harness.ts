// Replays a package set as N parallel installs against any npm registry (Verdaccio or Eyniq
// Cache): per package one abbreviated packument request, then the tarball URL the registry
// returned, exactly like npm/pnpm. All installs start at once to reproduce a CI burst.
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import type { PackageRef } from './lockfile.ts';
import { summarize, type Summary } from './stats.ts';

export interface LoadOptions {
  registry: string;
  packages: PackageRef[];
  /** Parallel installs (e.g. 2x the largest real CI burst). */
  installs: number;
  /** Requests in flight per install (pnpm's default network concurrency is 16). */
  concurrency: number;
  timeoutMs: number;
  token?: string;
}

export interface LoadResult {
  target: string;
  startedAt: string;
  durationMs: number;
  requests: number;
  rps: number;
  errors: number;
  timeouts: number;
  bytes: number;
  metadata: Summary;
  tarballs: Summary;
  errorSamples: string[];
}

const ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

interface Response {
  status: number;
  body: Buffer | null;
  bytes: number;
}

class TimeoutError extends Error {}

export async function runLoad(opts: LoadOptions): Promise<LoadResult> {
  const registry = opts.registry.replace(/\/+$/, '');
  const origin = new URL(registry).origin;
  const https = registry.startsWith('https:');
  const sockets = Math.max(1, opts.installs * opts.concurrency);
  const agent = https
    ? new HttpsAgent({ keepAlive: true, maxSockets: sockets })
    : new HttpAgent({ keepAlive: true, maxSockets: sockets });
  const send = https ? httpsRequest : httpRequest;
  const metadataMs: number[] = [];
  const tarballMs: number[] = [];
  const errorSamples: string[] = [];
  let errors = 0;
  let timeouts = 0;
  let bytes = 0;
  let requests = 0;

  const get = (url: string, keepBody: boolean): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { accept: keepBody ? ACCEPT : '*/*' };
      // The token goes to the registry origin only, never to a tarball host it points at.
      if (opts.token && new URL(url).origin === origin)
        headers.authorization = `Bearer ${opts.token}`;
      const req = send(url, { headers, agent, timeout: opts.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (keepBody) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: keepBody ? Buffer.concat(chunks) : null,
            bytes: size,
          });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new TimeoutError(`timeout after ${opts.timeoutMs} ms`)));
      req.on('error', reject);
      req.end();
    });

  const fail = (what: string, err: unknown): void => {
    if (err instanceof TimeoutError) timeouts++;
    else errors++;
    if (errorSamples.length < 20)
      errorSamples.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  async function timed(url: string, keepBody: boolean, into: number[]): Promise<Response | null> {
    const started = performance.now();
    requests++;
    try {
      const res = await get(url, keepBody);
      bytes += res.bytes;
      if (res.status !== 200) {
        fail(url, new Error(`HTTP ${res.status}`));
        return null;
      }
      // Latency of successful requests only: fast 403/404s would flatter the percentiles.
      into.push(performance.now() - started);
      return res;
    } catch (err) {
      fail(url, err);
      return null;
    }
  }

  async function installOne(pkg: PackageRef): Promise<void> {
    const name = pkg.name.startsWith('@') ? pkg.name.replace('/', '%2f') : pkg.name;
    const meta = await timed(`${registry}/${name}`, true, metadataMs);
    if (!meta?.body) return;
    let tarball: string | undefined;
    try {
      const doc = JSON.parse(meta.body.toString('utf8')) as {
        versions?: Record<string, { dist?: { tarball?: string } }>;
      };
      tarball = doc.versions?.[pkg.version]?.dist?.tarball;
    } catch {
      // handled below
    }
    if (!tarball) {
      fail(
        `${pkg.name}@${pkg.version}`,
        new Error('version not in packument (filtered by policy?)'),
      );
      return;
    }
    await timed(tarball, false, tarballMs);
  }

  async function install(): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < opts.packages.length) {
        const pkg = opts.packages[next++];
        if (pkg) await installOne(pkg);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.max(1, opts.installs) }, install));
  const durationMs = performance.now() - t0;
  agent.destroy();

  return {
    target: registry,
    startedAt,
    durationMs: Math.round(durationMs),
    requests,
    rps: Math.round((requests / (durationMs / 1000)) * 10) / 10,
    errors,
    timeouts,
    bytes,
    metadata: summarize(metadataMs),
    tarballs: summarize(tarballMs),
    errorSamples,
  };
}
