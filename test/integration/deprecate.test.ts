// npm deprecate through the write path: a dedicated PackageSource.deprecate operation,
// authorized as `publish` (route "deprecate"); sources without it keep the old answer.
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthProvider, Authorizer, Identity } from '../../src/core/contracts.ts';
import { json, send, type RawResponse } from '../helpers/http.ts';
import { MemorySource } from '../helpers/memory-source.ts';
import { startServer, type TestServer } from '../helpers/server.ts';
import { makeTarball, sha512Integrity } from '../helpers/tarball.ts';

const DEV = { authorization: 'Bearer dev' };
const devAuth: AuthProvider = {
  required: false,
  authenticate: (req: IncomingMessage): Promise<Identity | null> =>
    Promise.resolve(req.headers.authorization === 'Bearer dev' ? { name: 'dev' } : null),
};
const devPublishes: Authorizer = {
  authorize: (identity, action) =>
    Promise.resolve(action === 'read' || (action === 'publish' && identity?.name === 'dev')),
};
const ownsAcme = (name: string): boolean => name.startsWith('@acme/');

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function put(s: TestServer, path: string, body: unknown): Promise<RawResponse> {
  return send(s.url, {
    method: 'PUT',
    path,
    headers: { ...DEV, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withTwoVersions(
  source: MemorySource,
  authorizer: Authorizer = devPublishes,
): Promise<TestServer> {
  server = await startServer({
    deps: { auth: devAuth, authorizer, packageSources: { npm: source } },
  });
  for (const version of ['1.0.0', '1.1.0']) {
    const tgz = makeTarball({ 'package.json': JSON.stringify({ name: '@acme/lib', version }) });
    const res = await put(server, '/@acme%2flib', {
      name: '@acme/lib',
      'dist-tags': { latest: version },
      versions: {
        [version]: { name: '@acme/lib', version, dist: { integrity: sha512Integrity(tgz) } },
      },
      _attachments: {
        [`@acme/lib-${version}.tgz`]: { data: tgz.toString('base64'), length: tgz.length },
      },
    });
    expect(res.status).toBe(201);
  }
  return server;
}

/** What `npm deprecate @acme/lib@1.0.0 <message>` sends: the fetched document, edited. */
async function deprecateBody(s: TestServer, version: string, message: string): Promise<unknown> {
  const doc = json(await send(s.url, { path: '/@acme%2flib?write=true', headers: DEV }));
  const versions = doc.versions as Record<string, Record<string, unknown>>;
  versions[version] = { ...versions[version], deprecated: message };
  return doc;
}

describe('npm deprecate', () => {
  it('hands the deprecations to PackageSource.deprecate and serves them', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await withTwoVersions(source);
    const res = await put(s, '/@acme%2flib', await deprecateBody(s, '1.0.0', 'use 1.1.0'));
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    expect(source.calls.at(-1)).toMatchObject({
      op: 'deprecate',
      identity: 'dev',
      request: { ecosystem: 'npm', name: '@acme/lib', deprecations: { '1.0.0': 'use 1.1.0' } },
    });
    const doc = json(await send(s.url, { path: '/@acme%2flib' }));
    expect((doc.versions as Record<string, { deprecated?: string }>)['1.0.0']?.deprecated).toBe(
      'use 1.1.0',
    );
    expect(s.audit.ofType('deprecate')).toEqual([
      expect.objectContaining({ name: '@acme/lib', versions: ['1.0.0'], identity: 'dev' }),
    ]);
    // No empty publish event any more.
    expect(s.audit.ofType('publish')).toHaveLength(2);
    expect(source.calls.filter((c) => c.op === 'unpublish')).toHaveLength(0);
  });

  it('authorizes deprecate as publish on the route "deprecate"', async () => {
    const source = new MemorySource(ownsAcme);
    const noDeprecate: Authorizer = {
      authorize: (identity, action, resource) =>
        Promise.resolve(
          action === 'read' || (identity?.name === 'dev' && resource.route !== 'deprecate'),
        ),
    };
    const s = await withTwoVersions(source, noDeprecate);
    const res = await put(s, '/@acme%2flib', await deprecateBody(s, '1.0.0', 'nope'));
    expect(res.status).toBe(403);
    expect(source.calls.filter((c) => c.op === 'deprecate')).toHaveLength(0);
  });

  it('keeps the old answer (400, nothing removed) for a source without deprecate', async () => {
    const source = new MemorySource(ownsAcme);
    Object.defineProperty(source, 'deprecate', { value: undefined });
    const s = await withTwoVersions(source);
    const res = await put(s, '/@acme%2flib', await deprecateBody(s, '1.0.0', 'old'));
    expect(res.status).toBe(400);
    expect(json(res)).toEqual({
      error: 'unsupported change: only publishing and unpublishing versions is supported',
    });
    expect(Object.keys(source.docs.get('@acme/lib')?.versions ?? {})).toEqual(['1.0.0', '1.1.0']);
  });

  it('answers 400 for unusable messages, and the old answer for a source without deprecate', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await withTwoVersions(source);
    const res = await put(s, '/@acme%2flib', await deprecateBody(s, '1.0.0', 'bad \u001b[31m'));
    expect(res.status).toBe(400);
    expect(source.calls.filter((c) => c.op === 'deprecate')).toHaveLength(0);
  });

  it('treats a document that drops a visible version as an unpublish, not a deprecate', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await withTwoVersions(source);
    const doc = (await deprecateBody(s, '1.0.0', 'old')) as { versions: Record<string, unknown> };
    delete doc.versions['1.1.0'];
    const res = await put(s, '/@acme%2flib', doc);
    expect(res.status).toBe(200);
    expect(source.calls.filter((c) => c.op === 'deprecate')).toHaveLength(0);
    expect(source.calls.at(-1)).toMatchObject({
      op: 'unpublish',
      request: { versions: ['1.1.0'] },
    });
  });

  it('refuses deprecating a package the source does not own', async () => {
    const source = new MemorySource(ownsAcme);
    const s = await withTwoVersions(source);
    s.upstream.addPackage('lodash', [{ version: '1.0.0' }]);
    const res = await put(s, '/lodash', {
      name: 'lodash',
      versions: { '1.0.0': { name: 'lodash', version: '1.0.0', deprecated: 'x' } },
    });
    expect(res.status).toBe(403);
  });
});
