// Metadata processing is bounded (DESIGN.md section 11): when the worker pool's queue is full,
// a lookup that would need processing answers 503 with Retry-After instead of reading stored
// packuments or fetching upstream, and stored packuments are read only a few at a time.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import { loadConfig } from '../../src/config.ts';
import { StdoutAuditSink } from '../../src/core/audit.ts';
import type { Upstream } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';
import { InlineProcessor } from '../../src/metadata/processor.ts';
import { MetadataService } from '../../src/metadata/service.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { FsStorage } from '../../src/storage/fs.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-overload-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const docOf = (name: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      name,
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0', dist: { shasum: 'a'.repeat(40) } } },
      time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    }),
  );

/** FsStorage that counts packument reads and how many run at once. */
class CountingStorage extends FsStorage {
  reads = 0;
  active = 0;
  maxActive = 0;

  override async get(key: string): Promise<Readable | null> {
    if (!key.endsWith('.json.gz')) return super.get(key);
    this.reads++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 20));
    const body = await super.get(key);
    this.active--;
    return body;
  }
}

class Processor extends InlineProcessor {
  overloaded = false;
  refuse = false;

  override process(...args: Parameters<InlineProcessor['process']>) {
    if (this.refuse) {
      return Promise.reject(new HttpError(503, 'busy', { error: 'busy' }, { 'retry-after': '1' }));
    }
    return super.process(...args);
  }
}

async function setup(names: string[]) {
  const storage = new CountingStorage(root);
  const adapter = new NpmAdapter();
  const now = Date.now();
  for (const name of names) {
    await storage.put(adapter.metadataKey(name), Readable.from([gzipSync(docOf(name))]));
    await storage.put(
      `${adapter.metadataKey(name)}.meta`,
      Readable.from([Buffer.from(JSON.stringify({ fetchedAt: now, originFetchedAt: now }))]),
    );
  }
  let fetches = 0;
  adapter.fetchMetadata = (name: string) => {
    fetches++;
    return Promise.resolve({ status: 'ok', raw: { body: docOf(name), encoding: 'identity' } });
  };
  const processor = new Processor();
  const service = new MetadataService({
    upstreamFor: () => ({ origin: 'http://upstream.invalid' }) as Upstream,
    storage,
    policy: new MinReleaseAgePolicy({ minAgeMs: 0, failClosed: true, allowlist: [] }),
    audit: new StdoutAuditSink(),
    config: loadConfig({ PUBLIC_URL: 'http://cache.invalid', LOG_LEVEL: 'error' }),
    processor,
  });
  return { storage, adapter, processor, service, fetches: () => fetches };
}

describe('metadata processing overload', () => {
  it('answers 503 with Retry-After before any I/O while the processor is overloaded', async () => {
    const { storage, adapter, processor, service, fetches } = await setup(['stored']);
    processor.overloaded = true;
    for (const name of ['stored', 'unknown']) {
      const err = await service.lookup(adapter, name).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(503);
      expect((err as HttpError).headers['retry-after']).toBeDefined();
    }
    expect(storage.reads).toBe(0);
    expect(fetches()).toBe(0);
    processor.overloaded = false;
    expect((await service.lookup(adapter, 'stored')).entry).not.toBeNull();
  });

  it('does not turn a refused stored copy into an upstream fetch', async () => {
    const { adapter, processor, service, fetches } = await setup(['stored']);
    processor.refuse = true;
    await expect(service.lookup(adapter, 'stored')).rejects.toMatchObject({ status: 503 });
    expect(fetches()).toBe(0);
  });

  it('reads only a few stored packuments at once', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `pkg-${String(i)}`);
    const { storage, adapter, service, fetches } = await setup(names);
    const results = await Promise.all(names.map((n) => service.lookup(adapter, n)));
    expect(results.every((r) => r.entry !== null)).toBe(true);
    expect(fetches()).toBe(0);
    expect(storage.maxActive).toBeGreaterThan(1);
    expect(storage.maxActive).toBeLessThanOrEqual(16);
  });
});
