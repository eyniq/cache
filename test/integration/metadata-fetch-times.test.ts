import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/server.ts';

describe('CacheServer.metadataFetchTimes', () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('reports when a packument was fetched without asking upstream, and null for unknown names', async () => {
    srv = await startServer();
    srv.upstream.addPackage('fetch-times', [{ version: '1.0.0' }]);
    const adapter = srv.deps.adapters[0];
    if (!adapter) throw new Error('no adapter');
    expect(await srv.app.metadataFetchTimes(adapter, 'fetch-times')).toBeNull();
    const before = Date.now();
    const res = await fetch(`${srv.url}/fetch-times`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await srv.app.drain();
    const upstreamCalls = srv.upstream.countPath('/fetch-times');
    const times = await srv.app.metadataFetchTimes(adapter, 'fetch-times');
    expect(times?.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(times?.originFetchedAt).toBeGreaterThanOrEqual(before);
    expect(srv.upstream.countPath('/fetch-times')).toBe(upstreamCalls);
    expect(await srv.app.metadataFetchTimes(adapter, 'never-seen')).toBeNull();
  });
});
