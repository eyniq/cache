import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseDuration } from '../../src/config.ts';

const base = { PUBLIC_URL: 'http://localhost:4873' };

describe('config', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 4873,
      publicUrl: 'http://localhost:4873',
      upstreamUrl: 'https://registry.npmjs.org',
      storage: { kind: 'fs', root: '/data' },
      minReleaseAgeMs: 3 * 24 * 3600_000,
      failClosed: true,
      allowlistPath: null,
      filterRulesPath: null,
      metadataTtlMs: 5 * 60_000,
      lruMaxBytes: 268435456,
      maxPackumentBytes: 104857600,
      maxTarballBytes: 524288000,
      maxPublishBytes: 104857600,
      upstreamMaxConnections: 64,
      upstreamTimeoutMs: 30_000,
      searchTimeoutMs: 10_000,
      searchCacheTtlMs: 60_000,
      searchUpstreamRps: 5,
      searchUpstreamBurst: 20,
      workers: Math.max(1, Math.min(2, availableParallelism() - 1)),
      workerRecycleBytes: 67108864,
      metadataQueueBytes: 2 * 268435456,
      managementHost: null,
      readyMaxLagMs: 200,
      authTokensPath: null,
      logLevel: 'info',
      abbreviatedIncludeTime: false,
    });
  });

  it('applies the user store defaults (C3) and validates them', () => {
    expect(loadConfig(base)).toMatchObject({
      usersFile: null,
      userRegistration: false,
      maxUsers: 1000,
      userTokenTtlMs: 90 * 86_400_000,
      userTokenCacheTtlMs: 30_000,
      anonymousRead: false,
      trustProxyHops: 0,
    });
    expect(() => loadConfig({ ...base, USER_REGISTRATION: 'true' })).toThrow(/USERS_FILE/);
    expect(() => loadConfig({ ...base, USER_TOKEN_TTL: '0' })).toThrow(/USER_TOKEN_TTL/);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: '11' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(
      loadConfig({ ...base, USERS_FILE: '/etc/eyniq/users.json', USER_REGISTRATION: 'true' }),
    ).toMatchObject({ usersFile: '/etc/eyniq/users.json', userRegistration: true });
  });

  it('parses private package settings (C4)', () => {
    expect(loadConfig(base)).toMatchObject({
      privatePackages: [],
      unpublishWindowMs: 72 * 3600_000,
      minReleaseAgeLocal: false,
      maxPrivatePackumentBytes: 16 * 1024 * 1024,
      maxUnpackedBytes: 256 * 1024 * 1024,
      allowAnonymousPrivateRead: false,
    });
    expect(
      loadConfig({ ...base, PRIVATE_PACKAGES: ' @acme/* , internal-cli,tool-* ' }).privatePackages,
    ).toEqual(['@acme/*', 'internal-cli', 'tool-*']);
    expect(() => loadConfig({ ...base, PRIVATE_PACKAGES: '*' })).toThrow(/PRIVATE_PACKAGES/);
    expect(() => loadConfig({ ...base, PRIVATE_PACKAGES: 'a b' })).toThrow(/PRIVATE_PACKAGES/);
    expect(() => loadConfig({ ...base, UNPUBLISH_WINDOW: '400d' })).toThrow(/UNPUBLISH_WINDOW/);
    expect(loadConfig({ ...base, UNPUBLISH_WINDOW: '0' }).unpublishWindowMs).toBe(0);
  });

  it('refuses ANONYMOUS_READ with PRIVATE_PACKAGES unless explicitly accepted', () => {
    const open = { ...base, PRIVATE_PACKAGES: '@acme/*', ANONYMOUS_READ: 'true' };
    expect(() => loadConfig(open)).toThrow(/ALLOW_ANONYMOUS_PRIVATE_READ/);
    expect(
      loadConfig({ ...open, ALLOW_ANONYMOUS_PRIVATE_READ: 'true' }).allowAnonymousPrivateRead,
    ).toBe(true);
    expect(() => loadConfig({ ...base, ANONYMOUS_READ: 'true' })).not.toThrow();
  });

  it('parses web catalog settings (C5)', () => {
    expect(loadConfig(base)).toMatchObject({
      webUi: false,
      webUiImages: false,
      webSessionTtlMs: 3600_000,
    });
    expect(loadConfig({ ...base, WEB_UI: 'true', WEB_SESSION_TTL: '8h' })).toMatchObject({
      webUi: true,
      webSessionTtlMs: 8 * 3600_000,
    });
    expect(() => loadConfig({ ...base, WEB_SESSION_TTL: '0' })).toThrow(/WEB_SESSION_TTL/);
    expect(() => loadConfig({ ...base, WEB_SESSION_TTL: '8d' })).toThrow(/WEB_SESSION_TTL/);
  });

  it('requires PUBLIC_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/PUBLIC_URL/);
  });

  it('strips a trailing slash from PUBLIC_URL and UPSTREAM_URL', () => {
    const c = loadConfig({
      PUBLIC_URL: 'https://cache.example/npm/',
      UPSTREAM_URL: 'https://r.example/',
    });
    expect(c.publicUrl).toBe('https://cache.example/npm');
    expect(c.upstreamUrl).toBe('https://r.example');
  });

  it('parses PUBLIC_URL_ALIASES (none by default)', () => {
    expect(loadConfig(base).publicUrlAliases).toEqual([]);
    const c = loadConfig({
      ...base,
      PUBLIC_URL_ALIASES: ' https://npm.example.com/ , http://10.0.0.5:4873 ',
    });
    expect(c.publicUrlAliases).toEqual(['https://npm.example.com', 'http://10.0.0.5:4873']);
  });

  it.each([
    'ftp://x',
    'not a url',
    'https://x/?a=1',
    'http://localhost:4873',
    'https://a.example,https://a.example/other',
  ])('rejects PUBLIC_URL_ALIASES %s', (v) => {
    expect(() => loadConfig({ ...base, PUBLIC_URL_ALIASES: v })).toThrow(/PUBLIC_URL_ALIASES/);
  });

  it.each(['ftp://x', 'not a url', 'http://x/?a=1', 'http://user:pw@x/'])(
    'rejects PUBLIC_URL %s',
    (v) => {
      expect(() => loadConfig({ PUBLIC_URL: v })).toThrow(ConfigError);
    },
  );

  it.each([
    ['30m', 30 * 60_000],
    ['24h', 24 * 3600_000],
    ['3d', 3 * 24 * 3600_000],
    ['30s', 30_000],
    ['0', 0],
  ])('parses duration %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['abc', '-1h', '3w', '1.5h', '', '10'])('rejects duration %j', (input) => {
    expect(parseDuration(input)).toBeNull();
  });

  it('collects every problem in one error', () => {
    try {
      loadConfig({ ...base, PORT: 'x', FAIL_CLOSED: 'maybe', LRU_MAX_BYTES: '-5' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/PORT/);
      expect(msg).toMatch(/FAIL_CLOSED/);
      expect(msg).toMatch(/LRU_MAX_BYTES/);
    }
  });

  it.each(['0', '70000', '1.5'])('rejects PORT %s', (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow(/PORT/);
  });

  it('parses booleans strictly', () => {
    expect(loadConfig({ ...base, FAIL_CLOSED: 'false' }).failClosed).toBe(false);
    expect(loadConfig({ ...base, ABBREVIATED_INCLUDE_TIME: 'true' }).abbreviatedIncludeTime).toBe(
      true,
    );
  });

  it('requires the S3 settings when STORAGE=s3 and never echoes the secret', () => {
    const secret = 'super-secret-value-123';
    try {
      loadConfig({ ...base, STORAGE: 's3', S3_SECRET_ACCESS_KEY: secret });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/S3_BUCKET/);
      expect(msg).not.toContain(secret);
    }
  });

  it('budgets streaming tarball writes only for S3, which buffers them (STORAGE_STREAM_BYTES)', () => {
    const s3 = {
      ...base,
      STORAGE: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'cache',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
    };
    expect(loadConfig(base).storageStreamBytes).toBe(0);
    expect(loadConfig(s3).storageStreamBytes).toBe(134217728);
    expect(loadConfig({ ...s3, STORAGE_STREAM_BYTES: '0' }).storageStreamBytes).toBe(0);
    expect(loadConfig({ ...base, STORAGE_STREAM_BYTES: '1048576' }).storageStreamBytes).toBe(
      1048576,
    );
  });

  it('accepts a full S3 configuration', () => {
    const c = loadConfig({
      ...base,
      STORAGE: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'cache',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(c.storage).toEqual({
      kind: 's3',
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'cache',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });
  });

  it('rejects an unknown STORAGE and LOG_LEVEL', () => {
    expect(() => loadConfig({ ...base, STORAGE: 'redis' })).toThrow(/STORAGE/);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('requires WORKERS to be at least 1', () => {
    expect(() => loadConfig({ ...base, WORKERS: '0' })).toThrow(/WORKERS/);
    expect(loadConfig({ ...base, WORKERS: '3' }).workers).toBe(3);
  });

  it('derives METADATA_QUEUE_BYTES from LRU_MAX_BYTES and accepts 0', () => {
    expect(loadConfig({ ...base, LRU_MAX_BYTES: '1000' }).metadataQueueBytes).toBe(2000);
    expect(loadConfig({ ...base, METADATA_QUEUE_BYTES: '0' }).metadataQueueBytes).toBe(0);
    expect(loadConfig({ ...base, METADATA_QUEUE_BYTES: '5000' }).metadataQueueBytes).toBe(5000);
    expect(() => loadConfig({ ...base, METADATA_QUEUE_BYTES: '-1' })).toThrow(
      /METADATA_QUEUE_BYTES/,
    );
  });

  it('takes MANAGEMENT_HOST as an IP address or host name', () => {
    expect(loadConfig({ ...base, MANAGEMENT_HOST: '127.0.0.1' }).managementHost).toBe('127.0.0.1');
    expect(loadConfig({ ...base, MANAGEMENT_HOST: '::1' }).managementHost).toBe('::1');
    expect(loadConfig({ ...base, MANAGEMENT_HOST: 'localhost' }).managementHost).toBe('localhost');
    for (const bad of ['http://127.0.0.1', '127.0.0.1:9090', 'a b', '-x']) {
      expect(() => loadConfig({ ...base, MANAGEMENT_HOST: bad })).toThrow(/MANAGEMENT_HOST/);
    }
  });

  it('configures the statistics history', () => {
    expect(loadConfig(base)).toMatchObject({
      statsHistory: true,
      statsIntervalMs: 60_000,
      statsRetentionMinuteMs: 7 * 86_400_000,
      statsRetentionHourMs: 90 * 86_400_000,
      statsRetentionDayMs: 0,
    });
    const c = loadConfig({
      ...base,
      STATS_HISTORY: 'false',
      STATS_INTERVAL: '10s',
      POD_NAME: 'a/b c',
    });
    expect(c.statsHistory).toBe(false);
    expect(c.statsIntervalMs).toBe(10_000);
    expect(c.statsPod).toMatch(/^a-b-c-[0-9a-f]{6}$/);
    expect(() => loadConfig({ ...base, STATS_INTERVAL: '5s' })).toThrow(/STATS_INTERVAL/);
    expect(() => loadConfig({ ...base, STATS_HISTORY: 'maybe' })).toThrow(/STATS_HISTORY/);
  });

  it('refuses statistics retention shorter than the pages and rollups need', () => {
    expect(() => loadConfig({ ...base, STATS_RETENTION_MINUTE: '30m' })).toThrow(
      /STATS_RETENTION_MINUTE/,
    );
    expect(() => loadConfig({ ...base, STATS_RETENTION_HOUR: '12h' })).toThrow(
      /STATS_RETENTION_HOUR/,
    );
    expect(() => loadConfig({ ...base, STATS_RETENTION_DAY: '3d' })).toThrow(/STATS_RETENTION_DAY/);
    const ok = loadConfig({
      ...base,
      STATS_RETENTION_MINUTE: '1h',
      STATS_RETENTION_HOUR: '1d',
      STATS_RETENTION_DAY: '7d',
    });
    expect(ok.statsRetentionDayMs).toBe(7 * 86_400_000);
    expect(loadConfig({ ...base, STATS_RETENTION_DAY: '0' }).statsRetentionDayMs).toBe(0);
  });
});
