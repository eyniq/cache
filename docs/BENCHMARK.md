# Benchmark: Eyniq Cache against Verdaccio

How to reproduce the Linux comparison with Verdaccio 6.10.5 (its `@verdaccio/package-filter` age
filter enabled) and with filesystem or S3 storage, plus the reference numbers measured so far.
Scripts: `load/bench/` (shell and Node, no dependencies). The load generator is
`load/run.ts` (see `docs/OPERATIONS.md`).

## What is measured

The harness replays a lockfile as N parallel installs (per package one abbreviated packument
request, then the tarball URL the registry returned, 16 requests in flight per install, all
installs starting at once like a CI burst). Scenarios:

| Scenario                              | Meaning                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cold4`                               | 4 installs against a fresh process and an empty cache (new data dir or S3 bucket per run) |
| `warm4`, `warm16`, `warm32`, `warm64` | 4 to 64 installs against a primed cache (one warm-up install first)                       |

Per cell: requests per second, packument and tarball latency (p50-p95-p99 ms), errors, timeouts,
server CPU (% of one core, from `/proc`), server RSS (max of 1 s samples), upstream fetches
(requests the seed received), harness CPU, and whether the server survived. Two runs per cell
(`RUNS=2`), shown as `run 1 / run 2`.

Candidates:

| Candidate      | Setup                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eyniq-fs`     | `dist/main.js`, `STORAGE=fs`, `WORKERS=4`, `LOG_LEVEL=warn`, `MIN_RELEASE_AGE=3d`, default LRU and TTL                                                     |
| `eyniq-s3`     | the same with `STORAGE=s3` against versitygw                                                                                                               |
| `verdaccio-fs` | Verdaccio 6.10.5, `filters: '@verdaccio/package-filter': minAgeDays: 3`, uplink maxage 5m, audit middleware on, `--max-old-space-size=3072`, local storage |
| `verdaccio-s3` | the same with `verdaccio-aws-s3-storage` against versitygw                                                                                                 |

The age filter is on by default for both servers (`GATE=false` turns it off). Note what it
costs and what it does: on a lockfile without versions younger than 3 days nothing is filtered,
so the runs measure the cost of evaluating the gate. Verdaccio's filter only hides versions in
the metadata; their tarballs stay downloadable, while Eyniq also answers 403 for them.

## Method

Everything runs inside one Docker container (the `verdaccio/verdaccio:6.10.5` image run as root:
it brings Node 24 and Verdaccio), so the seed, the candidate, the load generator and the
versitygw S3 server (a second container in the same network namespace) share one loopback and the
network is not a variable.

1. The **seed** is an Eyniq instance (`METADATA_TTL=365d`, no age gate) in front of
   `registry.npmjs.org`. One install warms it from the real registry (network needed once; the
   data lives in a Docker volume, later runs are offline). Every candidate uses the seed as its
   upstream, so all of them see identical, fast, repeatable upstream behaviour.
2. Each candidate runs the scenarios in order; cold runs get a fresh process and a new data dir
   or bucket, warm runs share one process (restarted on its warm data if it dies, which is
   reported as `server survived: NO`).
3. A 10 s settle time precedes every run.

## Reproduce

Requirements: Docker, Node 24 (to render tables), pnpm, a lockfile of a realistic project
(`pnpm-lock.yaml` or `package-lock.json`; the bigger and more realistic the better).

```sh
pnpm install && pnpm build
export LOCKFILE=/path/to/pnpm-lock.yaml

# One install per candidate, a few seconds: checks that the plumbing works (not a measurement).
load/bench/run.sh smoke

# The full matrix (long: two runs per cell and a 10 s settle before each; plan for hours).
load/bench/run.sh all            # = up, seed, run, tables
load/bench/run.sh tables         # re-render RESULTS/tables.md from the JSON files

# Step by step, or a subset:
load/bench/run.sh up && load/bench/run.sh seed
CANDIDATES="eyniq-fs verdaccio-fs" SCENARIOS=cold4,warm16 load/bench/run.sh run
load/bench/run.sh down           # remove the containers (keeps the seed volume)
load/bench/run.sh clean          # also remove the volumes
```

Results go to `RESULTS` (default `load/results/bench-<date>`, git-ignored): one JSON file per run
plus `.meta.json` (server CPU, RSS, upstream fetches), `environment.json` (kernel, CPUs, memory,
versions, settings), `driver.log`, the server logs and `tables.md`. Options (environment):
`CANDIDATES`, `SCENARIOS`, `RUNS`, `GATE`, `BENCH_CPUS`, `BENCH_MEMORY`, `VERDACCIO_HEAP_MB`,
`LRU_MAX_BYTES`, `WORKERS`, `VERDACCIO_IMAGE`, `VERSITYGW_IMAGE`, `S3_PLUGIN_VERSION`,
`SEED_UPSTREAM` (see the header of `load/bench/run.sh`).

Notes on the Verdaccio S3 candidate:

- The plugin is installed with npm (`--ignore-scripts`) inside the throwaway container when the
  benchmark starts; it is not a dependency of this repository. `S3_PLUGIN_VERSION` must match
  `^[0-9A-Za-z.-]+$` (anything else aborts before docker runs). `verdaccio-aws-s3-storage` 12.x needs a DynamoDB
  table, so the S3-only `11.0.0-6-next.10` line is the default (`S3_PLUGIN_VERSION`). It uses the
  AWS SDK v2.
- versitygw is pinned to `v1.9.0` by tag and image digest (`VERSITYGW_IMAGE`); override it
  only to benchmark another version.
- versitygw runs with its POSIX backend on a Docker volume and fixed throwaway credentials
  (`bench` / `bench-secret-key`, reachable only inside the container). Both servers get a new
  bucket per cold run and per warm process.

## Caveats

- **Loopback, one VM.** The load generator is a single Node process (130 to 230% CPU at 4 to 64
  installs) sharing the VM with the server. Warm throughput saturates around 750 to 850 req/s for
  every Eyniq build in the reference run, so warm req/s does not rank servers that are fast
  enough; look at CPU, memory, latency and errors. For a publishable comparison run the load
  generator on a separate machine (`load/run.ts --registry` takes any URL) and pin CPUs.
- **macOS is not a valid host for the heavy scenarios.** Above about 16 parallel installs the
  macOS loopback runs out of mbufs and servers fail in ways that do not exist on Linux (see
  `eyniq-bench/ROOT-CAUSE.md`). Docker Desktop's VM is Linux, but it is a VM: virtio disk and
  network, shared with the host.
- **S3 here is a local gateway.** versitygw on a local volume says nothing about AWS S3 latency
  or throughput; it shows how each server behaves when every storage operation is an S3 request
  (no local page cache, request overhead), nothing more. No S3 numbers have been measured yet.
- **The seed removes the real upstream.** Upstream latency, rate limits and CDN behaviour are
  out of the picture on purpose (repeatable), which favours servers that fetch upstream a lot.
- **Memory limits matter for Verdaccio.** It was run with the production 3 GiB heap in an 8 GiB
  VM; changing `VERDACCIO_HEAP_MB` or `BENCH_MEMORY` changes where it falls over.
- **Two runs per cell** show the spread, not a confidence interval. Use `RUNS=5` or more for
  conclusions about small differences.

## Reference results (measured, not reproduced by these scripts)

Date 2026-10-15. Machine: Docker Desktop 4.92 on an Apple Silicon Mac, Linux VM (kernel
7.0.12-linuxkit, aarch64, 16 vCPU, 8 GiB RAM), one container (`verdaccio/verdaccio:6.10.5` run
as root, Node v24.15.0). Eyniq: this repository at commit 8d334c1 (`dist/main.js`,
`WORKERS=4`, `LOG_LEVEL=warn`, `MIN_RELEASE_AGE=0`, default 256 MiB LRU, TTL 5m), **filesystem
storage**. Verdaccio 6.10.5, **local storage**, uplink maxage 5m, audit middleware on,
`NODE_OPTIONS=--max-old-space-size=3072`, no filter in the main tables (the filter rows are
below). Upstream: a pre-warmed Eyniq seed (1,866 fetches from npmjs, then served locally).
Lockfile: a production application with 1,010 packages (several 50 MB+ binaries). 2 runs per cell
(`run 1 / run 2`), 10 s settle, sequential per candidate. Source: `eyniq-bench/ROOT-CAUSE.md`,
Linux section. This setup differs from `load/bench/` in using one fixed driver and no S3; the
scripts here are a cleaned-up, parameterized version of it.

Latency cells are p50-p95-p99 in ms (packuments `meta`, tarballs `tar`).

#### Cold, 4 installs (fresh process and data dir per run)

| Candidate        | req/s     | meta                              | tar                                 | errors | server RSS max MiB | upstream fetches | server survived |
| ---------------- | --------- | --------------------------------- | ----------------------------------- | ------ | ------------------ | ---------------- | --------------- |
| Eyniq            | 433 / 454 | 21-892-2,107 / 20-965-1,690       | 23-347-1,690 / 23-417-1,661         | 0 / 0  | 1,620 / 1,506      | 1,866 / 1,866    | yes / yes       |
| Verdaccio 6.10.5 | 104 / 103 | 251-1,227-3,255 / 273-1,269-2,936 | 244-2,427-11,819 / 248-2,337-12,451 | 0 / 0  | 1,828 / 1,382      | 7,729 / 7,846    | yes / yes       |

#### Warm, 4 installs

| Candidate        | req/s     | meta                        | tar                             | errors | server RSS max MiB | upstream fetches | server survived |
| ---------------- | --------- | --------------------------- | ------------------------------- | ------ | ------------------ | ---------------- | --------------- |
| Eyniq            | 773 / 764 | 33-123-380 / 35-115-436     | 28-306-2,699 / 33-315-2,512     | 0 / 0  | 1,542 / 1,589      | 0 / 0            | yes / yes       |
| Verdaccio 6.10.5 | 247 / 250 | 90-957-2,155 / 85-878-2,134 | 55-1,045-9,638 / 55-1,032-9,622 | 0 / 0  | 1,388 / 1,602      | 0 / 0            | yes / yes       |

#### Warm, 16 installs

| Candidate        | req/s     | meta                              | tar                                 | errors    | server RSS max MiB | upstream fetches | server survived |
| ---------------- | --------- | --------------------------------- | ----------------------------------- | --------- | ------------------ | ---------------- | --------------- |
| Eyniq            | 775 / 778 | 136-276-510 / 118-246-590         | 145-1,093-6,766 / 127-1,020-11,663  | 0 / 0     | 1,693 / 1,801      | 0 / 0            | yes / yes       |
| Verdaccio 6.10.5 | 235 / 264 | 401-3,528-8,605 / 533-2,965-5,896 | 251-4,839-28,409 / 248-4,571-25,247 | 0 / 5,776 | 3,808 / 4,604      | 0 / 9,994        | yes / NO        |

#### Warm, 32 installs

| Candidate        | req/s     | meta                               | tar                                 | errors          | server RSS max MiB | upstream fetches | server survived |
| ---------------- | --------- | ---------------------------------- | ----------------------------------- | --------------- | ------------------ | ---------------- | --------------- |
| Eyniq            | 785 / 795 | 212-349-1,094 / 206-313-888        | 226-3,274-13,758 / 218-2,976-19,988 | 0 / 0           | 1,773 / 1,697      | 0 / 737          | yes / yes       |
| Verdaccio 6.10.5 | 340 / 285 | 616-3,202-7,832 / 830-5,472-14,543 | 495-8,345-81,996 / 536-9,677-94,420 | 13,055 / 13,830 | 4,282 / 4,709      | 26 / 6,563       | NO / NO         |

#### Warm, 64 installs

| Candidate        | req/s          | meta                          | tar                                 | errors          | server RSS max MiB | upstream fetches | server survived |
| ---------------- | -------------- | ----------------------------- | ----------------------------------- | --------------- | ------------------ | ---------------- | --------------- |
| Eyniq            | 774 / 778      | 237-679-2,583 / 279-640-1,862 | 255-7,876-27,781 / 310-7,853-26,761 | 0 / 0           | 1,564 / 1,842      | 119 / 736        | yes / yes       |
| Verdaccio 6.10.5 | not comparable | not comparable                | not comparable                      | 64,576 / 64,576 | 6,278 / 6,576      | 1,084 / 0        | NO / NO         |

(Eyniq's non-zero warm upstream fetches are probably metadata revalidations after the 5 minute
TTL expired during a long run; this was not traced. Verdaccio's warm 64 req/s are meaningless:
about half of the requests hit a closed port after it died.)

#### Age filter on, warm 16 and 32 installs

Eyniq with `MIN_RELEASE_AGE=3d`, Verdaccio with `minAgeDays: 3`. No version in the lockfile was
younger than 3 days that day, so nothing was filtered: these rows are the cost of evaluating
the filter.

| Candidate                              | installs | req/s     | errors          | server RSS max MiB | upstream fetches | server survived |
| -------------------------------------- | -------- | --------- | --------------- | ------------------ | ---------------- | --------------- |
| Eyniq, MIN_RELEASE_AGE=3d              | 16       | 788 / 776 | 0 / 0           | 1,616 / 1,640      | 0 / 0            | yes / yes       |
| Verdaccio, package-filter minAgeDays 3 | 16       | 178 / 248 | 0 / 5,808       | 4,224 / 4,859      | 0 / 1,935        | yes / NO        |
| Eyniq, MIN_RELEASE_AGE=3d              | 32       | 771 / 766 | 0 / 0           | 1,646 / 1,703      | 0 / 0            | yes / yes       |
| Verdaccio, package-filter minAgeDays 3 | 32       | 227 / 266 | 14,188 / 14,168 | 4,114 / 4,173      | 15,695 / 1,364   | NO / NO         |

What the numbers say, with the caveats above in mind:

- Verdaccio does not coalesce concurrent upstream fetches: cold 4 caused 7.7 to 7.8 thousand
  upstream requests against 1,866 for Eyniq.
- Verdaccio ran out of memory under parallel installs: V8 heap exhaustion at the 3 GiB heap in
  warm 16 and 32, kernel OOM kills at 6.4 to 6.7 GiB RSS in warm 64. With its age filter on it
  behaved the same.
- Eyniq had no error at 4 to 64 installs and no corrupt byte in a separate integrity check
  (checker at 1,024 parallel requests next to 32 installs).
- Warm req/s of Eyniq is capped by the load generator, not by the server (see caveats).

The first smoke check of `load/bench/run.sh` (2026-10-16, 1 install of a four-package lockfile,
Docker Desktop VM as above) ran all four candidates without errors; it proves the plumbing and
is not a measurement.
