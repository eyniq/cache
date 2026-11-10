// Public API of the core (`@eyniq/cache`). Downstream builds can consume this repo (for example as a git
// submodule) and import from here (or from the narrower entries in package.json `exports`).
// Test helpers live in `@eyniq/cache/testing` and are deliberately not re-exported here.
export * from './core/contracts.ts';
export * from './defaults.ts';
export { createServer, type CacheServer, type ServerOptions } from './http/server.ts';
export {
  renderMarkdown,
  type MarkdownOptions,
  type MarkdownResult,
  type MdNode,
} from './web/markdown.ts';
export {
  ConfigError,
  createConfigReader,
  loadConfig,
  parseDuration,
  type Config,
  type ConfigReader,
  type LoadConfigOptions,
  type LogLevel,
  type StorageConfig,
} from './config.ts';
export { errorFields, log, setLogLevel, writeAudit, type LogFields } from './core/log.ts';
export {
  ConditionalWritesUnsupported,
  HttpError,
  badGateway,
  badRequest,
  gatewayTimeout,
  isHttpError,
  notFound,
} from './core/errors.ts';
export { assertSafeKey, contentKey, isSafeKey } from './core/names.ts';
export { isStorageAdmin } from './core/storage.ts';
export { readLimited } from './core/streams.ts';
export type { RequestContext } from './core/request.ts';
export { InlineProcessor, type MetadataProcessor } from './metadata/processor.ts';
export { WorkerPool } from './metadata/worker-pool.ts';
export type { Metrics } from './http/metrics.ts';
export { composePolicies } from './policy/compose.ts';
export { auditEvent, type AuditOrigin } from './core/audit.ts';

// Console prerequisites (statistics history read side, user store and sign-in building blocks).
export {
  STATS_RANGES,
  STATS_STEPS,
  StatsBusyError,
  StatsReader,
  StatsUnavailableError,
  isStatsRange,
  type StatsBucket,
  type StatsPodPoint,
  type StatsRange,
  type StatsReaderOptions,
  type StatsResult,
} from './stats/reader.ts';
export type { StatsTier, WriteStat } from './stats/types.ts';
export {
  UsersFile,
  isValidUserName,
  type UserRecord,
  type UsersData,
  type UsersFileOptions,
} from './auth/users.ts';
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordBusyError,
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from './auth/password.ts';
export { LoginLimiter, type LoginAttempt, type LoginLimiterOptions } from './auth/login-limiter.ts';
