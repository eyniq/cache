// P6: extension routes under /-/eyniq/, routed before adapters, with declared auth, audit and
// metrics access, plus start/close lifecycle hooks awaited by listen() and close().
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AuthProvider,
  Authorizer,
  AuthorizationResource,
  Extension,
  ExtensionContext,
  ExtensionServices,
  Identity,
} from '../../src/core/contracts.ts';
import { createServer } from '../../src/http/server.ts';
import { json, send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

const tokenAuth = (required: boolean): AuthProvider => ({
  required,
  authenticate(req: IncomingMessage): Promise<Identity | null> {
    const h = req.headers.authorization;
    if (h === 'Bearer admin') return Promise.resolve({ name: 'root', groups: ['admins'] });
    if (h === 'Bearer user') return Promise.resolve({ name: 'user' });
    return Promise.resolve(null);
  },
});

function ext(
  prefix: string,
  auth: Extension['auth'],
  extra: Partial<Extension> = {},
): Extension & { seen: ExtensionContext[] } {
  const seen: ExtensionContext[] = [];
  return {
    prefix,
    auth,
    seen,
    handler(_req: IncomingMessage, res: ServerResponse, ctx: ExtensionContext) {
      seen.push(ctx);
      const body = JSON.stringify({ path: ctx.path, identity: ctx.identity?.name ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    },
    ...extra,
  };
}

const groupAdmins: Authorizer = {
  authorize: (identity, action) =>
    Promise.resolve(action !== 'admin' || identity?.groups?.includes('admins') === true),
};

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('P6: extension routes', () => {
  it('routes /-/eyniq/<name> to the extension before adapters', async () => {
    const hello = ext('/-/eyniq/hello', 'none');
    server = await startServer({ deps: { extensions: [hello] } });
    for (const path of ['/-/eyniq/hello', '/-/eyniq/hello/deep/path?x=1']) {
      const res = await send(server.url, { path, headers: { 'x-request-id': 'ext-1' } });
      expect(res.status).toBe(200);
      expect(json(res).path).toBe(path.split('?')[0]);
    }
    expect(hello.seen[0]?.requestId).toBe('ext-1');
    // Other names and lookalikes keep their old answers.
    expect((await send(server.url, { path: '/-/eyniq/helloworld' })).status).toBe(404);
    expect((await send(server.url, { path: '/-/eyniq/other' })).status).toBe(404);
    expect(server.upstream.requests).toHaveLength(0);
  });

  it('refuses prefixes outside /-/eyniq/ and duplicates', async () => {
    const base = await startServer();
    try {
      for (const prefix of ['/admin', '/-/eyniq/', '/-/eyniq/a/b', '/-/eyniq/UP', '/-/eyniq/..']) {
        expect(
          () => createServer({ ...base.deps, extensions: [ext(prefix, 'none')] }),
          prefix,
        ).toThrow(/extension prefix/);
      }
      expect(() =>
        createServer({
          ...base.deps,
          extensions: [ext('/-/eyniq/a', 'none'), ext('/-/eyniq/a', 'admin')],
        }),
      ).toThrow(/duplicate/);
    } finally {
      await base.close();
    }
  });

  it("serves auth 'none' routes even when registry auth is required", async () => {
    server = await startServer({
      deps: { auth: tokenAuth(true), extensions: [ext('/-/eyniq/login', 'none')] },
    });
    expect((await send(server.url, { path: '/-/eyniq/login' })).status).toBe(200);
    expect((await send(server.url, { path: '/lodash' })).status).toBe(401);
  });

  it("requires an identity for 'authenticated' routes", async () => {
    server = await startServer({
      deps: { auth: tokenAuth(false), extensions: [ext('/-/eyniq/me', 'authenticated')] },
    });
    expect((await send(server.url, { path: '/-/eyniq/me' })).status).toBe(401);
    const res = await send(server.url, {
      path: '/-/eyniq/me',
      headers: { authorization: 'Bearer user' },
    });
    expect(json(res).identity).toBe('user');
    expect(server.audit.ofType('auth.denied')[0]).toMatchObject({ path: '/-/eyniq/me' });
  });

  it("authorizes 'admin' routes with the admin action", async () => {
    const calls: AuthorizationResource[] = [];
    const authorizer: Authorizer = {
      authorize: (identity, action, resource) => {
        calls.push(resource);
        return groupAdmins.authorize(identity, action, resource);
      },
    };
    const admin = ext('/-/eyniq/admin', 'admin');
    server = await startServer({
      deps: { auth: tokenAuth(false), authorizer, extensions: [admin] },
    });
    expect((await send(server.url, { path: '/-/eyniq/admin' })).status).toBe(401);
    const user = await send(server.url, {
      path: '/-/eyniq/admin/x',
      headers: { authorization: 'Bearer user' },
    });
    expect(user.status).toBe(403);
    const root = await send(server.url, {
      path: '/-/eyniq/admin/x',
      headers: { authorization: 'Bearer admin' },
    });
    expect(root.status).toBe(200);
    expect(calls[0]).toEqual({ ecosystem: '*', route: 'extension', extension: '/-/eyniq/admin' });
    expect(server.audit.ofType('auth.forbidden')[0]).toMatchObject({ action: 'admin' });
  });

  it('keeps admin routes closed with the default authorizer', async () => {
    server = await startServer({
      deps: { auth: tokenAuth(false), extensions: [ext('/-/eyniq/admin', 'admin')] },
    });
    const res = await send(server.url, {
      path: '/-/eyniq/admin',
      headers: { authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(403);
  });

  it('gives handlers a stamped audit helper and maps thrown errors', async () => {
    const audited = ext('/-/eyniq/allowlist', 'admin', {
      handler(_req, res, ctx) {
        ctx.audit('admin.allowlist.add', { package: 'x', version: '1.0.0' });
        res.writeHead(204);
        res.end();
      },
    });
    const failing = ext('/-/eyniq/boom', 'none', {
      handler() {
        throw new Error('extension bug');
      },
    });
    server = await startServer({
      deps: {
        auth: tokenAuth(false),
        authorizer: groupAdmins,
        extensions: [audited, failing],
      },
    });
    await send(server.url, {
      path: '/-/eyniq/allowlist',
      headers: { authorization: 'Bearer admin', 'x-request-id': 'adm-1' },
    });
    const [event] = server.audit.ofType('admin.allowlist.add');
    expect(event).toMatchObject({ requestId: 'adm-1', identity: 'root', package: 'x' });
    expect(event?.at).toBeTypeOf('string');
    const boom = await send(server.url, { path: '/-/eyniq/boom' });
    expect(boom.status).toBe(500);
    expect(json(boom)).toEqual({ error: 'internal error' });
  });
});

describe('P6: lifecycle, metrics and management extensions', () => {
  it('awaits start before listening and close on shutdown; exposes the metrics registry', async () => {
    const events: string[] = [];
    let hits: { inc(labels?: Record<string, string>, by?: number): void } | null = null;
    const counted = ext('/-/eyniq/counted', 'none', {
      async start(services: ExtensionServices) {
        await new Promise((r) => setTimeout(r, 20));
        hits = services.metrics.counter('ext_hits_total', 'Hits on the test extension.');
        services.metrics.gauge('ext_ready', 'Test gauge.', () => 1);
        events.push('started');
      },
      handler(_req, res) {
        hits?.inc({ kind: 'test' });
        res.writeHead(204);
        res.end();
      },
      async close() {
        await new Promise((r) => setTimeout(r, 10));
        events.push('closed');
      },
    });
    server = await startServer({ deps: { extensions: [counted] } });
    expect(events).toEqual(['started']);
    await send(server.url, { path: '/-/eyniq/counted' });
    const metrics = (await send(server.managementUrl, { path: '/metrics' })).body.toString();
    expect(metrics).toContain('eyniq_cache_ext_hits_total{kind="test"} 1');
    expect(metrics).toContain('eyniq_cache_ext_ready 1');
    await server.close();
    server = null;
    expect(events).toEqual(['started', 'closed']);
  });

  it('rejects listen when an extension fails to start, closing the ones already started', async () => {
    const base = await startServer();
    const closed: string[] = [];
    const ok = ext('/-/eyniq/ok', 'none', {
      close() {
        closed.push('ok');
      },
    });
    const bad = ext('/-/eyniq/bad', 'none', {
      start() {
        throw new Error('no license');
      },
    });
    const app = createServer({ ...base.deps, extensions: [ok, bad] });
    try {
      await expect(app.listen(0, '127.0.0.1')).rejects.toThrow(/no license/);
      expect(closed).toEqual(['ok']);
      expect(app.server.listening).toBe(false);
    } finally {
      await app.close();
      await base.close();
    }
  });

  it('serves management extensions on the management port only', async () => {
    server = await startServer({
      deps: { managementExtensions: [ext('/-/eyniq/debug', 'none')] },
    });
    expect((await send(server.managementUrl, { path: '/-/eyniq/debug' })).status).toBe(200);
    expect((await send(server.url, { path: '/-/eyniq/debug' })).status).toBe(404);
    expect((await send(server.managementUrl, { path: '/livez' })).status).toBe(200);
  });
});
