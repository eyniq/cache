# Operations

How to run, size, observe and load-test Eyniq Cache. The design is in [DESIGN.md](DESIGN.md);
configuration is the environment-variable table in section 10 (plus `MANAGEMENT_PORT`, below).

## Ports

| Port              | Default | Serves                                  | Exposure                    |
| ----------------- | ------- | --------------------------------------- | --------------------------- |
| `PORT`            | 4873    | the npm registry API (root and `/npm/`) | clients                     |
| `MANAGEMENT_PORT` | 9090    | `/livez`, `/readyz`, `/metrics`         | kubelet and Prometheus only |

The probes live on their own port because on the registry port `/metrics` is the real npm
package "metrics". They are never behind auth; keep the management port cluster-internal
(the Helm chart puts it on a separate Service). The chart's NetworkPolicy is on by default
(`networkPolicy.enabled=true`): only pods in the release's namespace reach the registry port
and only the kubelet reaches the management port until you list `clientNamespaces` (include
an Ingress controller's namespace) and `monitoringNamespaces`. It needs a CNI that enforces
NetworkPolicy; turn it off only if access is restricted another way.

`MANAGEMENT_HOST` binds the management port to one address instead of all interfaces (the
default, same as the registry port). On a plain host or VM use `127.0.0.1` so only local
scrapers reach it. In a container keep the default and publish the port on loopback instead
(`-p 127.0.0.1:9090:9090`, as above): `127.0.0.1` inside the container is unreachable from
outside it. In Kubernetes never use `127.0.0.1` (kubelet probes and Prometheus connect to the
pod IP); the pod IP (`extraEnv` with `valueFrom.fieldRef.fieldPath: status.podIP`) only
matters with `hostNetwork`, and makes `kubectl port-forward` to the management port fail.
Restrict it with the NetworkPolicy instead.

Without `AUTH_TOKENS_PATH` or `USERS_FILE` the cache has no auth: anyone who reaches `PORT`
can read every package through it (an open npm proxy, writes are refused). It logs a warning
at startup (`auth is DISABLED`); run it like that only on a private network.

## Running

```sh
# Locally
pnpm install && pnpm build
PUBLIC_URL=http://localhost:4873 FS_ROOT=./.data node dist/main.js

# Container (read-only root filesystem, non-root; only /data is written)
docker build -f deploy/Dockerfile -t ghcr.io/eyniq/cache:0.0.1 .
docker run --read-only -p 4873:4873 -p 127.0.0.1:9090:9090 -v eyniq-data:/data \
  -e PUBLIC_URL=http://localhost:4873 ghcr.io/eyniq/cache:0.0.1

# Kubernetes
helm upgrade --install eyniq-cache deploy/helm/eyniq-cache -n <namespace> \
  --set publicUrl=http://<release>.<namespace>.svc.cluster.local:4873 \
  --set storage.fs.persistence.storageClass=<rwx-storage-class>
```

Clients: set both `npm_config_registry` and `pnpm_config_registry` (pnpm 11+ only reads the
latter) to `PUBLIC_URL` with a trailing slash.

Clients that reach the cache under another host (e.g. in-cluster runners on the Service URL
and laptops through an Ingress) can each get tarball URLs on their own host: list the other
bases in `PUBLIC_URL_ALIASES` (comma-separated, e.g. `https://npm.example.com`). A request
whose `Host` header names an alias exactly gets that base in packuments and in the npm login
registry URL, with an ETag of its own; every other request keeps `PUBLIC_URL`. The Ingress
must pass the original `Host` header through (the default of Traefik and ingress-nginx).

## Storage

- `STORAGE=fs`: one volume shared by all replicas (`ReadWriteMany`, e.g. NFS). Objects are
  written to `FS_ROOT/.tmp` and renamed into place, so readers never see partial files and
  no locking is needed. The filesystem must be **case-sensitive** (legacy names such as
  `JSONStream` and `jsonstream` are different packages). Temp files older than an hour are
  removed at startup.
- `STORAGE=s3`: any S3-compatible bucket (AWS S3, GCS XML API with HMAC keys and
  `S3_REGION=auto`, versitygw, MinIO). Use `S3_FORCE_PATH_STYLE=true` for IP or localhost
  endpoints. Use https for non-local endpoints (the cache warns otherwise) and add an
  `AbortIncompleteMultipartUpload` lifecycle rule (for example 1 day).
- Layout: `npm/packuments/<name>.json.gz` (raw upstream document) and `.meta` (fetch time
  and upstream ETag), `tarballs/<sha512|sha1>/<hex>` (content-addressed, write-once),
  `index/npm/<name>/<version>` (digest of that version).
- Stored data is trusted when read: tarball bytes are verified when written, and stored
  packuments plus their `.meta` decide freshness (fetch times are bounded to now + 30 s,
  and a full upstream download is forced at least once a day). The bucket or NFS export
  must therefore be writable by the cache pods only.
- Pods keep clocks in sync via NTP; `.meta` fetch times written by one pod are read by others.
- Keys starting with `.` are internal: `FS_ROOT/.tmp`, `FS_ROOT/.locks` (compare-and-swap
  locks, used only by builds that call the StorageAdmin operations) and, on S3, short-lived
  `.eyniq-probe/` objects from the one-time conditional-write probe. Add a lifecycle rule
  expiring `.eyniq-probe/` after a day to catch leftovers of a crash mid-probe.
- Background storage writes: packument copies, `.meta` sidecars and index entries are written
  after the response is sent, through one limiter per pod. At most `STORAGE_WRITE_CONCURRENCY`
  (default 16, 1-256) run at once; the rest wait in a FIFO queue capped at
  `STORAGE_WRITE_QUEUE_MAX` entries (default 4096) and `STORAGE_WRITE_QUEUE_BYTES` (default
  128 MiB). When the queue overflows, the least valuable waiting writes are dropped first
  (oldest first within a kind): packument copies, then sidecars, then index entries; a
  tombstone for a removed package is dropped last. A dropped write only means the next miss
  fetches and stores it again; `storage_writes_dropped_total` counts them. Each write uses
  the I/O timeout `STORAGE_BACKGROUND_TIMEOUT` (default 120s; request-path S3 calls keep 30 s)
  and is repeated once after a timeout (jittered 0.5-1 s backoff). Tarballs stream from the
  client download and cannot wait in a queue without buffering, so they are not queued or
  retried: they use the long timeout, are counted in `storage_writes_in_flight` and the
  duration/failure metrics (kind `tarball`), and are bounded by the number of concurrent
  client downloads. Signs of an overloaded backend: a growing `storage_write_queue_length`,
  `storage_write_duration_seconds` p99 in seconds, and `storage_write_failures_total`.
- `MAX_PUBLISH_BYTES` (default 100 MB) only matters with a write path: `PRIVATE_PACKAGES`
  (see Private packages) or an edition's own PackageSource. Without one the cache stays
  read-only and answers 405 to every write.

## Auth

```sh
TOKEN=$(openssl rand -hex 32)
printf '{"ci": "%s"}\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)" > tokens.json
kubectl -n <namespace> create secret generic eyniq-cache-tokens --from-file=tokens.json
helm upgrade ... --set auth.existingSecret=eyniq-cache-tokens
# clients: //<release>.<namespace>.svc.cluster.local:4873/:_authToken=$TOKEN in .npmrc
# Over plain http the token travels in cleartext: only on a trusted in-cluster network,
# otherwise terminate TLS in front of the cache (Ingress or service mesh).
```

The file holds only sha256 hashes. Changing tokens needs a restart (rolling).
`ANONYMOUS_READ=true` makes tokens optional for reads (writes always need one).

## Users and npm login

```sh
# Create the users file (scrypt hashes; password from the terminal, never an argument)
# --packages is required: '' (read only), '@acme/*,tool' or '*' (every package this registry owns)
USERS_FILE=./users.json node dist/main.js user add alice --packages ''
USERS_FILE=./users.json node dist/main.js user add ci --packages '@acme/*'
USERS_FILE=./users.json node dist/main.js user list
# In the container image (distroless, no shell):
docker run --rm -it -v "$PWD:/w" -e USERS_FILE=/w/users.json ghcr.io/eyniq/cache:0.0.1 \
  dist/main.js user add alice --packages ''
kubectl -n <namespace> create secret generic eyniq-cache-users --from-file=users.json
helm upgrade ... --set users.existingSecret=eyniq-cache-users
# clients
npm login --registry https://npm.example.com/      # npm falls back from web to password login
npm token create --read-only                       # asks for the password
npm logout
```

- Tokens (`eyc_...`) are stored as sha256 records under `auth/user-tokens/` in the cache
  storage; they expire after `USER_TOKEN_TTL` (90 days). `user passwd` and `user remove`
  end every token of that user (through the user's `generation`; when editing the file by
  hand, raise `generation` to end a user's tokens); a pod notices the changed file within
  2 s, a token revoked on another pod within `USER_TOKEN_CACHE_TTL` (30 s).
- A user keeps at most 100 tokens from `npm token create` and 100 from `npm login`; a login
  beyond that revokes that user's oldest login token.
- Unknown `eyc_` tokens cost a storage read only within a budget (per client address 60
  burst and 2/s, IPv6 per /64; 1,000 burst and 100/s in total, per pod); beyond it they get
  401 at once. While a flood uses up the total budget, valid tokens that a pod has not cached
  yet are refused too, until it refills (cached ones keep working).
- After editing the Secret, kubelet updates the mounted file within a minute or so; no
  restart is needed.
- `packages` limits what a user may publish (`["*"]` or absent in a hand-written file:
  everything the registry owns, `[]`: nothing); edit the file or re-add the user to change
  it. Static tokens never publish.
- The users file is written with mode 0600 by whoever runs the CLI: run `user` as the same
  uid as the server (the image runs as 65532; `kubectl exec` into the pod, or
  `docker run --user 65532`), or the server cannot read the file (or, with self-registration,
  replace it).
- Logins are throttled per user name (5 free failures, then 1 s doubling up to 15 min) and
  per client address (30 failures per 15 min), per pod. Behind an ingress set
  `TRUST_PROXY_HOPS=1` (one proxy) so the limit applies to the real client address and not
  to the ingress; never set it higher than the number of proxies you run, or clients can
  pick their own address. With `TRUST_PROXY_HOPS` set, every client that reaches the pod
  directly can also pick its address: restrict ingress to the pods to the proxy (e.g. a
  Kubernetes NetworkPolicy allowing only the ingress controller's namespace).
- Lockout trade-off: anyone can use up a user name's free failures, so an attacker who
  knows a name can keep that user from logging in with a password (up to 15 min per
  failure after the first five). Existing tokens keep working. During a flood of made-up
  names, other names that share an overflow bucket are throttled too. Password checks
  beyond the hash queue get `503` and `Retry-After: 1`, not 401.
- One client address has at most 4 password checks in progress or queued at once (more get
  `503` and `Retry-After: 1`, not a failed login, so users behind one NAT retry), so a few addresses cannot fill the shared hash queue (2
  running, 64 waiting per pod). Accepted residual risk: an attacker with many addresses (e.g.
  many IPv6 /64s) can still keep the queue full; logins then get `503` until it drains, while
  memory stays bounded and existing tokens and sessions keep working.
- Web catalog sign-in counts towards its limit of 16 sign-ins in progress only once the form
  body has arrived (at most 8 KiB within 10 s), so slow uploads cannot block sign-in.
- Self-registration (`USER_REGISTRATION=true`, `MAX_USERS`) is off by default. It needs a
  writable users file (not a Secret): on a single replica or on the shared `fs` volume, e.g.
  `USERS_FILE=/data/users.json`. Registered users can read but not publish until you add
  `packages` for them.
- Migrating from Verdaccio: htpasswd hashes (bcrypt/crypt/SHA1) cannot be imported. Add the
  users with `user add` (or open self-registration for a short window) and let them run
  `npm login` once; existing Verdaccio tokens do not carry over.
- Web login (`npm login` opening a browser) is not offered; npm falls back to the password
  prompt automatically.

## Private packages

```sh
PRIVATE_PACKAGES='@acme/*,acme-cli' USERS_FILE=/etc/eyniq/users/users.json ...
npm login --registry https://npm.example.com/
npm publish                                  # scoped packages: no --access needed
npm dist-tag add @acme/lib@1.2.0 stable
npm deprecate @acme/lib@1.0.0 'use 1.2'
npm unpublish @acme/lib@1.2.1 --force        # within UNPUBLISH_WINDOW (72h)
```

- Claim every name you publish before the first publish, and never claim a public name you
  install from npmjs: owned names are served only from this registry, never from upstream
  (that is the dependency-confusion defence), and public search results for them are hidden.
- Who may publish: user accounts (USERS_FILE) with tokens that are not read-only, limited by
  each user's `packages` patterns. Static tokens and self-registered users cannot publish.
- Who may read: everyone who may read the registry. There are no per-package read
  permissions, so `ANONYMOUS_READ=true` together with `PRIVATE_PACKAGES` refuses to start
  unless you also set `ALLOW_ANONYMOUS_PRIVATE_READ=true` (the private packages are then
  public to everyone who reaches the registry; logged as a warning at startup).
- Only the user who published a version can unpublish it (within `UNPUBLISH_WINDOW`). To
  remove someone else's version as an operator, edit
  `private/npm/packuments/<name>.json` in storage: move the version from `versions` (and
  `time`) to `unpublished`, fix `dist-tags`, and increase `rev`; the tarball can stay.
- A version number can never be reused, also not after an unpublish. Tarballs are checked
  (valid package archive with the right name and version; `MAX_UNPACKED_BYTES`, 256 MiB, for
  all tarballs of one publish together), the document is capped at
  `MAX_PRIVATE_PACKUMENT_BYTES`, the request at `MAX_PUBLISH_BYTES`. Tarballs made by npm
  pass; hand-made archives with links, unusual pax records (e.g. macOS `tar` extended
  attributes) or non-canonical paths are refused with 400.
- Audit events: `publish` (versions, sha512 integrity per version, dist-tags), `unpublish`,
  `dist-tag`, `deprecate`, and `write.refused` (status 400/409/413 and the reason), each with
  the user and `tokenId` (the key `npm token list` shows; revoke with `npm token revoke`).
- Just-published versions are installable at once: own packages are exempt from
  `MIN_RELEASE_AGE` unless `MIN_RELEASE_AGE_LOCAL=true`. The package filter applies to them.
- npm provenance (`--provenance`) is accepted but not stored or verified.
- Storage: documents under `private/npm/packuments/`, tarballs in `tarballs/sha512/`. They
  need the compare-and-swap operations (FsStorage on a volume with working `link`/`O_EXCL`,
  or an S3 backend with conditional writes; the cache logs an error at startup otherwise).
  Back these keys up: unlike the cached public packages they cannot be fetched again.
- Search lists up to 10,000 private packages per pod; another pod's publish shows up in
  search within 10 s (the package itself at once).

## Web catalog

```sh
WEB_UI=true ...                 # catalog at https://npm.example.com/-/web/ (/ redirects)
WEB_UI_IMAGES=true              # optional: README images (https only, loaded by the browser)
WEB_SESSION_TTL=1h              # sign-in lifetime (with USERS_FILE)
```

- Read-only: search, package pages (versions, dist-tags, dependencies, links, install
  commands, tarball link) and READMEs. Versions the policy blocks are listed with the reason
  and the time they become allowed, never offered for download.
- Access is the registry's: with `AUTH_TOKENS_PATH`/`USERS_FILE` and without
  `ANONYMOUS_READ`, visitors sign in with a user account (C3). The session cookie only works
  for the catalog; npm still needs a token.
- Put TLS in front (Ingress) and use an https `PUBLIC_URL`: the session cookie is then
  marked `Secure` and the catalog sends HSTS (`max-age=31536000`); with an http `PUBLIC_URL`
  the server warns at startup, since passwords would travel unencrypted. `PUBLIC_URL` must be
  the URL users open, or the sign-in form is refused as cross-origin.
- Packages the package filter blocks as a whole are not shown (404), as in search. Catalog
  searches have their own upstream budget (`SEARCH_UPSTREAM_RPS`/`_BURST` each), so visitors
  cannot use up `npm search`'s.
- READMEs are rendered up to 64 KiB; longer ones are cut off (marked as truncated).
- With `WEB_UI_IMAGES=true` the browser of every visitor loads README images from the hosts
  the README names (without a referrer); leave it off on locked-down networks.
- Session records are small and expire, but are not deleted automatically: an S3 lifecycle
  rule expiring `auth/web-sessions/` after 7 days keeps the bucket tidy.

## Minimum release age

- Default `MIN_RELEASE_AGE=3d`, `FAIL_CLOSED=true`. `0` disables the gate (logged loudly).
- Allowlist (`ALLOWLIST_PATH`, Helm `allowlist:`): exact `package` + `version`, a `reason`
  and `expires` (`2026-11-01` means the start of that day in UTC). Expired entries are
  ignored and logged.
- Package filter (`FILTER_RULES_PATH`): JSON `{ "block": [...], "allow": [...] }` with rules
  `{ "id"?, "package", "versions"?, "reason"? }`. `package` is an exact name, `@scope/*`,
  `prefix*` or `*`; `versions` is an npm range (`<1.2.0 || 3.x`). Allow rules beat block rules
  and the age gate for the versions they name. Blocked tarballs get a 403 naming the rule.
  Invalid rules stop the process at startup; changes need a restart.
  Rule names are case-sensitive and `@scope/*` / `prefix*` patterns must be lowercase (an
  uppercase wildcard stops startup); an exact name may use legacy uppercase. Ranges match
  prereleases on purpose, so `<1.2.0` also blocks `1.2.0-beta.1`, and empty alternatives
  (`1.0.0 ||`) are rejected. A version that is not valid semver at all is treated as matching a
  block rule and as not matching an allow rule with `versions`.
  Allow-rule semantics: an allow rule lifts both a matching block rule and the minimum release
  age gate for the versions it names (other policies still apply). An allow rule with package
  `*` or a wildcard and no `versions` therefore disables the age gate for every matching
  package; startup logs a warning for each such rule.
- A lockfile that pins a too-new version gets a 403 that names `allowedAfter`. A
  `pkg@version` request for a filtered version fails earlier with npm's ETARGET.
- Search (`/-/v1/search`): fetched from upstream with a deadline (`SEARCH_TIMEOUT`, default 10s)
  and a 2 MiB cap, no client headers forwarded, cached for `SEARCH_CACHE_TTL` (default 60s, `0`
  disables). A blocked version is rewritten to the newest allowed one (or the hit is dropped)
  only for packages already in the metadata cache; other hits show upstream's version, and
  their tarballs are still gated. The query text still goes to the public registry.
  Limitations of the filtering: packages that a package-filter rule blocks as a whole (a
  name or `@scope/*` block without `versions` and no allow rule for that name) are dropped from
  results whether or not they are cached, but version-level blocks and the minimum release
  age gate are only reflected for packages that are in the metadata cache. Search results are
  not filtered per package by the Authorizer: search is one ecosystem-wide read, so anyone who
  may read the registry sees every hit (private package names and descriptions included).
  Cache misses are rate limited (`SEARCH_UPSTREAM_RPS`, default 5 per second, burst
  `SEARCH_UPSTREAM_BURST` 20, at most 4 requests in flight; `SEARCH_UPSTREAM_RPS=0` turns the
  limit off): over the limit a stale cached result is served if there is one, else 429 with
  `Retry-After`. Cache hits are never limited. A request that times out is aborted, so no
  upstream connection lingers.
- `npm audit` requests are passed through to the public registry and contain the
  dependency tree (including private package names).

## Sizing

Measured with a real project lockfile (1,010 packages, several 50 MB+ binaries), Docker on a laptop:

| Run                                       | Requests | Errors | Upstream fetches | Peak RSS   | Event-loop p99 |
| ----------------------------------------- | -------- | ------ | ---------------- | ---------- | -------------- |
| cold, 4 parallel installs                 | 8,080    | 0      | 1,866            | 1.3-1.6 GB | 19 ms          |
| warm, 16 parallel installs (41 GB served) | 32,320   | 0      | 0                | 1.4 GB     | 24 ms          |

RSS plateaus well above `LRU_MAX_BYTES` (allocator high-water from streaming large tarballs
plus about 230 MB per worker thread), so the chart requests 1 GiB and limits at 2 GiB.
Set `WORKERS` explicitly (Node sees the node's cores, not the pod's CPU limit).

Each metadata worker is its own V8 isolate and keeps the memory it used for large packuments
(react-native, typescript: 11-16 MB each). With one worker per core (7 on an 8-CPU node) that
reached the 3 GiB limit during a burst of cold React Native installs (both pods
OOMKilled). Hence the default of at most 2 workers, and `WORKER_RECYCLE_BYTES` (64 MiB):
a worker that has processed that many document bytes is replaced after its current job, which
returns its memory. Watch `eyniq_cache_metadata_worker_heap_bytes` (the worker isolates;
`heap_used_bytes` covers the main thread only) and `eyniq_cache_metadata_worker_recycles_total`.
More workers only speed up cold misses; cache hits never use them.

The worker pool's queue is bounded too: `METADATA_QUEUE_BYTES` (default twice `LRU_MAX_BYTES`)
caps the raw documents it holds, queued plus in progress. A metadata miss or publish beyond it
gets `503` with `Retry-After: 1` (npm retries) before the stored copy is read or upstream is
asked, so a flood of distinct cold names cannot buffer packuments without bound; at most 16
stored packuments are read at once per pod. Fresh LRU hits are never affected. Accepted
limit: an upstream fetch is not reserved in advance (its size is unknown until it arrives), so
during a burst of cold misses up to `UPSTREAM_MAX_CONNECTIONS` packuments (each at most
`MAX_PACKUMENT_BYTES`) can be in memory before the queue limit refuses them; lower either for
a tighter bound. Refusals are
counted in `eyniq_cache_metadata_overloaded_total`; if it grows during normal installs, raise
`WORKERS` or `METADATA_QUEUE_BYTES` together with the memory limit.

The image sets `MALLOC_MMAP_THRESHOLD_=131072`. glibc's dynamic mmap threshold climbs after large
frees, so big buffers then come from the heap and the freed holes are never returned: after a
4-install burst ~450 MiB stayed held by the allocator (gdb `malloc_stats`). With the fixed
threshold the idle RSS 30 s after that burst went from 1010 to 740 MiB and the peak dropped by
~200 MiB, at no measurable CPU cost.

With S3 storage a tarball miss is buffered until its PUT commits, and the client response waits
for that commit. `STORAGE_STREAM_BYTES` (128 MiB with S3) caps what those writes hold together:
a miss over budget is served uncached (counted in `storage_writes_dropped_total{kind="tarball"}`)
instead of adding memory and making clients wait on slow storage. On a rig with S3 throttled to
1 MiB/s and a mix of large projects, held tarball memory went from 244 to 92 MiB and 7 of 8
installs succeeded instead of 2.

## Metrics (management port, Prometheus text)

`eyniq_cache_` + `http_requests_total{route,status}`, `http_request_duration_seconds`,
`cache_results_total{result}`, `coalesced_waiters_total`, `metadata_overloaded_total`, `upstream_requests_total`,
`upstream_errors_total`, `upstream_request_duration_seconds`, `blocked_versions_total`,
`tarball_bytes_served_total`, `lru_bytes`, `lru_evictions_total`, `lru_lookups_total{result=hit|expired|miss}` (metadata LRU hit share), `worker_queue_length`,
`event_loop_delay_seconds{quantile}`, `heap_used_bytes`, `process_resident_memory_bytes`.

Background storage writes (see Background storage writes under Storage):
`storage_write_queue_length` (gauge), `storage_writes_in_flight` (gauge),
`storage_write_duration_seconds{kind}` (histogram, one observation per attempt; kind is
`metadata`, `meta`, `index` or `tarball`), `storage_write_failures_total{kind,reason}`
(reason `timeout` or `error`; counted once a write has failed for good),
`storage_writes_dropped_total{kind}` and `storage_write_retries_total{kind}`.

## Statistics history (no Prometheus needed)

Every pod records its own history in the cache's storage (`STATS_HISTORY=true`, the default):
one record per `STATS_INTERVAL` (60 s), hourly and daily rollups, objects under `stats/` in the
same bucket or volume. Retention: `STATS_RETENTION_MINUTE=7d`, `STATS_RETENTION_HOUR=90d`,
`STATS_RETENTION_DAY=0` (forever; minimums: minute 1h, hour 1d, day 0 or 7d). Each pod prunes
expired objects of all pods, which also cleans up after rollouts. A few KB per pod per
hour; the writes are one object rewrite every 5 minutes per pod. Set `POD_NAME` (Kubernetes
downward API) so pod ids are stable and readable; without it the hostname is used.

- `GET http://<pod>:9090/stats?range=24h` (management port, no auth, cluster-internal): JSON time
  series over all pods. Ranges `1h 24h 7d 30d 90d 1y`, `step=auto`. Raw data is cached for 30 s;
  at most 2 computations run at once, otherwise 503 with `Retry-After`.
- Each interval also records the background storage writes: stored, failed, dropped, retried,
  p50/p95/p99 attempt duration, peak queue length and writes in flight (`writes`,
  `writeLatency`, gauges). Points recorded before this version show 0 for them.
- `node dist/main.js stats --range 7d`: text summary read straight from storage (same
  environment as the server; works against a stopped cache).
- Latency across pods and rollups is the worst observed quantile (an upper bound), not an exact
  quantile. The Prometheus metrics stay the source for alerting.
- With `WEB_UI=true` the catalog has a stats page at `/-/web/stats` (charts with a table
  fallback; same sign-in as the catalog). Exposure: both this page and `/stats` show pod names,
  memory per pod, the request mix per route, hit ratios and blocked-version counts, though no
  package names, client addresses or identities. `/stats` is on the management port (keep it
  cluster-internal); the page is as visible as the catalog is. Hide the page alone with
  `WEB_STATS=false` (the recording and `/stats` stay), or restrict the `stats` resource in your
  authorizer.
- A failing storage never affects serving: see `eyniq_cache_stats_write_errors_total`.
- Turn all of it off with `STATS_HISTORY=false`; existing objects stay until you delete `stats/`.

## Load test: Verdaccio baseline vs Eyniq Cache

The harness (`load/`, no dependencies) replays a lockfile as N parallel installs that all
start at once (the CI-burst case): per package the abbreviated packument, then the tarball
URL the registry returned. Run it inside the cluster so a port-forward does not become the
bottleneck. `INSTALLS` = 2x the parallel jobs of the largest real burst. Deploy the Eyniq
Cache test instance next to Verdaccio with `config.minReleaseAge=0`; otherwise lockfile
versions younger than 3 days are reported as errors and the comparison is not like for like.

Server-side numbers come from two places: the harness scrapes Eyniq's `/metrics` on every
pod (upstream fetches, hit ratio, event-loop delay, RSS), and `--sample-only` (on your
machine, with kubectl) records CPU, memory and restarts for either target. Verdaccio exposes
no upstream-fetch, hit-ratio or event-loop metrics; `compare.ts` lists those as "not
compared" instead of skipping them silently.

```sh
# 0. Once: a load pod with the harness and your project's lockfile (from the eyniq-cache checkout).
INSTALLS=20
kubectl -n <namespace> run eyniq-load --image=node:26-trixie-slim --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"eyniq-load","image":"node:26-trixie-slim","command":["sleep","7200"],"resources":{"requests":{"cpu":"2","memory":"2Gi"}}}]}}'
kubectl -n <namespace> wait --for=condition=Ready pod/eyniq-load
kubectl -n <namespace> cp load eyniq-load:/load
kubectl -n <namespace> cp /path/to/your/pnpm-lock.yaml eyniq-load:/load/pnpm-lock.yaml

# 1. Verdaccio. Terminal B first (samples until Ctrl-C), then terminal A runs the load.
#    Run the pair twice: "cold" and then "warm".
node load/run.ts --sample-only --kube <namespace>/app=<verdaccio-label> \
  --out load/results/verdaccio-cold-samples.json                                           # terminal B
kubectl -n <namespace> exec eyniq-load -- node /load/run.ts --lockfile /load/pnpm-lock.yaml \
  --registry http://<verdaccio-service>.<namespace>.svc.cluster.local:4873 \
  --installs $INSTALLS --label verdaccio-cold --out /load/verdaccio-cold.json              # terminal A

# 2. Eyniq Cache (Helm release eyniq-cache in the same namespace). The harness needs the
#    /metrics URL of every pod, because counters are per pod.
METRICS=$(kubectl -n <namespace> get pods -l app.kubernetes.io/name=eyniq-cache \
  -o jsonpath='{range .items[*]}http://{.status.podIP}:9090/metrics,{end}')
node load/run.ts --sample-only --kube <namespace>/app.kubernetes.io/name=eyniq-cache \
  --out load/results/eyniq-cold-samples.json                                               # terminal B
kubectl -n <namespace> exec eyniq-load -- node /load/run.ts --lockfile /load/pnpm-lock.yaml \
  --registry http://<release>.<namespace>.svc.cluster.local:4873 --metrics-url "$METRICS" \
  --installs $INSTALLS --label eyniq-cold --out /load/eyniq-cold.json                      # terminal A

# Repeat steps 1 and 2 with "warm" instead of "cold" in every label and file name.

# 3. Compare cold with cold and warm with warm (exit code 1 if Eyniq is worse on any metric).
for run in cold warm; do
  kubectl -n <namespace> cp eyniq-load:/load/verdaccio-$run.json load/results/verdaccio-$run.json
  kubectl -n <namespace> cp eyniq-load:/load/eyniq-$run.json load/results/eyniq-$run.json
  node load/compare.ts load/results/verdaccio-$run.json load/results/eyniq-$run.json \
    --baseline-samples load/results/verdaccio-$run-samples.json \
    --candidate-samples load/results/eyniq-$run-samples.json
done
kubectl -n <namespace> delete pod eyniq-load
```

With auth enabled, pass the token as `LOAD_TOKEN=...` in the environment (never on the
command line). The `--timeout` is a socket idle timeout: a slowly trickling download is not
counted as a timeout.

## Canary rollout (DESIGN.md section 13)

1. Push the image: `docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t <registry>/cache:<tag> --push .`
2. Install `deploy/helm/eyniq-cache` next to your existing cache (a `ReadWriteMany` volume
   or an S3 bucket, `publicUrl` as above).
3. Run the load test above against both and compare.
4. Point one CI runner pool at it (`npm_config_registry` and `pnpm_config_registry` =
   `http://<release>.<namespace>.svc.cluster.local:4873/`) for a week; then switch the other
   pools one by one.
