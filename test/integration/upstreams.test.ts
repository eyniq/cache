// P8: per-adapter upstreams. ServerDeps.upstreams maps an adapter id to its own upstream;
// adapters without an entry use ServerDeps.upstream.
import { afterEach, describe, expect, it } from 'vitest';
import { createUpstream, type ClosableUpstream } from '../../src/core/upstream.ts';
import { FakeUpstream } from '../../src/testing/fake-upstream.ts';
import { send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

let server: TestServer | null = null;
let other: FakeUpstream | null = null;
let client: ClosableUpstream | null = null;

afterEach(async () => {
  await server?.close();
  client?.close();
  await other?.stop();
  server = null;
  client = null;
  other = null;
});

describe('P8: per-adapter upstreams', () => {
  it('routes metadata, artifacts and pass-through of an adapter to its own upstream', async () => {
    other = new FakeUpstream();
    await other.start();
    other.addPackage('lodash', [{ version: '4.17.21' }]);
    other.hook = (req, res) => {
      if (!req.url?.startsWith('/-/v1/search')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"objects":[]}');
      return true;
    };
    client = createUpstream({ url: other.origin, maxConnections: 4, timeoutMs: 5000 });
    server = await startServer({ deps: { upstreams: { npm: client } } });

    expect((await send(server.url, { path: '/lodash' })).status).toBe(200);
    expect((await send(server.url, { path: '/lodash/-/lodash-4.17.21.tgz' })).status).toBe(200);
    expect((await send(server.url, { path: '/-/v1/search?text=x' })).status).toBe(200);
    expect(other.countPath('/lodash')).toBe(1);
    expect(other.count((r) => r.path.endsWith('.tgz'))).toBe(1);
    expect(other.count((r) => r.path.startsWith('/-/v1/search'))).toBe(1);
    // The default upstream is never asked for this adapter.
    expect(server.upstream.requests).toHaveLength(0);
    const metrics = (await send(server.managementUrl, { path: '/metrics' })).body.toString();
    expect(metrics).toMatch(/eyniq_cache_upstream_requests_total\{method="GET"\} 3/);
  });

  it('falls back to the default upstream for adapters without an entry', async () => {
    server = await startServer({
      deps: {
        upstreams: { pypi: { origin: 'x', request: () => Promise.reject(new Error('unused')) } },
      },
    });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(server.url, { path: '/lodash' })).status).toBe(200);
    expect(server.upstream.countPath('/lodash')).toBe(1);
  });
});
