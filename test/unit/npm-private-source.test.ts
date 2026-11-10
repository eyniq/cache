import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NpmPrivateSource } from '../../src/adapters/npm/private-source.ts';
import type { Identity, PackageSource, StorageListPage } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';
import { contentKey } from '../../src/core/names.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { publishRequest } from '../helpers/publish.ts';
import { makeTarball } from '../helpers/tarball.ts';

const ALICE: Identity = { name: 'alice', claims: { via: 'user-token', readonly: false } };
const BOB: Identity = { name: 'bob', claims: { via: 'user-token', readonly: false } };

/** FsStorage that counts list() calls. */
class CountingStorage extends FsStorage {
  lists = 0;
  override list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<StorageListPage> {
    this.lists++;
    return super.list(prefix, opts);
  }
}
const HOUR = 3_600_000;
let root: string;
let now: number;
let source: NpmPrivateSource;

function make(opts: Partial<ConstructorParameters<typeof NpmPrivateSource>[0]> = {}) {
  return new NpmPrivateSource({
    storage: new FsStorage(root),
    packages: ['@acme/*', 'internal-tool'],
    unpublishWindowMs: 72 * HOUR,
    now: () => now,
    ...opts,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eyniq-private-'));
  now = Date.parse('2026-10-16T12:00:00.000Z');
  source = make();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function doc(s: PackageSource, name: string) {
  const r = await s.getMetadata(name, { maxBytes: 1 << 26 });
  if (r.status !== 'ok') return null;
  return JSON.parse(r.raw.body.toString()) as {
    _rev: string;
    versions: Record<string, Record<string, unknown>>;
    time: Record<string, string>;
    'dist-tags': Record<string, string>;
    description?: string;
  };
}

async function status(work: Promise<unknown>): Promise<number> {
  try {
    await work;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe('NpmPrivateSource', () => {
  it('owns its patterns case-insensitively and nothing else', () => {
    expect(source.owns('@acme/lib')).toBe(true);
    expect(source.owns('@ACME/Lib')).toBe(true);
    expect(source.owns('internal-tool')).toBe(true);
    expect(source.owns('internal-tools')).toBe(false);
    expect(source.owns('@acmex/lib')).toBe(false);
    expect(source.owns('lodash')).toBe(false);
  });

  it('publishes immutable versions with the publisher set by the registry', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', { manifest: { _npmUser: { name: 'mallory' } } }),
      ALICE,
    );
    const d = await doc(source, '@acme/lib');
    expect(d?.versions['1.0.0']?._npmUser).toEqual({ name: 'alice' });
    expect(d?.['dist-tags']).toEqual({ latest: '1.0.0' });
    expect(d?.time['1.0.0']).toBe('2026-10-16T12:00:00.000Z');
    expect(d?.description).toBe('@acme/lib package');
    expect(await status(source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE))).toBe(409);
    const tgz = await source.getArtifact('@acme/lib', 'lib-1.0.0.tgz');
    expect(tgz?.size).toBeGreaterThan(0);
    tgz?.body.resume();
    expect(await source.getArtifact('@acme/lib', 'lib-9.9.9.tgz')).toBeNull();
  });

  it('checks the tarball: it must describe the version being published', async () => {
    const wrongVersion = publishRequest('@acme/lib', '1.0.0', {
      tarballFor: { name: '@acme/lib', version: '2.0.0' },
    });
    expect(await status(source.publish(wrongVersion, ALICE))).toBe(400);
    const wrongName = publishRequest('@acme/lib', '1.0.0', {
      tarballFor: { name: '@acme/other', version: '1.0.0' },
    });
    expect(await status(source.publish(wrongName, ALICE))).toBe(400);
    const notTar = publishRequest('@acme/lib', '1.0.0');
    const v = notTar.versions[0]!;
    v.artifact.data = Buffer.from('not a tarball');
    expect(await status(source.publish(notTar, ALICE))).toBe(400);
    expect(await doc(source, '@acme/lib')).toBeNull();
  });

  it('serves scripts, license and dependencies from the tarball, not the publish body', async () => {
    // Manifest confusion: the body claims a harmless package, the tarball installs another.
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', {
        manifest: {
          scripts: { test: 'vitest' },
          license: 'MIT',
          dependencies: { safe: '^1.0.0' },
          devDependencies: { claimed: '1.0.0' },
          hasInstallScript: false,
          description: 'kept from the body',
        },
        packageJson: {
          scripts: { postinstall: 'node steal.js' },
          license: 'UNLICENSED',
          dependencies: { evil: '*' },
          optionalDependencies: { other: '2.0.0' },
        },
      }),
      ALICE,
    );
    const v = (await doc(source, '@acme/lib'))?.versions['1.0.0'];
    expect(v?.scripts).toEqual({ postinstall: 'node steal.js' });
    expect(v?.license).toBe('UNLICENSED');
    expect(v?.dependencies).toEqual({ evil: '*' });
    expect(v?.optionalDependencies).toEqual({ other: '2.0.0' });
    expect(v).not.toHaveProperty('devDependencies');
    expect(v?.hasInstallScript).toBe(true);
    expect(v?.description).toBe('kept from the body');
  });

  it('serves bin, os, cpu and engines from the tarball and derives _hasShrinkwrap', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', {
        manifest: {
          bin: { git: 'evil.js' },
          os: ['linux'],
          cpu: ['x64'],
          engines: { node: '>=18' },
          _hasShrinkwrap: false,
        },
        packageJson: { bin: { lib: 'cli.js' }, engines: { node: '>=22' } },
        files: { 'npm-shrinkwrap.json': '{}' },
      }),
      ALICE,
    );
    const v = (await doc(source, '@acme/lib'))?.versions['1.0.0'];
    expect(v?.bin).toEqual({ lib: 'cli.js' });
    expect(v?.engines).toEqual({ node: '>=22' });
    expect(v).not.toHaveProperty('os');
    expect(v).not.toHaveProperty('cpu');
    expect(v?._hasShrinkwrap).toBe(true);
    await source.publish(
      publishRequest('@acme/plain', '1.0.0', { manifest: { _hasShrinkwrap: true } }),
      ALICE,
    );
    expect((await doc(source, '@acme/plain'))?.versions['1.0.0']?._hasShrinkwrap).toBe(false);
  });

  it('keeps the bin npm derived from directories.bin, and only that', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', {
        // npm turns directories.bin into bin entries named after the files.
        manifest: { bin: { 'cli.js': 'bin/cli.js', 'tool.js': './bin/tool.js' } },
        packageJson: { directories: { bin: './bin' } },
      }),
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.versions['1.0.0']?.bin).toEqual({
      'cli.js': 'bin/cli.js',
      'tool.js': './bin/tool.js',
    });
    // Anything npm would not have derived from directories.bin is dropped.
    const refused = [
      { git: 'bin/cli.js' },
      { 'cli.js': 'lib/cli.js' },
      { 'x.js': 'bin/../x.js' },
      { 'y.js': 'bin/sub/x.js' },
    ];
    for (const [i, bin] of refused.entries()) {
      const name = `@acme/other${String(i)}`;
      await source.publish(
        publishRequest(name, '1.0.0', {
          manifest: { bin },
          packageJson: { directories: { bin: 'bin' } },
        }),
        ALICE,
      );
      expect((await doc(source, name))?.versions['1.0.0']).not.toHaveProperty('bin');
    }
  });

  it('derives hasInstallScript from the tarball (install scripts or binding.gyp)', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', { manifest: { hasInstallScript: true } }),
      ALICE,
    );
    await source.publish(
      publishRequest('@acme/gyp', '1.0.0', { files: { 'binding.gyp': '{}' } }),
      ALICE,
    );
    await source.publish(
      publishRequest('@acme/nogyp', '1.0.0', {
        files: { 'binding.gyp': '{}' },
        packageJson: { gypfile: false },
      }),
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.versions['1.0.0']).not.toHaveProperty(
      'hasInstallScript',
    );
    expect((await doc(source, '@acme/gyp'))?.versions['1.0.0']?.hasInstallScript).toBe(true);
    expect((await doc(source, '@acme/nogyp'))?.versions['1.0.0']).not.toHaveProperty(
      'hasInstallScript',
    );
  });

  it('refuses build metadata, digest mismatches, anonymous writes and foreign names', async () => {
    expect(await status(source.publish(publishRequest('@acme/lib', '1.0.0+build'), ALICE))).toBe(
      400,
    );
    const tampered = publishRequest('@acme/lib', '1.0.0');
    tampered.versions[0]!.artifact.data = Buffer.concat([
      tampered.versions[0]!.artifact.data,
      Buffer.from('x'),
    ]);
    expect(await status(source.publish(tampered, ALICE))).toBe(400);
    expect(await status(source.publish(publishRequest('@acme/lib', '1.0.0'), null))).toBe(403);
    expect(await status(source.publish(publishRequest('lodash', '1.0.0'), ALICE))).toBe(403);
    expect(await status(source.publish(publishRequest('@ACME/lib', '1.0.0'), ALICE))).toBe(400);
  });

  it('answers not-modified for the current etag', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    const first = await source.getMetadata('@acme/lib', { maxBytes: 1 << 24 });
    if (first.status !== 'ok') throw new Error('missing');
    expect(first.raw.etag).toBeTruthy();
    const again = await source.getMetadata('@acme/lib', {
      maxBytes: 1 << 24,
      etag: first.raw.etag!,
    });
    expect(again.status).toBe('not-modified');
    expect((await source.getMetadata('@acme/none', { maxBytes: 1 << 24 })).status).toBe(
      'not-found',
    );
  });

  it('unpublishes within the window, repoints latest and never reuses a version', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    now += HOUR;
    await source.publish(publishRequest('@acme/lib', '1.1.0'), ALICE);
    await source.unpublish({ ecosystem: 'npm', name: '@acme/lib', versions: ['1.1.0'] }, ALICE);
    // npm's second call removes the tarball file: idempotent and it must belong to the package.
    await source.unpublish(
      { ecosystem: 'npm', name: '@acme/lib', files: ['lib-1.1.0.tgz'] },
      ALICE,
    );
    expect(
      await status(
        source.unpublish(
          { ecosystem: 'npm', name: '@acme/lib', files: ['other-1.0.0.tgz'] },
          ALICE,
        ),
      ),
    ).toBe(404);
    let d = await doc(source, '@acme/lib');
    expect(Object.keys(d?.versions ?? {})).toEqual(['1.0.0']);
    expect(d?.['dist-tags'].latest).toBe('1.0.0');
    expect(await status(source.publish(publishRequest('@acme/lib', '1.1.0'), ALICE))).toBe(409);
    now += 72 * HOUR;
    expect(
      await status(
        source.unpublish({ ecosystem: 'npm', name: '@acme/lib', versions: ['1.0.0'] }, ALICE),
      ),
    ).toBe(403);
    d = await doc(source, '@acme/lib');
    expect(Object.keys(d?.versions ?? {})).toEqual(['1.0.0']);
  });

  it('refuses every unpublish with a window of 0', async () => {
    const strict = make({ unpublishWindowMs: 0 });
    await strict.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    expect(
      await status(
        strict.unpublish({ ecosystem: 'npm', name: '@acme/lib', versions: ['1.0.0'] }, ALICE),
      ),
    ).toBe(403);
  });

  it('removes a whole package inside the window; its versions stay burnt', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    await source.unpublish({ ecosystem: 'npm', name: '@acme/lib' }, ALICE);
    expect(await doc(source, '@acme/lib')).toBeNull();
    expect(await status(source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE))).toBe(409);
    await source.publish(publishRequest('@acme/lib', '1.0.1'), ALICE);
    expect(Object.keys((await doc(source, '@acme/lib'))?.versions ?? {})).toEqual(['1.0.1']);
  });

  it('manages dist-tags and deprecations', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    await source.publish(
      publishRequest('@acme/lib', '2.0.0-beta.1', { tags: { next: '2.0.0-beta.1' } }),
      ALICE,
    );
    await source.setDistTag(
      { ecosystem: 'npm', name: '@acme/lib', tag: 'stable', version: '1.0.0' },
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.['dist-tags']).toEqual({
      latest: '1.0.0',
      next: '2.0.0-beta.1',
      stable: '1.0.0',
    });
    expect(
      await status(
        source.setDistTag(
          { ecosystem: 'npm', name: '@acme/lib', tag: 'x', version: '9.9.9' },
          ALICE,
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        source.setDistTag(
          { ecosystem: 'npm', name: '@acme/lib', tag: 'latest', version: null },
          ALICE,
        ),
      ),
    ).toBe(400);
    await source.setDistTag(
      { ecosystem: 'npm', name: '@acme/lib', tag: 'stable', version: null },
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.['dist-tags'].stable).toBeUndefined();

    await source.deprecate(
      { ecosystem: 'npm', name: '@acme/lib', deprecations: { '1.0.0': 'use 2' } },
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.versions['1.0.0']?.deprecated).toBe('use 2');
    await source.deprecate(
      { ecosystem: 'npm', name: '@acme/lib', deprecations: { '1.0.0': '' } },
      ALICE,
    );
    expect((await doc(source, '@acme/lib'))?.versions['1.0.0']).not.toHaveProperty('deprecated');
    expect(
      await status(
        source.deprecate(
          { ecosystem: 'npm', name: '@acme/lib', deprecations: { '3.0.0': 'x' } },
          ALICE,
        ),
      ),
    ).toBe(404);
  });

  it('refuses a stale revision', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    const rev = (await doc(source, '@acme/lib'))!._rev;
    await source.publish(publishRequest('@acme/lib', '1.0.1'), ALICE);
    expect(
      await status(
        source.unpublish({ ecosystem: 'npm', name: '@acme/lib', versions: ['1.0.1'], rev }, ALICE),
      ),
    ).toBe(409);
  });

  it('enforces the document size limit', async () => {
    const small = make({ maxDocumentBytes: 4096 });
    const big = publishRequest('@acme/lib', '1.0.0', { document: { readme: 'r'.repeat(8192) } });
    expect(await status(small.publish(big, ALICE))).toBe(413);
  });

  it('finds its packages for search', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', {
        document: { description: 'Shared helpers', keywords: ['utils', 'acme'] },
      }),
      ALICE,
    );
    await source.publish(
      publishRequest('internal-tool', '0.1.0', { document: { description: 'CLI' } }),
      ALICE,
    );
    const q = (text: string) => source.search({ text, size: 20, from: 0, upstreamPath: '' }, ALICE);
    expect((await q('helpers')).map((h) => h.name)).toEqual(['@acme/lib']);
    expect((await q('keywords:utils')).map((h) => h.name)).toEqual(['@acme/lib']);
    expect((await q('acme')).map((h) => h.name)).toEqual(['@acme/lib']);
    expect((await q('tool')).map((h) => h.name)).toEqual(['internal-tool']);
    expect(await q('nothing-matches')).toEqual([]);
    const [hit] = await q('lib');
    expect(hit).toMatchObject({
      name: '@acme/lib',
      version: '1.0.0',
      description: 'Shared helpers',
      publisher: 'alice',
    });
  });

  it('deletes the tarballs it wrote when the document update fails', async () => {
    const small = make({ maxDocumentBytes: 4096 });
    const big = publishRequest('@acme/lib', '1.0.0', { document: { readme: 'r'.repeat(8192) } });
    const key = contentKey(big.versions[0]!.artifact.integrity);
    const storage = new FsStorage(root);
    expect(await status(small.publish(big, ALICE))).toBe(413);
    expect(await storage.head(key)).toBeNull();
    // Bytes that were there before the call stay.
    await storage.put(key, Readable.from([big.versions[0]!.artifact.data]));
    expect(await status(small.publish(big, ALICE))).toBe(413);
    expect(await storage.head(key)).not.toBeNull();
    // A conflict with the same version already published keeps the bytes it references.
    const ok = publishRequest('@acme/lib', '2.0.0');
    await source.publish(ok, ALICE);
    expect(await status(source.publish(ok, ALICE))).toBe(409);
    const kept = await source.getArtifact('@acme/lib', 'lib-2.0.0.tgz');
    expect(kept).not.toBeNull();
    kept?.body.destroy();
  });

  it('lets only the publisher of a version unpublish it', async () => {
    await source.publish(publishRequest('@acme/lib', '1.0.0'), ALICE);
    const one = { ecosystem: 'npm', name: '@acme/lib', versions: ['1.0.0'] };
    expect(await status(source.unpublish(one, BOB))).toBe(403);
    expect(await status(source.unpublish({ ecosystem: 'npm', name: '@acme/lib' }, BOB))).toBe(403);
    expect(Object.keys((await doc(source, '@acme/lib'))?.versions ?? {})).toEqual(['1.0.0']);
    await source.unpublish(one, ALICE);
    expect(await doc(source, '@acme/lib')).toBeNull();
  });

  it('applies the unpacked size limit to all tarballs of one publish together', async () => {
    const versionOf = (version: string) => {
      const data = makeTarball({
        'package.json': JSON.stringify({ name: '@acme/lib', version }),
        'blob.bin': 'x'.repeat(600 * 1024),
      });
      const req = publishRequest('@acme/lib', version);
      const v = req.versions[0]!;
      const hex = createHash('sha512').update(data).digest('hex');
      return {
        ...v,
        manifest: {
          ...v.manifest,
          dist: { integrity: `sha512-${Buffer.from(hex, 'hex').toString('base64')}` },
        },
        artifact: { ...v.artifact, data, integrity: { algorithm: 'sha512' as const, hex } },
      };
    };
    const limited = make({ maxUnpackedBytes: 1024 * 1024 });
    const one = { ...publishRequest('@acme/lib', '1.0.0'), versions: [versionOf('1.0.0')] };
    await limited.publish(one, ALICE);
    const two = {
      ...publishRequest('@acme/lib', '2.0.0'),
      versions: [versionOf('2.0.0'), versionOf('2.0.1')],
      distTags: { latest: '2.0.1' },
    };
    expect(await status(limited.publish(two, ALICE))).toBe(400);
  });

  it('indexes its own writes without listing every document again', async () => {
    const storage = new CountingStorage(root);
    const s = make({ storage });
    await s.publish(publishRequest('@acme/one', '1.0.0'), ALICE);
    const q = (text: string) => s.search({ text, size: 20, from: 0, upstreamPath: '' }, ALICE);
    expect((await q('acme')).map((h) => h.name)).toEqual(['@acme/one']);
    expect(storage.lists).toBe(1);
    await s.publish(publishRequest('@acme/two', '1.0.0'), ALICE);
    expect((await q('acme')).map((h) => h.name)).toEqual(['@acme/one', '@acme/two']);
    await s.unpublish({ ecosystem: 'npm', name: '@acme/one' }, ALICE);
    expect((await q('acme')).map((h) => h.name)).toEqual(['@acme/two']);
    expect(storage.lists).toBe(1); // only the changed documents were read again
    now += 11_000;
    await q('acme');
    expect(storage.lists).toBe(2); // other pods' changes: a full pass after the TTL
  });

  it('reads at most a byte budget of documents per index pass', async () => {
    for (const n of ['a', 'b', 'c'])
      await source.publish(publishRequest(`@acme/${n}`, '1.0.0'), ALICE);
    const fresh = make({ indexBytesPerPass: 1 });
    const q = () => fresh.search({ text: 'acme', size: 20, from: 0, upstreamPath: '' }, ALICE);
    expect(await q()).toHaveLength(1); // one document per pass
    expect(await q()).toHaveLength(2);
    expect(await q()).toHaveLength(3);
  });

  it('strips control and bidi characters from search hits', async () => {
    await source.publish(
      publishRequest('@acme/lib', '1.0.0', {
        document: { description: 'safe\u202e evil\u001b[31m red\nline', keywords: ['k\u2066w'] },
      }),
      ALICE,
    );
    const [hit] = await source.search({ text: 'acme', size: 5, from: 0, upstreamPath: '' }, ALICE);
    expect(hit?.description).toBe('safe evil [31m red line');
    expect(hit?.keywords).toEqual(['kw']);
  });

  it('needs storage with compare-and-swap', () => {
    const plain = {
      get: () => null,
      head: () => null,
      put: () => undefined,
      check: () => undefined,
    };
    expect(() => make({ storage: plain as never })).toThrow(/compare-and-swap/);
  });
});
