// Bounded background storage writes. A cold burst used to fire thousands of PUTs at once; on a
// slow backend (versitygw on NFS) they queued up inside it, timed out and were lost. All
// buffered background writes (packuments, sidecars, index entries) now go through one limiter:
// at most `concurrency` run at a time, the rest wait in a FIFO queue bounded in count and bytes,
// and when it overflows the least valuable writes are dropped (never the caller's response).
// Ecosystem-agnostic: it only knows the Storage contract.
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Storage } from './contracts.ts';
import { errorFields, log } from './log.ts';
import { StorageTimeout } from './storage.ts';

/** What is written: metadata copy, its .meta sidecar, an artifact index entry or a tarball. */
export type WriteKind = 'metadata' | 'meta' | 'index' | 'tarball';
export type WriteFailureReason = 'timeout' | 'error';

/** Drop order, least valuable first: re-fetchable copies go before anything else. */
const PRIORITY: Record<WriteKind, number> = { metadata: 0, meta: 1, index: 2, tarball: 3 };
/** A tombstone must not be lost (a removed package could come back); dropped last. */
const CRITICAL_PRIORITY = 10;

export class WriteDropped extends Error {
  constructor(kind: WriteKind) {
    super(`background ${kind} write dropped: write queue full`);
    this.name = 'WriteDropped';
  }
}

export interface WriteObserver {
  /** One storage attempt finished (success or not). */
  duration(kind: WriteKind, seconds: number): void;
  /** A write failed for good (retries used up). */
  failure(kind: WriteKind, reason: WriteFailureReason): void;
  dropped(kind: WriteKind): void;
  retry(kind: WriteKind): void;
}

export interface WriteLimiterOptions {
  storage: Storage;
  /** Writes running at once (default 16). */
  concurrency?: number;
  /** Writes waiting for a slot (default 4096). */
  maxQueue?: number;
  /** Bytes the waiting writes may hold (default 128 MiB). */
  maxQueueBytes?: number;
  /**
   * Bytes the streaming (tarball tee) writes may hold together before a new one is refused and
   * its artifact served uncached (default 128 MiB; 0 = unlimited).
   */
  maxStreamBytes?: number;
  /** I/O timeout passed to Storage.put for every write of the limiter (default 120 s). */
  timeoutMs?: number;
  observer?: WriteObserver;
  /** Backoff before the single retry after a timeout; jittered between 50% and 100%. */
  retryDelayMs?: number;
}

export interface BufferedWrite {
  kind: WriteKind;
  key: string;
  body: Buffer;
  contentType: string;
  /** Dropped only after everything else (tombstones). */
  critical?: boolean;
}

interface Queued extends BufferedWrite {
  priority: number;
  resolve(): void;
  reject(err: unknown): void;
}

const DEFAULTS = {
  concurrency: 16,
  maxQueue: 4096,
  maxQueueBytes: 134_217_728,
  maxStreamBytes: 134_217_728,
  timeoutMs: 120_000,
};

export class WriteLimiter {
  private readonly o: Required<Omit<WriteLimiterOptions, 'observer'>> & {
    observer: WriteObserver | undefined;
  };
  private readonly queue: Queued[] = [];
  private queuedBytes = 0;
  private running = 0;
  private streaming = 0;
  private streamBytes = 0;
  private readonly settled = new Set<Promise<unknown>>();
  private droppedSinceLog = 0;
  private lastDropLog = 0;

  constructor(opts: WriteLimiterOptions) {
    this.o = {
      storage: opts.storage,
      concurrency: opts.concurrency ?? DEFAULTS.concurrency,
      maxQueue: opts.maxQueue ?? DEFAULTS.maxQueue,
      maxQueueBytes: opts.maxQueueBytes ?? DEFAULTS.maxQueueBytes,
      maxStreamBytes: opts.maxStreamBytes ?? DEFAULTS.maxStreamBytes,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      retryDelayMs: opts.retryDelayMs ?? 1000,
      observer: opts.observer,
    };
  }

  /** Writes waiting for a slot. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Writes in flight: limited ones plus streaming ones (see stream()). */
  get inFlight(): number {
    return this.running + this.streaming;
  }

  /**
   * Resolves when the body is stored, rejects with the storage error (after one retry on a
   * timeout) or with WriteDropped. Bodies are buffers so an attempt can be repeated.
   */
  write(req: BufferedWrite): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({
        ...req,
        priority: req.critical ? CRITICAL_PRIORITY : PRIORITY[req.kind],
        resolve,
        reject,
      });
      this.queuedBytes += req.body.length;
    });
    this.track(promise);
    this.enforceBounds();
    this.pump();
    return promise;
  }

  /**
   * A write whose body streams from a live client download (tarball tee). It cannot wait in the
   * queue without buffering up to MAX_TARBALL_BYTES, and it cannot be retried (the stream is
   * consumed), so it bypasses the queue and the slot count; it is bounded by the number of
   * concurrent client downloads. It is timed, counted in the in-flight gauge and its failures
   * are classified like the others.
   */
  stream(
    kind: WriteKind,
    key: string,
    body: Readable,
    contentType: string,
    expectedBytes = 0,
  ): Promise<void> {
    // Byte budget: the storage may buffer the whole body until it commits (S3 PUT), so held
    // memory grows with concurrent misses x size on slow storage. Over budget the write is
    // refused and its body drained, so the client download continues uncached. One write is
    // always admitted, however large.
    const reserve = Math.min(Math.max(0, expectedBytes), this.o.maxStreamBytes);
    if (
      this.o.maxStreamBytes > 0 &&
      this.streamBytes > 0 &&
      this.streamBytes + reserve > this.o.maxStreamBytes
    ) {
      body.resume();
      this.o.observer?.dropped(kind);
      this.noteDrop();
      return Promise.reject(new WriteDropped(kind));
    }
    this.streamBytes += reserve;
    this.streaming++;
    const started = performance.now();
    const promise = this.o.storage
      .put(key, body, { contentType, timeoutMs: this.o.timeoutMs })
      .then(
        () => {
          this.o.observer?.duration(kind, (performance.now() - started) / 1000);
        },
        (err: unknown) => {
          this.o.observer?.duration(kind, (performance.now() - started) / 1000);
          this.o.observer?.failure(kind, reasonOf(err));
          throw err;
        },
      )
      .finally(() => {
        this.streaming--;
        this.streamBytes -= reserve;
      });
    this.track(promise);
    return promise;
  }

  /** Waits until everything accepted so far is written or failed (shutdown, tests). */
  async drain(): Promise<void> {
    while (this.settled.size > 0) await Promise.allSettled([...this.settled]);
  }

  private track(promise: Promise<unknown>): void {
    const t = promise.then(
      () => undefined,
      () => undefined,
    );
    this.settled.add(t);
    void t.then(() => this.settled.delete(t));
  }

  /** Over the count or byte cap: drop the least valuable, oldest first (the new one is last). */
  private enforceBounds(): void {
    while (this.queue.length > this.o.maxQueue || this.queuedBytes > this.o.maxQueueBytes) {
      let victim = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if ((this.queue[i] as Queued).priority < (this.queue[victim] as Queued).priority)
          victim = i;
      }
      const [item] = this.queue.splice(victim, 1) as [Queued];
      this.queuedBytes -= item.body.length;
      this.o.observer?.dropped(item.kind);
      this.noteDrop();
      item.reject(new WriteDropped(item.kind));
    }
  }

  private noteDrop(): void {
    this.droppedSinceLog++;
    const now = Date.now();
    if (now - this.lastDropLog < 60_000) return;
    this.lastDropLog = now;
    log.warn('background storage writes dropped: write queue full', {
      dropped: this.droppedSinceLog,
      queued: this.queue.length,
    });
    this.droppedSinceLog = 0;
  }

  private pump(): void {
    while (this.running < this.o.concurrency) {
      const item = this.queue.shift();
      if (!item) return;
      this.queuedBytes -= item.body.length;
      this.running++;
      void this.run(item).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(item: Queued): Promise<void> {
    try {
      try {
        await this.attempt(item);
      } catch (err) {
        if (!(err instanceof StorageTimeout)) throw err;
        // The write may even have landed; the key is the same, so repeating it is harmless.
        this.o.observer?.retry(item.kind);
        await sleep(this.o.retryDelayMs * (0.5 + Math.random() / 2));
        await this.attempt(item);
      }
      item.resolve();
    } catch (err) {
      this.o.observer?.failure(item.kind, reasonOf(err));
      log.debug('background storage write failed', {
        key: item.key,
        kind: item.kind,
        ...errorFields(err),
      });
      item.reject(err);
    }
  }

  private async attempt(item: Queued): Promise<void> {
    const started = performance.now();
    try {
      await this.o.storage.put(item.key, Readable.from([item.body]), {
        contentType: item.contentType,
        timeoutMs: this.o.timeoutMs,
      });
    } finally {
      this.o.observer?.duration(item.kind, (performance.now() - started) / 1000);
    }
  }
}

function reasonOf(err: unknown): WriteFailureReason {
  return err instanceof StorageTimeout ? 'timeout' : 'error';
}
