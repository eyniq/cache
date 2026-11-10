// The public API that downstream builds consume (git submodule, package exports map).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

const EXPECTED: Record<string, string[]> = {
  '@eyniq/cache': [
    'createServer',
    'FsStorage',
    'S3Storage',
    'NoAuth',
    'StaticTokenAuth',
    'MinReleaseAgePolicy',
    'StdoutAuditSink',
    'NpmAdapter',
    'createUpstream',
    'loadConfig',
    'parseDuration',
    'ConfigError',
    'log',
    'setLogLevel',
    'errorFields',
    'HttpError',
    'WorkerPool',
    'InlineProcessor',
    'composePolicies',
    'auditEvent',
    'isStorageAdmin',
    'ConditionalWritesUnsupported',
    'composeCommunity',
    'createStorage',
    'createAuth',
    'createPolicy',
    'renderMarkdown',
    'StatsReader',
    'STATS_RANGES',
    'UsersFile',
    'verifyPassword',
    'checkPasswordPolicy',
    'LoginLimiter',
    'npm',
  ],
  '@eyniq/cache/defaults': [
    'FsStorage',
    'S3Storage',
    'NoAuth',
    'StaticTokenAuth',
    'loadTokens',
    'DefaultAuthorizer',
    'MinReleaseAgePolicy',
    'loadAllowlist',
    'StdoutAuditSink',
    'NpmAdapter',
    'createUpstream',
    'composeCommunity',
    'createStorage',
    'createAuth',
    'createPolicy',
    'createAdapters',
    'createDefaultUpstream',
    'createUserAccounts',
    'createPackageSources',
    'CommunityAuthorizer',
    'LookupLimiter',
    'UserAccounts',
    'UserAuth',
    'UserTokenStore',
    'UsersFile',
    'npm',
  ],
  // Narrow npm entry: worker-thread modules import it instead of the whole defaults barrel.
  '@eyniq/cache/npm': [
    'processMetadata',
    'renderMetadata',
    'parseWriteBody',
    'parseIntegrity',
    'FULL_CONTENT_TYPE',
    'ABBREVIATED_CONTENT_TYPE',
    'isValidPackageName',
    'isValidVersion',
    'isValidTag',
    'isValidTarballFile',
    'isValidRev',
    'unscopedName',
    'compareVersions',
    'prereleaseChannel',
    'NpmPrivateSource',
    'inspectTarball',
    'npmCatalog',
  ],
  '@eyniq/cache/config': ['loadConfig', 'parseDuration', 'ConfigError', 'createConfigReader'],
  '@eyniq/cache/log': ['log', 'setLogLevel', 'errorFields', 'captureLogs'],
  '@eyniq/cache/testing': [
    'FakeUpstream',
    'makeTarball',
    'sha512Integrity',
    'sha1Hex',
    'send',
    'json',
    'storageConformance',
    'RecordingAuditSink',
    'policyConformance',
  ],
  // Types only: importing it must still work at runtime.
  '@eyniq/cache/contracts': [],
};

describe('public API', () => {
  it('declares an exports map for every entry point and stays private', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      private?: boolean;
      exports?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    for (const entry of [
      '.',
      './contracts',
      './defaults',
      './config',
      './log',
      './testing',
      './npm',
    ]) {
      expect(pkg.exports?.[entry], entry).toMatch(/^\.\/src\/.+\.ts$/);
    }
  });

  it('resolves every entry by package name in a plain Node process', () => {
    // A separate process uses Node's own resolver (self-reference through `exports`), exactly
    // what a consumer that links this repo as a submodule gets.
    const script = `
      const expected = ${JSON.stringify(EXPECTED)};
      const missing = [];
      for (const [spec, names] of Object.entries(expected)) {
        const mod = await import(spec);
        for (const n of names) if (!(n in mod)) missing.push(spec + ':' + n);
      }
      process.stdout.write(JSON.stringify(missing));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    expect(JSON.parse(out)).toEqual([]);
  });

  it('keeps the npm entry free of the server and the barrels (it runs in worker threads)', () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:^|\n)(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
        walk(join(dirname(file), m[1]!));
      }
    };
    walk(join(root, 'src', 'adapters', 'npm', 'public.ts'));
    const files = [...seen].map((f) => f.slice(root.length + 1));
    expect(files).toEqual(
      expect.arrayContaining(['src/adapters/npm/publish.ts', 'src/core/errors.ts']),
    );
    expect(
      files.filter((f) =>
        /^src\/(http|metadata|storage|auth)\/|^src\/(main|compose|defaults|index)\.ts$/.test(f),
      ),
    ).toEqual([]);
  });

  it('keeps test helpers out of the production entry points', async () => {
    const main = await import('../../src/index.ts');
    expect('FakeUpstream' in main).toBe(false);
    expect('storageConformance' in main).toBe(false);
  });
});
