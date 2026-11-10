// P3: the default-off write path. A PackageSource owns names that must never be fetched from
// upstream (dependency confusion); without one every write stays a 405 as before.
import type { IncomingMessage } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import { DefaultAuthorizer } from '../../src/auth/authorizer.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import type { AuthProvider, Authorizer, Identity, Policy } from '../../src/core/contracts.ts';
import { makeTarball, sha512Integrity } from '../helpers/tarball.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';
import { MemorySource } from '../helpers/memory-source.ts';
import { startServer, type StartServerOptions, type TestServer } from '../helpers/server.ts';

const DEV = { authorization: 'Bearer dev' };

const devAuth: AuthProvider = {
  required: false,
  authenticate(req: IncomingMessage): Promise<Identity | null> {
    return Promise.resolve(req.headers.authorization === 'Bearer dev' ? { name: 'dev' } : null);
  },
};

/** Reads for everyone; publish for the "dev" identity only. */
const devPublishes: Authorizer = {
  authorize: (identity, action) =>
    Promise.resolve(action === 'read' || (action === 'publish' && identity?.name === 'dev')),
};

const ownsAcme = (name: string): boolean => name.startsWith('@acme/') || name === 'acme-tool';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(
  source: MemorySource | null,
  opts: StartServerOptions = {},
): Promise<TestServer> {
  server = await startServer({
    ...opts,
    deps: {
      auth: devAuth,
      authorizer: devPublishes,
      ...(source ? { packageSources: { npm: source } } : {}),
      ...opts.deps,
    },
  });
  return server;
}

function publishBody(name: string, version: string, tgz: Buffer, tag = 'latest'): string {
  return JSON.stringify({
    _id: name,
    name,
    'dist-tags': { [tag]: version },
    versions: {
      [version]: { name, version, dist: { integrity: sha512Integrity(tgz) } },
    },
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: 'application/octet-stream',
        data: tgz.toString('base64'),
        length: tgz.length,
      },
    },
  });
}

function put(s: TestServer, path: string, body: string, headers = DEV): Promise<RawResponse> {
  return send(s.url, {
    method: 'PUT',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

const tgz = (v: string): Buffer =>
  makeTarball({ 'package.json': JSON.stringify({ name: '@acme/lib', version: v }) });

describe('P3: write path disabled (no package source)', () => {
  it('answers 405 for publish and unpublish, and 404 for dist-tags, exactly as before', async () => {
    const s = await start(null);
    for (const [method, path] of [
      ['PUT', '/@acme%2flib'],
      ['DELETE', '/@acme/lib/-rev/1-a'],
      ['PUT', '/npm/@acme%2flib'],
    ] as const) {
      // No body on DELETE: Node's client would send it unframed (no chunked default).
      const body = method === 'PUT' ? '{}' : undefined;
      const res = await send(s.url, { method, path, headers: DEV, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(json(res)).toEqual({ error: 'method not allowed: this is a read-only cache' });
    }
    const tag = await put(s, '/-/package/@acme%2flib/dist-tags/beta', '"1.0.0"');
    expect(tag.status).toBe(404);
  });
});

describe('P3: write path with a package source', () => {
  it('publishes, serves the package from the source and never asks upstream', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    // The same name exists upstream: a dependency-confusion attempt.
    s.upstream.addPackage('@acme/lib', [{ version: '99.0.0' }]);

    const res = await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    expect(res.status).toBe(201);
    expect(json(res)).toEqual({ ok: true });

    const doc = json(await send(s.url, { path: '/@acme%2flib' }));
    expect(Object.keys(doc.versions as object)).toEqual(['1.0.0']);
    const dist = (doc.versions as Record<string, { dist: { tarball: string } }>)['1.0.0']!.dist;
    expect(dist.tarball).toBe(`${s.url}/@acme/lib/-/lib-1.0.0.tgz`);
    const file = await send(s.url, { path: '/@acme/lib/-/lib-1.0.0.tgz' });
    expect(file.status).toBe(200);
    expect(file.body.equals(tgz('1.0.0'))).toBe(true);
    expect(file.headers['content-length']).toBe(String(tgz('1.0.0').length));

    expect(s.upstream.requests).toHaveLength(0);
    expect(source.calls[0]).toMatchObject({ op: 'publish', identity: 'dev' });
    expect(s.audit.ofType('publish')[0]).toMatchObject({
      type: 'publish',
      ecosystem: 'npm',
      name: '@acme/lib',
      versions: ['1.0.0'],
      identity: 'dev',
      integrity: { '1.0.0': sha512Integrity(tgz('1.0.0')) },
      tags: { latest: '1.0.0' },
    });
  });

  it('audits refused writes (bad bodies) with their status', async () => {
    const s = await start(new MemorySource(ownsAcme));
    const res = await put(s, '/@acme%2flib', JSON.stringify({ name: '@acme/lib', versions: 'x' }));
    expect(res.status).toBe(400);
    expect(s.audit.ofType('write.refused')[0]).toMatchObject({
      name: '@acme/lib',
      route: 'publish',
      status: 400,
      identity: 'dev',
    });
  });

  it('answers 404 for owned names the source does not have, without asking upstream', async () => {
    const s = await start(new MemorySource(ownsAcme));
    s.upstream.addPackage('acme-tool', [{ version: '1.0.0' }]);
    for (const path of ['/acme-tool', '/acme-tool/1.0.0', '/acme-tool/-/acme-tool-1.0.0.tgz']) {
      expect((await send(s.url, { path })).status, path).toBe(404);
    }
    expect(s.upstream.requests).toHaveLength(0);
  });

  it('keeps proxying names the source does not own and refuses to publish them', async () => {
    const s = await start(new MemorySource(ownsAcme));
    s.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    expect((await send(s.url, { path: '/lodash' })).status).toBe(200);
    const res = await put(s, '/lodash', publishBody('lodash', '5.0.0', tgz('5.0.0')));
    expect(res.status).toBe(403);
    expect(json(res).error).toMatch(/not accept writes/);
  });

  it('requires the publish permission (DefaultAuthorizer refuses it)', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source, { deps: { authorizer: new DefaultAuthorizer(devAuth) } });
    const body = publishBody('@acme/lib', '1.0.0', tgz('1.0.0'));
    expect((await put(s, '/@acme%2flib', body)).status).toBe(403);
    expect((await put(s, '/@acme%2flib', body, {} as typeof DEV)).status).toBe(403);
    expect(source.calls).toHaveLength(0);
    expect(s.audit.ofType('auth.forbidden')[0]).toMatchObject({ action: 'publish' });
  });

  it('enforces MAX_PUBLISH_BYTES with a 413', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source, { env: { MAX_PUBLISH_BYTES: '1000' } });
    const body = publishBody('@acme/lib', '1.0.0', Buffer.alloc(4000, 1));
    const res = await put(s, '/@acme%2flib', body);
    expect(res.status).toBe(413);
    expect(source.calls).toHaveLength(0);
  });

  it('maps a source conflict (409) and bad bodies (400) to the client', async () => {
    const s = await start(new MemorySource(ownsAcme));
    const body = publishBody('@acme/lib', '1.0.0', tgz('1.0.0'));
    expect((await put(s, '/@acme%2flib', body)).status).toBe(201);
    expect((await put(s, '/@acme%2flib', body)).status).toBe(409);
    expect((await put(s, '/@acme%2flib', '{not json')).status).toBe(400);
  });

  it('shows a new version immediately after publishing (metadata invalidated)', async () => {
    const s = await start(new MemorySource(ownsAcme, { metadataTtlMs: 60_000 }));
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    expect(json(await send(s.url, { path: '/@acme%2flib' }))['dist-tags']).toEqual({
      latest: '1.0.0',
    });
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.1.0', tgz('1.1.0')));
    const doc = json(await send(s.url, { path: '/@acme%2flib' }));
    expect(doc['dist-tags']).toEqual({ latest: '1.1.0' });
  });

  it('sets and removes dist-tags', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    expect((await put(s, '/-/package/@acme%2flib/dist-tags/beta', '"1.0.0"')).status).toBe(200);
    expect(json(await send(s.url, { path: '/@acme%2flib' }))['dist-tags']).toMatchObject({
      beta: '1.0.0',
    });
    const del = await send(s.url, {
      method: 'DELETE',
      path: '/-/package/@acme%2flib/dist-tags/beta',
      headers: DEV,
    });
    expect(del.status).toBe(200);
    expect(source.calls.map((c) => c.op)).toEqual(['publish', 'dist-tag', 'dist-tag']);
    expect(source.calls[2]?.request).toMatchObject({ tag: 'beta', version: null });
    expect(s.audit.ofType('dist-tag')).toHaveLength(2);
  });

  it('supports the npm unpublish flow for one version and for a whole package', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.1.0', tgz('1.1.0')));
    // npm unpublish @acme/lib@1.1.0: PUT the document without that version, then DELETE it.
    const doc = json(await send(s.url, { path: '/@acme%2flib?write=true' }));
    const versions = { ...(doc.versions as Record<string, unknown>) };
    delete versions['1.1.0'];
    const putRev = await put(s, '/@acme%2flib/-rev/2-mem', JSON.stringify({ ...doc, versions }));
    expect(putRev.status).toBe(200);
    const delFile = await send(s.url, {
      method: 'DELETE',
      path: '/@acme/lib/-/lib-1.1.0.tgz/-rev/3-mem',
      headers: DEV,
    });
    expect(delFile.status).toBe(200);
    expect(source.calls.slice(2).map((c) => c.request)).toMatchObject([
      { name: '@acme/lib', versions: ['1.1.0'], rev: '2-mem' },
      { name: '@acme/lib', files: ['lib-1.1.0.tgz'], rev: '3-mem' },
    ]);
    expect(
      Object.keys(json(await send(s.url, { path: '/@acme%2flib' })).versions as object),
    ).toEqual(['1.0.0']);
    // A document that removes nothing (e.g. npm deprecate) is not supported.
    const same = json(await send(s.url, { path: '/@acme%2flib' }));
    expect((await put(s, '/@acme%2flib', JSON.stringify(same))).status).toBe(400);

    const delAll = await send(s.url, {
      method: 'DELETE',
      path: '/@acme%2flib/-rev/4-mem',
      headers: DEV,
    });
    expect(delAll.status).toBe(200);
    expect((await send(s.url, { path: '/@acme%2flib' })).status).toBe(404);
    expect(s.audit.ofType('unpublish')).toHaveLength(3);
    expect(s.upstream.requests).toHaveLength(0);
  });

  it('applies policy to local packages and tells it where the version came from', async () => {
    const origins: Array<string | undefined> = [];
    const policy: Policy = {
      evaluate(input) {
        origins.push(input.origin);
        return { allow: true };
      },
    };
    const s = await start(new MemorySource(ownsAcme), { deps: { policy } });
    s.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    await send(s.url, { path: '/@acme%2flib' });
    await send(s.url, { path: '/lodash' });
    expect(origins).toEqual(['local', 'upstream']);
  });
});

describe('P3 review fixes', () => {
  async function publishThree(s: TestServer): Promise<void> {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      expect((await put(s, '/@acme%2flib', publishBody('@acme/lib', v, tgz(v)))).status).toBe(201);
    }
  }

  it('never unpublishes versions the client could not see (policy-filtered)', async () => {
    const source = new MemorySource(ownsAcme);
    const policy: Policy = {
      evaluate: (i) =>
        i.version === '1.2.0' ? { allow: false, reason: 'quarantined' } : { allow: true },
    };
    const s = await start(source, { deps: { policy } });
    await publishThree(s);
    const doc = json(await send(s.url, { path: '/@acme%2flib?write=true' }));
    const versions = { ...(doc.versions as Record<string, unknown>) };
    expect(Object.keys(versions)).toEqual(['1.0.0', '1.1.0']);
    delete versions['1.1.0'];
    const res = await put(s, '/@acme%2flib/-rev/3-mem', JSON.stringify({ ...doc, versions }));
    expect(res.status).toBe(200);
    expect(source.calls.at(-1)?.request).toMatchObject({ versions: ['1.1.0'] });
    expect(Object.keys(source.docs.get('@acme/lib')?.versions ?? {})).toEqual(['1.0.0', '1.2.0']);
  });

  it('requires a revision for a document that drops versions', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    await publishThree(s);
    const doc = json(await send(s.url, { path: '/@acme%2flib' }));
    delete doc._rev;
    const res = await put(s, '/@acme%2flib', JSON.stringify({ ...doc, versions: {} }));
    expect(res.status).toBe(400);
    expect(source.calls.filter((c) => c.op === 'unpublish')).toHaveLength(0);
  });

  it('authorizes a document that drops versions as an unpublish', async () => {
    const source = new MemorySource(ownsAcme);
    const noUnpublish: Authorizer = {
      authorize: (identity, action, resource) =>
        Promise.resolve(
          action === 'read' || (identity?.name === 'dev' && resource.route !== 'unpublish'),
        ),
    };
    const s = await start(source, { deps: { authorizer: noUnpublish } });
    await publishThree(s);
    const doc = json(await send(s.url, { path: '/@acme%2flib' }));
    const res = await put(s, '/@acme%2flib/-rev/3-mem', JSON.stringify({ ...doc, versions: {} }));
    expect(res.status).toBe(403);
    expect(source.calls.filter((c) => c.op === 'unpublish')).toHaveLength(0);
  });

  it('removes owned names from npm audit bodies and refuses tree-shaped audits', async () => {
    const s = await start(new MemorySource(ownsAcme));
    s.upstream.hook = (req, res) => {
      if (req.method !== 'POST') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return true;
    };
    const audit = JSON.stringify({
      '@acme/lib': ['1.0.0'],
      'acme-tool': ['1.0.0'],
      lodash: ['4.17.21'],
    });
    for (const gzip of [false, true]) {
      const body = gzip ? gzipSync(audit) : Buffer.from(audit);
      const res = await send(s.url, {
        method: 'POST',
        path: '/-/npm/v1/security/advisories/bulk',
        headers: {
          'content-type': 'application/json',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
        body,
      });
      expect(res.status).toBe(200);
      const sent = s.upstream.requests.at(-1);
      expect(JSON.parse(sent?.body.toString() ?? '')).toEqual({ lodash: ['4.17.21'] });
      expect(sent?.headers['content-encoding']).toBeUndefined();
    }
    const quick = await send(s.url, {
      method: 'POST',
      path: '/-/npm/v1/security/audits/quick',
      headers: { 'content-type': 'application/json' },
      body: '{"requires":{"@acme/lib":"1.0.0"}}',
    });
    expect(quick.status).toBe(404);
    expect(s.upstream.requests.filter((r) => r.path.includes('/audits'))).toHaveLength(0);
  });

  it('serves local artifacts with HEAD, 304 and 404 for missing files', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    const path = '/@acme/lib/-/lib-1.0.0.tgz';
    const head = await send(s.url, { method: 'HEAD', path });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(tgz('1.0.0').length));
    const etag = String(head.headers.etag);
    expect((await send(s.url, { path, headers: { 'if-none-match': etag } })).status).toBe(304);
    source.files.clear();
    expect((await send(s.url, { path })).status).toBe(404);
    expect(s.upstream.requests).toHaveLength(0);
  });

  it('revalidates local metadata by etag and serves it stale when the source fails', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await start(source);
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    expect((await send(s.url, { path: '/@acme%2flib' })).status).toBe(200);
    expect((await send(s.url, { path: '/@acme%2flib' })).status).toBe(200);
    source.failing = true;
    const stale = await send(s.url, { path: '/@acme%2flib' });
    expect(stale.status).toBe(200);
    expect(stale.headers['x-eyniq-stale']).toBe('1');
    expect(s.upstream.requests).toHaveLength(0);
  });

  it('exempts local packages from the release age gate by default', async () => {
    const policy = new MinReleaseAgePolicy({
      minAgeMs: 3 * 86_400_000,
      failClosed: true,
      allowlist: [],
    });
    const s = await start(new MemorySource(ownsAcme), { deps: { policy } });
    await put(s, '/@acme%2flib', publishBody('@acme/lib', '1.0.0', tgz('1.0.0')));
    expect((await send(s.url, { path: '/@acme/lib/-/lib-1.0.0.tgz' })).status).toBe(200);
  });

  it('keeps a JSON __proto__ key as plain data and clips echoed values', () => {
    const route = { kind: 'publish' as const, name: 'pkg' };
    const data = makeTarball({ 'package.json': '{}' });
    const body = `{"name":"pkg","__proto__":{"polluted":true},"versions":{"1.0.0":{"name":"pkg","version":"1.0.0","dist":{}}},"_attachments":{"pkg-1.0.0.tgz":{"data":"${data.toString('base64')}"}}}`;
    const out = new NpmAdapter().parseWriteBody(route, Buffer.from(body));
    expect(out.type).toBe('publish');
    if (out.type !== 'publish') return;
    expect(Object.getPrototypeOf(out.request.document)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out.request.document, '__proto__')?.value).toEqual({
      polluted: true,
    });
    const long = `{"name":"pkg","versions":{"${'x'.repeat(10_000)}":{}}}`;
    try {
      new NpmAdapter().parseWriteBody(route, Buffer.from(long));
      throw new Error('expected a 400');
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(120);
    }
  });
});
