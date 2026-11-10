// worker_threads pool for packument processing (DESIGN.md section 7.2): the main thread only
// moves bytes. A crashed or hung worker fails its own job and is replaced.
// Each worker is its own V8 isolate, and parsing large packuments (react-native, typescript:
// 11-16 MB) grows its heap and external memory, which the isolate never hands back; with one
// worker per core that alone pushed a 3Gi pod into OOMKilled (2026-11-02). So a worker is
// replaced once it has processed `recycleBytes` of documents: ending the isolate is the only
// way to return its memory. Documents are copied for a worker at dispatch, not while queued,
// but a queued job still keeps its caller's document alive: `maxQueuedBytes` bounds the bytes
// of the jobs the pool holds (queued and in progress) and refuses more with 503 + Retry-After.
import { Worker } from 'node:worker_threads';
import type {
  EcosystemAdapter,
  ProcessContext,
  ProcessedMetadata,
  RawMetadata,
  WriteBody,
  WriteRoute,
} from '../core/contracts.ts';
import { HttpError, overloaded } from '../core/errors.ts';
import { errorFields, log } from '../core/log.ts';
import { siblingModule } from '../core/modules.ts';
import type { MetadataProcessor } from './processor.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

/** A crafted document that makes a processor spin must not pin a worker forever. */
const JOB_TIMEOUT_MS = 60_000;
/** Respawn backoff for workers that keep dying (e.g. a broken build), capped. */
const MIN_RESPAWN_MS = 50;
const MAX_RESPAWN_MS = 10_000;
/** Documents a worker processes before it is replaced (WORKER_RECYCLE_BYTES). */
export const DEFAULT_RECYCLE_BYTES = 67_108_864;
/** How often heapBytes is refreshed (getHeapStatistics is async, metrics read synchronously). */
const HEAP_SAMPLE_MS = 15_000;

interface Job {
  id: number;
  /** Size of the document, counted against the worker's recycle budget. */
  bytes: number;
  /** Builds the message at dispatch, so a queued job holds no copy of its document. */
  build: () => { request: WorkerRequest; transfer: ArrayBuffer[] };
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker | null;
  job: Job | null;
  timer: NodeJS.Timeout | null;
  /** Consecutive failures, for the respawn backoff. */
  failures: number;
  /** Document bytes the current worker has processed. */
  bytes: number;
}

export interface WorkerPoolOptions {
  size: number;
  /** Replace a worker after it processed this many document bytes; 0 never replaces. */
  recycleBytes?: number;
  /**
   * Document bytes of the jobs held at once (queued plus in progress); a job beyond it is
   * refused with 503. One job is always taken when the pool holds none. 0 or absent = no limit.
   */
  maxQueuedBytes?: number;
}

/** postMessage turns Buffers into plain Uint8Arrays; restore Buffer views (no copy). */
function rewrapArtifacts(body: WriteBody): WriteBody {
  if (body.type !== 'publish') return body;
  for (const v of body.request.versions) {
    const d = v.artifact.data as Uint8Array;
    v.artifact.data = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  }
  return body;
}

export class WorkerPool implements MetadataProcessor {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly recycleBytes: number;
  private readonly maxQueuedBytes: number;
  private heldBytes = 0;
  private readonly heapTimer: NodeJS.Timeout;
  private nextId = 1;
  private closing = false;
  private recycleCount = 0;
  private heap = 0;

  constructor(opts: WorkerPoolOptions) {
    this.recycleBytes = opts.recycleBytes ?? DEFAULT_RECYCLE_BYTES;
    this.maxQueuedBytes = opts.maxQueuedBytes ?? 0;
    for (let i = 0; i < Math.max(1, opts.size); i++) {
      const slot: Slot = { worker: null, job: null, timer: null, failures: 0, bytes: 0 };
      this.slots.push(slot);
      this.spawn(slot);
    }
    this.heapTimer = setInterval(() => void this.refreshHeap(), HEAP_SAMPLE_MS);
    this.heapTimer.unref();
  }

  /** Jobs waiting for a free worker. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Document bytes of the jobs the pool holds (queued and in progress). */
  get queuedBytes(): number {
    return this.heldBytes;
  }

  /** The byte limit is reached: new jobs are refused until some finish. */
  get overloaded(): boolean {
    return this.maxQueuedBytes > 0 && this.heldBytes >= this.maxQueuedBytes;
  }

  get size(): number {
    return this.slots.length;
  }

  /** Workers replaced after reaching recycleBytes (not crashes). */
  get recycles(): number {
    return this.recycleCount;
  }

  /** Heap plus external memory of all workers at the last refresh. */
  get heapBytes(): number {
    return this.heap;
  }

  /** Reads the heap statistics of every worker; a worker that is gone counts as 0. */
  async refreshHeap(): Promise<number> {
    const stats = await Promise.all(
      this.slots.map(async (s) =>
        s.worker ? s.worker.getHeapStatistics().catch(() => null) : null,
      ),
    );
    let total = 0;
    for (const s of stats) if (s) total += s.total_heap_size + s.external_memory;
    this.heap = total;
    return total;
  }

  process(
    adapter: EcosystemAdapter,
    raw: RawMetadata,
    ctx: ProcessContext,
  ): Promise<ProcessedMetadata> {
    if (this.closing) return Promise.reject(new HttpError(503, 'shutting down'));
    const bytes = raw.body.length;
    const release = this.admit(bytes);
    if (!release) return Promise.reject(overloaded('metadata processing is busy'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        bytes,
        build: () => {
          // Copy into a buffer we own and transfer it: the caller keeps using `raw.body`
          // (persist), and Buffers from Node's pool must never be detached.
          const body = new Uint8Array(raw.body);
          return {
            request: {
              id,
              op: 'process',
              module: adapter.processorModule,
              raw: {
                body,
                encoding: raw.encoding,
                ...(raw.etag !== undefined ? { etag: raw.etag } : {}),
              },
              ctx,
            },
            transfer: [body.buffer],
          };
        },
        resolve: (r) => {
          release();
          resolve(r as ProcessedMetadata);
        },
        reject: (e) => {
          release();
          reject(e);
        },
      });
      this.dispatch();
    });
  }

  /**
   * Write bodies reach MAX_PUBLISH_BYTES: JSON, base64 and hashing happen off the main thread.
   * The body's memory is transferred to the worker: callers must not use `body` afterwards.
   */
  parseWriteBody(adapter: EcosystemAdapter, route: WriteRoute, body: Buffer): Promise<WriteBody> {
    if (this.closing) return Promise.reject(new HttpError(503, 'shutting down'));
    if (!adapter.parseWriteBody) return Promise.reject(new HttpError(405, 'method not allowed'));
    const bytes = body.length;
    const release = this.admit(bytes);
    if (!release) return Promise.reject(overloaded('metadata processing is busy'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        bytes,
        build: () => {
          // Move the body to the worker without a copy when it owns its whole ArrayBuffer (the
          // caller hands it over); otherwise copy it into one that can be transferred.
          const buf = body.buffer;
          const copy =
            buf instanceof ArrayBuffer &&
            body.byteOffset === 0 &&
            body.byteLength === buf.byteLength
              ? new Uint8Array(buf)
              : new Uint8Array(body);
          return {
            request: { id, op: 'write', module: adapter.processorModule, route, body: copy },
            transfer: [copy.buffer],
          };
        },
        resolve: (r) => {
          release();
          resolve(rewrapArtifacts(r as WriteBody));
        },
        reject: (e) => {
          release();
          reject(e);
        },
      });
      this.dispatch();
    });
  }

  /**
   * Counts a new job's bytes and returns the function that gives them back (once), or null
   * when the job does not fit. One job always fits.
   */
  private admit(bytes: number): (() => void) | null {
    if (this.maxQueuedBytes > 0 && this.heldBytes > 0) {
      if (this.heldBytes + bytes > this.maxQueuedBytes) return null;
    }
    this.heldBytes += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.heldBytes -= bytes;
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heapTimer);
    const shuttingDown = (): HttpError => new HttpError(503, 'shutting down');
    for (const job of this.queue.splice(0)) job.reject(shuttingDown());
    for (const slot of this.slots) this.finish(slot)?.reject(shuttingDown());
    await Promise.all(this.slots.map((s) => s.worker?.terminate() ?? Promise.resolve(0)));
  }

  private spawn(slot: Slot): void {
    const worker = new Worker(siblingModule('./worker', import.meta.url));
    slot.worker = worker;
    slot.bytes = 0;
    worker.on('message', (msg: WorkerResponse) => {
      // A reply for a job this slot no longer owns (e.g. after a timeout) is ignored.
      if (slot.job?.id !== msg.id) return;
      const job = this.finish(slot);
      slot.failures = 0;
      slot.bytes += job?.bytes ?? 0;
      if (msg.ok) job?.resolve(msg.result);
      else job?.reject(new HttpError(msg.status, msg.message, msg.body ?? { error: msg.message }));
      if (this.recycleBytes > 0 && slot.bytes >= this.recycleBytes && !this.closing) {
        this.recycle(slot);
      }
      this.dispatch();
    });
    worker.on('error', (err) => {
      log.error('metadata worker error', errorFields(err));
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      this.finish(slot)?.reject(new HttpError(502, 'metadata worker crashed'));
      if (this.closing) return;
      slot.failures++;
      const delay = Math.min(MAX_RESPAWN_MS, MIN_RESPAWN_MS * 2 ** (slot.failures - 1));
      log.error('metadata worker exited; replacing it', { code, delayMs: delay });
      setTimeout(() => {
        if (this.closing) return;
        this.spawn(slot);
        this.dispatch();
      }, delay).unref();
    });
  }

  /**
   * Replace an idle worker that reached its recycle budget. Not a failure: no backoff, and the
   * old worker's exit is ignored because it no longer owns the slot.
   */
  private recycle(slot: Slot): void {
    const old = slot.worker;
    this.recycleCount++;
    log.debug('recycling a metadata worker', { bytes: slot.bytes });
    this.spawn(slot);
    void old?.terminate();
  }

  /** Detach and return the slot's current job, clearing its timer. */
  private finish(slot: Slot): Job | null {
    const job = slot.job;
    slot.job = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    return job;
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.job || !slot.worker || this.queue.length === 0) continue;
      const job = this.queue.shift();
      if (!job) return;
      const worker = slot.worker;
      slot.job = job;
      slot.timer = setTimeout(() => {
        log.error('metadata job timed out; restarting its worker', { id: job.id });
        this.finish(slot)?.reject(new HttpError(502, 'metadata processing timed out'));
        void worker.terminate(); // the exit handler respawns it
      }, JOB_TIMEOUT_MS);
      slot.timer.unref();
      try {
        const { request, transfer } = job.build();
        worker.postMessage(request, transfer);
      } catch (err) {
        log.error('could not hand a job to a metadata worker', errorFields(err));
        this.finish(slot)?.reject(new HttpError(502, 'metadata processing failed'));
      }
    }
  }
}
