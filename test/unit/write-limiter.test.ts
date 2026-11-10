import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import type { Storage } from '../../src/core/contracts.ts';
import { StorageTimeout } from '../../src/core/storage.ts';
import {
  WriteDropped,
  WriteLimiter,
  type WriteKind,
  type WriteObserver,
} from '../../src/core/write-limiter.ts';

/** Storage whose puts are released by hand, so a test controls what is in flight. */
class GatedStorage implements Storage {
  readonly started: string[] = [];
  readonly done: string[] = [];
  readonly timeouts: Array<number | undefined> = [];
  private readonly gates: Array<() => void> = [];
  failures: Array<Error | null> = [];
  inFlight = 0;
  maxInFlight = 0;
  auto = false;

  get(): Promise<Readable | null> {
    return Promise.resolve(null);
  }
  head(): Promise<null> {
    return Promise.resolve(null);
  }
  check(): Promise<void> {
    return Promise.resolve();
  }
  async put(key: string, body: Readable, opts?: { timeoutMs?: number }): Promise<void> {
    await buffer(body);
    this.started.push(key);
    this.timeouts.push(opts?.timeoutMs);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (!this.auto) await new Promise<void>((r) => this.gates.push(r));
    this.inFlight--;
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.done.push(key);
  }
  release(n = 1): void {
    for (let i = 0; i < n; i++) this.gates.shift()?.();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function observer() {
  const seen = {
    durations: [] as WriteKind[],
    failures: [] as string[],
    dropped: [] as WriteKind[],
    retries: [] as WriteKind[],
  };
  const o: WriteObserver = {
    duration: (k) => seen.durations.push(k),
    failure: (k, reason) => seen.failures.push(`${k}:${reason}`),
    dropped: (k) => seen.dropped.push(k),
    retry: (k) => seen.retries.push(k),
  };
  return { seen, o };
}

const w = (kind: WriteKind, key: string, size = 1, critical = false) => ({
  kind,
  key,
  body: Buffer.alloc(size),
  contentType: 'application/json',
  critical,
});

describe('WriteLimiter', () => {
  it('runs at most `concurrency` writes and keeps FIFO order', async () => {
    const s = new GatedStorage();
    const lim = new WriteLimiter({ storage: s, concurrency: 2 });
    const all = ['a', 'b', 'c', 'd', 'e'].map((k) => lim.write(w('meta', k)));
    await tick();
    expect(s.started).toEqual(['a', 'b']);
    expect(lim.inFlight).toBe(2);
    expect(lim.queueLength).toBe(3);
    s.release();
    await tick();
    expect(s.started).toEqual(['a', 'b', 'c']);
    s.auto = true;
    s.release(10);
    await Promise.all(all);
    expect(s.maxInFlight).toBe(2);
    expect(s.done).toHaveLength(5);
    expect(lim.queueLength).toBe(0);
  });

  it('passes the background timeout to every write', async () => {
    const s = new GatedStorage();
    s.auto = true;
    const lim = new WriteLimiter({ storage: s, timeoutMs: 123_000 });
    await lim.write(w('index', 'k'));
    expect(s.timeouts).toEqual([123_000]);
  });

  it('drops the least valuable, oldest write first when the queue is full', async () => {
    const s = new GatedStorage();
    const { seen, o } = observer();
    const lim = new WriteLimiter({ storage: s, concurrency: 1, maxQueue: 3, observer: o });
    const results = new Map<string, Promise<void>>();
    const add = (kind: WriteKind, key: string, critical = false) => {
      const p = lim.write(w(kind, key, 1, critical));
      p.catch(() => undefined);
      results.set(key, p);
    };
    add('meta', 'running'); // takes the only slot
    await tick();
    add('metadata', 'm1');
    add('meta', 's1');
    add('index', 'i1');
    add('metadata', 'm2'); // queue would hold 4: m1 (lowest value, oldest) goes
    await expect(results.get('m1')).rejects.toBeInstanceOf(WriteDropped);
    add('metadata', 'tomb', true);
    add('index', 'i2'); // 5 > 3 again: m2, then s1
    await expect(results.get('m2')).rejects.toBeInstanceOf(WriteDropped);
    await expect(results.get('s1')).rejects.toBeInstanceOf(WriteDropped);
    expect(seen.dropped).toEqual(['metadata', 'metadata', 'meta']);
    expect(lim.queueLength).toBe(3);
    s.auto = true;
    s.release(10);
    await lim.drain();
    expect(s.done).toEqual(['running', 'i1', 'tomb', 'i2']);
  });

  it('bounds the bytes of waiting writes', async () => {
    const s = new GatedStorage();
    const lim = new WriteLimiter({ storage: s, concurrency: 1, maxQueueBytes: 100 });
    lim.write(w('meta', 'running', 10)).catch(() => undefined);
    await tick();
    const a = lim.write(w('metadata', 'a', 60));
    a.catch(() => undefined);
    const b = lim.write(w('metadata', 'b', 60));
    await expect(a).rejects.toBeInstanceOf(WriteDropped);
    expect(lim.queueLength).toBe(1);
    s.auto = true;
    s.release(5);
    await b;
  });

  it('retries once after a timeout and reports it', async () => {
    const s = new GatedStorage();
    s.auto = true;
    s.failures = [new StorageTimeout('S3 PUT')];
    const { seen, o } = observer();
    const lim = new WriteLimiter({ storage: s, observer: o, retryDelayMs: 1 });
    await lim.write(w('metadata', 'k'));
    expect(s.started).toEqual(['k', 'k']);
    expect(seen.retries).toEqual(['metadata']);
    expect(seen.failures).toEqual([]);
    expect(seen.durations).toHaveLength(2);
  });

  it('fails after a second timeout, and never retries other errors', async () => {
    const s = new GatedStorage();
    s.auto = true;
    s.failures = [new StorageTimeout('S3 PUT'), new StorageTimeout('S3 PUT')];
    const { seen, o } = observer();
    const lim = new WriteLimiter({ storage: s, observer: o, retryDelayMs: 1 });
    await expect(lim.write(w('meta', 'k'))).rejects.toBeInstanceOf(StorageTimeout);
    expect(s.started).toHaveLength(2);
    expect(seen.failures).toEqual(['meta:timeout']);
    s.failures = [new Error('boom')];
    await expect(lim.write(w('index', 'j'))).rejects.toThrow('boom');
    expect(s.started).toHaveLength(3);
    expect(seen.failures).toEqual(['meta:timeout', 'index:error']);
    expect(seen.retries).toEqual(['meta']);
  });

  it('streaming writes bypass the queue, count as in flight and are not retried', async () => {
    const s = new GatedStorage();
    const { seen, o } = observer();
    const lim = new WriteLimiter({ storage: s, concurrency: 1, observer: o });
    lim.write(w('meta', 'buffered')).catch(() => undefined);
    const st = lim.stream('tarball', 't', Readable.from([Buffer.from('x')]), 'application/x-gzip');
    st.catch(() => undefined);
    await tick();
    expect(s.started).toEqual(['buffered', 't']);
    expect(lim.inFlight).toBe(2);
    s.failures = [new Error('unused'), new StorageTimeout('S3 PUT')];
    s.release(2);
    await expect(st).rejects.toBeInstanceOf(StorageTimeout);
    expect(seen.failures).toContain('tarball:timeout');
    expect(seen.retries).toEqual([]);
    await lim.drain().catch(() => undefined);
  });

  it('refuses a streaming write over the byte budget and drains its body', async () => {
    const s = new GatedStorage();
    const { seen, o } = observer();
    const lim = new WriteLimiter({ storage: s, maxStreamBytes: 100, observer: o });
    const first = lim.stream('tarball', 'a', Readable.from([Buffer.alloc(80)]), 'x', 80);
    const second = lim.stream('tarball', 'b', Readable.from([Buffer.alloc(80)]), 'x', 80);
    await expect(second).rejects.toBeInstanceOf(WriteDropped);
    expect(seen.dropped).toEqual(['tarball']);
    // One write is always admitted, however large; the budget frees when it settles.
    await tick();
    s.release();
    await first;
    const third = lim.stream('tarball', 'c', Readable.from([Buffer.alloc(500)]), 'x', 500);
    await tick();
    s.release();
    await third;
    expect(s.done).toEqual(['a', 'c']);
  });
});
