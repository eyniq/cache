// P10: adapters of other ecosystems. sha256 is verified by the core; adapter-defined digests
// (e.g. a hash over an archive's contents) are verified by EcosystemAdapter.createVerifier,
// and ProcessedMetadata.packageName is the name policies and audit events see when an adapter
// keys its metadata per version.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterRoute,
  ArtifactIntegrity,
  ArtifactRef,
  ArtifactVerifier,
  EcosystemAdapter,
  MetadataFetchResult,
  Policy,
  PolicyInput,
  ProcessContext,
  ProcessedMetadata,
  RawMetadata,
  RenderInput,
  RenderResult,
  Upstream,
} from '../../src/core/contracts.ts';
import { readLimited } from '../../src/core/streams.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

interface ToyVersion {
  version: string;
  file: string;
  algorithm: string;
  hex: string;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** The toy adapter-defined digest: sha256 of the reversed bytes. */
const reversedSha256 = (b: Buffer): string => sha256(Buffer.from(b).reverse());

class ToyAdapter implements EcosystemAdapter {
  readonly id = 'toy';
  readonly mountPath = '/toy';
  readonly processorModule = 'unused:inline';
  readonly processOptions = {};
  readonly forwardHeaders = [];
  verifiers: Array<{ aborted: number; verified: number }> = [];
  verifyDelayMs = 0;
  handles = true;
  /** How the verifier misbehaves (hostile or buggy adapters). */
  mode: 'ok' | 'reject' | 'throw' | 'update-throws' = 'ok';
  packageNameOf: (lookup: string) => string = (lookup) => lookup.split('@')[0]!;
  keyOf: (algorithm: string, hex: string) => string = (a, h) => `toy/blobs/${a}/${h}`;
  publishedAt = Date.parse('2020-01-01');

  match(_req: IncomingMessage, path: string): AdapterRoute | null {
    const m = /^\/([a-z]+)(?:\/([a-z0-9.-]+))?$/.exec(path);
    if (!m) return null;
    // Per-version style lookup keys: the policy must see only the part before "@".
    if (m[2]) return { kind: 'artifact', name: `${m[1]!}@all`, file: m[2] };
    return { kind: 'metadata', name: `${m[1]!}@all`, view: 'json' };
  }

  async fetchMetadata(name: string, upstream: Upstream): Promise<MetadataFetchResult> {
    const res = await upstream.request({ path: `/toy-meta/${name.split('@')[0]!}` });
    if (res.status === 404) {
      res.body.resume();
      return { status: 'not-found' };
    }
    const body = await readLimited(res.body, 1 << 20, () => new Error('too large'));
    return { status: 'ok', raw: { body, encoding: 'identity' } };
  }

  processMetadata(raw: RawMetadata, ctx: ProcessContext): ProcessedMetadata {
    const versions = JSON.parse(raw.body.toString('utf8')) as ToyVersion[];
    return {
      name: ctx.name,
      packageName: this.packageNameOf(ctx.name),
      digest: sha256(raw.body),
      versions: versions.map((v) => ({
        version: v.version,
        publishedAt: this.publishedAt,
        artifact: {
          file: v.file,
          upstreamPath: `/toy-files/${v.file}`,
          integrity: { algorithm: v.algorithm, hex: v.hex },
        },
      })),
      payload: null,
      byteSize: raw.body.length,
    };
  }

  renderMetadata(input: RenderInput): RenderResult {
    return {
      status: 200,
      body: Buffer.from(JSON.stringify([...input.allowed])),
      contentType: 'application/json',
    };
  }

  createVerifier(integrity: ArtifactIntegrity): ArtifactVerifier | null {
    if (!this.handles || integrity.algorithm !== 'toy-reversed') return null;
    const chunks: Buffer[] = [];
    const state = { aborted: 0, verified: 0 };
    this.verifiers.push(state);
    return {
      update: (chunk) => {
        if (this.mode === 'update-throws') throw new Error('parser exploded');
        chunks.push(chunk);
      },
      verify: (): Promise<boolean> => {
        if (this.mode === 'throw') throw new Error('verifier bug');
        return (async () => {
          await sleep(this.verifyDelayMs);
          state.verified++;
          if (this.mode === 'reject') throw new Error('scratch volume full');
          return reversedSha256(Buffer.concat(chunks)) === integrity.hex;
        })();
      },
      abort: () => {
        state.aborted++;
      },
    };
  }

  metadataKey(name: string): string {
    return `toy/meta/${name}.json.gz`;
  }

  artifactKey(
    route: Extract<AdapterRoute, { kind: 'artifact' }>,
    metadata: ProcessedMetadata,
  ): ArtifactRef {
    const v = metadata.versions.find((x) => x.artifact?.file === route.file);
    if (!v?.artifact?.integrity) return { status: 'not-found' };
    const { algorithm, hex } = v.artifact.integrity;
    return {
      status: 'ok',
      version: v.version,
      artifact: v.artifact,
      storageKey: this.keyOf(algorithm, hex),
      contentType: 'application/octet-stream',
    };
  }
}

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(
  versions: ToyVersion[],
  files: Record<string, Buffer>,
  extra: { policy?: Policy; adapter?: ToyAdapter } = {},
): Promise<{ server: TestServer; adapter: ToyAdapter }> {
  const adapter = extra.adapter ?? new ToyAdapter();
  server = await startServer({
    deps: { adapters: [adapter], ...(extra.policy ? { policy: extra.policy } : {}) },
  });
  server.upstream.hook = (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/toy-meta/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(versions));
      return true;
    }
    const file = files[url.replace('/toy-files/', '')];
    if (!url.startsWith('/toy-files/') || !file) return false;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(file);
    return true;
  };
  return { server, adapter };
}

const bytes = Buffer.from('toy artifact bytes '.repeat(100));

describe('P10: sha256 and adapter-defined digests', () => {
  it('verifies and caches a sha256 artifact', async () => {
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'a.bin', algorithm: 'sha256', hex: sha256(bytes) }],
      { 'a.bin': bytes },
    );
    const first = await send(s.url, { path: '/toy/a/a.bin' });
    expect(first.status).toBe(200);
    expect(first.body.equals(bytes)).toBe(true);
    expect(first.headers.etag).toBe(`"sha256-${sha256(bytes)}"`);
    const second = await send(s.url, { path: '/toy/a/a.bin' });
    expect(second.body.equals(bytes)).toBe(true);
    expect(s.upstream.count((r) => r.path === '/toy-files/a.bin')).toBe(1);
  });

  it('refuses sha256 bytes that do not match and stores nothing', async () => {
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'a.bin', algorithm: 'sha256', hex: sha256(Buffer.from('x')) }],
      { 'a.bin': bytes },
    );
    const res = await send(s.url, { path: '/toy/a/a.bin' });
    expect(res.aborted).toBe(true);
    await sleep(50); // the failed download leaves the coalescer
    await send(s.url, { path: '/toy/a/a.bin' });
    expect(s.upstream.count((r) => r.path === '/toy-files/a.bin')).toBe(2);
    expect(s.audit.events.map((e) => e.type)).toContain('integrity.mismatch');
  });

  it('verifies an adapter-defined digest asynchronously before committing', async () => {
    const adapter = new ToyAdapter();
    adapter.verifyDelayMs = 50;
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    const first = await send(s.url, { path: '/toy/a/b.bin' });
    expect(first.status).toBe(200);
    expect(first.aborted).toBe(false);
    expect(first.body.equals(bytes)).toBe(true);
    expect(first.headers.etag).toBe(`"toy-reversed-${reversedSha256(bytes)}"`);
    const second = await send(s.url, { path: '/toy/a/b.bin' });
    expect(second.body.equals(bytes)).toBe(true);
    expect(s.upstream.count((r) => r.path === '/toy-files/b.bin')).toBe(1);
    expect(adapter.verifiers).toEqual([{ aborted: 0, verified: 1 }]);
  });

  it('fails the download when the adapter verifier answers false', async () => {
    const adapter = new ToyAdapter();
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: sha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    expect((await send(s.url, { path: '/toy/a/b.bin' })).aborted).toBe(true);
    await sleep(50); // the failed download leaves the coalescer
    expect((await send(s.url, { path: '/toy/a/b.bin' })).aborted).toBe(true);
    expect(s.upstream.count((r) => r.path === '/toy-files/b.bin')).toBe(2);
    const mismatch = s.audit.events.find((e) => e.type === 'integrity.mismatch');
    expect(mismatch).toMatchObject({ ecosystem: 'toy', name: 'a', version: '1.0.0' });
  });

  it('refuses an adapter-defined digest that no verifier handles, without downloading', async () => {
    const adapter = new ToyAdapter();
    adapter.handles = false;
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    const res = await send(s.url, { path: '/toy/a/b.bin' });
    expect(res.status).toBe(502);
    expect(s.upstream.count((r) => r.path === '/toy-files/b.bin')).toBe(0);
  });

  it('aborts the adapter verifier when the upstream stream fails', async () => {
    const adapter = new ToyAdapter();
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      {},
      { adapter },
    );
    const metaHook = s.upstream.hook;
    s.upstream.hook = (req, res, body) => {
      if (!req.url?.startsWith('/toy-files/')) return metaHook?.(req, res, body) ?? false;
      res.writeHead(200, { 'content-length': String(bytes.length) });
      res.write(bytes.subarray(0, 10));
      setTimeout(() => res.destroy(), 20);
      return true;
    };
    expect((await send(s.url, { path: '/toy/a/b.bin' })).aborted).toBe(true);
    await sleep(50);
    expect(adapter.verifiers).toEqual([{ aborted: 1, verified: 0 }]);
  });

  it('shows policies and audit events the package name, not the per-version lookup key', async () => {
    const seen: PolicyInput[] = [];
    const policy: Policy = {
      evaluate(input) {
        seen.push(input);
        return { allow: false, reason: 'blocked for the test' };
      },
    };
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'a.bin', algorithm: 'sha256', hex: sha256(bytes) }],
      { 'a.bin': bytes },
      { policy },
    );
    const res = await send(s.url, { path: '/toy/a/a.bin' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString('utf8'))).toMatchObject({ package: 'a' });
    expect(seen[0]).toMatchObject({ ecosystem: 'toy', name: 'a', version: '1.0.0' });
    const blocked = s.audit.events.find((e) => e.type === 'policy.blocked');
    expect(blocked).toMatchObject({ ecosystem: 'toy', name: 'a', version: '1.0.0' });
  });

  it('serves every coalesced waiter from storage after a slow verification', async () => {
    const adapter = new ToyAdapter();
    adapter.verifyDelayMs = 150;
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    const all = await Promise.all(
      Array.from({ length: 5 }, () => send(s.url, { path: '/toy/a/b.bin' })),
    );
    for (const r of all) {
      expect(r.status).toBe(200);
      expect(r.body.equals(bytes)).toBe(true);
    }
    expect(s.upstream.count((r) => r.path === '/toy-files/b.bin')).toBe(1);
  });

  it('withholds the end of the response until the verifier answered', async () => {
    const adapter = new ToyAdapter();
    adapter.verifyDelayMs = 200;
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    const started = Date.now();
    const res = await send(s.url, { path: '/toy/a/b.bin' });
    expect(res.aborted).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it.each([
    ['rejects', 'reject'],
    ['throws synchronously', 'throw'],
    ['throws on a chunk', 'update-throws'],
  ] as const)('fails closed when the verifier %s, without a mismatch event', async (_l, mode) => {
    const adapter = new ToyAdapter();
    adapter.mode = mode;
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      { 'b.bin': bytes },
      { adapter },
    );
    expect((await send(s.url, { path: '/toy/a/b.bin' })).aborted).toBe(true);
    await sleep(50);
    const key = `toy/blobs/toy-reversed/${reversedSha256(bytes)}`;
    expect(await s.deps.storage.head(key)).toBeNull();
    expect(s.audit.events.map((e) => e.type)).not.toContain('integrity.mismatch');
    expect(adapter.verifiers[0]?.aborted).toBe(1);
    // The server is still alive.
    expect((await send(s.url, { path: '/toy/a' })).status).toBe(200);
  });

  it('commits nothing when the verifier says no', async () => {
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: sha256(bytes) }],
      { 'b.bin': bytes },
    );
    expect((await send(s.url, { path: '/toy/a/b.bin' })).aborted).toBe(true);
    await sleep(50);
    expect(await s.deps.storage.head(`toy/blobs/toy-reversed/${sha256(bytes)}`)).toBeNull();
  });

  it('aborts the verifier when upstream has no such artifact', async () => {
    const adapter = new ToyAdapter();
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'b.bin', algorithm: 'toy-reversed', hex: reversedSha256(bytes) }],
      {},
      { adapter },
    );
    expect((await send(s.url, { path: '/toy/a/b.bin' })).status).toBe(404);
    expect(adapter.verifiers).toEqual([{ aborted: 1, verified: 0 }]);
  });

  it.each([
    ['a storage key that does not end in the digest', { key: 'toy/blobs/fixed' }], // gitleaks:allow (storage key, not a secret)
    ['an algorithm with header characters', { algorithm: 'toy"x' }],
    ['a digest that is not lowercase hex', { hex: 'ABCDEF0123456789' }],
  ])(
    'refuses %s before downloading',
    async (_label, o: { key?: string; algorithm?: string; hex?: string }) => {
      const adapter = new ToyAdapter();
      if (o.key !== undefined) {
        const fixed = o.key;
        adapter.keyOf = () => fixed;
      }
      const { server: s } = await start(
        [
          {
            version: '1.0.0',
            file: 'a.bin',
            algorithm: o.algorithm ?? 'sha256',
            hex: o.hex ?? sha256(bytes),
          },
        ],
        { 'a.bin': bytes },
        { adapter },
      );
      expect((await send(s.url, { path: '/toy/a/a.bin' })).status).toBe(502);
      expect(s.upstream.count((r) => r.path === '/toy-files/a.bin')).toBe(0);
    },
  );

  it('refuses a package name that is not the lookup name or its leading part', async () => {
    const adapter = new ToyAdapter();
    adapter.packageNameOf = () => 'lodash';
    const { server: s } = await start(
      [{ version: '1.0.0', file: 'a.bin', algorithm: 'sha256', hex: sha256(bytes) }],
      { 'a.bin': bytes },
      { adapter },
    );
    expect((await send(s.url, { path: '/toy/a' })).status).toBe(502);
  });

  it('matches allowlist entries of the adapter ecosystem on the package name', async () => {
    const policy = new MinReleaseAgePolicy({
      minAgeMs: 3_600_000,
      failClosed: true,
      allowlist: [
        {
          ecosystem: 'toy',
          package: 'a',
          version: '2.0.0',
          reason: 'r',
          expires: Date.now() + 3_600_000,
        },
      ],
    });
    const adapter = new ToyAdapter();
    adapter.publishedAt = Date.now();
    const { server: s } = await start(
      [
        { version: '1.0.0', file: 'a.bin', algorithm: 'sha256', hex: sha256(bytes) },
        { version: '2.0.0', file: 'c.bin', algorithm: 'sha256', hex: sha256(bytes) },
      ],
      { 'a.bin': bytes },
      { adapter, policy },
    );
    const listed: unknown = JSON.parse(
      (await send(s.url, { path: '/toy/a' })).body.toString('utf8'),
    );
    expect(listed).toEqual(['2.0.0']);
  });
});
