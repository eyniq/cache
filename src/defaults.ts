// Community default implementations of the contracts in src/core/contracts.ts, as one entry
// point (`@eyniq/cache/defaults`), plus the community composition (src/compose.ts). The
// downstream builds compose these with their own parts, usually through
// composeCommunity(config, overrides), and calls createServer(deps). Nothing inside src
// imports this file.
// eslint-disable-next-line no-restricted-imports -- public composition entry, like src/main.ts
export { NpmAdapter } from './adapters/npm/index.ts';
// eslint-disable-next-line no-restricted-imports -- npm helpers, also `@eyniq/cache/npm`
export * as npm from './adapters/npm/public.ts';
export {
  composeCommunity,
  createAdapters,
  createAuth,
  createDefaultUpstream,
  createPolicy,
  createStorage,
  createPackageSources,
  createUserAccounts,
  type CommunityDeps,
  type UserAccountParts,
} from './compose.ts';
export { CommunityAuthorizer } from './auth/community-authorizer.ts';
export { LoginLimiter, type LoginAttempt, type LoginLimiterOptions } from './auth/login-limiter.ts';
export { LookupLimiter, type LookupLimiterOptions } from './auth/lookup-limiter.ts';
export { UserAccounts, type UserAccountsOptions } from './auth/user-accounts.ts';
export { UserAuth, type UserAuthOptions } from './auth/user-auth.ts';
export { UserTokenStore, type UserTokenRecord } from './auth/user-tokens.ts';
export { UsersFile, parseUsers, type UserRecord, type UsersData } from './auth/users.ts';
export { hashPassword, verifyPassword, type ScryptParams } from './auth/password.ts';
export { DefaultAuthorizer } from './auth/authorizer.ts';
export { NoAuth } from './auth/none.ts';
export { StaticTokenAuth, loadTokens, parseTokens } from './auth/static-token.ts';
export { StdoutAuditSink } from './core/audit.ts';
export { createUpstream, type ClosableUpstream, type UpstreamOptions } from './core/upstream.ts';
export {
  loadAllowlist,
  parseAllowlist,
  type AllowlistEntry,
  type ParsedAllowlist,
} from './policy/allowlist.ts';
export { MinReleaseAgePolicy, type MinReleaseAgeOptions } from './policy/min-release-age.ts';
export { FsStorage } from './storage/fs.ts';
export { S3Storage, type S3Options } from './storage/s3.ts';
