// P2: the authorization hook. Every registry route is authorized after authentication;
// the community default keeps today's behaviour for reads and refuses writes and admin.
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultAuthorizer } from '../../src/auth/authorizer.ts';
import { NoAuth } from '../../src/auth/none.ts';
import { HttpError } from '../../src/core/errors.ts';
import { captureLogs } from '../../src/core/log.ts';
import type {
  AuthorizationAction,
  AuthorizationResource,
  AuthProvider,
  Authorizer,
  Identity,
} from '../../src/core/contracts.ts';
import { json, send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

interface Call {
  identity: Identity | null;
  action: AuthorizationAction;
  resource: AuthorizationResource;
}

class RecordingAuthorizer implements Authorizer {
  readonly calls: Call[] = [];
  allow: (call: Call) => boolean = () => true;

  authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    const call = { identity, action, resource };
    this.calls.push(call);
    return Promise.resolve(this.allow(call));
  }
}

/** Token "dev" yields an identity with groups; `required` decides if anonymous is allowed. */
class DevTokenAuth implements AuthProvider {
  readonly required: boolean;

  constructor(required: boolean) {
    this.required = required;
  }

  authenticate(req: IncomingMessage): Promise<Identity | null> {
    if (req.headers.authorization !== 'Bearer dev') return Promise.resolve(null);
    return Promise.resolve({ name: 'dev', groups: ['frontend'], claims: { sub: 'u-1' } });
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('P2: authorization hook', () => {
  it('authorizes metadata, artifact and pass-through routes as read with the resource', async () => {
    const authorizer = new RecordingAuthorizer();
    server = await startServer({ deps: { authorizer } });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(server.url, { path: '/lodash' })).status).toBe(200);
    expect((await send(server.url, { path: '/npm/lodash/4.17.21' })).status).toBe(200);
    expect((await send(server.url, { path: '/lodash/-/lodash-4.17.21.tgz' })).status).toBe(200);
    expect((await send(server.url, { path: '/-/v1/search?text=x' })).status).toBe(502); // the fake upstream has no search
    const meta = { ecosystem: 'npm', route: 'metadata', name: 'lodash' };
    expect(authorizer.calls).toEqual([
      { identity: null, action: 'read', resource: meta },
      { identity: null, action: 'read', resource: meta },
      {
        identity: null,
        action: 'read',
        resource: {
          ecosystem: 'npm',
          route: 'artifact',
          name: 'lodash',
          file: 'lodash-4.17.21.tgz',
        },
      },
      { identity: null, action: 'read', resource: { ecosystem: 'npm', route: 'passthrough' } },
    ]);
  });

  it('answers 403 JSON and records an audit event on deny, without contacting upstream', async () => {
    const authorizer = new RecordingAuthorizer();
    authorizer.allow = (c) => c.resource.name !== 'secret';
    server = await startServer({ deps: { authorizer, auth: new DevTokenAuth(false) } });
    server.upstream.addPackage('secret', [{ version: '1.0.0' }]);
    for (const path of ['/secret', '/secret/-/secret-1.0.0.tgz', '/npm/secret']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await send(server.url, {
          method,
          path,
          headers: { authorization: 'Bearer dev' },
        });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.headers['content-type']).toBe('application/json');
        if (method === 'GET') expect(json(res)).toEqual({ error: 'forbidden' });
      }
    }
    expect(server.upstream.requests).toHaveLength(0);
    expect(server.audit.ofType('auth.forbidden')[0]).toMatchObject({
      type: 'auth.forbidden',
      path: '/secret',
      action: 'read',
      ecosystem: 'npm',
      name: 'secret',
      identity: 'dev',
    });
  });

  it('passes groups and claims through, and optional identities when auth is not required', async () => {
    const authorizer = new RecordingAuthorizer();
    server = await startServer({ deps: { authorizer, auth: new DevTokenAuth(false) } });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    await send(server.url, { path: '/lodash', headers: { authorization: 'Bearer dev' } });
    await send(server.url, { path: '/lodash' });
    expect(authorizer.calls.map((c) => c.identity)).toEqual([
      { name: 'dev', groups: ['frontend'], claims: { sub: 'u-1' } },
      null,
    ]);
  });

  it('returns 401 before authorizing when authentication is required', async () => {
    const authorizer = new RecordingAuthorizer();
    server = await startServer({ deps: { authorizer, auth: new DevTokenAuth(true) } });
    const res = await send(server.url, { path: '/lodash' });
    expect(res.status).toBe(401);
    expect(authorizer.calls).toHaveLength(0);
  });

  it('does not authorize ping, whoami or rejected paths', async () => {
    const authorizer = new RecordingAuthorizer();
    authorizer.allow = () => false;
    server = await startServer({ deps: { authorizer } });
    expect((await send(server.url, { path: '/-/ping' })).status).toBe(200);
    expect((await send(server.url, { path: '/-/whoami' })).status).toBe(401);
    expect((await send(server.url, { path: '/%2e%2e/x' })).status).toBe(400);
    expect(authorizer.calls).toHaveLength(0);
  });

  it('allows only a literal true', async () => {
    server = await startServer({
      deps: {
        authorizer: {
          authorize: () => Promise.resolve('yes' as unknown as boolean),
        },
      },
    });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(server.url, { path: '/lodash' })).status).toBe(403);
  });

  it('fails closed (503) when the authorizer hangs', async () => {
    server = await startServer({
      deps: { authorizer: { authorize: () => new Promise<boolean>(() => undefined) } },
      options: { authorizeTimeoutMs: 100 },
    });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    const res = await send(server.url, { path: '/lodash' });
    expect(res.status).toBe(503);
    expect(server.upstream.requests).toHaveLength(0);
  });

  it('does not call the auth provider for ping when auth is optional', async () => {
    let calls = 0;
    server = await startServer({
      deps: {
        auth: {
          required: false,
          authenticate: () => {
            calls++;
            return Promise.resolve(null);
          },
        },
      },
    });
    expect((await send(server.url, { path: '/-/ping' })).status).toBe(200);
    expect(calls).toBe(0);
  });

  it('fails closed when the authorizer throws', async () => {
    server = await startServer({
      deps: {
        authorizer: {
          authorize: () => Promise.reject(new Error('directory down')),
        },
      },
    });
    server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(server.url, { path: '/lodash' })).status).toBe(500);
    expect(server.upstream.requests).toHaveLength(0);
  });

  it('treats a 403 thrown by the authorizer as a refusal: its message, an audit event, no error log', async () => {
    const logs = captureLogs();
    try {
      server = await startServer({
        deps: {
          auth: new DevTokenAuth(false),
          authorizer: {
            authorize: () => Promise.reject(new HttpError(403, 'licence user limit reached')),
          },
        },
      });
      server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      const res = await send(server.url, {
        path: '/lodash',
        headers: { authorization: 'Bearer dev' },
      });
      expect(res.status).toBe(403);
      expect(json(res)).toEqual({ error: 'licence user limit reached' });
      expect(server.upstream.requests).toHaveLength(0);
      expect(server.audit.ofType('auth.forbidden')[0]).toMatchObject({
        type: 'auth.forbidden',
        path: '/lodash',
        action: 'read',
        reason: 'licence user limit reached',
        identity: 'dev',
      });
      expect(JSON.stringify(logs.lines)).not.toMatch(/authorizer failed/);
    } finally {
      logs.restore();
    }
  });

  it('still logs and fails closed for other errors thrown by the authorizer', async () => {
    const logs = captureLogs();
    try {
      server = await startServer({
        deps: {
          authorizer: { authorize: () => Promise.reject(new HttpError(500, 'boom')) },
        },
      });
      server.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      expect((await send(server.url, { path: '/lodash' })).status).toBe(500);
      expect(server.audit.ofType('auth.forbidden')).toHaveLength(0);
      expect(JSON.stringify(logs.lines)).toMatch(/authorizer failed/);
    } finally {
      logs.restore();
    }
  });
});

describe('P2: DefaultAuthorizer', () => {
  const someone: Identity = { name: 'ci' };
  const resource = { ecosystem: 'npm', route: 'metadata', name: 'x' };

  it('allows reads when authentication is not required, or for any identity', async () => {
    const open = new DefaultAuthorizer(new NoAuth());
    expect(await open.authorize(null, 'read', resource)).toBe(true);
    const closed = new DefaultAuthorizer(new DevTokenAuth(true));
    expect(await closed.authorize(null, 'read', resource)).toBe(false);
    expect(await closed.authorize(someone, 'read', resource)).toBe(true);
  });

  it('refuses publish and admin: the community edition has no write or admin roles', async () => {
    for (const auth of [new NoAuth(), new DevTokenAuth(true)]) {
      const authorizer = new DefaultAuthorizer(auth);
      for (const action of ['publish', 'admin'] as const) {
        expect(await authorizer.authorize(someone, action, resource)).toBe(false);
        expect(await authorizer.authorize(null, action, resource)).toBe(false);
      }
    }
  });
});
