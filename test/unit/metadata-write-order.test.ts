// A slow background write of an older packument must not land after a tombstone (which would
// let a removed package come back during an upstream outage).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import { loadConfig } from '../../src/config.ts';
import { StdoutAuditSink } from '../../src/core/audit.ts';
import type { MetadataFetchResult, Upstream } from '../../src/core/contracts.ts';
import { InlineProcessor } from '../../src/metadata/processor.ts';
import { MetadataService } from '../../src/metadata/service.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { FsStorage } from '../../src/storage/fs.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-order-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** FsStorage whose first write of the raw packument takes a while. */
class SlowFirstWrite extends FsStorage {
  private slowed = false;

  override async put(key: string, body: Readable): Promise<void> {
    if (!this.slowed && key.endsWith('.json.gz')) {
      this.slowed = true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return super.put(key, body);
  }
}

describe('background metadata writes', () => {
  it('apply in call order, so a tombstone is never overwritten by an older write', async () => {
    const storage = new SlowFirstWrite(root);
    const adapter = new NpmAdapter();
    const doc = {
      name: 'gone',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'gone', version: '1.0.0', dist: { shasum: 'a'.repeat(40) } } },
      time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    };
    const answers: MetadataFetchResult[] = [
      { status: 'ok', raw: { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' } },
      { status: 'not-found' },
    ];
    adapter.fetchMetadata = () => Promise.resolve(answers.shift() ?? { status: 'not-found' });
    const service = new MetadataService({
      upstreamFor: () => ({ origin: 'http://upstream.invalid' }) as Upstream,
      storage,
      policy: new MinReleaseAgePolicy({ minAgeMs: 0, failClosed: true, allowlist: [] }),
      audit: new StdoutAuditSink(),
      config: loadConfig({
        PUBLIC_URL: 'http://cache.invalid',
        METADATA_TTL: '0',
        LOG_LEVEL: 'error',
      }),
      processor: new InlineProcessor(),
    });

    expect((await service.lookup(adapter, 'gone')).entry).not.toBeNull(); // slow persist queued
    expect((await service.lookup(adapter, 'gone')).entry).toBeNull(); // upstream 404: tombstone
    await service.drain();

    const stored = await storage.get(adapter.metadataKey('gone'));
    expect(gunzipSync(await buffer(stored!)).toString()).toContain('tombstone');
  });
});
