# Eyniq Cache

Pull-through npm registry cache with a minimum release age gate (community edition). Design: `docs/DESIGN.md` is the source of truth.

## Structure

- `src/core/` ecosystem-agnostic contracts (`contracts.ts`: storage, auth, authorizer, policy, audit, adapters, write path incl. deprecate, accounts, extensions), coalescer, bytes-capped LRU, errors, names, name patterns (`patterns.ts`), audit and storage helpers.
- `src/metadata/` metadata service (upstream and PackageSource lookups, policy re-filtering), worker pool and worker entry (packument processing and write-body parsing off the main thread).
- `src/artifacts/` artifact service (streaming, tee to storage, integrity verification, local artifacts).
- `src/adapters/npm/` ALL npm-specific code: routes (incl. write grammar), packument processing and facts (incl. version-history facts), publish/deprecate body parsing, account wire format (`account.ts`: login, logout, tokens), storage keys, private packages (`private-source.ts`: the community PackageSource, `tarball-check.ts`: published tarball validation), web catalog data (`catalog.ts`), `public.ts` (the `@eyniq/cache/npm` entry). The core never imports from here.
- `src/web/` read-only web catalog (C5, `WEB_UI`): `handler.ts` (routes under `/-/web/`, CSP, sign-in), `sessions.ts`, `markdown.ts` (safe README tree), `static/` (shell, `app.js` client checked with its own `tsconfig.json`, CSS; copied to `dist/web/static` by `pnpm build`).
- `src/policy/` minimum release age policy, allowlist, `composePolicies`.
- `src/stats/` statistics history: sample deltas, hour/day rollups, recorder (per-pod objects under `stats/`), reader (all pods, bounded, cached), text summary and `stats` CLI. `src/http/stats-source.ts` adapts the metrics registry; `GET /stats` is on the management port; the catalog stats page (`/-/web/stats`, `api/stats`) reuses the reader.
- `src/storage/` `FsStorage`, `S3Storage` (own SigV4 signer), both with the StorageAdmin operations.
- `src/auth/` `NoAuth`, `StaticTokenAuth`, `DefaultAuthorizer`; user store (C3): `users.ts` (USERS_FILE, lock, reload), `password.ts` (scrypt), `user-tokens.ts` (sha256 token records in storage), `user-auth.ts`, `user-accounts.ts` (AccountProvider), `login-limiter.ts`, `community-authorizer.ts`, `users-cli.ts` (`main.js user ...`).
- `src/http/` `node:http` server (auth, authorization, extensions, lifecycle), routes (registry, pass-through, write, account), health probes, metrics registry, request logging.
- `src/config.ts` env parsing/validation (`createConfigReader`, `loadConfig(env, { extend })`); `src/compose.ts` community composition (`composeCommunity(config, overrides)` and the create* parts); `src/main.ts` composition root of the community build (uses compose.ts); `src/constants.ts` product names.
- Public API for downstream builds that import this repo (extension API): `src/index.ts`, `src/defaults.ts`, `src/adapters/npm/public.ts` and the `exports` map in `package.json`; `src/testing/` fake upstream, HTTP helpers and the storage/policy conformance suites (excluded from the container build).
- `test/unit|integration|concurrency/` Vitest projects; `test/helpers/server.ts` starts `createServer` with overridable deps; `test/fixtures/` recorded packuments.
- `load/` load-test harness (no dependencies); `load/bench/` reproducible Docker benchmark against Verdaccio (`docs/BENCHMARK.md`). `deploy/` Dockerfile and Helm chart.

## Conventions

- Zero runtime dependencies; `src/` imports only `node:*` and relative files (enforced by ESLint and `test/unit/repo-rules.test.ts`).
- Edition-specific behaviour goes behind interfaces in `src/core/contracts.ts`; never add downstream-only code here. New hooks are default-off and keep community behaviour unchanged.
- Cache-hit hot path must not parse JSON or run policy code.
- Tests first; every change touching HTTP, storage, auth or policy gets a security review.
- Conventional commits, English only.

## Commands

```sh
pnpm install
pnpm check              # typecheck (incl. web client) + lint + format check + all tests
pnpm test:unit | test:integration | test:concurrency
pnpm build && PUBLIC_URL=http://localhost:4873 FS_ROOT=./.data pnpm start
```
