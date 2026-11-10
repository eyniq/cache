// C4: concurrent publishes of distinct versions of one package must all survive
// (compare-and-swap on the package document), also across several "pods" sharing storage.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NpmPrivateSource } from '../../src/adapters/npm/private-source.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { publishRequest } from '../helpers/publish.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('concurrent private publishes', () => {
  it('40 concurrent publishes of distinct versions on 4 pods lose no version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eyniq-private-conc-'));
    dirs.push(root);
    const pods = Array.from(
      { length: 4 },
      () =>
        new NpmPrivateSource({
          storage: new FsStorage(root),
          packages: ['@acme/*'],
          unpublishWindowMs: 0,
        }),
    );
    const versions = Array.from({ length: 40 }, (_, i) => `1.0.${i}`);
    const results = await Promise.allSettled(
      versions.map((v, i) =>
        pods[i % pods.length]!.publish(publishRequest('@acme/busy', v, { tags: {} }), {
          name: `ci-${i}`,
          claims: { via: 'user-token', readonly: false },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const got = await pods[0]!.getMetadata('@acme/busy', { maxBytes: 1 << 24 });
    if (got.status !== 'ok') throw new Error('package missing');
    const doc = JSON.parse(got.raw.body.toString()) as { versions: object; _rev: string };
    expect(Object.keys(doc.versions).sort()).toEqual([...versions].sort());
    expect(doc._rev.startsWith('40-')).toBe(true);
  });
});
