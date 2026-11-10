// S3-compatible object storage (AWS S3, MinIO, GCS XML API with HMAC keys) with an own
// SigV4 signer. Objects only become visible when complete (single PUT or a completed
// multipart upload), so readers never see a partial object.
import { createHash, randomUUID } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  OpenedObject,
  Storage,
  StorageAdmin,
  StorageCapabilities,
  StorageListEntry,
  StorageListPage,
  StorageObjectInfo,
} from '../core/contracts.ts';
import { ConditionalWritesUnsupported } from '../core/errors.ts';
import { assertSafeKey, isSafeKey } from '../core/names.ts';
import { StorageTimeout, clampLimit } from '../core/storage.ts';
import { readLimited } from '../core/streams.ts';
import { encodeKeyPath, signRequest } from './sigv4.ts';

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Multipart part size; S3 requires at least 5 MiB for every part but the last. */
/** I/O timeout of request-path storage calls; background writes pass a longer one. */
const REQUEST_TIMEOUT_MS = 30_000;
const PART_BYTES = 8 * 1024 * 1024;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const ERROR_BODY_LIMIT = 16 * 1024;

/** A ListObjectsV2 page of 1000 keys is well under this. */
const LIST_BODY_LIMIT = 4 * 1024 * 1024;

/**
 * Waits before each retry of a PUT refused with 409 ExistingObjectIsDirectory. versitygw's
 * posix backend answers that when its mkdir of the key's parent directory fails, which on a
 * filesystem shared by several gateways (NFS) also happens when nothing is in the way: another
 * gateway just created the directory, mkdir says EEXIST and this gateway's cached "does not
 * exist" lookup hides it until the client revalidates (seconds). Nothing was written, so the
 * same body is sent again. About 5-10 s in all; equal jitter (half fixed, half random) keeps
 * the pods of a burst from retrying in lockstep.
 */
const CONFLICT_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600, 3200, 3200];
const DIRECTORY_RACE = 'ExistingObjectIsDirectory';

export interface S3Tuning {
  /** Tests only: override CONFLICT_RETRY_DELAYS_MS (one retry per entry). */
  conflictRetryDelaysMs?: readonly number[];
}

/** A PUT answered with 409; `code` is the S3 error code from the body. */
class PutConflict extends Error {
  readonly code: string;
  constructor(what: string, code: string) {
    super(`S3 ${what} failed: 409 ${code}`);
    this.code = code;
  }
}

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Text content of an XML element (S3 escapes &, <, > and quotes in keys and ETags). */
function xmlText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const state = { invalid: false }; // set inside the replacer
  const text = raw.replace(/&(#x[0-9a-fA-F]{1,8}|#\d{1,8}|[a-z]+);/g, (whole, entity: string) => {
    if (!entity.startsWith('#')) return XML_ENTITIES[entity] ?? whole;
    const code = entity.startsWith('#x')
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10);
    // Out of range or NUL: the element is unusable (fromCodePoint would throw on the former).
    if (code < 1 || code > 0x10ffff) {
      state.invalid = true;
      return '';
    }
    return String.fromCodePoint(code);
  });
  return state.invalid ? undefined : text;
}

/** The S3 error code of an error response; consumes the (size-capped) body. */
async function errorCode(res: IncomingMessage): Promise<string> {
  const body = await readLimited(res, ERROR_BODY_LIMIT, () => new Error('error body too large'))
    .then((b) => b.toString('utf8'))
    .catch(() => '');
  return /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? 'unknown';
}

export class S3Storage implements Storage, StorageAdmin {
  private caps: Promise<StorageCapabilities> | null = null;
  private readonly opts: S3Options;
  private readonly base: URL;
  private readonly agent: HttpAgent | HttpsAgent;
  // check() backs /readyz: on its own socket it never queues behind busy data sockets
  // (tarball streams), so a saturated pool is not reported as an unreachable bucket.
  private readonly probeAgent: HttpAgent | HttpsAgent;
  private readonly send: typeof httpRequest;
  private readonly conflictRetryDelaysMs: readonly number[];

  constructor(opts: S3Options, tuning: S3Tuning = {}) {
    this.opts = opts;
    this.conflictRetryDelaysMs = tuning.conflictRetryDelaysMs ?? CONFLICT_RETRY_DELAYS_MS;
    this.base = new URL(opts.endpoint);
    const https = this.base.protocol === 'https:';
    this.agent = https
      ? new HttpsAgent({ keepAlive: true, maxSockets: 64 })
      : new HttpAgent({ keepAlive: true, maxSockets: 64 });
    this.probeAgent = https
      ? new HttpsAgent({ keepAlive: true, maxSockets: 1 })
      : new HttpAgent({ keepAlive: true, maxSockets: 1 });
    this.send = https ? httpsRequest : httpRequest;
  }

  /** Keys starting with "." (the capability probe) are internal: callers cannot reach them. */
  private url(key: string | null, query = '', internal = false): URL {
    if (key?.startsWith('.') && !internal) throw new Error('unsafe storage key');
    const path = key === null ? '' : `/${encodeKeyPath(assertSafeKey(key))}`;
    const prefix = this.base.pathname.replace(/\/+$/, '');
    if (this.opts.forcePathStyle) {
      return new URL(`${this.base.origin}${prefix}/${this.opts.bucket}${path}${query}`);
    }
    return new URL(
      `${this.base.protocol}//${this.opts.bucket}.${this.base.host}${prefix}${path || '/'}${query}`,
    );
  }

  private request(
    method: string,
    url: URL,
    body?: Buffer,
    extra: Record<string, string> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    agent = this.agent,
  ): Promise<IncomingMessage> {
    const payload = body ?? Buffer.alloc(0);
    const { headers } = signRequest({
      method,
      url,
      headers: { ...extra, ...(body ? { 'content-length': String(payload.length) } : {}) },
      payloadHash: body ? sha256Hex(payload) : EMPTY_SHA256,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.opts.region,
      service: 's3',
      date: new Date(),
    });
    return new Promise((resolve, reject) => {
      const req = this.send(url, { method, headers, agent, timeout: timeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new StorageTimeout(`S3 ${method}`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Throws a short error; S3 error bodies carry no secrets but can be large. */
  private async fail(res: IncomingMessage, what: string): Promise<never> {
    throw new Error(`S3 ${what} failed: ${res.statusCode ?? 0} ${await errorCode(res)}`);
  }

  /**
   * PUT of a fully buffered body. A 409 is thrown as PutConflict, never returned; the
   * transient ExistingObjectIsDirectory one (see CONFLICT_RETRY_DELAYS_MS) only once the
   * retries are used up.
   */
  private async putBuffered(
    key: string,
    body: Buffer,
    headers: Record<string, string>,
    what: string,
    timeoutMs?: number,
  ): Promise<IncomingMessage> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request('PUT', this.url(key), body, headers, timeoutMs);
      if (res.statusCode !== 409) return res;
      const code = await errorCode(res);
      const delay = this.conflictRetryDelaysMs[attempt];
      if (code !== DIRECTORY_RACE || delay === undefined) throw new PutConflict(what, code);
      await sleep(delay / 2 + Math.random() * (delay / 2));
    }
  }

  async get(key: string): Promise<Readable | null> {
    return (await this.open(key))?.body ?? null;
  }

  async open(key: string): Promise<OpenedObject | null> {
    const res = await this.request('GET', this.url(key));
    if (res.statusCode === 404) {
      res.resume();
      return null;
    }
    if (res.statusCode !== 200) return this.fail(res, 'GET');
    const size = Number(res.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) {
      res.destroy();
      throw new Error('S3 GET returned no usable Content-Length');
    }
    const etag = res.headers.etag;
    return { body: res, size, ...(etag ? { etag } : {}) };
  }

  async head(key: string): Promise<StorageObjectInfo | null> {
    const res = await this.request('HEAD', this.url(key));
    res.resume();
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) throw new Error(`S3 HEAD failed: ${res.statusCode ?? 0}`);
    const etag = res.headers.etag;
    return { size: Number(res.headers['content-length'] ?? 0), ...(etag ? { etag } : {}) };
  }

  async put(
    key: string,
    body: Readable,
    opts: { contentType?: string; timeoutMs?: number } = {},
  ): Promise<void> {
    const { timeoutMs } = opts;
    const contentType = opts.contentType ?? 'application/octet-stream';
    let chunks: Buffer[] = [];
    let buffered = 0;
    let uploadId: string | null = null;
    const parts: string[] = [];
    // One part upload stays in flight while the next part is read, so the source stream (and
    // the client it is shared with) is not paused for every part round trip.
    let pending: Promise<string> | null = null;
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        buffered += chunk.length;
        if (buffered >= PART_BYTES) {
          uploadId ??= await this.createUpload(key, contentType, timeoutMs);
          if (pending) parts.push(await pending);
          pending = this.uploadPart(
            key,
            uploadId,
            parts.length + 1,
            Buffer.concat(chunks),
            timeoutMs,
          );
          pending.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
          chunks = [];
          buffered = 0;
        }
      }
      // One chunk needs no copy; drop the chunk list so a slow PUT holds the body only once.
      const rest = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      chunks = [];
      if (uploadId === null) {
        const res = await this.putBuffered(
          key,
          rest,
          { 'content-type': contentType },
          'PUT',
          timeoutMs,
        );
        if (res.statusCode !== 200) return await this.fail(res, 'PUT');
        res.resume();
        return;
      }
      if (pending) parts.push(await pending);
      pending = null;
      if (rest.length > 0)
        parts.push(await this.uploadPart(key, uploadId, parts.length + 1, rest, timeoutMs));
      await this.completeUpload(key, uploadId, parts, timeoutMs);
    } catch (err) {
      await pending?.catch(() => undefined);
      // An aborted upload leaves nothing visible; the abort itself is best effort.
      if (uploadId !== null) {
        await this.request('DELETE', this.url(key, `?uploadId=${encodeURIComponent(uploadId)}`))
          .then((r) => r.resume())
          .catch(() => undefined);
      }
      throw err;
    }
  }

  private async createUpload(
    key: string,
    contentType: string,
    timeoutMs?: number,
  ): Promise<string> {
    const res = await this.request(
      'POST',
      this.url(key, '?uploads='),
      Buffer.alloc(0),
      { 'content-type': contentType },
      timeoutMs,
    );
    if (res.statusCode !== 200) return this.fail(res, 'CreateMultipartUpload');
    const xml = (
      await readLimited(res, ERROR_BODY_LIMIT, () => new Error('response too large'))
    ).toString();
    const id = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!id) throw new Error('S3 CreateMultipartUpload returned no UploadId');
    return id;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    n: number,
    data: Buffer,
    timeoutMs?: number,
  ): Promise<string> {
    const query = `?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`;
    const res = await this.request('PUT', this.url(key, query), data, {}, timeoutMs);
    if (res.statusCode !== 200) return this.fail(res, 'UploadPart');
    res.resume();
    const etag = res.headers.etag;
    if (!etag) throw new Error('S3 UploadPart returned no ETag');
    return etag;
  }

  private async completeUpload(
    key: string,
    uploadId: string,
    etags: string[],
    timeoutMs?: number,
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload>' +
      etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const query = `?uploadId=${encodeURIComponent(uploadId)}`;
    const res = await this.request(
      'POST',
      this.url(key, query),
      Buffer.from(xml),
      { 'content-type': 'application/xml' },
      timeoutMs,
    );
    if (res.statusCode !== 200) return this.fail(res, 'CompleteMultipartUpload');
    // S3 can answer 200 with an error document for CompleteMultipartUpload.
    const body = (
      await readLimited(res, ERROR_BODY_LIMIT, () => new Error('response too large'))
    ).toString();
    if (body.includes('<Error>')) throw new Error('S3 CompleteMultipartUpload failed');
  }

  // ---- StorageAdmin ---------------------------------------------------------------------

  /**
   * Probed once: S3 compatibles differ, and some silently ignore If-None-Match / If-Match,
   * which would turn a compare-and-swap into a blind overwrite. A probe object is written,
   * then overwritten conditionally; only a 412 for both proves enforcement.
   */
  capabilities(): Promise<StorageCapabilities> {
    this.caps ??= this.probe().catch((err: unknown) => {
      this.caps = null; // a network failure is not an answer; probe again next time
      throw err;
    });
    return this.caps;
  }

  /**
   * Strict: both preconditions must fail with exactly 412, a matching If-Match must succeed,
   * and the object must still hold what was written. Anything else (an ignored header, 400,
   * 501, a 404 from a wrong bucket) means "not enforced". The probe object lives under
   * .eyniq-probe/ and is deleted; a lifecycle rule on that prefix catches leftovers.
   */
  private async probe(): Promise<StorageCapabilities> {
    const url = this.url(`.eyniq-probe/${randomUUID()}`, '', true);
    const status = async (headers: Record<string, string>, body: string): Promise<number> => {
      const res = await this.request('PUT', url, Buffer.from(body), {
        'content-type': 'text/plain',
        ...headers,
      });
      res.resume();
      return res.statusCode ?? 0;
    };
    const created = await this.request('PUT', url, Buffer.from('probe'), {
      'content-type': 'text/plain',
    });
    created.resume();
    if (created.statusCode !== 200) {
      throw new Error(`S3 capability probe failed: ${created.statusCode ?? 0}`);
    }
    const etag = created.headers.etag;
    try {
      const enforced =
        (await status({ 'if-none-match': '*' }, 'x')) === 412 &&
        (await status({ 'if-match': '"0"' }, 'x')) === 412 &&
        etag !== undefined &&
        (await status({ 'if-match': etag }, 'probe')) === 200;
      let intact = false;
      if (enforced) {
        const res = await this.request('GET', url);
        const body = await readLimited(res, 64, () => new Error('probe object too large'));
        intact = res.statusCode === 200 && body.toString() === 'probe';
      }
      return { list: true, delete: true, conditionalWrites: enforced && intact };
    } finally {
      await this.request('DELETE', url)
        .then((r) => r.resume())
        .catch(() => undefined);
    }
  }

  private async requireConditionalWrites(): Promise<void> {
    if (!(await this.capabilities()).conditionalWrites) throw new ConditionalWritesUnsupported();
  }

  /**
   * true: written; false: precondition failed (412), lost a race (409, except the transient
   * directory race, which is retried and then thrown) or no object (404).
   */
  private async conditionalPut(
    key: string,
    body: Buffer,
    condition: Record<string, string>,
    contentType = 'application/octet-stream',
  ): Promise<boolean> {
    let res: IncomingMessage;
    try {
      res = await this.putBuffered(
        key,
        body,
        { 'content-type': contentType, ...condition },
        'conditional PUT',
      );
    } catch (err) {
      // Nothing was written on a directory race, so it must not look like someone else won.
      if (err instanceof PutConflict && err.code !== DIRECTORY_RACE) return false;
      throw err;
    }
    const status = res.statusCode ?? 0;
    if (status === 200) {
      res.resume();
      return true;
    }
    // 404 only means "object gone" for If-Match; for If-None-Match it is a wrong bucket,
    // which must not look like "someone else wrote it" to a retrying caller.
    if (status === 412 || (status === 404 && 'if-match' in condition)) {
      res.resume();
      return false;
    }
    if (status === 501) {
      res.resume();
      throw new ConditionalWritesUnsupported();
    }
    return this.fail(res, 'conditional PUT');
  }

  async putIfAbsent(
    key: string,
    body: Buffer,
    opts: { contentType?: string } = {},
  ): Promise<boolean> {
    await this.requireConditionalWrites();
    return this.conditionalPut(key, body, { 'if-none-match': '*' }, opts.contentType);
  }

  async putIfMatch(
    key: string,
    body: Buffer,
    etag: string,
    opts: { contentType?: string } = {},
  ): Promise<boolean> {
    await this.requireConditionalWrites();
    if (!/^(W\/)?"[\x21\x23-\x7e]{1,200}"$/.test(etag)) return false;
    return this.conditionalPut(key, body, { 'if-match': etag }, opts.contentType);
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', this.url(key));
    if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 404) {
      res.resume();
      return;
    }
    return this.fail(res, 'DELETE');
  }

  /** ListObjectsV2; the cursor is the last key returned (StartAfter), as for FsStorage. */
  async list(
    prefix: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<StorageListPage> {
    if (prefix !== '') assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const limit = clampLimit(opts.limit);
    if (opts.cursor !== undefined && opts.cursor.length > 1024) throw new Error('invalid cursor');
    const params = new URLSearchParams({ 'list-type': '2', 'max-keys': String(limit), prefix });
    if (opts.cursor !== undefined) params.set('start-after', opts.cursor);
    const query = `?${params.toString().replace(/\+/g, '%20')}`;
    const res = await this.request('GET', this.url(null, query));
    if (res.statusCode !== 200) return this.fail(res, 'ListObjectsV2');
    const xml = (
      await readLimited(res, LIST_BODY_LIMIT, () => new Error('S3 list response too large'))
    ).toString('utf8');
    const entries: StorageListEntry[] = [];
    let lastKey: string | undefined;
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1] ?? '';
      const key = xmlText(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]);
      if (key === undefined) continue;
      lastKey = key;
      // Keys the cache did not write (or internal probes) are not part of the namespace.
      if (!isSafeKey(key) || key.startsWith('.')) continue;
      const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0);
      const etag = xmlText(/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1]);
      entries.push({ key, size, ...(etag ? { etag } : {}) });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (
      truncated &&
      opts.cursor !== undefined &&
      (lastKey === undefined || lastKey <= opts.cursor)
    ) {
      // A backend that ignores StartAfter would hand out the same page forever.
      throw new Error('S3 ListObjectsV2 did not advance past the cursor');
    }
    return { entries, ...(truncated && lastKey !== undefined ? { cursor: lastKey } : {}) };
  }

  async check(): Promise<void> {
    const res = await this.request(
      'HEAD',
      this.url(null),
      undefined,
      {},
      REQUEST_TIMEOUT_MS,
      this.probeAgent,
    );
    res.resume();
    if (res.statusCode !== 200) throw new Error(`S3 bucket not reachable: ${res.statusCode ?? 0}`);
  }

  /** Tests and local setups only: create the bucket if it does not exist. */
  async createBucketForTests(): Promise<void> {
    const res = await this.request('PUT', this.url(null), Buffer.alloc(0));
    res.resume();
    if (res.statusCode !== 200 && res.statusCode !== 409) {
      throw new Error(`S3 CreateBucket failed: ${res.statusCode ?? 0}`);
    }
  }
}
