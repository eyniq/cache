// Community composition: the parts src/main.ts runs with, exported (through
// `@eyniq/cache/defaults`) so another edition composes exactly the same defaults and replaces
// only what it overrides. Nothing inside src imports this file except main.ts.
// eslint-disable-next-line no-restricted-imports -- composition entry, like src/main.ts
import { NpmAdapter } from './adapters/npm/index.ts';
// eslint-disable-next-line no-restricted-imports -- composition entry, like src/main.ts
import { NpmPrivateSource } from './adapters/npm/private-source.ts';
// eslint-disable-next-line no-restricted-imports -- composition entry, like src/main.ts
import {
  PackageFilterPolicy,
  broadAllowRules,
  loadFilterRules,
} from './adapters/npm/package-filter.ts';
import { access, constants } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CommunityAuthorizer } from './auth/community-authorizer.ts';
import { LoginLimiter } from './auth/login-limiter.ts';
import { LookupLimiter } from './auth/lookup-limiter.ts';
import { NoAuth } from './auth/none.ts';
import { StaticTokenAuth, loadTokens } from './auth/static-token.ts';
import { UserAccounts } from './auth/user-accounts.ts';
import { UserAuth } from './auth/user-auth.ts';
import { UserTokenStore } from './auth/user-tokens.ts';
import { UsersFile, generationOf } from './auth/users.ts';
import { ConfigError, type Config } from './config.ts';
import { StdoutAuditSink, auditEvent } from './core/audit.ts';
import type {
  AuditSink,
  AuthProvider,
  EcosystemAdapter,
  PackageSource,
  Policy,
  ServerDeps,
  Storage,
  Upstream,
  WebLogin,
} from './core/contracts.ts';
import { errorFields, log } from './core/log.ts';
import { isStorageAdmin } from './core/storage.ts';
import { clientAddress } from './http/client-address.ts';
import { createUpstream, type ClosableUpstream } from './core/upstream.ts';
import { composePolicies } from './policy/compose.ts';
import { loadAllowlist, type AllowlistEntry } from './policy/allowlist.ts';
import { MinReleaseAgePolicy } from './policy/min-release-age.ts';
import { FsStorage } from './storage/fs.ts';
import { S3Storage } from './storage/s3.ts';

/** FsStorage (stale temp files swept) or S3Storage, as configured by STORAGE. */
export async function createStorage(config: Config): Promise<Storage> {
  if (config.storage.kind === 's3') {
    const { hostname, protocol } = new URL(config.storage.endpoint);
    if (protocol === 'http:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      log.warn(
        'S3_ENDPOINT uses plain http: credentials are signed but stored objects can be swapped in transit',
      );
    }
    return new S3Storage(config.storage);
  }
  const fs = new FsStorage(config.storage.root);
  const swept = await fs.sweepTemp().catch((err: unknown) => {
    log.warn('could not sweep temp files', errorFields(err));
    return 0;
  });
  if (swept > 0) log.info('removed stale temp files', { count: swept });
  return fs;
}

/**
 * StaticTokenAuth when AUTH_TOKENS_PATH is set, otherwise NoAuth. With ANONYMOUS_READ the
 * tokens are optional for reads. Throws ConfigError.
 */
export function createAuth(config: Config): AuthProvider {
  if (!config.authTokensPath) return new NoAuth();
  try {
    return new StaticTokenAuth(loadTokens(config.authTokensPath), {
      required: !config.anonymousRead,
    });
  } catch (err) {
    throw new ConfigError([
      `AUTH_TOKENS_PATH: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
}

/**
 * The minimum release age gate with the ALLOWLIST_PATH exceptions; expired allowlist entries
 * are audited as allowlist.expired. With FILTER_RULES_PATH the package filter runs first
 * (composePolicies) and its allow rules also lift the age gate for the versions they name.
 * Throws ConfigError.
 */
export function createPolicy(
  config: Config,
  audit: AuditSink,
  opts: { gateLocal?: boolean } = {},
): Policy {
  let allowlist: AllowlistEntry[] = [];
  if (config.allowlistPath) {
    try {
      const parsed = loadAllowlist(config.allowlistPath, Date.now());
      allowlist = parsed.entries;
      for (const e of parsed.expired) {
        audit.record(
          auditEvent('allowlist.expired', {
            name: e.package,
            version: e.version,
            expires: new Date(e.expires).toISOString(),
          }),
        );
      }
    } catch (err) {
      throw new ConfigError([
        `ALLOWLIST_PATH: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  }
  let filter: PackageFilterPolicy | null = null;
  if (config.filterRulesPath) {
    try {
      const rules = loadFilterRules(config.filterRulesPath);
      for (const r of broadAllowRules(rules)) {
        log.warn('package filter allow rule disables the minimum release age gate', {
          rule: r.id,
          package: r.package,
        });
      }
      filter = new PackageFilterPolicy(rules);
    } catch (err) {
      throw new ConfigError([
        `FILTER_RULES_PATH: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  }
  const gate = new MinReleaseAgePolicy({
    minAgeMs: config.minReleaseAgeMs,
    failClosed: config.failClosed,
    allowlist,
    gateLocal: opts.gateLocal ?? config.minReleaseAgeLocal,
    ...(filter ? { exempt: (input) => filter.exemption(input) } : {}),
  });
  return filter ? composePolicies(filter, gate) : gate;
}

/** The user store parts (C3), composed by createUserAccounts. */
export interface UserAccountParts {
  users: UsersFile;
  tokens: UserTokenStore;
  limiter: LoginLimiter;
  /** User tokens, with the static tokens of AUTH_TOKENS_PATH accepted next to them. */
  auth: UserAuth;
  accounts: UserAccounts;
  authorizer: CommunityAuthorizer;
  /** Sign-in for the web catalog (used when WEB_UI is on). */
  webLogin: WebLogin;
}

/**
 * Users and npm login (USERS_FILE): null when it is not set. The storage must support
 * StorageAdmin (FsStorage, S3Storage): tokens live there as sha256 records. Throws
 * ConfigError for an unusable users file or storage.
 */
export async function createUserAccounts(
  config: Config,
  storage: Storage,
  opts: { fallbackAuth?: AuthProvider } = {},
): Promise<UserAccountParts | null> {
  if (!config.usersFile) return null;
  const problem = (message: string): ConfigError => new ConfigError([`USERS_FILE: ${message}`]);
  let users: UsersFile;
  try {
    users = await UsersFile.open(config.usersFile, { allowMissing: config.userRegistration });
  } catch (err) {
    throw problem(err instanceof Error ? err.message : String(err));
  }
  if (config.userRegistration) {
    try {
      await access(dirname(config.usersFile), constants.W_OK);
    } catch {
      throw problem('USER_REGISTRATION needs a writable directory for the users file');
    }
  }
  if (!isStorageAdmin(storage)) {
    throw problem('user tokens need storage with compare-and-swap (fs or s3)');
  }
  const fallback = opts.fallbackAuth ?? (config.authTokensPath ? createAuth(config) : undefined);
  const tokens = new UserTokenStore({
    storage,
    cacheTtlMs: config.userTokenCacheTtlMs,
    lookupLimiter: new LookupLimiter(),
  });
  const limiter = new LoginLimiter();
  const auth = new UserAuth({
    users,
    tokens,
    required: !config.anonymousRead,
    addressOf: (req) => clientAddress(req, config.trustProxyHops),
    ...(fallback ? { fallback } : {}),
  });
  const accounts = new UserAccounts({
    users,
    tokens,
    limiter,
    tokenTtlMs: config.userTokenTtlMs,
    registration: { enabled: config.userRegistration, maxUsers: config.maxUsers },
    stillValid: (record) => auth.stillValid(record),
  });
  const authorizer = new CommunityAuthorizer({ auth, users });
  // Web catalog sign-in (WEB_UI) with the same password checks and limits as npm login.
  // Sessions carry the user's generation: a password change ends them, as it ends tokens.
  const webLogin: WebLogin = {
    async login(name, password, ctx) {
      const user = await accounts.passwordUser(name, password, ctx.clientAddress);
      return user
        ? { name, claims: { via: 'web-session', stamp: String(generationOf(user)) } }
        : null;
    },
    isValid(name, _issuedAt, stamp) {
      const user = users.get(name);
      return user !== undefined && stamp === String(generationOf(user));
    },
  };
  if (config.userRegistration) {
    log.warn('USER_REGISTRATION is on: anyone who reaches the registry can create a user', {
      maxUsers: config.maxUsers,
    });
  }
  return { users, tokens, limiter, auth, accounts, authorizer, webLogin };
}

/**
 * Private npm packages (PRIVATE_PACKAGES): `{ npm: NpmPrivateSource }`, or undefined when no
 * names are claimed. Needs StorageAdmin storage (compare-and-swap). Throws ConfigError.
 */
export function createPackageSources(
  config: Config,
  storage: Storage,
): Record<string, PackageSource> | undefined {
  if (config.privatePackages.length === 0) return undefined;
  if (!isStorageAdmin(storage)) {
    throw new ConfigError([
      'PRIVATE_PACKAGES: private packages need storage with compare-and-swap (fs or s3)',
    ]);
  }
  if (!config.usersFile) {
    log.warn(
      'PRIVATE_PACKAGES is set without USERS_FILE: the names are reserved, nobody can publish',
    );
  }
  if (config.anonymousRead) {
    log.warn(
      'ANONYMOUS_READ with ALLOW_ANONYMOUS_PRIVATE_READ: ANYONE who reaches the registry can read the private packages',
      { privatePackages: config.privatePackages },
    );
  }
  storage.capabilities().then(
    (c) => {
      if (!c.conditionalWrites) {
        log.error('storage does not enforce conditional writes: publishing will fail');
      }
    },
    (err: unknown) => {
      log.warn('could not probe storage capabilities', errorFields(err));
    },
  );
  return {
    npm: new NpmPrivateSource({
      storage,
      packages: config.privatePackages,
      unpublishWindowMs: config.unpublishWindowMs,
      maxDocumentBytes: config.maxPrivatePackumentBytes,
      maxUnpackedBytes: config.maxUnpackedBytes,
    }),
  };
}

/** The community adapters: npm. */
export function createAdapters(config: Config): EcosystemAdapter[] {
  return [new NpmAdapter({ abbreviatedIncludeTime: config.abbreviatedIncludeTime })];
}

/** The shared upstream (UPSTREAM_URL), forwarding the adapters' extra headers. */
export function createDefaultUpstream(
  config: Config,
  adapters: readonly EcosystemAdapter[],
): ClosableUpstream {
  return createUpstream({
    url: config.upstreamUrl,
    maxConnections: config.upstreamMaxConnections,
    timeoutMs: config.upstreamTimeoutMs,
    extraHeaders: adapters.flatMap((a) => a.forwardHeaders),
  });
}

export interface CommunityDeps extends ServerDeps {
  /**
   * Releases what composeCommunity created itself (the upstream connection pool), after the
   * server closed. Parts passed in as overrides belong to the caller and are left alone.
   */
  dispose(): void;
}

/**
 * ServerDeps of the community build. Every field of `overrides` replaces the default, and a
 * replaced default is never built (so e.g. an auth override does not read AUTH_TOKENS_PATH).
 * `config` drives every default part; `overrides.config` only changes ServerDeps.config.
 * Throws ConfigError for unusable configuration files.
 */
export async function composeCommunity(
  config: Config,
  overrides: Partial<ServerDeps> = {},
): Promise<CommunityDeps> {
  const audit = overrides.audit ?? new StdoutAuditSink();
  const adapters = overrides.adapters ?? createAdapters(config);
  const policy = overrides.policy ?? createPolicy(config, audit);
  const storage = overrides.storage ?? (await createStorage(config));
  // Users (USERS_FILE) bring their own auth, account routes and authorizer; each can still
  // be overridden. The static tokens stay accepted next to user tokens.
  const users =
    overrides.auth && overrides.accounts && overrides.authorizer && overrides.webLogin
      ? null
      : await createUserAccounts(
          config,
          storage,
          overrides.auth ? { fallbackAuth: overrides.auth } : {},
        );
  const auth = overrides.auth ?? users?.auth ?? createAuth(config);
  const packageSources = overrides.packageSources ?? createPackageSources(config, storage);
  const userParts = users
    ? {
        ...(overrides.accounts ? {} : { accounts: users.accounts }),
        ...(overrides.authorizer ? {} : { authorizer: users.authorizer }),
        ...(overrides.webLogin ? {} : { webLogin: users.webLogin }),
      }
    : {};
  // Created last: nothing that can still throw comes after it, so it never leaks.
  let owned: ClosableUpstream | null = null;
  let upstream: Upstream;
  if (overrides.upstream) {
    upstream = overrides.upstream;
  } else {
    owned = createDefaultUpstream(config, adapters);
    upstream = owned;
  }
  return {
    ...overrides,
    ...userParts,
    ...(packageSources ? { packageSources } : {}),
    storage,
    auth,
    policy,
    audit,
    adapters,
    config: overrides.config ?? config,
    upstream,
    dispose() {
      owned?.close();
    },
  };
}
