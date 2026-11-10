// Environment parsing and validation (DESIGN.md section 10). Invalid config exits at startup
// with every problem listed at once. Secret values are never echoed in messages.
import { isIP } from 'node:net';
import { availableParallelism, hostname } from 'node:os';
import { parseNamePatterns } from './core/patterns.ts';
import { sanitizePod } from './stats/keys.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type StorageConfig =
  | { kind: 'fs'; root: string }
  | {
      kind: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

export interface Config {
  port: number;
  /** Separate port for /livez, /readyz and /metrics (never behind auth, not for clients). */
  managementPort: number;
  /**
   * Address the management port listens on (e.g. 127.0.0.1 or the pod IP); null = the same
   * as the registry port (all interfaces unless the caller passes a host).
   */
  managementHost: string | null;
  publicUrl: string;
  /**
   * PUBLIC_URL_ALIASES: further bases for requests whose Host header names them (documents get
   * this base instead of PUBLIC_URL); each host at most once and never PUBLIC_URL's own host.
   */
  publicUrlAliases: string[];
  upstreamUrl: string;
  storage: StorageConfig;
  minReleaseAgeMs: number;
  failClosed: boolean;
  allowlistPath: string | null;
  /** JSON rules of the package filter (block/allow by name and version range); null = off. */
  filterRulesPath: string | null;
  metadataTtlMs: number;
  lruMaxBytes: number;
  /** Gzip metadata responses for clients that accept it (http/compress.ts). */
  compressMetadata: boolean;
  /** Bytes of gzip metadata bodies kept for reuse, per worker; 0 keeps none. */
  compressCacheBytes: number;
  maxPackumentBytes: number;
  maxTarballBytes: number;
  /** Largest accepted write body (publish); only used when a PackageSource is configured. */
  maxPublishBytes: number;
  upstreamMaxConnections: number;
  upstreamTimeoutMs: number;
  /** Deadline for the whole upstream search request (`GET /-/v1/search`). */
  searchTimeoutMs: number;
  /** How long an upstream search result is reused; 0 disables the search cache. */
  searchCacheTtlMs: number;
  /** Upstream search requests per second on cache misses; 0 disables the limit. */
  searchUpstreamRps: number;
  /** Burst size of that limit. */
  searchUpstreamBurst: number;
  /** Background storage writes running at once per pod (metadata, sidecars, index entries). */
  storageWriteConcurrency: number;
  /** Background writes waiting for a slot; beyond this (or the byte cap) the least valuable are dropped. */
  storageWriteQueueMax: number;
  /** Bytes the waiting background writes may hold in memory. */
  storageWriteQueueBytes: number;
  /**
   * Bytes the streaming tarball writes may hold together; a miss over budget is served uncached.
   * S3 buffers each tarball until its PUT commits, so it defaults to 128 MiB there; FS writes to
   * disk as it streams, so 0 (no budget).
   */
  storageStreamBytes: number;
  /** I/O timeout of background storage writes (the request path keeps its shorter one). */
  storageBackgroundTimeoutMs: number;
  /** Metadata worker threads; each is a V8 isolate that holds the memory of what it parsed. */
  workers: number;
  /** Document bytes a metadata worker processes before it is replaced; 0 never replaces. */
  workerRecycleBytes: number;
  /**
   * Raw document bytes the metadata worker pool may hold (queued plus in progress); beyond it
   * metadata misses and publishes get 503 with Retry-After. 0 = no limit.
   */
  metadataQueueBytes: number;
  readyMaxLagMs: number;
  authTokensPath: string | null;
  /** Users (scrypt hashes) for npm login; null = no user accounts (C3). */
  usersFile: string | null;
  /** Self-registration through `npm adduser` (needs a writable USERS_FILE). */
  userRegistration: boolean;
  /** Self-registration stops when USERS_FILE holds this many users. */
  maxUsers: number;
  /** Lifetime of tokens issued by npm login (and the longest of created tokens). */
  userTokenTtlMs: number;
  /** How long a pod trusts a looked-up user token (revocation delay on other pods). */
  userTokenCacheTtlMs: number;
  /** With AUTH_TOKENS_PATH or USERS_FILE: reads need no token (writes still do). */
  anonymousRead: boolean;
  /** Reverse proxies in front of the cache whose X-Forwarded-For entry is trusted. */
  trustProxyHops: number;
  /** Names published to this registry (exact, `@scope/*`, `prefix*`); empty = read-only (C4). */
  privatePackages: string[];
  /** Versions of private packages can be unpublished this long after publishing; 0 never. */
  unpublishWindowMs: number;
  /** Also apply MIN_RELEASE_AGE to private packages (default: they are exempt). */
  minReleaseAgeLocal: boolean;
  /** Largest stored private package document. */
  maxPrivatePackumentBytes: number;
  /** Largest unpacked size of the tarballs of one publish (decompression cap). */
  maxUnpackedBytes: number;
  /** Accepts ANONYMOUS_READ with PRIVATE_PACKAGES: private packages readable by anyone. */
  allowAnonymousPrivateRead: boolean;
  /** Read-only web catalog under /-/web/ (C5). */
  webUi: boolean;
  /** Show https images in READMEs (loads them from third-party hosts). */
  webUiImages: boolean;
  /** Show the statistics page in the web catalog (needs WEB_UI and STATS_HISTORY). */
  webStats: boolean;
  /** Lifetime of a web catalog session. */
  webSessionTtlMs: number;
  /** Keep a statistics history in storage and serve it (/stats, catalog stats page). */
  statsHistory: boolean;
  /** Time between two history records of a pod. */
  statsIntervalMs: number;
  /** How long each history tier is kept; 0 = forever. */
  statsRetentionMinuteMs: number;
  statsRetentionHourMs: number;
  statsRetentionDayMs: number;
  /** This pod's id in history keys (POD_NAME, else the hostname), sanitized. */
  statsPod: string;
  logLevel: LogLevel;
  abbreviatedIncludeTime: boolean;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses `30s`, `30m`, `24h`, `3d` or `0`; returns null when invalid. */
export function parseDuration(input: string): number | null {
  if (input === '0') return 0;
  const m = /^(\d{1,9})([smhd])$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export type Env = Record<string, string | undefined>;

/**
 * Typed environment readers that record a problem instead of throwing, so every invalid
 * variable is reported at once. Another edition gets one through loadConfig's `extend`.
 */
export interface ConfigReader {
  /** The raw value; an empty string counts as unset. */
  readonly str: (key: string) => string | undefined;
  readonly int: (key: string, def: number, min: number, max?: number) => number;
  readonly bool: (key: string, def: boolean) => boolean;
  /** `30s`, `30m`, `24h`, `3d` or `0`, in ms. */
  readonly duration: (key: string, def: string) => number;
  /** Absolute http(s) URL without credentials, query or fragment; required without `def`. */
  readonly url: (key: string, def?: string) => string;
  /** Comma-separated list of such URLs; empty when unset. */
  readonly urls: (key: string) => string[];
  /** Record a problem of your own (e.g. a cross-field rule). */
  readonly problem: (message: string) => void;
}

export interface LoadConfigOptions<T> {
  /**
   * Parse the edition's own variables with the same reader. Runs after the community parser
   * (whose result it receives, possibly with defaults in place of invalid values) and before
   * any ConfigError is thrown, so both sets of problems are reported together.
   */
  extend: (read: ConfigReader, community: Config) => T;
}

export function loadConfig(env: Env): Config;
export function loadConfig<T>(
  env: Env,
  opts: LoadConfigOptions<T>,
): Config & { readonly extension: T };
export function loadConfig<T>(
  env: Env,
  opts?: LoadConfigOptions<T>,
): Config | (Config & { readonly extension: T }) {
  const problems: string[] = [];
  const read = createConfigReader(env, problems);
  const config = communityConfig(read, problems);
  if (!opts) {
    if (problems.length > 0) throw new ConfigError(problems);
    return config;
  }
  const extension = opts.extend(read, config);
  if (problems.length > 0) throw new ConfigError(problems);
  return { ...config, extension };
}

export function createConfigReader(env: Env, problems: string[]): ConfigReader {
  const str = (key: string): string | undefined => {
    const v = env[key];
    return v === undefined || v === '' ? undefined : v;
  };

  const int = (key: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return def;
    }
    return Number(raw);
  };

  const bool = (key: string, def: boolean): boolean => {
    const raw = str(key);
    if (raw === undefined) return def;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    problems.push(`${key} must be "true" or "false"`);
    return def;
  };

  const duration = (key: string, def: string): number => {
    const raw = str(key) ?? def;
    const ms = parseDuration(raw);
    if (ms === null) {
      problems.push(`${key} must be a duration like 30s, 30m, 24h, 3d or 0`);
      return parseDuration(def) ?? 0;
    }
    return ms;
  };

  const url = (key: string, def?: string): string => {
    const raw = str(key) ?? def;
    if (raw === undefined) {
      problems.push(`${key} is required`);
      return '';
    }
    return checkedUrl(key, raw);
  };

  const urls = (key: string): string[] =>
    (str(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .map((v) => checkedUrl(key, v));

  const checkedUrl = (key: string, raw: string): string => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      problems.push(`${key} must be an absolute http(s) URL`);
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`${key} must use http or https`);
    } else if (parsed.search || parsed.hash || parsed.username || parsed.password) {
      problems.push(`${key} must not contain credentials, a query or a fragment`);
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  };

  const problem = (message: string): void => {
    problems.push(message);
  };

  return { str, int, bool, duration, url, urls, problem };
}

function communityConfig(read: ConfigReader, problems: string[]): Config {
  const { str, int, bool, duration, url, urls } = read;
  const storageKind = str('STORAGE') ?? 'fs';
  let storage: StorageConfig = { kind: 'fs', root: str('FS_ROOT') ?? '/data' };
  if (storageKind === 's3') {
    const required = [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const;
    const missing = required.filter((k) => str(k) === undefined);
    if (missing.length > 0) problems.push(`STORAGE=s3 requires ${missing.join(', ')}`);
    storage = {
      kind: 's3',
      endpoint: missing.includes('S3_ENDPOINT') ? '' : url('S3_ENDPOINT'),
      region: str('S3_REGION') ?? '',
      bucket: str('S3_BUCKET') ?? '',
      accessKeyId: str('S3_ACCESS_KEY_ID') ?? '',
      secretAccessKey: str('S3_SECRET_ACCESS_KEY') ?? '',
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    };
  } else if (storageKind !== 'fs') {
    problems.push('STORAGE must be "fs" or "s3"');
  }

  if (
    storage.kind === 's3' &&
    storage.bucket &&
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket)
  ) {
    problems.push('S3_BUCKET is not a valid bucket name');
  }

  const logLevel = str('LOG_LEVEL') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push('LOG_LEVEL must be one of debug, info, warn, error');
  }

  const lruMaxBytes = int('LRU_MAX_BYTES', 268_435_456, 1);
  const config: Config = {
    port: int('PORT', 4873, 1, 65535),
    managementPort: int('MANAGEMENT_PORT', 9090, 1, 65535),
    managementHost: str('MANAGEMENT_HOST') ?? null,
    publicUrl: url('PUBLIC_URL'),
    publicUrlAliases: urls('PUBLIC_URL_ALIASES'),
    upstreamUrl: url('UPSTREAM_URL', 'https://registry.npmjs.org'),
    storage,
    minReleaseAgeMs: duration('MIN_RELEASE_AGE', '3d'),
    failClosed: bool('FAIL_CLOSED', true),
    allowlistPath: str('ALLOWLIST_PATH') ?? null,
    filterRulesPath: str('FILTER_RULES_PATH') ?? null,
    metadataTtlMs: duration('METADATA_TTL', '5m'),
    lruMaxBytes,
    compressMetadata: bool('COMPRESS_METADATA', true),
    compressCacheBytes: int('COMPRESS_CACHE_BYTES', 16_777_216, 0),
    maxPackumentBytes: int('MAX_PACKUMENT_BYTES', 104_857_600, 1),
    maxTarballBytes: int('MAX_TARBALL_BYTES', 524_288_000, 1),
    maxPublishBytes: int('MAX_PUBLISH_BYTES', 104_857_600, 1),
    upstreamMaxConnections: int('UPSTREAM_MAX_CONNECTIONS', 64, 1, 10_000),
    upstreamTimeoutMs: duration('UPSTREAM_TIMEOUT', '30s'),
    searchTimeoutMs: duration('SEARCH_TIMEOUT', '10s'),
    searchCacheTtlMs: duration('SEARCH_CACHE_TTL', '60s'),
    searchUpstreamRps: int('SEARCH_UPSTREAM_RPS', 5, 0, 10_000),
    searchUpstreamBurst: int('SEARCH_UPSTREAM_BURST', 20, 1, 100_000),
    storageWriteConcurrency: int('STORAGE_WRITE_CONCURRENCY', 16, 1, 256),
    storageWriteQueueMax: int('STORAGE_WRITE_QUEUE_MAX', 4096, 1, 1_000_000),
    storageWriteQueueBytes: int('STORAGE_WRITE_QUEUE_BYTES', 134_217_728, 1),
    storageStreamBytes: int('STORAGE_STREAM_BYTES', storageKind === 's3' ? 134_217_728 : 0, 0),
    storageBackgroundTimeoutMs: duration('STORAGE_BACKGROUND_TIMEOUT', '120s'),
    // Not one per core: every worker's isolate keeps up to hundreds of MB after large
    // packuments, and two keep up with a burst of cold installs (docs/OPERATIONS.md).
    workers: int('WORKERS', Math.max(1, Math.min(2, availableParallelism() - 1)), 1, 1024),
    workerRecycleBytes: int('WORKER_RECYCLE_BYTES', 67_108_864, 0),
    metadataQueueBytes: int('METADATA_QUEUE_BYTES', 2 * lruMaxBytes, 0),
    readyMaxLagMs: int('READY_MAX_LAG_MS', 200, 1),
    authTokensPath: str('AUTH_TOKENS_PATH') ?? null,
    usersFile: str('USERS_FILE') ?? null,
    userRegistration: bool('USER_REGISTRATION', false),
    maxUsers: int('MAX_USERS', 1000, 1, 100_000),
    userTokenTtlMs: duration('USER_TOKEN_TTL', '90d'),
    userTokenCacheTtlMs: duration('USER_TOKEN_CACHE_TTL', '30s'),
    anonymousRead: bool('ANONYMOUS_READ', false),
    trustProxyHops: int('TRUST_PROXY_HOPS', 0, 0, 10),
    privatePackages: [],
    unpublishWindowMs: duration('UNPUBLISH_WINDOW', '72h'),
    minReleaseAgeLocal: bool('MIN_RELEASE_AGE_LOCAL', false),
    maxPrivatePackumentBytes: int('MAX_PRIVATE_PACKUMENT_BYTES', 16_777_216, 1024),
    maxUnpackedBytes: int('MAX_UNPACKED_BYTES', 268_435_456, 1024),
    allowAnonymousPrivateRead: bool('ALLOW_ANONYMOUS_PRIVATE_READ', false),
    webUi: bool('WEB_UI', false),
    webUiImages: bool('WEB_UI_IMAGES', false),
    webStats: bool('WEB_STATS', true),
    webSessionTtlMs: duration('WEB_SESSION_TTL', '1h'),
    statsHistory: bool('STATS_HISTORY', true),
    statsIntervalMs: duration('STATS_INTERVAL', '60s'),
    statsRetentionMinuteMs: duration('STATS_RETENTION_MINUTE', '7d'),
    statsRetentionHourMs: duration('STATS_RETENTION_HOUR', '90d'),
    statsRetentionDayMs: duration('STATS_RETENTION_DAY', '0'),
    statsPod: sanitizePod(str('POD_NAME') ?? hostname()),
    logLevel: logLevel as LogLevel,
    abbreviatedIncludeTime: bool('ABBREVIATED_INCLUDE_TIME', false),
  };

  if (config.port === config.managementPort) {
    problems.push('MANAGEMENT_PORT must differ from PORT');
  }
  if (
    config.managementHost !== null &&
    isIP(config.managementHost) === 0 &&
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
      config.managementHost,
    )
  ) {
    problems.push('MANAGEMENT_HOST must be an IP address or a host name');
  }
  // One base per host: the Host header selects the alias.
  const hostOf = (u: string): string | null => URL.parse(u)?.host || null;
  const aliasHosts = new Set<string>();
  for (const alias of config.publicUrlAliases) {
    const host = hostOf(alias);
    if (host === null) continue; // already reported as invalid
    if (host === hostOf(config.publicUrl) || aliasHosts.has(host)) {
      problems.push(`PUBLIC_URL_ALIASES names the host ${host} twice (or PUBLIC_URL's own host)`);
    }
    aliasHosts.add(host);
  }
  if (config.upstreamTimeoutMs === 0) problems.push('UPSTREAM_TIMEOUT must be greater than 0');
  if (config.storageBackgroundTimeoutMs === 0) {
    problems.push('STORAGE_BACKGROUND_TIMEOUT must be greater than 0');
  }
  if (config.searchTimeoutMs === 0) problems.push('SEARCH_TIMEOUT must be greater than 0');
  if (config.userTokenTtlMs === 0) problems.push('USER_TOKEN_TTL must be greater than 0');
  const owned = str('PRIVATE_PACKAGES');
  if (owned !== undefined) {
    const patterns = parseNamePatterns(owned);
    if (patterns === null || patterns.includes('*')) {
      problems.push(
        'PRIVATE_PACKAGES must be comma-separated names, @scope/* or prefix* patterns (not "*")',
      );
    } else {
      config.privatePackages = patterns;
    }
  }
  // There are no per-package read permissions: anonymous reads include private packages.
  if (
    config.anonymousRead &&
    config.privatePackages.length > 0 &&
    !config.allowAnonymousPrivateRead
  ) {
    problems.push(
      'ANONYMOUS_READ=true with PRIVATE_PACKAGES lets anyone read the private packages; set ALLOW_ANONYMOUS_PRIVATE_READ=true to accept that',
    );
  }
  if (config.webSessionTtlMs === 0 || config.webSessionTtlMs > 7 * 86_400_000) {
    problems.push('WEB_SESSION_TTL must be between 1s and 7d');
  }
  if (config.statsIntervalMs < 10_000 || config.statsIntervalMs > 3_600_000) {
    problems.push('STATS_INTERVAL must be between 10s and 1h');
  }
  if (config.statsRetentionMinuteMs < 3_600_000) {
    problems.push('STATS_RETENTION_MINUTE must be at least 1h');
  }
  if (config.statsRetentionHourMs < 86_400_000) {
    problems.push('STATS_RETENTION_HOUR must be at least 1d');
  }
  if (config.statsRetentionDayMs !== 0 && config.statsRetentionDayMs < 7 * 86_400_000) {
    problems.push('STATS_RETENTION_DAY must be 0 or at least 7d');
  }
  if (config.unpublishWindowMs > 365 * 86_400_000) {
    problems.push('UNPUBLISH_WINDOW must be at most 365d');
  }
  if (config.userRegistration && !config.usersFile) {
    problems.push('USER_REGISTRATION=true requires USERS_FILE');
  }
  return config;
}
