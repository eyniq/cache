// Gzip for metadata responses. Packuments are large JSON (react: about 7 MB, 1.4 MB gzipped)
// and npm always sends `Accept-Encoding: gzip`, so sending them uncompressed made the cache
// slower than the public registry on anything but a fast LAN. Rendered bodies depend on policy
// (age gate, filters, public-URL aliases), so a gzip copy cannot be stored with the packument;
// it is made on demand, keyed by the response ETag (which already identifies the exact body),
// kept in a small byte-capped LRU, and concurrent requests for the same body share one job.
// zlib's async API runs on the libuv threadpool, so the event loop never compresses.
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { ByteLru } from '../core/lru.ts';

const gzipAsync = promisify(gzipCb);

/** Below this a gzip header and the extra CPU cost more than the bytes saved. */
const DEFAULT_MIN_BYTES = 1024;
const LEVEL = 6;

/** True when the client accepts gzip (RFC 9110 section 12.5.3; `q=0` means "not acceptable"). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  for (const part of value.split(',')) {
    const [coding = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (coding !== 'gzip' && coding !== 'x-gzip' && coding !== '*') continue;
    const q = params.find((p) => p.startsWith('q='));
    if (q === undefined || Number(q.slice(2)) > 0) return true;
  }
  return false;
}

/** ETag of the gzip representation: a different encoding is a different representation. */
export function gzipEtag(etag: string): string {
  return etag.endsWith('"') ? `${etag.slice(0, -1)}-gz"` : `${etag}-gz`;
}

export interface MetadataCompressorOptions {
  /** Bytes of gzip bodies kept for reuse (per worker); 0 keeps none. */
  maxCacheBytes: number;
  minBytes?: number;
}

export class MetadataCompressor {
  private readonly cache: ByteLru<Buffer>;
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly minBytes: number;

  constructor(opts: MetadataCompressorOptions) {
    this.cache = new ByteLru(opts.maxCacheBytes);
    this.minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
  }

  get cacheBytes(): number {
    return this.cache.bytes;
  }

  worthCompressing(body: Buffer): boolean {
    return body.length >= this.minBytes;
  }

  /** The gzip form of `body`; `key` must identify the body exactly (its ETag). */
  gzip(key: string, body: Buffer): Promise<Buffer> {
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const job = gzipAsync(body, { level: LEVEL })
      .then((gz) => {
        this.cache.set(key, gz, gz.length);
        return gz;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, job);
    return job;
  }
}
