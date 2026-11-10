# Eyniq Cache: design (MVP, community edition)

Status: source-available (FSL-1.1-ALv2).
Working name: Eyniq Cache. Repo `github.com/eyniq/cache`, image `ghcr.io/eyniq/cache`, package `@eyniq/cache`. Renaming later is cheap; keep names in one constants file.

## 1. Goal

A pull-through npm registry cache that survives the CI bursts of a large self-hosted CI fleet (many runner pools, parallel pnpm installs) without restarts, OOMs or install errors, and that enforces a server-side minimum release age. The core must stay clean enough for downstream builds to plug into it through an extension API.

Primary user: teams running CI against a shared cache. They self-host it, for example in their own AWS or GCP account.

## 2. Why: the failure modes this addresses

An existing Verdaccio cache (2 replicas, read-only proxy) failed under a burst from a self-hosted CI fleet:

- OOMKilled at a 768Mi limit during parallel pnpm installs; every CI job failed with `ERR_PNPM_META_FETCH_FAIL`.
- The single Node event loop blocked for seconds; a 1s liveness ping failed and the kubelet restarted both pods 12 times.
- Each pod had its own storage: duplicate upstream fetches and a cold cache after every restart.
- After raising limits to 4Gi / 3 GB heap and making probes tolerant, the next burst passed, but the ping probe still timed out 5 times. The problem is hidden, not solved.

Every design choice below targets one of these failure modes.

## 3. Locked decisions

| Decision | Choice |
| --- | --- |
| Language and runtime | TypeScript, Node 26, ESM, `strict: true` |
| HTTP | `node:http` with a small hand-written router. No web framework. |
| Upstream client | `undici` as bundled in Node (`fetch` / `Agent`), keep-alive pool |
| License (core) | FSL-1.1-ALv2 (becomes Apache 2.0 two years after each release). Add `LICENSE` and a short "what you may do" section in README. CLA for outside contributions. |
| Editions | This repo is the community edition. Downstream builds import it through the extension API; downstream-only code never lives here. |
| Deployment | Customer-hosted only: container image, Helm chart. Terraform modules for AWS/GCP come after the MVP. |
| Runtime dependencies | Zero by default. Every runtime dependency needs a written justification in `docs/DEPENDENCIES.md`. Dev dependencies are fine. |

## 4. MVP scope

In scope:
- Read-only pull-through proxy for npm, pnpm and yarn clients (unscoped and scoped packages).
- Full and abbreviated packuments, tarballs, ETag / 304, HEAD.
- Minimum release age gate with allowlist and fail-closed default.
- Request coalescing, off-main-thread packument processing, bounded memory.
- Storage: local/shared filesystem and S3-compatible object storage.
- Optional static bearer tokens.
- `/livez`, `/readyz`, `/metrics` (Prometheus text), JSON logs to stdout.
- Dockerfile (distroless), Helm chart, load-test harness.

Out of scope for the MVP (later phases): publishing private packages, OSV and publisher checks, policy engine, audit log with retention, SSO/RBAC, dashboard, SBOM export, multi-region replication, PyPI/Docker/Maven, air-gapped mirror, licensing. `PUT`, `DELETE` and login endpoints return `405`.

## 5. Registry protocol to implement

Upstream defaults to `https://registry.npmjs.org`. The npm adapter is mounted at `/npm/` and, for compatibility, at `/`. Paths below are relative to that mount. Later ecosystems get their own prefix (`/go/`, `/pypi/`, `/maven/`).

| Method and path | Behaviour |
| --- | --- |
| `GET /{name}` (unscoped), `GET /@{scope}%2f{name}` and `GET /@{scope}/{name}` | Packument. If `Accept` prefers `application/vnd.npm.install-v1+json`, serve the abbreviated form; otherwise the full form. Both are filtered by the age gate. |
| `GET /{name}/{version}` and the scoped equivalent | Single version document, derived from the cached full packument. 404 if the version is filtered out. |
| `GET /{name}/-/{file}.tgz`, `GET /@{scope}/{name}/-/{file}.tgz` | Tarball. Streamed. Blocked versions return 403 with a JSON error. |
| `HEAD` on all of the above | Same headers, no body. |
| `GET /-/ping` | `200 {}` |
| `GET /-/whoami` | With token auth: `{"username": "<token name>"}`. Without: 401. |
| `POST /-/npm/v1/security/*` | Transparent pass-through to upstream (npm/pnpm audit). Not cached. Body size limit 10 MB. |
| `GET /-/v1/search` | Transparent pass-through. Not cached. |
| `PUT`, `DELETE`, `/-/user/*` | `405` with a clear message: read-only cache. |
| `GET /livez`, `/readyz`, `/metrics` | See section 9. Never behind auth. |

Rules:
- Rewrite every `dist.tarball` in served packuments to the cache's public base URL (`PUBLIC_URL`). npm's default `replace-registry-host=npmjs` then also routes lockfile URLs through the cache.
- Validate package names against npm naming rules (lowercase, max 214 chars, URL-safe, scope form) before anything else. Reject with 400.
- Only ever fetch from the configured upstream host. Never follow a tarball URL from a packument to another host. Follow at most 2 redirects, same host only.
- Verify every tarball against `dist.integrity` (sha512) or, for old packages, `dist.shasum` (sha1) while streaming. On mismatch: discard, do not cache, return 502.

## 6. Architecture

```
client ──► HTTP layer (node:http, router, auth, validation)
              │
              ├─► MetadataService ──► Coalescer ──► Upstream (undici pool)
              │        │                               │
              │        ├─► WorkerPool (parse, filter,  │
              │        │    serialize packuments)      │
              │        ├─► MetadataLRU (bytes-capped)  │
              │        └─► Storage (raw packument, stale copy)
              │
              └─► ArtifactService ─► Coalescer ──► Upstream
                       ├─► Policy (age gate)
                       └─► Storage (content-addressed tarballs)
```

### 6.1 Extension points

All edition-specific behaviour sits behind interfaces in `src/core/contracts.ts`. The community build composes default implementations in `src/main.ts`. Downstream builds call `createServer(deps)` with their own implementations.

```ts
export interface Storage {
  get(key: string): Promise<Readable | null>;
  head(key: string): Promise<{ size: number; etag?: string } | null>;
  // Must be atomic: readers never see a partial object.
  put(key: string, body: Readable, opts?: { contentType?: string }): Promise<void>;
}

export interface AuthProvider {
  // Returns an identity or null; null on a protected route means 401.
  authenticate(req: IncomingMessage): Promise<Identity | null>;
}

export interface Policy {
  // Decide per version, given its publish time; used for filtering and tarball blocking.
  evaluate(input: PolicyInput): PolicyDecision; // { allow: true } | { allow: false; reason: string }
}

export interface AuditSink {
  record(event: AuditEvent): void; // must never throw, never block the request path
}

// One per package ecosystem. npm is the only implementation in the MVP, but the
// core (coalescing, workers, storage, streaming, policy, metrics) must only talk
// to ecosystems through this interface, so Go modules, PyPI, Maven and others
// can be added later without touching the core.
export interface EcosystemAdapter {
  id: string;                       // "npm", later "go", "pypi", "maven", "cargo"
  mountPath: string;                // "/npm"; npm is also served at "/" for compatibility
  match(req: IncomingMessage): AdapterRoute | null;   // metadata, artifact, passthrough, unsupported
  fetchMetadata(route: AdapterRoute, upstream: Upstream): Promise<RawMetadata>;
  // Runs in a worker thread: parse, extract per-version publish times, filter, serialize.
  processMetadata(raw: RawMetadata, ctx: FilterContext): ProcessedMetadata;
  artifactKey(route: AdapterRoute): ArtifactRef;      // includes expected digest when known
  verifyArtifact: IntegrityVerifier;  // built in: sha512, sha256, sha1; other digests: createVerifier (P10)
}

export interface ServerDeps {
  storage: Storage;
  auth: AuthProvider;
  policy: Policy;
  audit: AuditSink;
  adapters: EcosystemAdapter[];
  config: Config;
}
```

Readiness hook (default off): `ServerDeps.readiness?: () => string | null` is called synchronously on every `/readyz` probe (so it must do no I/O); a string is the reason the pod must not get traffic and `/readyz` answers 503 with it, in addition to the event-loop and storage checks. A throwing hook counts as no objection. `/livez` ignores it.

Community defaults: `FsStorage`, `S3Storage`, `StaticTokenAuth` / `NoAuth`, `MinReleaseAgePolicy`, `StdoutAuditSink`, `NpmAdapter`.

Future adapters (not in the MVP), for reference when shaping the interface:

| Ecosystem | Protocol | Publish time for the age gate |
| --- | --- | --- |
| Go modules | GOPROXY: `/@v/list`, `.info`, `.mod`, `.zip`, `/@latest`; checksum DB pass-through | `Time` in `.info` |
| Python | PyPI simple API (PEP 503 / PEP 691 JSON), files from files.pythonhosted.org | `upload-time` per file (PEP 700) |
| Java | Maven repository layout, `maven-metadata.xml`, `.sha1`/`.sha256` | Not in the metadata itself; needs a secondary source |
| Rust | Cargo sparse index | Not in the index; needs the crates.io API |
| Containers | OCI distribution API (manifests, blobs, token auth) | Image config `created`, unreliable |

### 6.2 Repo layout

```
src/
  core/        contracts.ts, coalescer.ts, lru.ts, names.ts, errors.ts
  metadata/    service.ts, worker.ts, worker-pool.ts (ecosystem-agnostic)
  artifacts/   service.ts, integrity.ts (ecosystem-agnostic streaming and storage)
  adapters/npm/  routes.ts, packument.ts (parse, filter, dist-tags), keys.ts
  policy/      min-release-age.ts, allowlist.ts
  storage/     fs.ts, s3.ts (own SigV4 signer, no AWS SDK)
  auth/        static-token.ts, none.ts
  http/        server.ts, router.ts, routes/*.ts, health.ts, metrics.ts
  config.ts    env parsing and validation
  main.ts      composition root (community build)
test/
  fixtures/    real packuments incl. one > 20 MB (e.g. a large @types package)
  fake-upstream.ts
  unit/, integration/, concurrency/
load/          load-test harness and scenarios
deploy/        Dockerfile, helm/eyniq-cache/
docs/          DESIGN.md, DEPENDENCIES.md, OPERATIONS.md
```

## 7. Concurrency design

These are hard requirements, not optimisations.

1. **Request coalescing.** One in-flight upstream request per key (packument name, tarball key). Concurrent callers await the same promise. Key removal on settle. Covered by a test: 1,000 concurrent requests for an uncached package cause exactly 1 upstream fetch.
2. **Nothing heavy on the main thread.** Parsing, filtering and serializing packuments happens in a `worker_threads` pool (size: available cores minus 1, minimum 1). The main thread only moves bytes. Responses are served from pre-serialized `Buffer`s with a precomputed ETag.
3. **Precompute once per upstream change.** When a full packument arrives, the worker produces: the version publish-time index, the filtered full document, the filtered abbreviated document, and their ETags. Re-filtering is needed only when the age cutoff moves a version from blocked to allowed; schedule that on the next request after the earliest pending unblock time, not per request.
4. **Bounded memory.** The metadata LRU is capped in bytes (`LRU_MAX_BYTES`, default 256 MB). Max accepted packument size `MAX_PACKUMENT_BYTES` (default 100 MB); larger ones return 502 with a clear error. Upstream concurrency capped (`UPSTREAM_MAX_CONNECTIONS`, default 64).
5. **Stream tarballs.** Never buffer a tarball. On a miss, stream from upstream to the client and to a temp object at the same time, verify integrity, then commit (atomic rename or S3 put). If the client disconnects, finish the download for the cache unless the upstream fails.
6. **Shared storage, no locks.** Tarballs are content-addressed (`tarballs/sha512/<hex>`) plus an index key `index/<name>/<version>` pointing to the digest. Objects are write-once, so pods sharing an RWX volume or a bucket need no locking; a duplicate write is harmless.
   Background writes (packument copy, `.meta`, index entry) go through one per-pod limiter in the core (`src/core/write-limiter.ts`): at most `STORAGE_WRITE_CONCURRENCY` at a time, a FIFO queue bounded in count and bytes, drop order packument copy < sidecar < index entry < tombstone (metrics count drops), one retry after a timeout with a longer `STORAGE_BACKGROUND_TIMEOUT`, buffered bodies only. Per-package write order (call order) is kept by the per-package chain, which awaits each write; a dropped write fails its chain step so a sidecar is never written for a missing copy. Tarball tees stream from the client download and are not queued (queueing would need buffering up to `MAX_TARBALL_BYTES`) nor retried (a consumed stream cannot be resent); they only share the timeout and the metrics. The artifact index entry is written in the background and no longer delays the end of the download response.
7. **Probes that tell the truth.** `/livez` is answered by the main thread with no I/O. `/readyz` returns 503 when event-loop delay (p99 over 10s, from `perf_hooks.monitorEventLoopDelay`) exceeds `READY_MAX_LAG_MS` (default 200) or storage is unreachable, so Kubernetes stops routing to a saturated pod instead of killing it.
8. **Stale on error.** If upstream fails or times out and a stored packument exists, serve it (re-filtered) with header `X-Eyniq-Stale: 1`. Clients have no fallback registry, so the cache must not fail when npmjs does.
9. **Stateless pods.** Everything durable is in storage. Scale horizontally; per-pod LRU only.

## 8. Minimum release age gate

- Publish times come from the full packument's `time` map. Abbreviated packuments have no per-version times, so always fetch the full document from upstream, even when the client asked for abbreviated.
- Default minimum age: 72h (`MIN_RELEASE_AGE`, accepts `30m`, `24h`, `3d`). `0` disables the gate.
- Filtering: remove versions younger than the cutoff from `versions` and `time`. Then fix `dist-tags`: any tag pointing to a removed version is repointed to the newest allowed version with the same prerelease channel; if none exists, the tag is dropped. If no version remains, return 404 with a JSON error naming the policy.
- Consider adding the `time` map to abbreviated responses so pnpm (which refetches full metadata when `minimumReleaseAge` is set) can skip the second request. Verify pnpm accepts it before enabling; feature flag `ABBREVIATED_INCLUDE_TIME`, default off.
- Tarball for a blocked version: 403 `{"error":"blocked by minimum release age","package":"x","version":"1.2.3","publishedAt":"...","allowedAfter":"..."}`. This also stops lockfiles that pin a too-new version.
- Allowlist: a JSON file (`ALLOWLIST_PATH`) with entries `{ "package": "lodash", "version": "4.17.22", "reason": "security fix", "expires": "2026-11-01" }`. Expired entries are ignored and logged.
- Unknown publish time (missing `time` entry): blocked when `FAIL_CLOSED=true` (default), allowed and logged otherwise.

## 9. Observability

- Logs: one JSON line per request on completion (method, path, status, duration ms, cache: hit/miss/stale/coalesced, bytes) plus policy decisions. No request bodies, no tokens.
- Metrics (Prometheus text format, hand-written, no dependency): request count and duration histogram by route and status, cache hits/misses/stale, coalesced waiters, upstream requests and errors, upstream latency, blocked versions, tarball bytes served, LRU size and evictions, worker pool queue length, event-loop delay p50/p99, heap used.

## 10. Configuration

Environment variables, validated at startup; invalid config exits with a clear message.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4873` | Listen port |
| `MANAGEMENT_PORT` | `9090` | Probes and metrics (`/livez`, `/readyz`, `/metrics`, `/stats`), never behind auth |
| `MANAGEMENT_HOST` | all interfaces | Address the management port listens on (e.g. `127.0.0.1` on a plain host; see OPERATIONS.md) |
| `PUBLIC_URL` | required | Base URL clients use; used for tarball rewriting |
| `PUBLIC_URL_ALIASES` | none | Comma-separated further base URLs; a request whose `Host` header names one gets documents (and the npm login registry URL) with that base instead of `PUBLIC_URL`. Unknown hosts get `PUBLIC_URL` |
| `UPSTREAM_URL` | `https://registry.npmjs.org` | Upstream registry |
| `STORAGE` | `fs` | `fs` or `s3` |
| `FS_ROOT` | `/data` | Root for `fs` storage (may be an RWX volume) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | | S3-compatible storage (AWS S3, GCS via XML API and HMAC keys, MinIO) |
| `MIN_RELEASE_AGE` | `3d` | Age gate |
| `FAIL_CLOSED` | `true` | Unknown publish time blocks |
| `ALLOWLIST_PATH` | none | Allowlist file |
| `FILTER_RULES_PATH` | none | Package filter rules (section 16) |
| `SEARCH_TIMEOUT` | `10s` | Deadline for the upstream search request |
| `SEARCH_CACHE_TTL` | `60s` | Reuse of an upstream search result; `0` disables |
| `SEARCH_UPSTREAM_RPS` | `5` | Upstream search requests per second on cache misses (token bucket); `0` disables the limit |
| `SEARCH_UPSTREAM_BURST` | `20` | Burst size of that limit |
| `METADATA_TTL` | `5m` | Revalidate packuments with upstream after this |
| `LRU_MAX_BYTES` | `268435456` | Metadata LRU cap |
| `COMPRESS_METADATA` | `true` | Gzip metadata responses (1 KiB and up) for clients that accept it; the gzip form has its own ETag (`-gz` suffix) |
| `COMPRESS_CACHE_BYTES` | `16777216` | Gzip bodies kept for reuse, per worker (keyed by ETag); `0` keeps none |
| `MAX_PACKUMENT_BYTES` | `104857600` | Largest packument processed |
| `MAX_TARBALL_BYTES` | `524288000` | Largest tarball served |
| `UPSTREAM_MAX_CONNECTIONS` | `64` | Upstream pool size |
| `UPSTREAM_TIMEOUT` | `30s` | Per upstream request |
| `STORAGE_WRITE_CONCURRENCY` | `16` | Background storage writes running at once per pod (1-256) |
| `STORAGE_WRITE_QUEUE_MAX`, `STORAGE_WRITE_QUEUE_BYTES` | `4096`, `134217728` | Bounds of the queue of waiting background writes; overflow drops the least valuable first |
| `STORAGE_STREAM_BYTES` | `134217728` with S3, `0` with FS | Bytes the streaming tarball writes may hold together (S3 buffers each tarball until its PUT commits); a miss over budget is served uncached; one write is always admitted; `0` = no budget |
| `STORAGE_BACKGROUND_TIMEOUT` | `120s` | I/O timeout of background storage writes (one retry after a timeout) |
| `WORKERS` | cores minus 1, at most 2 | Metadata worker threads; each isolate keeps the memory of what it parsed |
| `WORKER_RECYCLE_BYTES` | `67108864` | Replace a metadata worker after it processed this many document bytes; `0` never replaces |
| `METADATA_QUEUE_BYTES` | 2 x `LRU_MAX_BYTES` | Raw documents (packuments, publish bodies) the worker pool holds at once, queued plus in progress; beyond it metadata misses and publishes get `503` with `Retry-After` before any storage read or upstream fetch; `0` = no limit |
| `READY_MAX_LAG_MS` | `200` | Readiness threshold |
| `AUTH_TOKENS_PATH` | none | JSON `{ "<name>": "<sha256 of token>" }`; enables auth when set |
| `USERS_FILE` | none | Users for `npm login` (scrypt hashes, section 16 C3); enables auth when set |
| `USER_REGISTRATION` | `false` | Self-registration through `npm adduser` (needs a writable `USERS_FILE`) |
| `MAX_USERS` | `1000` | Self-registration stops at this many users |
| `USER_TOKEN_TTL` | `90d` | Lifetime of tokens issued by `npm login` (and the longest of created tokens) |
| `USER_TOKEN_CACHE_TTL` | `30s` | How long a pod trusts a looked-up user token (revocation delay on other pods) |
| `ANONYMOUS_READ` | `false` | With tokens or users configured: reads need no token (writes still do) |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse proxies in front (client address from `X-Forwarded-For`, for login limits) |
| `PRIVATE_PACKAGES` | none | Names published to this registry (`@acme/*,internal-*,tool`, section 16 C4); never fetched upstream |
| `UNPUBLISH_WINDOW` | `72h` | Private versions can be unpublished this long after publishing; `0` never |
| `MIN_RELEASE_AGE_LOCAL` | `false` | Also apply `MIN_RELEASE_AGE` to private packages |
| `MAX_PRIVATE_PACKUMENT_BYTES` | `16777216` | Largest stored private package document |
| `MAX_UNPACKED_BYTES` | `268435456` | Decompression cap for the tarballs of one publish together |
| `ALLOW_ANONYMOUS_PRIVATE_READ` | `false` | Needed to start with `ANONYMOUS_READ=true` and `PRIVATE_PACKAGES` (private packages readable by anyone) |
| `WEB_UI` | `false` | Read-only web catalog under `/-/web/` (section 16 C5); `/` redirects there |
| `WEB_STATS` | `true` | Show the statistics page in the web catalog (needs `WEB_UI` and `STATS_HISTORY`); `false` keeps `/stats` on the management port |
| `WEB_UI_IMAGES` | `false` | Show https images in READMEs (the browser then loads them from third-party hosts) |
| `WEB_SESSION_TTL` | `1h` | Lifetime of a catalog sign-in session (at most `7d`) |
| `STATS_HISTORY` | `true` | Keep a statistics history in storage and serve it (section 17) |
| `STATS_INTERVAL` | `60s` | Time between two history records of a pod (10s to 1h) |
| `STATS_RETENTION_MINUTE`, `STATS_RETENTION_HOUR`, `STATS_RETENTION_DAY` | `7d`, `90d`, `0` | How long each history tier is kept; `0` = forever |
| `POD_NAME` | hostname | This pod's id in history keys (sanitized) |
| `LOG_LEVEL` | `info` | |

## 11. Security requirements

- Validate names and versions before use; storage keys are derived from validated names or digests, never from raw paths. Test path traversal (`..`, encoded slashes, null bytes).
- Fixed upstream host; no SSRF via packument URLs or redirects.
- Integrity verification on every tarball before it is cached.
- Size limits on packuments, tarballs and pass-through bodies, and on the raw documents waiting for the metadata workers (`METADATA_QUEUE_BYTES`, 503 with `Retry-After` beyond it).
- Tokens are compared as SHA-256 hashes in constant time; never logged.
- Insecure setups are loud: without `AUTH_TOKENS_PATH` or `USERS_FILE` (an open read proxy) and with `MIN_RELEASE_AGE=0` the server logs a warning at startup. The Helm chart's NetworkPolicy is on by default.
- Strip `Authorization` and cookies from upstream requests; forward only an allowlist of headers.
- Container runs as non-root on a read-only root filesystem; only the storage path is writable.
- CI runs type-check, lint, tests, dependency audit and a secret scan. Every change touching HTTP, storage, auth or policy gets a security review.

## 12. Testing and acceptance

- Unit: name validation, filtering and dist-tag repointing (including prereleases), allowlist expiry, config parsing, SigV4 signing against AWS test vectors.
- Integration: against a fake upstream (`test/fake-upstream.ts`) with recorded fixtures. Real clients: `npm install`, `pnpm install` and `yarn install` of a fixture project succeed through the cache, cold and warm.
- Concurrency: 1,000 concurrent requests for one uncached packument cause exactly 1 upstream fetch; 200 concurrent cold tarball requests for the same file cause 1 upstream fetch and identical bytes; the 20+ MB fixture packument does not raise event-loop delay above 50 ms while being processed.
- Load test (`load/`): replay the dependency set of a real project lockfile as N parallel installs. Run against Verdaccio first to record a baseline (requests/s, p95 latency for metadata and tarballs, errors, timeouts, CPU, memory, event-loop delay, upstream fetches, hit ratio), then against Eyniq Cache.

MVP is done when:
1. All tests pass in CI.
2. The load test at 2x the largest real burst shows 0 restarts, 0 install errors, memory within the pod limit, and better numbers than the Verdaccio baseline on every metric.
3. It runs as canary on one CI runner pool (both `npm_config_registry` and `pnpm_config_registry` set) for a week without incidents.

## 13. Deployment

- `deploy/Dockerfile`: multi-stage; build with `tsc`; run on a distroless Node 26 image as non-root.
- `deploy/helm/eyniq-cache`: Deployment (2+ replicas), Service, ConfigMap, Secret refs, PodDisruptionBudget, probes on `/livez` and `/readyz`, resource requests and limits, optional PVC (RWX) for `fs` storage.
- Rollout: install next to the existing cache, canary on one runner pool, compare with the Verdaccio baseline, then switch pools one by one.

## 14. Build order (vertical slices)

1. **Proxy one unscoped package end to end.** Full packument + tarball, tarball URL rewrite, integrity check, `FsStorage`, JSON logs. `npm install lodash` works through it.
2. **Protocol completeness.** Scoped packages, abbreviated packuments, version documents, ETag/304, HEAD, ping, audit and search pass-through, 405s, stale-on-error.
3. **Concurrency core.** Coalescer, worker pool, pre-serialized responses, bytes-capped LRU, readiness on event-loop delay, metrics. Concurrency tests green.
4. **Age gate.** Filtering, dist-tag repointing, tarball blocking, allowlist, fail-closed.
5. **Shared storage and auth.** Content-addressed layout, atomic writes on shared volumes, `S3Storage` with own SigV4 signer (tested against MinIO), static tokens.
6. **Ship.** Dockerfile, Helm chart, load-test harness, Verdaccio baseline run, canary rollout.

## 15. Rules for whoever builds this (human or agent)

- Keep the hot path (cache hit) free of anything that parses JSON or touches policy code at request time.
- No new runtime dependency without an entry in `docs/DEPENDENCIES.md` and maintainer approval.
- Never put downstream-only features in this repo; add an interface instead if the core needs a hook.
- All npm-specific code lives in `src/adapters/npm/`. The core never imports from an adapter.
- Explain non-obvious code with short comments; Every change is reviewed.

## 16. Verdaccio parity (C1-C6)

Goal: close the feature gaps against Verdaccio 6 that block adoption (gap list kept by downstream builds), without breaking the zero-dependency, hot-path and adapter rules. Planned in six slices; C1, C2 and C6 come first, C3 to C5 build on the write path of P3/P9.

| Slice | What |
| --- | --- |
| C1 | Package filter: block by name, `@scope/*` or `prefix*` and by version range; allow rules that override blocks and the age gate; dist-tags of filtered versions repoint to the newest remaining version of the same channel. |
| C2 | `GET /-/v1/search`: bounded proxy to the upstream search, no client credentials forwarded, results never advertise blocked versions, optional `PackageSource.search` hook to merge local packages (used by C4). |
| C3 | Users and `npm login` against a built-in user store (an `AccountProvider` implementation). |
| C4 | Private publishing for the community build (a `PackageSource` implementation on storage). |
| C5 | Web catalog (read-only package browser). |
| C6 | Reproducible Linux benchmark against Verdaccio with its package filter and S3 storage (`docs/BENCHMARK.md`, `load/bench/`). |

### C1 package filter

- `FILTER_RULES_PATH` points to a JSON file `{ "block": [...], "allow": [...] }`; a rule is `{ "id"?, "package", "versions"?, "reason"? }`. Unknown keys, bad patterns, bad ranges, duplicate ids and more than 10,000 rules are startup errors (`ConfigError`, the process exits).
- `package` is an exact name, `@scope/*`, `prefix*` or `*`. Matching is plain string comparison; rule text is never turned into a regular expression. `versions` is an npm range (exact, `^`, `~`, comparators, x-ranges, hyphen ranges, `||`) parsed by `src/adapters/npm/range.ts` (own matcher, bounded length and size). Prereleases are matched on purpose: a block on `>=1.0.0 <2.0.0` also blocks `1.5.0-beta.1`. A rule without `versions` matches every version, including ones that are not valid semver.
- Implemented as a `Policy` (`PackageFilterPolicy`, npm only) placed before the age gate in `composePolicies`. A blocked tarball is a 403 `blocked by package filter rule "<id>": <reason>`, like the age gate's. If every version is blocked the packument is a 404 naming the policy.
- An allow rule beats a block rule and the age gate, for the versions it names only. It does not reach later policies in the chain (an advisory policy still applies). Mechanism: the filter reports the exemption to the age gate (`MinReleaseAgeOptions.exempt`, consulted only when the gate would deny), so no ordering trick in `composePolicies` is needed. An override is audited as `policy.allowlisted`.
- "Replace" behaviour (Verdaccio `strategy: replace`) is the existing dist-tag repointing of the render step (section 8), which works for any policy: a tag whose version is filtered moves to the newest allowed version of the same prerelease channel, otherwise it is dropped. Deliberately not Verdaccio's "highest remaining": `latest` never lands on a prerelease.
- Rules are static for the process lifetime (no reload); change the file and roll the pods.

### C2 search

- `GET /-/v1/search` is no longer a transparent pass-through for adapters with `EcosystemAdapter.search` (npm). The route stays `kind: 'passthrough'` with `search: true`, so authorizers see the same resource (`route: "passthrough"`, ecosystem-wide read) as before.
- Query: only `text` (at most 512 chars), `size` (1-250, default 20), `from` (0-10000) and `quality`/`popularity`/`maintenance` (0-1) are accepted and re-encoded in a fixed order; unknown parameters are dropped and invalid or repeated ones are a 400 before anything goes upstream.
- Upstream: one GET with only `Accept: application/json` (no client headers, so no credentials or cookies), a deadline (`SEARCH_TIMEOUT`, 504), a 2 MiB cap on the (decoded) body (502), 502 for non-200 or unparsable answers. The upstream body is parsed once by the adapter (`SearchProtocol.parseUpstream`) and the parsed result is cached for `SEARCH_CACHE_TTL` in a 16 MiB LRU (accounted by raw size), so a cache hit does no JSON.parse; concurrent identical queries are coalesced. Cache misses pass a token bucket (`SEARCH_UPSTREAM_RPS`/`SEARCH_UPSTREAM_BURST`) and a concurrency cap of 4: over the limit a stale entry is served, else 429 with Retry-After. The deadline aborts the upstream request (`UpstreamRequest.signal`). Whole-package name blocks are applied without metadata through the optional `Policy.blocksWholePackage`. Only the upstream part is cached: it does not depend on the caller, while filtering and local hits are applied per request.
- Policy: results never advertise a blocked version when the package is in the metadata LRU (`MetadataService.peek`: memory only, no fetch). The `version` (and `date`) is rewritten with the same rule as dist-tags (`repointVersion`: newest allowed version of the same channel); a package without any allowed version is dropped and `total` reduced. Packages that are not cached are left as upstream sent them (a search must not cost a packument fetch per hit); their tarballs are still gated.
- `PackageSource.search?(query, identity)` (default off) returns `SearchHit`s (name, version, description, keywords, date, publisher). They are shown first on the first page (`from=0`), trimmed to `size`, and counted in `total`. Upstream results whose name the source owns are dropped so a public package cannot shadow a private one. A throwing or slow (5 s) source is skipped; if upstream fails, local hits alone are returned.

### C3 users and npm login

- `USERS_FILE`: `{ "version": 1, "users": { "<name>": { "password", "created", "changed", "generation", "packages"? } } }`, managed with `node dist/main.js user add --packages <patterns>|passwd|remove|list` (`src/auth/users-cli.ts`; `add` requires `--packages`, `"*"` for every owned package, `""` for none, so a forgotten option never means "publish everything"). Names are 1-64 lowercase `[a-z0-9._-]`. Passwords: scrypt from `node:crypto` as `$scrypt$ln=15,r=8,p=3$<salt>$<hash>` (16-byte random salt, 64-byte key, OWASP's N=2^15/p=3 variant: 32 MiB per hash instead of 128 MiB), checked with `timingSafeEqual`; parameters in a file are capped at `ln<=17`, `r<=8` (128 MiB per hash); at most 2 hashes run at once per process (queue of 64, then `503` with `Retry-After`, never a 401) so a login flood cannot exhaust memory. The CLI reads the password from the terminal without echo (asked twice) or as the first line of stdin, never from argv; at least 12 characters.
- The server re-reads the file when its size or mtime changes (checked at most every 2 s, lazily on use, so CLI edits and Secret updates apply without a restart) and keeps the last good snapshot when a new version does not parse. Writers (CLI, self-registration) take an `O_EXCL` lock file next to it holding a random owner id, re-read under the lock and replace it atomically (temp file plus rename, mode 0600); a writer removes the lock only while it still holds its id, and a stale lock (older than 30 s) is broken under a second `O_EXCL` guard, renamed aside and checked before removal, so writers breaking the same stale lock cannot remove each other's fresh lock.
- Verdaccio's htpasswd hashes (bcrypt, crypt, SHA1) cannot be imported: re-add users with the CLI (or open self-registration for a short window). Basic auth with a password on registry requests is not supported: every request would cost a scrypt hash.
- `npm login` (`PUT /-/user/org.couchdb.user:<name>`; npm falls back to it from web login, which the community build does not offer) issues `eyc_<32 random bytes, base64url>`. Only the sha256 is stored (`auth/user-tokens/<hex>`, plus an empty marker under `auth/user-index/<sha256 of the user>/` for listing), with expiry (`USER_TOKEN_TTL`) and revocation, changed only by compare-and-swap (StorageAdmin). A token is valid while its record is active, the user is still in the file and the token carries the user's current `generation` (an integer that `user passwd` raises and that differs for a removed and re-added name; hand-written records without it use the `changed` time in ms): `user passwd` and `user remove` end every token of that user without comparing clocks between hosts. Pods cache lookups for `USER_TOKEN_CACHE_TTL` (unknown tokens in a separate, smaller map); a lookup that overlapped a revocation on the same pod does not cache what it read; the cache-hit path is a sha256 plus a map lookup. Cache misses for unknown tokens are bounded (`LookupLimiter`: per client address, IPv6 per /64, 60 burst and 2/s; globally 1,000 burst and 100/s; a lookup that finds a real token gives its budget back): beyond that the request gets the usual 401 without a storage read. Listing a user's tokens removes the index markers (and records) of expired, revoked or missing tokens.
- `npm logout` revokes the token (it needs no credentials, so reading a token record this pod does not know comes out of the same `LookupLimiter` budget, refunded when the token exists; beyond it the answer is the usual 200 without a storage read); `npm token list|create|revoke` work for user identities only. Creating a token needs the account password, never outlives the token used, and a read-only token creates and revokes only read-only tokens; CIDR-restricted tokens are refused (behind an ingress the source address is not the client's); at most 100 active created tokens per user (more are refused with 429) and 100 login tokens (a login beyond that revokes the user's oldest login token, so repeated `npm login` from CI keeps working). Tokens carry the generation of the record the password was checked against.
- Brute force (`src/auth/login-limiter.ts`, per process): per user name 5 free failures, then 1 s, 2 s, 4 s ... up to 15 min during which attempts fail without a password check; per client address (IPv6 per /64, IPv4-mapped IPv6 as IPv4) 30 failures per 15 min and at most 4 checks in progress at once (beyond it `503` with `Retry-After`, not a failed login, so a few addresses cannot fill the scrypt queue; many addresses still can, which only delays logins with 503). Every check first reserves its attempt; unresolved reservations count as failures, so concurrent guesses cannot all pass before the first failure is counted (at most the free failures run at once per name, one at a time after that). Entries are dropped only once idle (nothing pending, not blocked, failures forgotten); when a map (10,000 entries) is full of live entries, further names and addresses share 1,024 overflow buckets (keyed hash), which are always checked too: a flood of made-up names can never erase a real lockout, at the price of throttling unrelated names in the same bucket while it lasts (a lockout, not a bypass). Unknown names cost the same scrypt work (a dummy hash with the users' own parameters) and are counted like real ones; every failure is the core's one `401 invalid credentials`. The client address is the socket peer, or with `TRUST_PROXY_HOPS=N` the `X-Forwarded-For` entry N places from the right (new optional `AccountContext.clientAddress`).
- Self-registration (`USER_REGISTRATION=true`, default off like Verdaccio's `max_users: -1` in production): `npm adduser`/`npm login` with an unknown name and a policy-conforming password creates the user while the file holds fewer than `MAX_USERS`; such users get `packages: []` (read only) until an operator grants publish patterns. Registration needs a writable `USERS_FILE` directory (checked at startup); an existing name is always a login, never a re-registration. Every registration counts against the per-address budget, so one address cannot fill `MAX_USERS` in a burst; a refused registration (short password, full) costs the same scrypt work as a login.
- Auth: `UserAuth` accepts user tokens and, next to them, the static tokens of `AUTH_TOKENS_PATH`. With either configured, reads need a token unless `ANONYMOUS_READ=true`. `CommunityAuthorizer`: reads as before; `publish` only for user-token identities that are not read-only, of users still in the file, for names their `packages` patterns allow (absent: any name the PackageSource owns; patterns as in `src/core/patterns.ts`); static token identities never publish; `account` for user identities; `admin` never.
- Composition: `createUserAccounts(config, storage)` in `src/compose.ts` (exported through `defaults`); `composeCommunity` uses its auth, accounts and authorizer unless overridden.

### C4 private packages

- `PRIVATE_PACKAGES` (exact names, `@scope/*`, `prefix*`; `*` is refused) composes `NpmPrivateSource` (`src/adapters/npm/private-source.ts`) as the npm `PackageSource`. Owned names are matched case-insensitively and are never fetched from upstream, also not on a 404 or an upstream outage (core, P3); upstream search hits of owned names are dropped (C2). Publishing needs a user token (C3, `CommunityAuthorizer`); without `USERS_FILE` the names are reserved and read-only. There are no per-package read permissions: whoever may read the registry reads the private packages, so `ANONYMOUS_READ=true` with `PRIVATE_PACKAGES` refuses to start unless `ALLOW_ANONYMOUS_PRIVATE_READ=true` (then logged loudly).
- Storage: `private/npm/packuments/<name>.json` (document with `rev`, random `epoch`, versions, time, dist-tags, package-level fields and the `unpublished` map) and the tarballs in the content-addressed `tarballs/sha512/<hex>`. Same layout and format as other sources built on the extension API, so a registry can switch builds. Every change is a read-modify-write with `putIfAbsent`/`putIfMatch` and up to 200 retries with jittered backoff (503 after that): concurrent publishes on several pods never lose a version (concurrency test: 40 versions on 4 pods). Tarballs are written before the document, so a document never names missing bytes; refused publishes are checked before any byte is written.
- Publish checks on top of the core's (permission, ownership, name, body size `MAX_PUBLISH_BYTES`, sha512/shasum computed from the bytes and compared with the client's claim, registry-only fields such as `_npmUser` dropped): integrity again in the source; 1-10 versions; no build metadata (`1.0.0+x` would equal `1.0.0`); versions are immutable and an unpublished number is burnt forever (409); a stale `_rev` is 409; the tarball must be a gzip tar whose `package/package.json` names exactly this name and version (`tarball-check.ts`: async gunzip stopped at `MAX_UNPACKED_BYTES` for all tarballs of the publish together and yielding to the event loop every 4 MiB, header checksums, at most 100,000 entries, package.json at most 1 MiB, no paths outside `package/`, no absolute paths, no `..`, `.` or empty segments (one trailing slash allowed), no links or special files, no second package.json in any spelling an extractor could map onto it (`package/./package.json`, `package//package.json`, case variants, Windows trailing dots and spaces), header fields read as npm's extractor (node-tar) reads them (the ustar prefix only with magic `ustar\0` and version `00`, GNU headers with an empty prefix area, other formats refused, no bytes after a field's NUL terminator, no file entry ending in a slash, no directory entry with a size), pax headers only with `path`, the times and a `size` equal to the entry's (no `linkpath`, charset or vendor records, no global path/size, strictly formed records, no header without its entry), no truncation or data after the end marker); `scripts`, `license`, `os`, `cpu`, `engines`, `bin` and the dependency fields (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`, `bundledDependencies`) of a stored version come from the tarball's package.json, never from the publish body (manifest confusion; without `bin` only the entries npm derives from `directories.bin` are kept), `hasInstallScript` is derived from its install scripts or a `binding.gyp` and `_hasShrinkwrap` from an `npm-shrinkwrap.json` (any spelling a file system could map onto it); a `deprecated` field in a published manifest follows the `npm deprecate` rules (400); the document stays below `MAX_PRIVATE_PACKUMENT_BYTES` (413). The publisher (`_npmUser`) is the authenticated identity. Tarballs a publish wrote are deleted again when its document update fails (unless the document references them by then).
- Provenance and attestations are accepted but neither stored nor verified: the adapter drops `.sigstore` attachments and `dist.attestations`/`signatures`, so served documents never claim provenance.
- `npm dist-tag add/rm` (`latest` cannot be removed), `npm deprecate` (idempotent, whole-document PUT), `npm unpublish` of versions or the whole package within `UNPUBLISH_WINDOW` (default 72h like npm; `0` disables unpublishing), only by the user who published each version (403 otherwise); removed versions drop their tags and `latest` moves to the newest remaining stable version. The core audits `publish` (with the integrity per version and the dist-tags), `unpublish`, `dist-tag` and `deprecate` with request id, identity and the credential id (`Identity.claims.tokenId`: the sha256 of a user token), and refused writes (400, 409, 413) as `write.refused` with status and reason.
- Policy: private versions go through the same policy chain (`PolicyInput.origin: "local"`). The package filter (C1) applies as for any package; the age gate exempts own packages by default (a team's just-published version must be installable at once; the gate protects against fresh third-party releases), `MIN_RELEASE_AGE_LOCAL=true` gates them too.
- Search: `NpmPrivateSource.search` keeps a per-pod index (name, latest version, description, keywords, date, publisher) refreshed at most every 10 s by listing the documents and re-reading only those whose etag changed, at most 64 MiB of documents per pass (the next search continues; at most 10,000 packages); a pod's own writes mark just that package for re-reading. Description and keywords lose control and bidi characters. Terms match name, description and keywords; `keywords:`, `scope:`, `author:`/`maintainer:` are understood. Hits are merged in front of upstream results on page one (C2) after the core authorized the ecosystem-wide read; npm's search output needs `maintainers`, so local hits carry the publisher there.

### C5 web catalog

- `WEB_UI=true` serves a read-only catalog from the registry port under the fixed prefix `/-/web/` (no package name can start with `-`); `GET /` redirects there. Off by default: the registry then answers exactly as before.
- Shell: `src/web/static/` (`index.html`, one ES module `app.js`, `style.css`, `favicon.svg`), plain files without a build step; `pnpm build` copies them to `dist/web/static/` and the server reads them once at startup (a build without them fails at startup when `WEB_UI` is on). The client is type-checked (`checkJs`, `src/web/static/tsconfig.json`) and linted like the rest; it builds DOM only with `createElement` and text nodes (a unit test refuses `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and friends) and sets `href`/`src` only after checking for an absolute http(s)/mailto URL; external links get `rel="noopener noreferrer nofollow"`. Semantic landmarks, labels, a skip link, focus management and a live region; responsive; light and dark through `prefers-color-scheme`.
- Headers on every `/-/web/` response: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' [https: with WEB_UI_IMAGES]; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (with `no-referrer` browsers send `Origin: null` on the sign-in form post), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`, `Permissions-Policy`, and `Strict-Transport-Security: max-age=31536000` when `PUBLIC_URL` is https. HTML and JSON are `no-store`; assets revalidate by ETag. Error answers carry the same headers (an unexpected failure is logged and answered 500 by the catalog itself). No inline scripts or styles anywhere. With an http `PUBLIC_URL` the server warns at startup.
- JSON endpoints (GET): `api/session`, `api/search?text=` (the registry search service itself, C2, sharing its cache, with its own upstream token bucket so catalog visitors and `npm search` cannot use up each other's budget, incl. private packages, C4), `api/package/<name>?version=` and `api/readme/<name>`. They use the registry's authentication and the same `read` authorization (`metadata` resource for a package, the ecosystem-wide `passthrough` resource for search); the package lookup is the registry's (owned names never go upstream), and a package the policy hides as a whole (`blocksWholePackage`, package filter) is a 404 as in search.
- Package detail comes from the new optional `EcosystemAdapter.catalog` (`CatalogProtocol`, npm: `src/adapters/npm/catalog.ts`) on the main thread, bounded: package fields from the pre-serialized head (parsed up to 4 MiB), only the detailed version's fragment parsed (up to 1 MiB), at most 500 versions listed. Dist-tags are shown as served (policy repointing). Blocked versions are listed with the policy reason and `allowedAfter`; a blocked selected version gets no install commands and no download link. Links (homepage, repository, bugs) are reduced to absolute http(s) URLs without credentials (git and shorthand repository URLs normalized to https).
- README: `src/web/markdown.ts` parses a Markdown subset server-side into a JSON tree of whitelisted node types (headings, paragraphs, emphasis, strong, strikethrough, inline/fenced/indented code, lists, quotes, rules, pipe tables, links, optional images, line breaks). Raw HTML never passes: tags are stripped (their text stays), comments and `<script>`/`<style>` bodies are dropped. Links only to absolute http/https/mailto URLs parsed with `URL` (no relative, protocol-relative, `javascript:`, `data:` or credential URLs). Images only with `WEB_UI_IMAGES` and only https, rendered with `referrerpolicy="no-referrer"`; otherwise their alt text. Bounded: 64 KiB of input, 20,000 nodes, nesting depth 12, delimiter look-ahead cached, a link destination scanned once (at most 2,248 characters, parenthesis balance counted on the way, at most 32 deep), trailing spaces trimmed by a loop, and a global step budget (1,000,000 loop rounds and weighted scanned characters; real 60 KiB READMEs use under 50,000) after which the rest is cut off and marked truncated, so hostile input stays linear (tests: the review's quadratic inputs and a seeded fuzz loop each under 200 ms). Rendering stays on the main thread (bounded as above); check, render and store in the cache run without an await in between, so concurrent requests for one README render it once. Rendered trees are cached per package digest (8 MiB).
- Sign-in (when `ServerDeps.webLogin` exists, i.e. `USERS_FILE`): `POST /-/web/login` (form) with the same password check and brute-force limits as npm login (C3); the POST must carry `Origin` equal to `PUBLIC_URL`'s origin, or no usable `Origin` (absent or `null`) together with `Sec-Fetch-Site: same-origin` (else 403), so cross-site and unmarked posts never sign anyone in; the form body must arrive within 10 s (408), and only a sign-in whose body has arrived counts towards the 16 in progress (503 beyond). Unknown session ids cost a storage read only within the same budget as unknown user tokens (`LookupLimiter`, keyed by the client address on every lookup, logout included) and are cached in a separate, smaller map (1,000) so they cannot evict real sessions; a lookup overlapping a logout is not cached. A session keeps the `stamp` its login returned (`WebLogin`; the community build: the user's generation, C3). A session is `eyw_<32 random bytes>` in cookie `eyniq_web_session` (`HttpOnly; SameSite=Strict; Path=/-/web/`, `Secure` when `PUBLIC_URL` is https, `Max-Age` = `WEB_SESSION_TTL`); storage keeps only its sha256 under `auth/web-sessions/` with user and expiry (lookups cached `USER_TOKEN_CACHE_TTL`). A session also ends when the user is removed or changes the password (generation, not clocks). `POST /-/web/logout` (same origin check) deletes it. Sessions only open the catalog's read endpoints: the registry never reads the cookie or that key prefix. Logins are audited as `auth.login`/`auth.denied` with `method`/`action` `web-catalog`.
- Hooks (default off): `EcosystemAdapter.catalog`, `ServerDeps.webLogin` (`WebLogin`: `login` with an optional `claims.stamp`, optional `isValid(name, issuedAt, stamp)`), config `webUi`, `webUiImages`, `webSessionTtlMs`. `createSearchService` is shared by the search route and the catalog (`run(..., channel)` picks the token bucket).

### C6 benchmark

- `load/bench/run.sh` drives `load/bench/driver.ts` inside one container (Verdaccio image as root: Node 24 plus Verdaccio; versitygw joins its network namespace), so the seed, candidate and load generator share one loopback. Candidates: Eyniq and Verdaccio 6.10.5, each on filesystem and on S3 (versitygw), with the age filter on (`MIN_RELEASE_AGE=3d` and `package-filter minAgeDays: 3`).
- The seed is an Eyniq in front of the real registry, warmed once by one install and kept in a volume; all candidates use it as upstream, so runs are repeatable and offline. Method, caveats and the reference numbers of the Linux run: `docs/BENCHMARK.md`.
- Zero dependencies: the scripts use only Node, shell and Docker. The Verdaccio S3 plugin is installed with npm inside the throwaway container at bench time, not into this repository.

## 17. Statistics history (H1-H2)

Operators should see how the cache runs without Prometheus or Grafana, so every pod keeps its own history in the storage it already has. Default on (`STATS_HISTORY=false` turns it off); nothing is added to the request path: the recorder only reads the existing metric counters on a timer.

### H1 Recording, rollups, read side

- `src/stats/` is ecosystem-agnostic and has no dependency on the HTTP layer; `src/http/stats-source.ts` adapts the `Metrics` registry (counters now also keep their label sets, `Counter.entries()`, `Histogram.snapshot()`) into a cumulative `StatsSample`. The core contracts are unchanged.
- Every `STATS_INTERVAL` (default 60 s) a pod turns the difference between two samples into one `StatsPoint`: requests by route and status class (probe, `/metrics` and `/stats` routes excluded), cache results, coalesced waiters, upstream requests and errors, blocked versions, tarball bytes, LRU evictions, the gauges sampled at the tick (LRU bytes, worker queue, RSS, heap, event-loop delay p50/p99) and p50/p95/p99 per route, derived from the histogram bucket deltas of the interval (linear interpolation inside a bucket, like `histogram_quantile`). `t` is the end of the interval in epoch seconds (UTC), `s` the seconds it really covered, so a late tick keeps rates honest. A counter that goes down is treated as a restart.
- Storage layout, all keys built from digits and a sanitized pod id (`POD_NAME`, else the hostname; `[A-Za-z0-9._-]`, at most 63 characters; when sanitizing changed the name, a hash of the raw name is appended so different names stay different; logged at startup): `stats/minute/<yyyy>/<mm>/<dd>/<hh>/<pod>.ndjson` (points of one hour), `stats/hour/<yyyy>/<mm>/<dd>/<pod>.ndjson` (one rollup per hour), `stats/day/<yyyy>/<mm>/<pod>.ndjson` (one rollup per day). "minute" is the finest tier whatever the interval is.
- Only the pod itself writes its keys, so there is no compare-and-swap. The current hour lives in memory; it is written (append by rewriting the pod's own object, merged by timestamp with what an earlier run of the same pod left) at most every 5 minutes, when the hour changes and on shutdown (a final partial tick first). Each flush also recomputes the rollups of the objects it wrote: hour = rollup of the hour's points, day = rollup of the day's hour rollups, so a restart or a failed write only costs the unwritten tail. Counters add up, gauge averages are weighted by sample count (the maximum is kept), latency quantiles take the maximum of the merged quantiles. That last step is an approximation (an upper bound): exact quantiles cannot be rebuilt from quantiles.
- Retention: 10 minutes after start and then every 6 hours a pod lists each tier and deletes the objects of any pod whose period ended before `now - STATS_RETENTION_*` (a tier with `0` is kept forever). An object past its retention has no live writer, so this also cleans up the pods of earlier rollouts (Kubernetes gives every rollout new pod names); the objects a pod still holds in memory are never deleted. The shutdown flush does not prune, and is bounded by a 5 s timeout. Minimum retention (checked at config load): minute 1h, hour 1d, day 0 or 7d. Pruning is skipped when the storage has no `StorageAdmin` operations.
- Robustness: a failed write is counted in `eyniq_cache_stats_write_errors_total` and logged as a warning at most every 10 minutes; serving never waits for it. Unwritten objects stay in memory (at most 6; older ones are dropped and counted), the objects are never read back except to merge once per object.
- Read side (`StatsReader`): `GET /stats?range=1h|24h|7d|30d|90d|1y&step=auto` on the management port (cluster-internal, no auth, like `/metrics`; 404 when the history is off). 1h and 24h read the minute tier, 7d to 90d the hour tier, 1y the day tier; `auto` picks 1 min, 5 min, 1 h, 6 h, 1 d, 1 d, or `step` is one of 60, 300, 900, 3600, 21600, 86400 seconds. The reader lists the tier's prefixes (a day, month or year each), keeps objects overlapping the range and merges all pods: counters are summed, gauges averaged and maxed, latency is the maximum of the pods' quantiles (an approximation, see above). It also returns the memory per pod. The hit ratio is (hit + revalidated + stale) / (those + miss + coalesced); pass-through requests are not counted.
- Bounds on the read side: at most 200 objects, the 32 most recently written pods (so dead pods of old rollouts never hide live ones), 20 list pages per prefix, 2 MiB and 5,000 lines per object, 8 reads in flight; the raw points of a range are cached for 30 s (at most 6 ranges) and every `step` is re-bucketed from them in memory, concurrent queries of a range share one computation, and at most 2 computations run at once (a third gets 503 with `Retry-After`), so the work does not grow with the request rate. `HEAD /stats` is refused (405). The statistics endpoints' own polling is not counted in the request statistics. Anything above a bound (including the list page limit) sets `truncated`; unreadable or malformed objects are skipped and counted in `skipped`. Stored lines are validated strictly (finite non-negative numbers, key names matching `[A-Za-z0-9_.:-]{1,48}`, at most 64 keys per map) and parsed into null-prototype maps, so a tampered object cannot do more than show wrong numbers.
- Storage writes (console prerequisite P1): points also carry `writes` (`ok`, `failed`, `dropped`, `retries` of the background write limiter; `ok` = attempts minus retries and final failures), `writeLatency` ([p50, p95, p99, attempts], from `storage_write_duration_seconds` summed over kinds) and the gauges `writeQueue` and `writesInFlight`. `/stats` buckets return `writes` and `writeLatency`. Fields missing in points stored by older versions read as 0/null with the same strict validation otherwise (a present but malformed field rejects the line).
- Public API (P2/P3): `src/index.ts` also exports `StatsReader` with its types and `STATS_RANGES`, `UsersFile`, `verifyPassword`, `checkPasswordPolicy`, `hashPassword` and `LoginLimiter` (no behaviour change). `CacheServer.metadataFetchTimes(adapter, name)` returns `{ fetchedAt, originFetchedAt }` (epoch ms) from the LRU entry or the stored `.meta` sidecar, without contacting upstream; `null` when never fetched or owned by a PackageSource. `fetchedAt` is the last fetch or 304 revalidation, `originFetchedAt` the last full fetch.
- CLI: `node dist/main.js stats [--range 24h]` reads the storage directly with the server's environment (it needs `PUBLIC_URL` like any config) and prints totals, hit ratio, upstream fetches, blocked versions, p95/p99 and peak memory.
- Not in scope: alerting, per-package statistics, exact quantiles across pods.

### H2 Stats page in the web catalog

- Only with `WEB_UI=true`, `STATS_HISTORY=true` and `WEB_STATS=true` (the default; `false` hides the page and its endpoint but keeps the management `/stats`): the page `/-/web/stats` (same shell as the other pages) and the JSON endpoint `GET /-/web/api/stats?range=...` (default 24h; `step` is always auto). The endpoint is authorized like every catalog read (session cookie or registry credentials, then the `read` authorization with the resource `{ ecosystem: "*", route: "stats" }`, so an authorizer can restrict it) and calls the same cached `StatsReader` as the management `/stats`, so the catalog adds no extra storage load. `/-/web/api/session` reports `stats: true|false`; the header shows a "Statistics" link only then.
- Client (`src/web/static/app.js`): plain SVG built with `createElementNS` (no library, no innerHTML), colors and dashes only through classes in `style.css` (palette variables with a dark variant; series also differ by dash style), so the CSP stays `style-src 'self'` and a unit test refuses inline style attributes. Charts: requests per second (with 5xx), cache hit ratio, upstream fetches and errors, blocked versions, p95 latency, resident memory per pod (at most 8 pods drawn). Each chart has a heading, `role="img"` with `<title>` and `<desc>` (latest and highest value per series), a legend, and a "Show as table" `<details>` with the data (built when opened). A range selector (`1h` ... `1y`) is a nav of links with `aria-current`.
- Data exposure: request counts per route and status class, hit ratio, upstream and blocked counts, latency, memory and pod names. No package names, client addresses or identities. Pod names, memory, the request mix per route and blocked counts are operator information, so deployments that show the catalog to people who should not see them can restrict the `stats` resource in their authorizer or set `WEB_STATS=false`. The endpoint's own polling is counted under its own route label and left out of the statistics; a busy reader answers 503 with `Retry-After`.

