import { afterEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import type { EcosystemAdapter, ProcessContext } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';
import { WorkerPool } from '../../src/metadata/worker-pool.ts';
import { makeTarball, sha512Integrity } from '../helpers/tarball.ts';

const ctx: ProcessContext = {
  name: 'lodash',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 1024 * 1024,
  options: {},
};

const doc = {
  name: 'lodash',
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { name: 'lodash', version: '1.0.0', dist: { shasum: 'a'.repeat(40) } } },
  time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
};
const raw = { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' as const };

let pool: WorkerPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe('WorkerPool', () => {
  it('parses write bodies off the main thread and returns Buffers (P3)', async () => {
    const adapter = new NpmAdapter();
    pool = new WorkerPool({ size: 1 });
    const tgz = makeTarball({ 'package.json': '{}' });
    const body = Buffer.from(
      JSON.stringify({
        name: 'pkg',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': { name: 'pkg', version: '1.0.0', dist: { integrity: sha512Integrity(tgz) } },
        },
        _attachments: { 'pkg-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length } },
      }),
    );
    const viaWorker = await pool.parseWriteBody(adapter, { kind: 'publish', name: 'pkg' }, body);
    expect(viaWorker.type).toBe('publish');
    if (viaWorker.type !== 'publish') return;
    const data = viaWorker.request.versions[0]?.artifact.data;
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data?.equals(tgz)).toBe(true);
    expect(viaWorker).toEqual(adapter.parseWriteBody({ kind: 'publish', name: 'pkg' }, body));
    await expect(
      pool.parseWriteBody(adapter, { kind: 'publish', name: 'other' }, body),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('produces the same result as inline processing', async () => {
    const adapter = new NpmAdapter();
    pool = new WorkerPool({ size: 2 });
    const viaWorker = await pool.process(adapter, raw, ctx);
    const inline = adapter.processMetadata(raw, ctx);
    expect(viaWorker.versions).toEqual(inline.versions);
    expect(viaWorker.digest).toBe(inline.digest);
    const out = adapter.renderMetadata({
      processed: viaWorker,
      allowed: new Set(['1.0.0']),
      view: 'full',
    });
    expect(out.status).toBe(200);
  });

  it('keeps the HTTP status of errors thrown in the worker', async () => {
    pool = new WorkerPool({ size: 1 });
    const err = await pool
      .process(new NpmAdapter(), { body: Buffer.from('{nope'), encoding: 'identity' }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
  });

  it('processes many documents concurrently and reports queue length', async () => {
    pool = new WorkerPool({ size: 2 });
    const adapter = new NpmAdapter();
    const jobs = Array.from({ length: 20 }, () => pool!.process(adapter, raw, ctx));
    expect(pool.queueLength).toBeGreaterThan(0);
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(20);
    expect(pool.queueLength).toBe(0);
  });

  it('replaces a worker that dies and fails only its own task', async () => {
    pool = new WorkerPool({ size: 1 });
    const crashing = {
      processorModule: new URL('../fixtures/crash-processor.ts', import.meta.url).href,
    } as unknown as EcosystemAdapter;
    const err = await pool
      .process(crashing, { body: Buffer.from('exit'), encoding: 'identity' }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const ok = await pool.process(new NpmAdapter(), raw, ctx);
    expect(ok.name).toBe('lodash');
  });

  it('replaces a worker once it has processed recycleBytes, without failing jobs', async () => {
    pool = new WorkerPool({ size: 1, recycleBytes: raw.body.length * 2 });
    const adapter = new NpmAdapter();
    for (let i = 0; i < 6; i++) {
      const out = await pool.process(adapter, raw, ctx);
      expect(out.name).toBe('lodash');
    }
    expect(pool.recycles).toBe(3);
  });

  it('recycles without the crash backoff, so a busy pool keeps its pace', async () => {
    // A recycle after every job: with the crash backoff (50 ms doubling) 12 jobs would take
    // minutes and time out.
    pool = new WorkerPool({ size: 1, recycleBytes: 1 });
    const adapter = new NpmAdapter();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pool!.process(adapter, raw, ctx)),
    );
    expect(results).toHaveLength(12);
    expect(pool.recycles).toBe(12);
  });

  it('never recycles with recycleBytes 0', async () => {
    pool = new WorkerPool({ size: 1, recycleBytes: 0 });
    const adapter = new NpmAdapter();
    for (let i = 0; i < 5; i++) await pool.process(adapter, raw, ctx);
    expect(pool.recycles).toBe(0);
  });

  it('reports the heap and external memory of its workers', async () => {
    pool = new WorkerPool({ size: 2 });
    await pool.process(new NpmAdapter(), raw, ctx);
    const bytes = await pool.refreshHeap();
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(pool.heapBytes).toBe(bytes);
  });

  it('settles queued and in-flight jobs when it closes', async () => {
    const closing = new WorkerPool({ size: 1 });
    const adapter = new NpmAdapter();
    const jobs = Array.from({ length: 4 }, () =>
      closing.process(adapter, raw, ctx).catch((e: unknown) => e),
    );
    await closing.close();
    const results = await Promise.all(jobs);
    const refused = results.filter((r) => r instanceof HttpError && r.status === 503);
    expect(refused.length).toBeGreaterThan(0);
    await expect(closing.process(adapter, raw, ctx)).rejects.toMatchObject({ status: 503 });
  });

  describe('queued byte limit (maxQueuedBytes)', () => {
    it('refuses work beyond the limit with 503 and Retry-After, and accepts it again later', async () => {
      pool = new WorkerPool({ size: 1, maxQueuedBytes: raw.body.length * 2 });
      const adapter = new NpmAdapter();
      const first = pool.process(adapter, raw, ctx);
      const second = pool.process(adapter, raw, ctx);
      expect(pool.overloaded).toBe(true);
      const err = await pool.process(adapter, raw, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(503);
      expect((err as HttpError).headers['retry-after']).toBe('1');
      // Write bodies share the budget.
      await expect(
        pool.parseWriteBody(adapter, { kind: 'publish', name: 'pkg' }, Buffer.from('{}')),
      ).rejects.toMatchObject({ status: 503 });
      await Promise.all([first, second]);
      expect(pool.queuedBytes).toBe(0);
      expect(pool.overloaded).toBe(false);
      await expect(pool.process(adapter, raw, ctx)).resolves.toBeDefined();
    });

    it('always takes one document when idle, even above the limit', async () => {
      pool = new WorkerPool({ size: 1, maxQueuedBytes: 1 });
      await expect(pool.process(new NpmAdapter(), raw, ctx)).resolves.toBeDefined();
    });

    it('has no limit by default (library use) and with 0', async () => {
      pool = new WorkerPool({ size: 1, maxQueuedBytes: 0 });
      const adapter = new NpmAdapter();
      const jobs = Array.from({ length: 10 }, () => pool!.process(adapter, raw, ctx));
      expect(pool.overloaded).toBe(false);
      await expect(Promise.all(jobs)).resolves.toHaveLength(10);
    });
  });
});
