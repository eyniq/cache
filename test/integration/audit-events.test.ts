// P5: open-ended audit events with time, request id and identity; request ids on every
// request; artifact.served only for sinks that ask for it; policy.allowlisted on download.
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, AuditSink } from '../../src/core/contracts.ts';
import { StdoutAuditSink } from '../../src/core/audit.ts';
import { captureLogs } from '../../src/core/log.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const NOW = Date.now();
const DAY = 86_400_000;

class WantsServed implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
  wants(type: string): boolean {
    return type === 'artifact.served';
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('P5: request ids', () => {
  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    server = await startServer();
    const echoed = await send(server.url, {
      path: '/-/ping',
      headers: { 'x-request-id': 'ci-run-42.step:7' },
    });
    expect(echoed.headers['x-request-id']).toBe('ci-run-42.step:7');
    for (const bad of ['x'.repeat(200), 'has space', 'quote"']) {
      const res = await send(server.url, { path: '/-/ping', headers: { 'x-request-id': bad } });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    const fresh = await send(server.url, { path: '/-/ping' });
    expect(fresh.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs the request id with every request line', async () => {
    server = await startServer({ env: { LOG_LEVEL: 'info' } });
    const logs = captureLogs();
    try {
      await send(server.url, { path: '/-/ping', headers: { 'x-request-id': 'trace-1' } });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      logs.restore();
    }
    expect(logs.lines.find((l) => l.msg === 'request')).toMatchObject({ requestId: 'trace-1' });
  });
});

describe('P5: audit events', () => {
  it('stamps events with time, request id and path', async () => {
    server = await startServer({
      deps: {
        auth: { required: true, authenticate: () => Promise.resolve(null) },
      },
    });
    await send(server.url, { path: '/lodash', headers: { 'x-request-id': 'req-9' } });
    const [denied] = server.audit.ofType('auth.denied');
    expect(denied).toMatchObject({ type: 'auth.denied', requestId: 'req-9', path: '/lodash' });
    expect(denied?.at).toMatch(ISO);
  });

  it('emits artifact.served only to sinks that want it', async () => {
    server = await startServer();
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    await send(server.url, { path: '/lodash/-/lodash-4.17.21.tgz' });
    expect(server.audit.ofType('artifact.served')).toHaveLength(0);
    await server.close();

    const sink = new WantsServed();
    server = await startServer({ deps: { audit: sink } });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    for (let i = 0; i < 2; i++) {
      await send(server.url, {
        path: '/lodash/-/lodash-4.17.21.tgz',
        headers: { 'x-request-id': `dl-${i}` },
      });
    }
    await send(server.url, { method: 'HEAD', path: '/lodash/-/lodash-4.17.21.tgz' });
    await new Promise((r) => setTimeout(r, 20));
    const served = sink.events.filter((e) => e.type === 'artifact.served');
    expect(served).toHaveLength(2);
    expect(served[0]).toMatchObject({
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.21',
      file: 'lodash-4.17.21.tgz',
      cache: 'miss',
      requestId: 'dl-0',
    });
    expect(served[1]).toMatchObject({ cache: 'hit', requestId: 'dl-1' });
    expect(served[0]?.bytes).toBeGreaterThan(0);
  });

  it('records policy.allowlisted when an allowlisted version is downloaded', async () => {
    const policy = new MinReleaseAgePolicy({
      minAgeMs: 3 * DAY,
      failClosed: true,
      allowlist: [{ package: 'fresh', version: '1.0.0', reason: 'hotfix', expires: NOW + DAY }],
    });
    server = await startServer({ deps: { policy } });
    server.upstream.addPackage('fresh', [
      { version: '1.0.0', publishedAt: new Date(NOW - 1000).toISOString() },
    ]);
    expect((await send(server.url, { path: '/fresh/-/fresh-1.0.0.tgz' })).status).toBe(200);
    expect(server.audit.ofType('policy.allowlisted')[0]).toMatchObject({
      ecosystem: 'npm',
      name: 'fresh',
      version: '1.0.0',
      reason: 'allowlisted: hotfix',
    });
  });

  it('writes stdout audit lines without a duplicate time field', () => {
    const logs = captureLogs();
    try {
      new StdoutAuditSink().record({
        type: 'admin.allowlist.add',
        at: new Date().toISOString(),
        requestId: 'r-1',
        identity: 'alice',
        package: 'x',
      });
    } finally {
      logs.restore();
    }
    expect(logs.lines[0]).toEqual({
      time: expect.stringMatching(ISO) as unknown,
      level: 'info',
      msg: 'audit',
      type: 'admin.allowlist.add',
      requestId: 'r-1',
      identity: 'alice',
      package: 'x',
    });
  });
});
