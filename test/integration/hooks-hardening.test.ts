// Review follow-ups for P4-P6: fault isolation and validation around the new hooks.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvent, StdoutAuditSink } from '../../src/core/audit.ts';
import type { Extension, Policy, PolicyDecision } from '../../src/core/contracts.ts';
import { captureLogs } from '../../src/core/log.ts';
import { createServer } from '../../src/http/server.ts';
import { Metrics } from '../../src/http/metrics.ts';
import { composePolicies } from '../../src/policy/compose.ts';
import { json, send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const noContent = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(204);
  res.end();
};

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('extension validation and lifecycle', () => {
  it('refuses an unknown auth value instead of downgrading an admin route', async () => {
    const base = await startServer();
    try {
      const bad = {
        prefix: '/-/eyniq/x',
        auth: 'Admin',
        handler: noContent,
      } as unknown as Extension;
      expect(() => createServer({ ...base.deps, extensions: [bad] })).toThrow(/invalid auth/);
    } finally {
      await base.close();
    }
  });

  it('keeps open routes up when the auth provider throws', async () => {
    server = await startServer({
      deps: {
        auth: { required: true, authenticate: () => Promise.reject(new Error('idp down')) },
        extensions: [{ prefix: '/-/eyniq/login', auth: 'none', handler: noContent }],
      },
    });
    expect((await send(server.url, { path: '/-/eyniq/login' })).status).toBe(204);
  });

  it('starts extensions on listenManagement too, and waits for a slow start on close', async () => {
    const base = await startServer();
    const events: string[] = [];
    const slow: Extension = {
      prefix: '/-/eyniq/slow',
      auth: 'none',
      handler: noContent,
      async start() {
        await new Promise((r) => setTimeout(r, 50));
        events.push('started');
      },
      close() {
        events.push('closed');
      },
    };
    const app = createServer({ ...base.deps, extensions: [slow] });
    const listening = app.listenManagement(0, '127.0.0.1');
    const closing = app.close();
    await listening.catch(() => undefined);
    await closing;
    expect(events).toEqual(['started', 'closed']);
    await base.close();
  });

  it('survives a throwing audit sink on the artifact.served path', async () => {
    server = await startServer({
      deps: {
        audit: {
          record: () => {
            throw new Error('sink broken');
          },
          wants: () => true,
        },
      },
    });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(server.url, { path: '/lodash/-/lodash-4.17.21.tgz' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await send(server.url, { path: '/-/ping' })).status).toBe(200);
  });
});

describe('metrics registry for extensions', () => {
  it('rejects invalid, reserved and duplicate names', () => {
    const m = new Metrics();
    for (const name of ['Bad', 'x-y', 'http_requests_total', 'thing_count', 'thing_bucket']) {
      expect(() => m.counter(name, 'h'), name).toThrow();
    }
    m.counter('ok_total', 'h');
    expect(() => {
      m.gauge('ok_total', 'h', () => 1);
    }).toThrow(/already registered/);
  });

  it('bounds series, ignores bad increments and survives a failing gauge', () => {
    const m = new Metrics();
    const c = m.counter('ext_total', 'multi\nline help');
    for (let i = 0; i < 1500; i++) c.inc({ id: String(i) });
    c.inc({}, -5);
    c.inc({}, Number.NaN);
    c.inc({ 'bad key': 'x' });
    m.gauge('ext_broken', 'h', () => {
      throw new Error('boom');
    });
    const out = m.render();
    expect(out.match(/^eyniq_cache_ext_total\{id=/gm)).toHaveLength(1000);
    expect(out).toContain('# HELP eyniq_cache_ext_total multi line help');
    // Over the cap, further series (here the one left after dropping the bad label) are ignored.
    expect(out).not.toContain('bad key');
    expect(out).not.toMatch(/^eyniq_cache_ext_total -|NaN/m);
    expect(out).toContain('# TYPE eyniq_cache_ext_broken gauge');
  });
});

describe('audit stamping', () => {
  it('never lets fields override type, at or the log envelope', () => {
    const e = auditEvent('admin.x', { type: 'forged', at: 'yesterday', msg: 'not audit' });
    expect(e.type).toBe('admin.x');
    expect(e.at).not.toBe('yesterday');
    const logs = captureLogs();
    try {
      new StdoutAuditSink().record(e);
    } finally {
      logs.restore();
    }
    expect(logs.lines[0]).toMatchObject({ msg: 'audit', level: 'info', type: 'admin.x' });
  });
});

describe('policy composition and revision', () => {
  it('names the allowlist reason when a later member allowlisted the version', () => {
    const p = composePolicies(
      { evaluate: () => ({ allow: true, reason: 'no advisories' }) },
      { evaluate: () => ({ allow: true, reason: 'allowlisted: hotfix', allowlisted: true }) },
    );
    expect(
      p.evaluate({ ecosystem: 'npm', name: 'x', version: '1.0.0', publishedAt: 0, now: 1 }),
    ).toEqual({ allow: true, reason: 'allowlisted: hotfix', allowlisted: true });
  });

  it('re-filters on revalidation when only the revision changed (no onChange)', async () => {
    let denied = false;
    const policy: Policy & { revision: number } = {
      revision: 0,
      evaluate(input): PolicyDecision {
        return denied && input.version === '1.1.0'
          ? { allow: false, reason: 'denied' }
          : { allow: true };
      },
    };
    server = await startServer({ deps: { policy }, env: { METADATA_TTL: '1s' } });
    server.upstream.addPackage('pkg', [{ version: '1.0.0' }, { version: '1.1.0' }]);
    expect(Object.keys(json(await send(server.url, { path: '/pkg' })).versions as object)).toEqual([
      '1.0.0',
      '1.1.0',
    ]);
    denied = true;
    policy.revision = 1;
    // Within the TTL the cached decision stands (no policy call on the hot path) ...
    expect(Object.keys(json(await send(server.url, { path: '/pkg' })).versions as object)).toEqual([
      '1.0.0',
      '1.1.0',
    ]);
    await new Promise((r) => setTimeout(r, 1100));
    // ... and the next revalidation (an upstream 304) picks up the new revision.
    expect(Object.keys(json(await send(server.url, { path: '/pkg' })).versions as object)).toEqual([
      '1.0.0',
    ]);
  });
});
