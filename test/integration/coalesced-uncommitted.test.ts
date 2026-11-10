import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStorage } from '../../src/storage/fs.ts';
import { send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

/** Tarball writes (content-addressed keys) fail after a delay, so concurrent requests coalesce. */
class FailingTarballStorage extends FsStorage {
  tarballPuts = 0;

  override async put(key: string, body: Readable): Promise<void> {
    if (/[0-9a-f]{64,}$/.test(key)) {
      this.tarballPuts++;
      body.resume();
      await sleep(150);
      throw new Error('disk full');
    }
    return super.put(key, body);
  }
}

describe('coalesced artifact waiters when the leader does not commit', () => {
  let server: TestServer | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
    server = null;
    root = null;
  });

  it('fetches the artifact for every waiter instead of answering 502', async () => {
    root = await mkdtemp(join(tmpdir(), 'eyniq-coalesced-'));
    const storage = new FailingTarballStorage(root);
    server = await startServer({ deps: { storage } });
    server.upstream.addPackage('lodash', [{ version: '1.0.0' }]);
    const path = '/lodash/-/lodash-1.0.0.tgz';
    const all = await Promise.all(Array.from({ length: 5 }, () => send(server!.url, { path })));
    const expected = all[0]?.body;
    for (const r of all) {
      expect(r.status).toBe(200);
      expect(r.aborted).toBe(false);
      expect(r.body.equals(expected ?? Buffer.alloc(0))).toBe(true);
    }
    // The waiters fetched for themselves after the leader's write failed.
    expect(storage.tarballPuts).toBeGreaterThan(1);
  });
});
