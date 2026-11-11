# Eyniq Cache

[![CI](https://github.com/eyniq/cache/actions/workflows/ci.yml/badge.svg)](https://github.com/eyniq/cache/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/eyniq/cache?sort=semver&label=version)](https://github.com/eyniq/cache/tags)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](LICENSE)

A pull-through npm registry cache that survives CI bursts without restarts or out-of-memory kills, and enforces a server-side minimum release age. Source-available under FSL-1.1-ALv2.

## Why

Most npm supply-chain attacks are caught within hours or days of a malicious publish. A minimum release age gate keeps brand-new versions out of your builds until the ecosystem has had time to notice. Doing this in a shared cache, rather than in every client config, makes it impossible to bypass by accident and gives a whole CI fleet one policy, one audit trail, and far fewer upstream requests.

- Read-only proxy for npm, pnpm and yarn (scoped and unscoped packages, full and abbreviated metadata, tarballs).
- Minimum release age gate with an allowlist; fails closed when a publish time is unknown.
- Request coalescing, packument processing in worker threads, a bytes-capped metadata cache, streamed tarballs with integrity checks.
- Filesystem (including shared RWX volumes) or S3-compatible storage. Stateless pods.
- Zero runtime dependencies. Requires Node.js 26 when run from source; the container image bundles it.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and [docs/OPERATIONS.md](docs/OPERATIONS.md) for running it.

## Run it

Container images are published to both registries on every release:

```sh
docker run --read-only -p 4873:4873 -v eyniq-data:/data \
  -e PUBLIC_URL=http://localhost:4873 \
  ghcr.io/eyniq/cache:latest        # or: docker.io/eyniq/cache:latest

npm install lodash --registry http://localhost:4873/
```

From source (Node.js 26, pnpm):

```sh
pnpm install
pnpm build
PUBLIC_URL=http://localhost:4873 FS_ROOT=./.data pnpm start
```

On Kubernetes, use the Helm chart in [deploy/helm/eyniq-cache](deploy/helm/eyniq-cache) (`helm upgrade --install eyniq-cache deploy/helm/eyniq-cache --set publicUrl=...`).

### Main settings

| Variable          | Default                      | Meaning                                                              |
| ----------------- | ---------------------------- | -------------------------------------------------------------------- |
| `PUBLIC_URL`      | (required)                   | Base URL clients use; tarball URLs in packuments are rewritten to it |
| `UPSTREAM_URL`    | `https://registry.npmjs.org` | Upstream registry                                                    |
| `MIN_RELEASE_AGE` | `3d`                         | Versions younger than this are hidden and their tarballs blocked     |
| `FAIL_CLOSED`     | `true`                       | Block versions whose publish time is unknown                         |
| `ALLOWLIST_PATH`  | (none)                       | JSON file of per-version exceptions to the age gate                  |
| `STORAGE`         | `fs`                         | `fs` or `s3`                                                         |
| `FS_ROOT`         | `/data`                      | Data directory for `STORAGE=fs`                                      |
| `PORT`            | `4873`                       | Registry port                                                        |
| `MANAGEMENT_PORT` | `9090`                       | `/livez`, `/readyz` and `/metrics`                                   |
| `LOG_LEVEL`       | `info`                       | Log level                                                            |

All other settings (S3, authentication, users, private packages, web catalog, sizing) are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## License: what you may do

Eyniq Cache is source-available, not open source: it is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). Each release converts to Apache-2.0 two years after it is published.

- You may use, copy, modify and redistribute it for any purpose **other than a competing use**: offering it, or a product substantially similar to it, to others as a commercial product or service.
- Running it for your own organisation (for example as the npm cache of your CI) is permitted, including in production and inside a company.
- Each release automatically becomes available under the Apache License 2.0 two years after it is published.

This summary is not legal advice; the [LICENSE](LICENSE) text is what counts.

## Community and Enterprise

This repository is the community edition. A commercial enterprise edition is built on the same core.

|                                                                                                 |   Community   | Enterprise |
| ----------------------------------------------------------------------------------------------- | :-----------: | :--------: |
| npm pull-through cache with request coalescing                                                  |       ✓       |     ✓      |
| Minimum release age for new versions, with an allowlist                                         |       ✓       |     ✓      |
| Package filter (block or allow by name and version range)                                       |       ✓       |     ✓      |
| Search and a read-only web catalog                                                              |       ✓       |     ✓      |
| Storage on a filesystem or S3-compatible object storage                                         |       ✓       |     ✓      |
| Static tokens, a users file and `npm login`                                                     |       ✓       |     ✓      |
| Private packages (publish, deprecate)                                                           |       ✓       |     ✓      |
| Prometheus metrics, health probes, Helm chart, statistics history                               |       ✓       |     ✓      |
| Storage tiers (memory or disk cache in front of the storage)                                    |               |     ✓      |
| Role-based access per scope, CI workload identity (GitHub Actions, Kubernetes)                  |               |     ✓      |
| Tamper-evident audit log                                                                        |               |     ✓      |
| Admin console and admin API                                                                     |               |  preview   |
| Single sign-on with OIDC, `npm login --auth-type=web`                                           |               |  preview   |
| Policy engine (OSV advisories, licences, install scripts, publisher changes), waivers, dry runs |               |  preview   |
| Audit export to a SIEM (syslog, signed webhook)                                                 |               |  preview   |
| SBOM export (CycloneDX)                                                                         |               |  preview   |
| Signed bundles for air-gapped installations                                                     |               |  preview   |
| Multi-region replication of private packages                                                    |               |  preview   |
| More ecosystems: Go, PyPI, Maven, Cargo, OCI images                                             |               |  preview   |
| Support                                                                                         | GitHub issues | Commercial |

_Preview: functional and covered by automated tests, not yet proven in production._

The enterprise edition needs a licence key. Contact enterprise@eyniq.com.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Outside contributions are accepted under the [CLA](CLA.md). Please open an issue before starting larger changes. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm check            # typecheck, lint, format check, all tests
pnpm test:unit
pnpm test:integration
pnpm test:concurrency
```
