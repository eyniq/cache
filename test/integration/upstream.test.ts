import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/core/errors.ts';
import { createUpstream } from '../../src/core/upstream.ts';

let servers: Server[] = [];

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const srv = createServer(handler);
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) =>
      s.close(() => {
        resolve();
      }),
    );
  }
  servers = [];
});

const opts = { maxConnections: 4, timeoutMs: 2000 };

describe('upstream client', () => {
  it('forwards only allowlisted headers', async () => {
    let seen: IncomingMessage['headers'] = {};
    const origin = await serve((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const up = createUpstream({ url: origin, ...opts });
    const res = await up.request({
      path: '/x',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer secret',
        cookie: 'a=b',
        'x-forwarded-for': '1.2.3.4',
      },
    });
    expect(await text(res.body)).toBe('ok');
    expect(seen.accept).toBe('application/json');
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(seen['user-agent']).toMatch(/^eyniq-cache\//);
  });

  it('prefixes the base path of the upstream URL', async () => {
    let path = '';
    const origin = await serve((req, res) => {
      path = req.url ?? '';
      res.end();
    });
    const up = createUpstream({ url: `${origin}/registry`, ...opts });
    await text((await up.request({ path: '/lodash' })).body);
    expect(path).toBe('/registry/lodash');
  });

  it('follows at most two same-host redirects', async () => {
    const origin = await serve((req, res) => {
      const n = Number((req.url ?? '/0').slice(1));
      if (n < 5) {
        res.writeHead(302, { location: `/${n + 1}` });
        res.end();
      } else res.end('done');
    });
    const up = createUpstream({ url: origin, ...opts });
    const ok = await up.request({ path: '/3' });
    expect(await text(ok.body)).toBe('done');
    await expect(up.request({ path: '/0' })).rejects.toMatchObject({ status: 502 });
  });

  it('refuses redirects to another host', async () => {
    const other = await serve((_req, res) => res.end('should never be fetched'));
    const origin = await serve((_req, res) => {
      res.writeHead(301, { location: `${other}/x` });
      res.end();
    });
    const up = createUpstream({ url: origin, ...opts });
    const err = await up.request({ path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
  });

  it('times out slow upstreams with 504', async () => {
    const origin = await serve(() => {
      /* never answer */
    });
    const up = createUpstream({ url: origin, maxConnections: 2, timeoutMs: 200 });
    await expect(up.request({ path: '/slow' })).rejects.toMatchObject({ status: 504 });
  });

  it('maps connection failures to 502', async () => {
    const up = createUpstream({ url: 'http://127.0.0.1:1', ...opts });
    await expect(up.request({ path: '/x' })).rejects.toMatchObject({ status: 502 });
  });
});
