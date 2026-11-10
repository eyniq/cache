// Extension points (DESIGN.md section 6.1). Everything edition- or ecosystem-specific sits
// behind these interfaces; the community build composes defaults in src/main.ts and downstream
// builds call createServer(deps) with their own implementations.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import type { Config } from '../config.ts';

export interface Identity {
  readonly name: string;
  /** Group memberships from the identity provider (e.g. OIDC groups); used by authorizers. */
  readonly groups?: readonly string[];
  /**
   * Further provider claims; opaque to the core. Never put secrets (tokens) here. A string
   * `tokenId` (a non-secret id of the credential used, e.g. a token hash) is added to the
   * audit events of writes.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface StorageObjectInfo {
  size: number;
  etag?: string;
}

/** An object opened for reading, with the size of exactly the bytes that will be streamed. */
export interface OpenedObject {
  body: Readable;
  size: number;
  /** Version of exactly the bytes being streamed, usable with StorageAdmin.putIfMatch. */
  etag?: string;
}

export interface Storage {
  get(key: string): Promise<Readable | null>;
  // Optional: open with a size that matches the stream (no head()/get() race).
  open?(key: string): Promise<OpenedObject | null>;
  head(key: string): Promise<StorageObjectInfo | null>;
  // Must be atomic: readers never see a partial object. If `body` errors, nothing is stored.
  // `timeoutMs` raises the per-request I/O timeout of backends that have one (S3); background
  // writes pass a longer one than the request path uses. Backends without a timeout ignore it.
  put(
    key: string,
    body: Readable,
    opts?: { contentType?: string; timeoutMs?: number },
  ): Promise<void>;
  // Cheap reachability probe for /readyz; rejects when storage is unusable.
  check(): Promise<void>;
}

export interface StorageListEntry {
  key: string;
  size: number;
  etag?: string;
}

export interface StorageListPage {
  /**
   * In ascending key order (by UTF-8 bytes). A page may hold fewer than `limit` entries, even
   * none, while more follow (S3 pages are filtered after the server applied max-keys).
   */
  entries: StorageListEntry[];
  /** Pass to the next list() call; only its absence ends the listing. */
  cursor?: string;
}

export interface StorageCapabilities {
  list: boolean;
  delete: boolean;
  /** putIfAbsent / putIfMatch are enforced by the backend (not silently ignored). */
  conditionalWrites: boolean;
}

/**
 * Optional management operations on top of Storage (implemented by FsStorage and S3Storage;
 * check with isStorageAdmin). Keys follow the same safety rules as Storage, and keys starting
 * with "." are reserved for the implementation. Objects written with putIfAbsent /
 * putIfMatch must only be changed through these two and delete(): a plain put() does not take
 * part in the compare-and-swap. Etags are opaque and backend-specific; compare them only with
 * etags from the same storage. FsStorage's guarantees on shared volumes have limits (NFSv3+,
 * clock and stall caveats): see the header of src/storage/fs.ts.
 */
export interface StorageAdmin {
  /**
   * Keys starting with `prefix` (a partial last segment is allowed). `limit` is clamped to
   * 1..1000 (default 1000).
   */
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<StorageListPage>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /**
   * Writes only when no object exists; false when one does. Throws
   * ConditionalWritesUnsupported when the backend cannot enforce it.
   */
  putIfAbsent(key: string, body: Buffer, opts?: { contentType?: string }): Promise<boolean>;
  /**
   * Replaces the object only while its etag (from head(), open() or list()) still matches;
   * false when it changed or no longer exists. Throws ConditionalWritesUnsupported when the
   * backend cannot enforce it.
   */
  putIfMatch(
    key: string,
    body: Buffer,
    etag: string,
    opts?: { contentType?: string },
  ): Promise<boolean>;
  /**
   * Probes the backend once (S3 compatibles differ; FS mounts too) and caches the answer.
   * Rejects when the probe itself fails (e.g. storage unreachable); asked again next time.
   */
  capabilities(): Promise<StorageCapabilities>;
}

export interface AuthProvider {
  // True when registry routes require an identity (null identity then means 401).
  readonly required: boolean;
  // Returns an identity or null; null on a protected route means 401.
  authenticate(req: IncomingMessage): Promise<Identity | null>;
}

/**
 * read: metadata, artifacts, pass-through. publish: write routes. admin: extension routes.
 * account: an identity managing its own credentials (token list, create, delete); login and
 * logout are never authorized (they work before there is an identity).
 */
export type AuthorizationAction = 'read' | 'publish' | 'admin' | 'account';

export interface AuthorizationResource {
  /** Adapter id ("npm"), or "*" for routes that belong to no ecosystem (extension routes). */
  ecosystem: string;
  /**
   * The route kind ("metadata", "artifact", "passthrough", "stats" (the web catalog's
   * statistics page, ecosystem "*"), write kinds, or "extension"). A
   * read without `name` (pass-through search and audit) is ecosystem-wide: it can reveal
   * names and metadata of any package, so per-package rules must treat it accordingly.
   */
  route: string;
  /** Validated package name, when the route names one. */
  name?: string;
  /** Artifact file name (artifact routes): the version is only known after the metadata. */
  file?: string;
  /** Version, when the route itself names one (e.g. a dist-tag target). */
  version?: string;
  /** Prefix of the extension being called (extension routes only). */
  extension?: string;
  /** The account action (account routes only; route is "account"). */
  account?: AccountAction;
}

/**
 * Decides whether an (optional) identity may perform an action. Called by the HTTP layer
 * after authentication for every registry route except ping and whoami; false answers 403.
 * Rejecting with HttpError 403 is a refusal too: the client gets that message and the
 * `auth.forbidden` audit event carries it as `reason` (e.g. an edition's licence limit). Any
 * other rejection fails the request closed (500) and is logged as an authorizer failure.
 */
export interface Authorizer {
  authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): Promise<boolean>;
}

export interface PolicyInput {
  ecosystem: string;
  name: string;
  version: string;
  /** Publish time in epoch ms, or null when the registry did not provide one. */
  publishedAt: number | null;
  /** Evaluation time in epoch ms. */
  now: number;
  /**
   * Where the version comes from: the upstream registry, or a PackageSource (packages
   * published to this registry). Policies such as the release age gate may treat local
   * packages differently; the core always sets it.
   */
  origin?: 'upstream' | 'local';
  /** Facts the adapter extracted for this version (see VersionInfo.facts). */
  facts?: VersionFacts;
}

export type PolicyDecision =
  | {
      allow: true;
      reason?: string;
      /** Allowed only by an explicit exception; downloads are audited as policy.allowlisted. */
      allowlisted?: boolean;
      /** decision may change at this epoch ms */ validUntil?: number;
    }
  | { allow: false; reason: string; allowedAfter?: number; validUntil?: number };

/**
 * Decides per version; used for filtering and tarball blocking. evaluate runs when metadata is
 * (re)filtered, never per cache hit: it must stay synchronous, pure for a given configuration
 * and identity-free (DESIGN.md section 15). Compose several with composePolicies().
 */
export interface Policy {
  evaluate(input: PolicyInput): PolicyDecision;
  /**
   * Increases whenever the configuration or the data behind decisions changes (allowlist,
   * advisories). Cached entries are re-filtered when they are next revalidated.
   */
  readonly revision?: number;
  /**
   * Subscribe to changes; the metadata service re-filters every cached entry on this pod
   * before serving it again. Update the state evaluate() reads BEFORE notifying. Returns an
   * unsubscribe function.
   */
  onChange?(listener: () => void): () => void;
  /**
   * Whether every version of the package is blocked regardless of its metadata, decided from
   * the name alone. Optional and default off; search uses it to hide such packages without a
   * packument. A policy returning true must also deny every version in evaluate().
   */
  blocksWholePackage?(ecosystem: string, name: string): boolean;
}

/**
 * Audit event types the core emits (and names reserved for downstream builds). Extensions
 * may use any other `type`, by convention `admin.<thing>.<verb>` for admin actions.
 */
export type KnownAuditEventType =
  | 'policy.blocked'
  | 'policy.allowlisted'
  | 'policy.unknown-publish-time'
  | 'integrity.mismatch'
  | 'allowlist.expired'
  | 'auth.denied'
  | 'auth.forbidden'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token.created'
  | 'auth.token.deleted'
  | 'publish'
  | 'unpublish'
  | 'dist-tag'
  | 'deprecate'
  | 'artifact.served';

/**
 * An audit record: open-ended so editions and extensions can add types and fields. Never put
 * secrets (tokens, request bodies) in it.
 */
export interface AuditEvent {
  type: KnownAuditEventType | (string & {});
  /** ISO 8601 time of the event (UTC). */
  at: string;
  /**
   * The request it belongs to: the client's X-Request-Id when well-formed (so it correlates,
   * but proves nothing; clients choose it), otherwise a generated UUID.
   */
  requestId?: string;
  /** Name of the authenticated identity, when there is one. */
  identity?: string;
  [field: string]: unknown;
}

export interface AuditSink {
  /** Must never throw and never block the request path. */
  record(event: AuditEvent): void;
  /**
   * Opt in to high-volume types the core skips otherwise: artifact.served is emitted only
   * when this returns true for it. Asked per event, so keep it cheap.
   */
  wants?(type: string): boolean;
}

// ---- Upstream -------------------------------------------------------------------------

export interface UpstreamRequest {
  method?: 'GET' | 'HEAD' | 'POST';
  /** Path plus optional query, relative to the configured upstream base URL. */
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /** Aborts the request (and its response body) when it fires; no socket is left behind. */
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface Upstream {
  /** Only ever talks to this origin; redirects to other hosts are refused. */
  readonly origin: string;
  request(req: UpstreamRequest): Promise<UpstreamResponse>;
}

// ---- Ecosystem adapters ---------------------------------------------------------------

export type AdapterRoute =
  /** Package metadata. `view` is adapter-defined (npm: full, abbreviated, version). */
  | { kind: 'metadata'; name: string; view: string; ref?: string }
  /** A downloadable artifact identified by package name and file name. */
  | { kind: 'artifact'; name: string; file: string }
  /** Forward to upstream without caching. */
  | { kind: 'passthrough'; upstreamPath: string; maxBodyBytes: number; search?: true }
  | { kind: 'ping' }
  | { kind: 'whoami' }
  /** `logPath` replaces the request path in logs and audit events (it holds a secret). */
  | { kind: 'reject'; status: number; message: string; logPath?: string }
  /** Write routes; adapters only return them when MatchContext.writable is true. */
  | WriteRoute
  /** Account routes; adapters only return them for MatchContext.accountActions. */
  | AccountRoute;

/**
 * Publish a document (npm: PUT /:name, also PUT /:name/-rev/:rev, which npm uses to drop
 * versions), unpublish a whole package or one artifact, or change a dist-tag.
 */
export type WriteRoute =
  | { kind: 'publish'; name: string; rev?: string }
  | { kind: 'unpublish'; name: string; file?: string; rev?: string }
  | { kind: 'dist-tag'; name: string; tag: string; op: 'set' | 'delete' };

export interface MatchContext {
  /** A PackageSource is configured for this adapter: write routes may be returned. */
  writable: boolean;
  /**
   * Account actions the AccountProvider implements (only passed to adapters with an
   * `accounts` protocol): the adapter returns account routes for exactly these and keeps its
   * old answers for everything else.
   */
  accountActions?: ReadonlySet<AccountAction>;
}

// ---- Accounts (default off) ----------------------------------------------------------

/**
 * Credential endpoints of an ecosystem protocol (npm: web and password login, logout, token
 * management), served through ServerDeps.accounts. Authentication rules are fixed by the
 * core: login-start, login-poll, user-login and logout need no credentials (they work before
 * there is one; a logout proves itself with the token it revokes); token-list, token-create
 * and token-delete need an identity (401) and the authorizer's `account` action (403).
 */
export type AccountAction =
  | 'login-start'
  | 'login-poll'
  | 'user-login'
  | 'token-list'
  | 'token-create'
  | 'token-delete'
  | 'logout';

/**
 * `logPath` is the request path (relative to the mount) as it may appear in logs and audit
 * events: adapters replace secrets and user-typed names with "[redacted]".
 */
export type AccountRoute = { kind: 'account'; logPath: string } & (
  | { action: 'login-start' }
  /** Polling the doneUrl of a web login; `session` is the path after the login endpoint. */
  | { action: 'login-poll'; session: string }
  | { action: 'user-login'; name: string }
  | { action: 'token-list' }
  | { action: 'token-create' }
  | { action: 'token-delete'; key: string }
  | { action: 'logout'; token: string }
);

/** An account request as parsed by the adapter (path parameters plus body and headers). */
export type AccountRequest =
  | { action: 'login-start' }
  | { action: 'login-poll'; session: string }
  | UserLoginRequest
  | { action: 'token-list' }
  | TokenCreateRequest
  | { action: 'token-delete'; key: string }
  | { action: 'logout'; token: string };

export interface UserLoginRequest {
  action: 'user-login';
  name: string;
  password: string;
  /** One-time password the client sent (npm: npm-otp header). */
  otp?: string;
}

export interface TokenCreateRequest {
  action: 'token-create';
  name?: string;
  description?: string;
  /** The account password, when the client sent one (npm asks for it). */
  password?: string;
  readonly: boolean;
  /** CIDR ranges the token may be used from; empty means anywhere. */
  cidrWhitelist: string[];
  expiresInDays?: number;
  otp?: string;
}

/** A token as listed to its owner: never the secret itself. */
export interface AccountToken {
  /** Stable identifier used to delete the token (not a secret). */
  key: string;
  /** A short, non-secret prefix of the token for recognition. */
  preview: string;
  name?: string;
  readonly: boolean;
  cidrWhitelist: string[];
  /** ISO 8601. */
  created: string;
  updated?: string;
}

/** What the core hands the adapter to render, per action. */
export type AccountResult =
  | { action: 'login-start'; loginUrl: string; doneUrl: string }
  | { action: 'login-poll'; status: 'pending'; retryAfterSeconds: number }
  | { action: 'login-poll'; status: 'done'; token: string }
  | { action: 'user-login'; name: string; token: string }
  | { action: 'token-list'; tokens: AccountToken[] }
  | { action: 'token-create'; token: string; info: AccountToken }
  | { action: 'token-delete' }
  | { action: 'logout' };

export interface AccountResponse {
  status: number;
  /** Empty for responses without a body (e.g. 204). */
  body: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

/** The wire format of an ecosystem's account endpoints (EcosystemAdapter.accounts). */
export interface AccountProtocol {
  /** Request bodies above this many bytes are refused with 413. */
  readonly maxBodyBytes: number;
  /** Throw HttpError(400) for invalid input. `body` is empty for requests without one. */
  parse(route: AccountRoute, body: Buffer, headers: IncomingHttpHeaders): AccountRequest;
  render(route: AccountRoute, result: AccountResult): AccountResponse;
}

export interface AccountContext {
  readonly requestId: string;
  /** Adapter id of the protocol in use ("npm"). */
  readonly ecosystem: string;
  /**
   * Public URL of the registry as the client addressed it (PUBLIC_URL plus the mount it
   * used, e.g. "/npm"), without a trailing slash. Base for loginUrl and doneUrl.
   */
  readonly registryUrl: string;
  /**
   * The client's IP address, for per-address limits: the socket peer, or the address the
   * outermost trusted proxy saw (TRUST_PROXY_HOPS). Absent when unknown.
   */
  readonly clientAddress?: string;
  /** Records an audit event stamped with time, request id and identity. */
  audit(type: string, fields?: Record<string, unknown>): void;
}

export type WebLoginPoll =
  | { status: 'pending'; retryAfterSeconds: number }
  /** `name` (optional) is the identity that logged in, for the auth.login audit event. */
  | { status: 'done'; token: string; name?: string };

/**
 * Credentials for ecosystem clients (ServerDeps.accounts). Every method is optional: the
 * routes of a missing one keep the answers they had without a provider. Throw HttpError to
 * answer the client (never with secrets or whether a user exists); anything else is a 500.
 * The core audits auth.login, auth.denied, auth.logout, auth.token.created and
 * auth.token.deleted itself. Rate limiting of the unauthenticated methods is the provider's.
 */
export interface AccountProvider {
  /**
   * Starts a web login. doneUrl is polled by the client; a URL under
   * `${ctx.registryUrl}/-/v1/login/` (npm) reaches pollWebLogin. Both must be http(s) URLs.
   */
  startWebLogin?(ctx: AccountContext): Promise<{ loginUrl: string; doneUrl: string }>;
  /** Unknown or expired sessions: throw HttpError(404). `done` hands out the token once. */
  pollWebLogin?(session: string, ctx: AccountContext): Promise<WebLoginPoll>;
  /**
   * Password login. null for ANY failure (unknown user, wrong password): the core answers
   * one indistinguishable 401. Throw HttpError(401) with `www-authenticate: OTP` to ask for a
   * one-time password, or HttpError(503) when overloaded whoever asks (passed on as is).
   */
  login?(
    request: UserLoginRequest,
    ctx: AccountContext,
  ): Promise<{ name: string; token: string } | null>;
  /** Only tokens of `identity`. */
  listTokens?(identity: Identity, ctx: AccountContext): Promise<AccountToken[]>;
  /** Creates a token for `identity` (re-check the password when one is required). */
  createToken?(
    identity: Identity,
    request: TokenCreateRequest,
    ctx: AccountContext,
  ): Promise<{ token: string; info: AccountToken }>;
  /**
   * Deletes a token of `identity` by key (npm also sends the token itself as the key); false
   * when `identity` has no such token (404). Never delete another identity's token.
   */
  deleteToken?(identity: Identity, key: string, ctx: AccountContext): Promise<boolean>;
  /**
   * Revokes `token` when it is valid. Called without authentication: answer the same way
   * whether or not it was valid (the core answers 200). A refusal that comes before anything
   * about the token is known (e.g. HttpError 429 with Retry-After when lookups are rate
   * limited) is passed on as is, so a client never takes it for a completed logout.
   */
  logout?(token: string, ctx: AccountContext): Promise<void>;
}

export interface RawMetadata {
  body: Buffer;
  /** Content-Encoding of `body` as received (stored as-is). */
  encoding: 'gzip' | 'identity';
  /** Upstream validator for conditional revalidation. */
  etag?: string;
}

export type MetadataFetchResult =
  { status: 'ok'; raw: RawMetadata } | { status: 'not-modified' } | { status: 'not-found' };

export interface MetadataFetchOptions {
  etag?: string;
  maxBytes: number;
}

/** Digests the core verifies itself. */
export type BuiltinDigestAlgorithm = 'sha512' | 'sha256' | 'sha1';

/**
 * Expected digest of an artifact, as advertised by the registry. sha512, sha256 and sha1 are
 * verified by the core. Any other algorithm is adapter-defined (lowercase letters, digits and
 * dashes, at most 32 characters, e.g. a directory hash over an archive's contents) and is
 * verified only by the adapter's createVerifier; an artifact whose digest nothing can verify
 * is refused (502). `hex` is 16-512 lowercase hex characters.
 */
export interface ArtifactIntegrity {
  algorithm: BuiltinDigestAlgorithm | (string & {});
  /** Lowercase hex digest. */
  hex: string;
}

/**
 * Checks artifact bytes against an adapter-defined digest (EcosystemAdapter.createVerifier),
 * one instance per download. The core streams to the client and to a temporary object as
 * usual and withholds the end of the response and the storage commit until verify() resolves
 * true.
 */
export interface ArtifactVerifier {
  /** Every chunk, in order. Must not throw. */
  update(chunk: Buffer): void;
  /**
   * Called once after the last chunk. Resolves true when the bytes match; false or a
   * rejection fails the download. Releases the verifier's resources when it settles.
   */
  verify(): Promise<boolean>;
  /**
   * The download was abandoned: release resources. Idempotent; may follow verify() and may
   * be called while verify() is still pending (deadline), which should then settle promptly.
   */
  abort(): void;
}

export interface ArtifactInfo {
  /** File name clients use to request the artifact. */
  file: string;
  /** Path on the upstream host (never a foreign host). */
  upstreamPath: string;
  integrity: ArtifactIntegrity | null;
}

/**
 * Per-version facts for policies, extracted by the adapter in processMetadata (worker thread).
 * Keys are adapter-defined; npm: publisher, maintainers, hasInstallScript, license,
 * deprecated, hasAttestations, hasSignatures, and history facts computed over the whole
 * document: previousPublisher (publisher of the closest earlier version by semver precedence,
 * or null) and publisherFirstSeen (epoch ms of the first version by this version's publisher,
 * or null). For local packages (PackageSource) publisher,
 * attestations and signatures are set by the source, the rest by whoever published: a policy
 * must not treat publisher-controlled facts as proof of anything.
 */
export type VersionFacts = Readonly<Record<string, string | number | boolean | null>>;

export interface VersionInfo {
  version: string;
  publishedAt: number | null;
  artifact: ArtifactInfo | null;
  facts?: VersionFacts;
}

/** Context handed to processMetadata in the worker; must be structured-cloneable. */
export interface ProcessContext {
  /** The validated name that was requested; the document must describe exactly this name. */
  name: string;
  /** Public base URL including the mount path, without a trailing slash. */
  publicBaseUrl: string;
  upstreamOrigin: string;
  maxBytes: number;
  options: Record<string, boolean>;
}

/**
 * Output of processMetadata. `payload` is adapter-private, structured-cloneable data
 * (typically pre-serialized byte fragments) that renderMetadata turns into responses
 * without parsing JSON again.
 */
export interface ProcessedMetadata {
  name: string;
  /**
   * The package name policies and audit events see, when the lookup name is a finer key
   * (adapters with one metadata entry per version, e.g. "module@version"). Default: the
   * lookup name. It must be the lookup name or its leading part before "@", ":" or "/"
   * (checked; otherwise the document is refused with 502).
   */
  packageName?: string;
  /** sha256 hex of the raw upstream document; part of every derived ETag. */
  digest: string;
  versions: VersionInfo[];
  payload: unknown;
  /** Approximate retained size in bytes, for the LRU. */
  byteSize: number;
}

export interface RenderInput {
  processed: ProcessedMetadata;
  /** Versions the policy allows. */
  allowed: ReadonlySet<string>;
  view: string;
  ref?: string;
}

export type RenderResult =
  { status: 200; body: Buffer; contentType: string } | { status: 404; error: string };

export type ArtifactRef =
  | {
      status: 'ok';
      version: string;
      artifact: ArtifactInfo;
      /** Storage key for the artifact bytes (content-addressed). */
      storageKey: string;
      /** Optional name/version index entry pointing at the digest (write-once). */
      indexKey?: string;
      contentType: string;
    }
  | { status: 'not-found' };

// ---- Search (default off) -------------------------------------------------------------

/** A validated search request; the adapter canonicalizes it (unknown parameters are dropped). */
export interface SearchQuery {
  text: string;
  size: number;
  from: number;
  /** Path plus query to request from the upstream registry. */
  upstreamPath: string;
}

/** A package of a PackageSource, offered to the search endpoint. */
export interface SearchHit {
  name: string;
  version: string;
  description?: string;
  keywords?: readonly string[];
  /** ISO 8601 time of `version`. */
  date?: string;
  publisher?: string;
}

/** What the metadata cache knows about a package; only ever read from memory. */
export interface SearchPackageView {
  processed: ProcessedMetadata;
  /** Versions the policy allows. */
  allowed: ReadonlySet<string>;
}

export interface SearchComposeInput {
  query: SearchQuery;
  /** What SearchProtocol.parseUpstream returned, or null when upstream failed or was unusable. */
  upstream: unknown;
  /** Hits of the PackageSource, shown first. */
  local: readonly SearchHit[];
  /** The cached state of a package, or null when it is not in the metadata cache. */
  view(name: string): SearchPackageView | null;
  /** The PackageSource owns this name: an upstream result of that name must not be shown. */
  isOwned(name: string): boolean;
  /** The policy blocks every version of this package (a name-only check, no metadata). */
  isBlocked(name: string): boolean;
}

export interface SearchProtocol {
  /** `query` is the raw query string including the "?" (or ""). Null answers 400. */
  parseQuery(query: string): SearchQuery | null;
  /**
   * Parses an upstream response body (at most 2 MiB, decoded) once so cache hits do not parse
   * again. The result is opaque to the core and is handed to compose() for every request that
   * uses it, so it must not be mutated. Null when the body is unusable.
   */
  parseUpstream(body: Buffer): unknown;
  /**
   * Builds the response body. Results must not advertise versions the policy blocks: rewrite
   * or drop those the cache knows. Null when there is nothing usable (upstream failed or
   * answered garbage, and no local hits): the core answers 502.
   */
  compose(input: SearchComposeInput): Buffer | null;
}

// ---- Web catalog (default off) --------------------------------------------------------

/** What the core hands the adapter to describe a package for the web catalog. */
export interface CatalogInput {
  processed: ProcessedMetadata;
  /** Versions the policy allows. */
  allowed: ReadonlySet<string>;
  /** Versions the policy blocks, with the decision (reason, allowedAfter epoch ms). */
  blocked: ReadonlyMap<string, { reason: string; allowedAfter?: number }>;
  /** The version to detail; default: what the `latest` tag (as served) points at. */
  version?: string;
}

export interface CatalogVersion {
  version: string;
  /** ISO 8601. */
  published?: string;
  deprecated?: string;
  /** Set when the policy blocks the version: it is shown, never offered for download. */
  blocked?: { reason: string; allowedAfter?: string };
}

export interface CatalogVersionDetail extends CatalogVersion {
  publisher?: string;
  license?: string;
  /** Dependency groups in a fixed order (npm: dependencies, peerDependencies, ...). */
  dependencies: Array<{ kind: string; entries: Array<{ name: string; range: string }> }>;
  /** Only for allowed versions; a URL of this registry. */
  download?: { url: string; integrity?: string };
}

/**
 * A package as the web catalog shows it. Every link is an absolute http(s) URL (the adapter
 * drops anything else); text fields are plain text, rendered as text by the client.
 */
export interface CatalogPackage {
  name: string;
  description?: string;
  license?: string;
  keywords: string[];
  maintainers: string[];
  links: { homepage?: string; repository?: string; bugs?: string };
  /** Tags as the registry serves them (after policy filtering and repointing). */
  distTags: Array<{ tag: string; version: string }>;
  /** Newest first; possibly fewer than versionCount. */
  versions: CatalogVersion[];
  versionCount: number;
  /** The detailed version, or null when it does not exist. */
  selected: CatalogVersionDetail | null;
  /** Install commands for the selected version; empty when it is blocked. */
  install: Array<{ label: string; command: string }>;
}

export interface CatalogSearchResult {
  total: number;
  results: Array<{ name: string; version: string; description?: string; date?: string }>;
}

/**
 * How the web catalog reads an ecosystem's metadata (EcosystemAdapter.catalog). Runs on the
 * main thread per catalog request (never on the registry hot path); implementations must
 * bound the work (e.g. only parse the one version they detail).
 */
export interface CatalogProtocol {
  isValidName(name: string): boolean;
  describe(input: CatalogInput): CatalogPackage;
  /** README source (Markdown) of the package, or null; the core renders it safely. */
  readme(input: CatalogInput): string | null;
  /** Turns the body of this ecosystem's search endpoint into plain results. */
  searchResults(body: Buffer): CatalogSearchResult;
}

/**
 * Password sign-in for the web catalog (ServerDeps.webLogin, default off). The catalog keeps
 * the session itself; it only grants reads in the catalog, never registry access.
 */
export interface WebLogin {
  /**
   * The identity for a correct password, else null for ANY failure (rate limit inside); may
   * throw HttpError(503) when overloaded. A string `claims.stamp` (at most 128 characters) is
   * kept with the session and handed to isValid.
   */
  login(
    name: string,
    password: string,
    ctx: { requestId: string; clientAddress?: string },
  ): Promise<Identity | null>;
  /**
   * Whether a session issued to `name` at `issuedAt` (epoch ms), with the `stamp` its login
   * returned, may still be used.
   */
  isValid?(name: string, issuedAt: number, stamp?: string): boolean;
}

export interface EcosystemAdapter {
  id: string; // "npm", later "go", "pypi", "maven", "cargo"
  mountPath: string; // "/npm"; npm is also served at "/" for compatibility
  /** Module (file URL) exporting `processMetadata`, loaded inside worker threads. */
  processorModule: string;
  /** `path` is the request path with the mount prefix removed, query string included. */
  match(req: IncomingMessage, path: string, ctx?: MatchContext): AdapterRoute | null;
  /** Adapter-owned flags passed to processMetadata (e.g. npm's ABBREVIATED_INCLUDE_TIME). */
  readonly processOptions: Record<string, boolean>;
  /** Extra request headers this ecosystem may forward to its upstream (pass-through routes). */
  readonly forwardHeaders: readonly string[];
  fetchMetadata(
    name: string,
    upstream: Upstream,
    opts: MetadataFetchOptions,
  ): Promise<MetadataFetchResult>;
  // Runs in a worker thread: parse, extract per-version publish times, pre-serialize.
  processMetadata(raw: RawMetadata, ctx: ProcessContext): ProcessedMetadata;
  // Main thread: assemble a response from pre-serialized parts; no JSON parsing.
  renderMetadata(input: RenderInput): RenderResult;
  /**
   * Parse a write body (runs in a worker thread, like processMetadata). Throw HttpError(400)
   * for invalid input. Required for write routes; without it they answer 405.
   */
  parseWriteBody?(route: WriteRoute, body: Buffer): WriteBody;
  /**
   * Only consulted when a PackageSource is configured: strip names the source owns from a
   * pass-through request body (decoded, identity encoding) before it goes upstream, so
   * private names never reach the public registry. Return null to refuse the request (404).
   * Without this hook, pass-through requests with a body are refused while a source exists.
   */
  redactPassthrough?(
    route: Extract<AdapterRoute, { kind: 'passthrough' }>,
    body: Buffer,
    isOwned: (name: string) => boolean,
  ): Buffer | null;
  /**
   * Wire format of the account endpoints (login, logout, tokens). Without it, account routes
   * are never requested from this adapter.
   */
  readonly accounts?: AccountProtocol;
  /**
   * Handles passthrough routes with `search: true`: the core fetches the upstream result
   * itself (bounded, cached briefly, without client credentials), merges the PackageSource's
   * hits and lets the adapter filter the result. Without it such a route is a plain
   * pass-through.
   */
  readonly search?: SearchProtocol;
  /** Read-only web catalog support (WEB_UI); without it the catalog skips this adapter. */
  readonly catalog?: CatalogProtocol;
  /**
   * Verifier for an adapter-defined digest (an ArtifactIntegrity.algorithm that is not built
   * in), created on the main thread for each upstream download. Null when it does not handle
   * the algorithm (the artifact is then refused). For every artifact, the storage key must
   * end in `/<hex>` of its digest (the core refuses others), so stored bytes are always the
   * ones verified against that digest. A throwing update() or verify() fails the download;
   * a verifier error is not audited as integrity.mismatch.
   */
  createVerifier?(integrity: ArtifactIntegrity): ArtifactVerifier | null;
  /** Storage key of the raw upstream metadata (stale copy). */
  metadataKey(name: string): string;
  artifactKey(
    route: Extract<AdapterRoute, { kind: 'artifact' }>,
    metadata: ProcessedMetadata,
  ): ArtifactRef;
}

// ---- Write path (default off) --------------------------------------------------------

/** An artifact uploaded with a publish, decoded and digested by the adapter. */
export interface PublishedArtifact {
  /** File name clients will request it by (as in the artifact route). */
  file: string;
  contentType: string;
  data: Buffer;
  /** Computed from `data` by the adapter; any digest the client sent was checked against it. */
  integrity: ArtifactIntegrity;
}

export interface PublishedVersion {
  version: string;
  /** Ecosystem manifest of the version (npm: the version document), sanitised by the adapter. */
  manifest: Record<string, unknown>;
  artifact: PublishedArtifact;
}

export interface PublishRequest {
  ecosystem: string;
  name: string;
  versions: PublishedVersion[];
  /** Tags to point at versions of this request. */
  distTags: Record<string, string>;
  /** Package-level fields of the ecosystem document (npm: description, readme, ...). */
  document: Record<string, unknown>;
  /** Revision the client based its change on, for optimistic concurrency (npm `_rev`). */
  rev?: string;
}

/** Without `versions` and `files` the whole package is removed. */
export interface UnpublishRequest {
  ecosystem: string;
  name: string;
  versions?: string[];
  files?: string[];
  rev?: string;
}

export interface DistTagRequest {
  ecosystem: string;
  name: string;
  tag: string;
  /** null removes the tag. */
  version: string | null;
}

/** Deprecation messages for versions of one package (npm deprecate). */
export interface DeprecateRequest {
  ecosystem: string;
  name: string;
  /**
   * Version to message; an empty message removes the deprecation. Messages are printable
   * (the adapter refuses control and bidi characters) and at most 1024 characters. npm sends
   * the whole document back, so this is the complete desired state of every version that has
   * a deprecation field, unchanged ones included: apply it idempotently (or diff it).
   */
  deprecations: Record<string, string>;
  rev?: string;
}

/** What an adapter parsed out of a write request body. */
export type WriteBody =
  | { type: 'publish'; request: PublishRequest }
  /**
   * Deprecation changes (npm sends the whole document back). `versions` lists every version
   * in the document: for a source without deprecate() the body is handled as a `retain` of
   * them, which is the answer such a document always got. `invalid` (a client error) makes
   * the core answer 400 when the source has deprecate(); it is ignored for the retain case.
   */
  | { type: 'deprecate'; request: DeprecateRequest; versions: string[]; invalid?: string }
  /** A document listing the versions that remain (npm's unpublish of one version). */
  | { type: 'retain'; versions: string[]; rev?: string }
  | { type: 'dist-tag'; version: string };

/**
 * Packages published to this registry (one source per adapter, ServerDeps.packageSources).
 * Names it owns are served only from it and NEVER fetched from upstream, even when it has no
 * such package (404): this is the dependency-confusion defence. `owns` runs on every request
 * for the adapter, so it must be synchronous and cheap (e.g. a scope check).
 */
export interface PackageSource {
  /**
   * Must match every spelling the adapter accepts for a name (npm still serves legacy
   * mixed-case names, so compare case-insensitively when claiming a namespace).
   */
  owns(name: string): boolean;
  /**
   * The ecosystem document, processed by the adapter exactly like an upstream one. Set
   * raw.etag and answer not-modified for a matching opts.etag: with the default
   * metadataTtlMs of 0 it is asked on every request (so other pods see a publish at once),
   * and without an etag every request re-processes the document in a worker.
   */
  getMetadata(name: string, opts: MetadataFetchOptions): Promise<MetadataFetchResult>;
  getArtifact(name: string, file: string): Promise<OpenedObject | null>;
  /**
   * Throw HttpError to answer the client. The core checks permission, ownership, names,
   * digests and body size; the source enforces the rest: versions are immutable (409 when one
   * exists), a request is applied atomically, and a `rev` that is not current is refused
   * with 409.
   */
  publish(req: PublishRequest, identity: Identity | null): Promise<void>;
  /**
   * npm removes one version in two calls (versions, then files); both must be idempotent.
   * The source also drops or repoints dist-tags that pointed at removed versions, and must
   * check that `files` belong to the package.
   */
  unpublish(req: UnpublishRequest, identity: Identity | null): Promise<void>;
  /** The source checks that `version` exists (404 otherwise). */
  setDistTag(req: DistTagRequest, identity: Identity | null): Promise<void>;
  /**
   * Optional. Sets or clears (empty message) deprecation messages, atomically; authorized as
   * `publish` on the route "deprecate". The source checks that every version exists (404)
   * and refuses a `rev` that is not current (409). Versions may include ones a policy hides
   * from the client. Without this method a deprecate body is handled as before: as a `retain`
   * body listing the document's versions (a document that keeps every version gets 400).
   */
  deprecate?(req: DeprecateRequest, identity: Identity | null): Promise<void>;
  /**
   * Optional. Packages of this source that match a search (at most `query.size`); merged in
   * front of the upstream results of the first page. The source applies its own visibility
   * rules for `identity`. A throwing or slow (5 s) source is skipped, never fails the search.
   */
  search?(query: SearchQuery, identity: Identity | null): Promise<SearchHit[]>;
  /** How long a fetched document may be served before getMetadata is asked again. Default 0. */
  readonly metadataTtlMs?: number;
}

// ---- Extensions (routes and lifecycle for other editions) -----------------------------

/** Prometheus registry shared with the core; names get the product prefix (eyniq_cache_). */
export interface MetricsRegistry {
  /** Registers a counter; throws on an invalid or already registered name. */
  counter(name: string, help: string): MetricsCounter;
  /** A value read at scrape time. */
  gauge(
    name: string,
    help: string,
    read: () => number | Array<[Record<string, string>, number]>,
    type?: 'gauge' | 'counter',
  ): void;
}

export interface MetricsCounter {
  inc(labels?: Record<string, string>, by?: number): void;
}

/**
 * none: reachable without credentials, even when registry auth is required (login flows).
 * authenticated: needs an identity (401). admin: needs an identity and the authorizer's
 * `admin` action (403); DefaultAuthorizer never grants it.
 */
export type ExtensionAuth = 'none' | 'authenticated' | 'admin';

export interface ExtensionContext {
  readonly requestId: string;
  /** The authenticated identity, or null (only possible for auth "none"). */
  readonly identity: Identity | null;
  /** Request path without the query string. */
  readonly path: string;
  /** Records an audit event stamped with time, request id and identity. */
  audit(type: string, fields?: Record<string, unknown>): void;
}

export interface ExtensionServices {
  metrics: MetricsRegistry;
  audit: AuditSink;
  storage: Storage;
  config: Config;
}

/**
 * Routes and background work of another edition. Registry-port extensions are routed before
 * adapters; the prefix must be `/-/eyniq/<name>` (lowercase letters, digits, dashes), which no
 * package name can collide with. The handler gets every HTTP method and owns the response,
 * method checks and body size limits; a throw becomes a JSON error. `auth` uses the server's
 * AuthProvider and Authorizer, on the management port too. Declarations are validated when
 * the server is created (prefix, auth value, handler).
 */
export interface Extension {
  readonly prefix: string;
  readonly auth: ExtensionAuth;
  handler(req: IncomingMessage, res: ServerResponse, ctx: ExtensionContext): void | Promise<void>;
  /** Awaited before the server listens; a rejection fails listen(). */
  start?(services: ExtensionServices): void | Promise<void>;
  /** Awaited by close(), after the servers stopped accepting requests. */
  close?(): void | Promise<void>;
}

export interface ServerDeps {
  storage: Storage;
  auth: AuthProvider;
  /** Defaults to DefaultAuthorizer: reads as today, publish and admin refused. */
  authorizer?: Authorizer;
  policy: Policy;
  audit: AuditSink;
  adapters: EcosystemAdapter[];
  /** Adapter id to PackageSource. Without one, every write route answers 405 (read-only). */
  packageSources?: Readonly<Record<string, PackageSource>>;
  config: Config;
  /** Upstream of every adapter without an entry in `upstreams`. */
  upstream: Upstream;
  /** Adapter id to its own upstream (e.g. a different registry per ecosystem). */
  upstreams?: Readonly<Record<string, Upstream>>;
  /** Routes under /-/eyniq/ on the registry port, checked before any adapter. */
  extensions?: Extension[];
  /** Routes under /-/eyniq/ on the management port (after /livez, /readyz, /metrics). */
  managementExtensions?: Extension[];
  /**
   * Login, logout and token endpoints of the ecosystem clients. Without it (or for methods
   * it lacks) those paths answer exactly as before (404 or 405).
   */
  accounts?: AccountProvider;
  /** Password sign-in for the web catalog (WEB_UI); without it the catalog has no login. */
  webLogin?: WebLogin;
  /**
   * Edition readiness hook, called synchronously on every /readyz probe, so it must be cheap
   * (no I/O). A string is the reason this pod must not receive traffic (503); null means no
   * objection. /livez is unaffected, and a throwing hook counts as null.
   */
  readiness?: () => string | null;
}
