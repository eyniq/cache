#!/usr/bin/env bash
# Reproducible Linux benchmark: Eyniq Cache against Verdaccio, with the minimum-age filter on
# and with filesystem or S3 (versitygw) storage. Method and caveats: docs/BENCHMARK.md.
#
#   LOCKFILE=/path/to/pnpm-lock.yaml load/bench/run.sh smoke      one tiny install per candidate
#   LOCKFILE=/path/to/pnpm-lock.yaml load/bench/run.sh all        up + seed + run + tables
#   load/bench/run.sh up | seed | run [candidate...] | tables | down | clean
#
# Environment (all optional except LOCKFILE):
#   LOCKFILE          pnpm-lock.yaml or package-lock.json to replay (any realistic project)
#   RESULTS           output directory (default load/results/bench-<UTC date>)
#   CANDIDATES        space separated: eyniq-fs eyniq-s3 verdaccio-fs verdaccio-s3 (default all four)
#   SCENARIOS         comma separated: cold4,warm4,warm16,warm32,warm64 (default those five)
#   RUNS              runs per cell (default 2)       GATE=false  turns the age filter off
#   BENCH_CPUS        docker --cpus for the container   BENCH_MEMORY  docker --memory (e.g. 8g)
#   VERDACCIO_IMAGE   default verdaccio/verdaccio:6.10.5   VERSITYGW_IMAGE default versity/versitygw:v1.9.0@sha256:eb7f786f... (pinned)
#   S3_PLUGIN_VERSION version of verdaccio-aws-s3-storage installed inside the container
#   VERDACCIO_HEAP_MB Verdaccio --max-old-space-size (default 3072)
#   LRU_MAX_BYTES, WORKERS   passed to Eyniq (defaults: its own, 4 workers)
#   SEED_UPSTREAM     registry the seed warms from (default https://registry.npmjs.org)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

NAME=${BENCH_NAME:-eyniq-bench}
VERDACCIO_IMAGE=${VERDACCIO_IMAGE:-verdaccio/verdaccio:6.10.5}
# Pinned by tag and digest (the digest was checked with `docker pull`), never "latest".
VERSITYGW_IMAGE=${VERSITYGW_IMAGE:-versity/versitygw:v1.9.0@sha256:eb7f786fcd91e72194e48fcf1ac16302d686bf8e3a71434bdbc067a6efd3fdc7}
# 12.x of the plugin needs a DynamoDB table; the 6-next line is the S3-only one for Verdaccio 6.
S3_PLUGIN_VERSION=${S3_PLUGIN_VERSION:-11.0.0-6-next.10}
CANDIDATES=${CANDIDATES:-eyniq-fs eyniq-s3 verdaccio-fs verdaccio-s3}
SCENARIOS=${SCENARIOS:-cold4,warm4,warm16,warm32,warm64}
RESULTS=${RESULTS:-$repo/load/results/bench-$(date -u +%Y%m%d)}

die() { echo "bench: $*" >&2; exit 2; }
# The version ends up in a shell command inside the container: only npm version characters.
printf '%s' "$S3_PLUGIN_VERSION" | grep -Eq '^[0-9A-Za-z.-]+$' || die "invalid S3_PLUGIN_VERSION"
need_lockfile() {
  [ -n "${LOCKFILE:-}" ] || die "set LOCKFILE to a pnpm-lock.yaml or package-lock.json"
  [ -f "$LOCKFILE" ] || die "LOCKFILE not found: $LOCKFILE"
}
in_container() { docker exec -e RESULTS=/results -e LOCKFILE="/bench/$(basename "${LOCKFILE:-lockfile}")" \
  -e RUNS="${RUNS:-2}" -e GATE="${GATE:-true}" -e SETTLE_MS="${SETTLE_MS:-10000}" \
  -e VERDACCIO_HEAP_MB="${VERDACCIO_HEAP_MB:-3072}" -e LRU_MAX_BYTES="${LRU_MAX_BYTES:-}" \
  -e WORKERS="${WORKERS:-4}" -e SEED_UPSTREAM="${SEED_UPSTREAM:-https://registry.npmjs.org}" \
  "$NAME" "$@"; }

uses_s3() { case " $CANDIDATES " in *-s3*) return 0 ;; *) return 1 ;; esac; }

cmd_up() {
  need_lockfile
  command -v docker >/dev/null || die "docker is required"
  [ -f "$repo/dist/main.js" ] || die "dist/ is missing: run 'pnpm build' first"
  mkdir -p "$RESULTS"
  docker rm -f "$NAME-s3" "$NAME" >/dev/null 2>&1 || true
  limits=()
  [ -z "${BENCH_CPUS:-}" ] || limits+=(--cpus "$BENCH_CPUS")
  [ -z "${BENCH_MEMORY:-}" ] || limits+=(--memory "$BENCH_MEMORY")
  # One container: the seed, the candidate and the load generator share its loopback. The
  # Verdaccio image brings Node 24 and Verdaccio; it runs as root so it can write the volumes.
  docker run -d --name "$NAME" --user root --entrypoint sleep ${limits[@]+"${limits[@]}"} \
    --ulimit nofile=1048576:1048576 \
    -v "$repo/dist:/ts/dist:ro" -v "$repo/load:/ts/load:ro" -v "$repo/package.json:/ts/package.json:ro" \
    -v "$here:/bench-src:ro" -v "$LOCKFILE:/bench/$(basename "$LOCKFILE"):ro" \
    -v "$RESULTS:/results" -v "$NAME-seed:/seed" -v "$NAME-data:/data" \
    "$VERDACCIO_IMAGE" infinity >/dev/null
  if uses_s3; then
    # versitygw joins the container's network namespace: S3 is 127.0.0.1:7070 for everyone.
    docker run -d --name "$NAME-s3" --network "container:$NAME" -v "$NAME-s3data:/s3" \
      "$VERSITYGW_IMAGE" --access bench --secret bench-secret-key --port :7070 posix /s3 >/dev/null
    case "$CANDIDATES" in
      *verdaccio-s3*)
        # Installed at bench time inside the throwaway container; not a dependency of this repo.
        in_container sh -c "mkdir -p /data/plugins && npm install --silent --no-audit --no-fund --ignore-scripts --prefix /data/plugins \"verdaccio-aws-s3-storage@$S3_PLUGIN_VERSION\"" ;;
    esac
  fi
  # driver.ts is copied (not mounted from the repo path) so the container never writes there.
  in_container node /bench-src/driver.ts info
}

cmd_seed() { need_lockfile; in_container node /bench-src/driver.ts seed; }

cmd_run() {
  need_lockfile
  [ $# -eq 0 ] || CANDIDATES="$*"
  for c in $CANDIDATES; do
    echo "== $c: $SCENARIOS"
    in_container node /bench-src/driver.ts suite "$c" "$SCENARIOS"
  done
}

cmd_tables() { node "$here/render.ts" "$RESULTS"; }

cmd_down() { docker rm -f "$NAME-s3" "$NAME" >/dev/null 2>&1 || true; }

cmd_clean() {
  cmd_down
  docker volume rm "$NAME-seed" "$NAME-data" "$NAME-s3data" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) cmd_up ;;
  seed) cmd_seed ;;
  run) shift; cmd_run "$@" ;;
  tables) cmd_tables ;;
  down) cmd_down ;;
  clean) cmd_clean ;;
  all) cmd_up; cmd_seed; cmd_run; cmd_tables ;;
  smoke)
    # One install, no settle time: proves the plumbing, says nothing about performance.
    export RUNS=1 SETTLE_MS=1000 SCENARIOS=cold1
    cmd_up; cmd_seed; cmd_run; cmd_tables ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
