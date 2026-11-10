// The community composition, exported so downstream builds compose the same parts
// instead of mirroring src/main.ts.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm/index.ts';
import { NoAuth } from '../../src/auth/none.ts';
import { StaticTokenAuth } from '../../src/auth/static-token.ts';
import { composeCommunity, createAuth, createPolicy, createStorage } from '../../src/compose.ts';
import { ConfigError, loadConfig, type Config } from '../../src/config.ts';
import { StdoutAuditSink } from '../../src/core/audit.ts';
import type { AuthProvider, Upstream } from '../../src/core/contracts.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { FsStorage } from '../../src/storage/fs.ts';
import { S3Storage } from '../../src/storage/s3.ts';
import { RecordingAuditSink } from '../../src/testing/audit.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function config(env: Record<string, string> = {}): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), 'eyniq-compose-'));
  dirs.push(root);
  return loadConfig({
    PUBLIC_URL: 'http://localhost:4873',
    FS_ROOT: root,
    LOG_LEVEL: 'error',
    ...env,
  });
}

describe('community composition', () => {
  it('composes the community defaults', async () => {
    const deps = await composeCommunity(await config());
    try {
      expect(deps.storage).toBeInstanceOf(FsStorage);
      expect(deps.auth).toBeInstanceOf(NoAuth);
      expect(deps.policy).toBeInstanceOf(MinReleaseAgePolicy);
      expect(deps.audit).toBeInstanceOf(StdoutAuditSink);
      expect(deps.adapters.map((a) => a.id)).toEqual(['npm']);
      expect(deps.adapters[0]).toBeInstanceOf(NpmAdapter);
      expect(deps.upstream.origin).toBe('https://registry.npmjs.org');
      expect(deps.authorizer).toBeUndefined();
      expect(deps.packageSources).toBeUndefined();
    } finally {
      deps.dispose();
    }
  });

  it('uses overrides and does not build the parts they replace', async () => {
    // An unreadable tokens file would fail createAuth: an auth override must skip it.
    const c = await config({ AUTH_TOKENS_PATH: '/nonexistent/tokens' });
    const auth: AuthProvider = { required: true, authenticate: () => Promise.resolve(null) };
    const upstream: Upstream = {
      origin: 'https://example.invalid',
      request: () => Promise.reject(new Error('x')),
    };
    const audit = new RecordingAuditSink();
    const deps = await composeCommunity(c, { auth, upstream, audit, extensions: [] });
    expect(deps.auth).toBe(auth);
    expect(deps.upstream).toBe(upstream);
    expect(deps.audit).toBe(audit);
    expect(deps.extensions).toEqual([]);
    deps.dispose(); // must not touch the caller's upstream
  });

  it('reports configuration errors as ConfigError', async () => {
    await expect(
      composeCommunity(await config({ AUTH_TOKENS_PATH: '/nonexistent' })),
    ).rejects.toBeInstanceOf(ConfigError);
    const c = await config();
    expect(() => createAuth({ ...c, authTokensPath: '/nonexistent' })).toThrow(ConfigError);
    expect(() =>
      createPolicy({ ...c, allowlistPath: '/nonexistent' }, new RecordingAuditSink()),
    ).toThrow(ConfigError);
  });

  it('builds static-token auth, S3 storage and an age policy that can gate local packages', async () => {
    const c = await config();
    const tokens = join(dirs[0]!, 'tokens');
    await writeFile(tokens, JSON.stringify({ ci: 'a'.repeat(64) }));
    expect(createAuth({ ...c, authTokensPath: tokens })).toBeInstanceOf(StaticTokenAuth);
    const s3 = await config({
      STORAGE: 's3',
      S3_BUCKET: 'bucket',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    });
    expect(await createStorage(s3)).toBeInstanceOf(S3Storage);
    const audit = new RecordingAuditSink();
    const policy = createPolicy(c, audit, { gateLocal: true });
    const decision = policy.evaluate({
      ecosystem: 'npm',
      name: '@acme/lib',
      version: '1.0.0',
      publishedAt: Date.now(),
      now: Date.now(),
      origin: 'local',
    });
    expect(decision.allow).toBe(false);
  });
});
