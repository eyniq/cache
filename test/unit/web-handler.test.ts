// C5: the web catalog handler's own guarantees, with fake dependencies: every answer (also an
// unexpected error) carries the security headers, and a sign-in body must arrive in time.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/core/request.ts';
import { createWebHandler, type WebHandlerDeps } from '../../src/web/handler.ts';
import { send } from '../helpers/http.ts';

let server: Server | null = null;

afterEach(async () => {
  const s = server;
  server = null;
  if (s) {
    await new Promise<void>((r) => {
      s.close(() => {
        r();
      });
    });
  }
});

async function start(over: Partial<WebHandlerDeps> = {}): Promise<string> {
  const deps = {
    config: { publicUrl: 'http://localhost', webUiImages: false, trustProxyHops: 0 },
    adapters: [{ id: 'npm', catalog: { isValidName: () => true } }],
    metadata: {
      lookup: () => Promise.reject(new Error('storage exploded')),
      blocksWholePackage: () => false,
    },
    search: { run: () => Promise.reject(new Error('search exploded')) },
    auth: { required: false, authenticate: () => Promise.resolve(null) },
    audit: { record: () => undefined },
    sessions: {
      maxAgeSeconds: 60,
      lookup: () => Promise.resolve(null),
      create: () => Promise.resolve('eyw_x'),
      delete: () => Promise.resolve(),
    },
    webLogin: { login: () => Promise.resolve(null) },
    authorize: () => Promise.resolve(),
    clientAddress: () => '127.0.0.1',
    loginBodyTimeoutMs: 200,
    ...over,
  } as unknown as WebHandlerDeps;
  const handler = createWebHandler(deps);
  server = createServer((req, res) => {
    const ctx: RequestContext = {
      cache: 'none',
      bytes: 0,
      path: (req.url ?? '/').split('?')[0] ?? '/',
      route: 'unknown',
      requestId: 'r',
    };
    handler(req, res, ctx).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      () => {
        // The server's generic answer: no security headers.
        if (!res.headersSent) res.writeHead(500).end('generic');
      },
    );
  });
  await new Promise<void>((r) =>
    server!.listen(0, '127.0.0.1', () => {
      r();
    }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('web catalog handler', () => {
  it('answers unexpected errors itself, with the security headers and no-store', async () => {
    const url = await start();
    const r = await send(url, { path: '/-/web/api/package/left-pad' });
    expect(r.status).toBe(500);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.toString()).not.toContain('exploded');
  });

  it('gives up on a sign-in body that does not arrive in time', async () => {
    const url = new URL(await start());
    const started = Date.now();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write(
          [
            'POST /-/web/login HTTP/1.1',
            'Host: localhost',
            'Origin: http://localhost',
            'Content-Type: application/x-www-form-urlencoded',
            'Content-Length: 100',
            '',
            'name=alice',
          ].join('\r\n'),
        );
      });
      let data = '';
      socket.on('data', (c: Buffer) => {
        data += c.toString();
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 3_000);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('passes the client address to the session lookup on logout', async () => {
    const seen: (string | undefined)[] = [];
    const url = await start({
      sessions: {
        maxAgeSeconds: 60,
        lookup: (_token: string, address?: () => string | undefined) => {
          seen.push(address?.());
          return Promise.resolve(null);
        },
        create: () => Promise.resolve('eyw_x'),
        delete: () => Promise.resolve(),
      },
    } as unknown as Partial<WebHandlerDeps>);
    const r = await send(url, {
      method: 'POST',
      path: '/-/web/logout',
      headers: {
        origin: 'http://localhost',
        cookie: `eyniq_web_session=eyw_${'a'.repeat(43)}`,
      },
    });
    expect(r.status).toBe(303);
    expect(seen).toEqual(['127.0.0.1']);
  });

  it('does not let slow sign-in bodies block sign-in for others', async () => {
    const url = new URL(await start({ loginBodyTimeoutMs: 5_000 }));
    // Each sends its headers and part of a 100-byte body, then waits.
    const slow = Array.from({ length: 20 }, () => rawLogin(url, 'name=', 100));
    try {
      await new Promise((r) => setTimeout(r, 200));
      const r = await send(url.origin, {
        method: 'POST',
        path: '/-/web/login',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'name=alice&password=wrong-password',
      });
      expect(r.status).toBe(303); // a failed sign-in, not 503
    } finally {
      for (const s of slow) s.destroy();
    }
  });

  it('still caps password checks in progress', async () => {
    const url = new URL(
      await start({
        webLogin: { login: () => new Promise(() => undefined) },
      } as unknown as Partial<WebHandlerDeps>),
    );
    const body = 'name=alice&password=wrong-password';
    const hanging = Array.from({ length: 16 }, () => rawLogin(url, body, body.length));
    try {
      await new Promise((r) => setTimeout(r, 200));
      const r = await send(url.origin, {
        method: 'POST',
        path: '/-/web/login',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      expect(r.status).toBe(503);
    } finally {
      for (const s of hanging) s.destroy();
    }
  });
});

/** A sign-in POST on a raw socket that sends `body` and declares `length` bytes. */
function rawLogin(url: URL, body: string, length: number): Socket {
  const socket = connect(Number(url.port), url.hostname, () => {
    socket.write(
      [
        'POST /-/web/login HTTP/1.1',
        'Host: localhost',
        'Origin: http://localhost',
        'Content-Type: application/x-www-form-urlencoded',
        `Content-Length: ${String(length)}`,
        '',
        body,
      ].join('\r\n'),
    );
  });
  socket.on('error', () => undefined);
  return socket;
}
