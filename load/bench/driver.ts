// In-container benchmark driver (docs/BENCHMARK.md). Runs INSIDE the bench container, started by
// load/bench/run.sh: the seed (the upstream), the candidate registry and the load harness share
// the container's loopback, so the network is not the variable. Node 24 runs this file as is.
//
//   node driver.ts info                          write environment.json (versions, CPUs, memory)
//   node driver.ts seed                          start the seed and warm it with one install
//   node driver.ts suite <candidate> [scenario]  run the scenarios for one candidate
//   node driver.ts stopall
//
// Candidates: eyniq-fs, eyniq-s3, verdaccio-fs, verdaccio-s3. Scenarios: cold4, warm4, warm16,
// warm32, warm64 (cold N = N parallel installs on an empty cache; warm N = on a primed one).
// Configuration comes from the environment (see run.sh): RESULTS, LOCKFILE, RUNS, GATE,
// SETTLE_MS, VERDACCIO_HEAP_MB, LRU_MAX_BYTES, WORKERS, S3_PLUGIN_DIR.
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const RESULTS = process.env.RESULTS ?? '/results';
const LOCKFILE = process.env.LOCKFILE ?? '/bench/lockfile';
const RUNS = Number(process.env.RUNS ?? 2);
const GATE = process.env.GATE !== 'false';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 10_000);
const VERDACCIO_HEAP_MB = Number(process.env.VERDACCIO_HEAP_MB ?? 3072);
const S3_PLUGIN_DIR = process.env.S3_PLUGIN_DIR ?? '/data/plugins/node_modules';
const ENDPOINT = 'http://127.0.0.1:7070';
const S3_ACCESS = 'bench';
const S3_SECRET = 'bench-secret-key';
const SEED_PORT = 6100;
const SEED_MANAGEMENT_PORT = 6190;
const MIN_AGE_DAYS = 3;
const CLK_TCK = 100; // Linux

mkdirSync(RESULTS, { recursive: true });
const LOG = `${RESULTS}/driver.log`;
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  appendFileSync(LOG, `${line}\n`);
}

type Candidate = 'eyniq-fs' | 'eyniq-s3' | 'verdaccio-fs' | 'verdaccio-s3';
interface Spec {
  port: number;
  managementPort: number | null;
  kind: 'eyniq' | 'verdaccio';
  s3: boolean;
}
const CANDIDATES: Record<Candidate, Spec> = {
  'eyniq-fs': { port: 6101, managementPort: 6201, kind: 'eyniq', s3: false },
  'eyniq-s3': { port: 6102, managementPort: 6202, kind: 'eyniq', s3: true },
  'verdaccio-fs': { port: 6104, managementPort: null, kind: 'verdaccio', s3: false },
  'verdaccio-s3': { port: 6105, managementPort: null, kind: 'verdaccio', s3: true },
};
const isCandidate = (s: string | undefined): s is Candidate =>
  s !== undefined && Object.hasOwn(CANDIDATES, s);

// ---- /proc helpers ----------------------------------------------------------------------

function cpuTicks(pid: number): number | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
    return Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch {
    return null;
  }
}

function rssMiB(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m?.[1] ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    return (
      existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
    );
  } catch {
    return false;
  }
}

async function get(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url);
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

/** Sum of a Prometheus metric family (all label sets). */
function promSum(text: string, name: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const next = line[name.length];
    if (next !== '{' && next !== ' ') continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1)) || 0;
  }
  return sum;
}

/** Requests the seed received = upstream fetches of the candidate. */
async function seedRequests(): Promise<number> {
  const res = await get(`http://127.0.0.1:${SEED_MANAGEMENT_PORT}/metrics`);
  return res ? promSum(res.text, 'eyniq_cache_http_requests_total') : Number.NaN;
}

// ---- processes --------------------------------------------------------------------------

interface Started {
  pid: number;
  startupMs: number;
}

async function createBucket(bucket: string): Promise<void> {
  // The build's own S3 client (the repo's SigV4 signer) creates the bucket for both servers.
  const module = '/ts/dist/storage/s3.js'; // a variable: the build output is not a TS module here
  const { S3Storage } = (await import(module)) as {
    S3Storage: new (o: object) => { createBucketForTests(): Promise<void> };
  };
  await new S3Storage({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket,
    accessKeyId: S3_ACCESS,
    secretAccessKey: S3_SECRET,
    forcePathStyle: true,
  }).createBucketForTests();
}

function verdaccioConfig(dataDir: string, bucket: string | null, gate: boolean): string {
  const store = bucket
    ? `store:
  aws-s3-storage:
    bucket: ${bucket}
    keyPrefix: verdaccio
    region: us-east-1
    endpoint: ${ENDPOINT}
    s3ForcePathStyle: true
    accessKeyId: ${S3_ACCESS}
    secretAccessKey: ${S3_SECRET}
plugins: ${S3_PLUGIN_DIR}
`
    : `storage: ${dataDir}/storage
`;
  const filter = gate
    ? `filters:
  '@verdaccio/package-filter':
    minAgeDays: ${MIN_AGE_DAYS}
`
    : '';
  // Production-like settings (docs/BENCHMARK.md): the seed is the uplink, metadata is
  // revalidated after 5m (Eyniq's default METADATA_TTL), no web UI, audit middleware on.
  const text = `${store}web:
  enable: false
auth:
  htpasswd:
    file: ${dataDir}/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: http://127.0.0.1:${SEED_PORT}/
    timeout: 60s
    maxage: 5m
packages:
  '**':
    access: $all
    publish: nobody
    unpublish: nobody
    proxy: npmjs
middlewares:
  audit:
    enabled: true
log:
  type: stdout
  format: json
  level: warn
${filter}`;
  const file = `${dataDir}.yaml`;
  writeFileSync(file, text);
  return file;
}

async function start(
  name: Candidate,
  dataDir: string,
  tag: string,
  bucket: string | null,
): Promise<Started> {
  const spec = CANDIDATES[name];
  mkdirSync(dataDir, { recursive: true });
  const t0 = performance.now();
  const logFile = `${RESULTS}/server-${tag}.log`;
  const fd = openSync(logFile, 'a');
  if (bucket) await createBucket(bucket);
  let child;
  if (spec.kind === 'verdaccio') {
    const config = verdaccioConfig(dataDir, bucket, GATE);
    child = spawn('verdaccio', ['--config', config, '--listen', `127.0.0.1:${spec.port}`], {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${VERDACCIO_HEAP_MB}` },
      detached: true,
    });
  } else {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MIN_RELEASE_AGE: GATE ? `${MIN_AGE_DAYS}d` : '0',
      LOG_LEVEL: 'warn',
      WORKERS: process.env.WORKERS ?? '4',
      UPSTREAM_URL: `http://127.0.0.1:${SEED_PORT}`,
      PORT: String(spec.port),
      MANAGEMENT_PORT: String(spec.managementPort),
      PUBLIC_URL: `http://127.0.0.1:${spec.port}`,
      ...(process.env.LRU_MAX_BYTES ? { LRU_MAX_BYTES: process.env.LRU_MAX_BYTES } : {}),
      ...(bucket
        ? {
            STORAGE: 's3',
            S3_ENDPOINT: ENDPOINT,
            S3_REGION: 'us-east-1',
            S3_BUCKET: bucket,
            S3_ACCESS_KEY_ID: S3_ACCESS,
            S3_SECRET_ACCESS_KEY: S3_SECRET,
            S3_FORCE_PATH_STYLE: 'true',
          }
        : { FS_ROOT: dataDir }),
    };
    child = spawn('node', ['/ts/dist/main.js'], {
      stdio: ['ignore', fd, fd],
      env,
      detached: true,
    });
  }
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${name} did not start`);
  const readyUrl =
    spec.kind === 'verdaccio'
      ? `http://127.0.0.1:${spec.port}/-/ping`
      : `http://127.0.0.1:${spec.managementPort}/readyz`;
  for (let i = 0; i < 6000; i++) {
    const res = await get(readyUrl);
    if (res?.status === 200) {
      // An answer from a server that is not our child means the port was taken (a leftover).
      if (!alive(pid)) throw new Error(`${name}: port ${spec.port} is already in use`);
      return { pid, startupMs: Math.round(performance.now() - t0) };
    }
    if (!alive(pid)) throw new Error(`${name} died at startup, see ${logFile}`);
    await sleep(5);
  }
  throw new Error(`${name} not ready, see ${logFile}`);
}

async function stop(pid: number): Promise<void> {
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
  for (let i = 0; i < 300 && alive(pid); i++) await sleep(50);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
}

// ---- measured runs ----------------------------------------------------------------------

interface HarnessOutcome {
  wallS: number;
  cpuPct: number;
  rssMiB: number;
  output: string;
}

function harness(port: number, installs: number, out: string): Promise<HarnessOutcome> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(
      'node',
      [
        '/ts/load/run.ts',
        '--lockfile',
        LOCKFILE,
        '--registry',
        `http://127.0.0.1:${port}`,
        '--installs',
        String(installs),
        '--concurrency',
        '16',
        '--out',
        out,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let maxRss = 0;
    let lastTicks = 0;
    const timer = setInterval(() => {
      if (child.pid === undefined) return;
      maxRss = Math.max(maxRss, rssMiB(child.pid));
      lastTicks = cpuTicks(child.pid) ?? lastTicks;
    }, 500);
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('exit', () => {
      clearInterval(timer);
      const wallS = (performance.now() - t0) / 1000;
      resolve({
        wallS,
        cpuPct: Math.round((lastTicks / CLK_TCK / wallS) * 1000) / 10,
        rssMiB: Math.round(maxRss),
        output,
      });
    });
  });
}

interface RunSummary {
  rps?: number;
  errors?: number;
  timeouts?: number;
  errorSamples?: string[];
  metadata?: { p95: number };
  tarballs?: { p95: number };
}

async function measuredRun(
  pid: number,
  port: number,
  label: string,
  installs: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const out = `${RESULTS}/${label}.json`;
  const seed0 = await seedRequests();
  const cpu0 = cpuTicks(pid);
  const t0 = performance.now();
  let rssMax = 0;
  const timer = setInterval(() => (rssMax = Math.max(rssMax, rssMiB(pid))), 1000);
  const h = await harness(port, installs, out);
  clearInterval(timer);
  rssMax = Math.max(rssMax, rssMiB(pid)); // short runs end before the first 1 s sample
  const wall = (performance.now() - t0) / 1000;
  const cpu1 = cpuTicks(pid);
  const survived = alive(pid);
  const seed1 = await seedRequests();
  let res: RunSummary = {};
  try {
    res = JSON.parse(readFileSync(out, 'utf8')) as RunSummary;
  } catch {
    log(`  no harness output: ${h.output.slice(-300)}`);
  }
  const meta = {
    label,
    installs,
    alive: survived,
    serverCpuAvgPct:
      cpu0 !== null && cpu1 !== null
        ? Math.round(((cpu1 - cpu0) / CLK_TCK / wall) * 1000) / 10
        : null,
    serverRssMaxMiB: Math.round(rssMax),
    seedDelta: seed1 - seed0,
    harnessCpuPct: h.cpuPct,
    harnessRssMiB: h.rssMiB,
    loadavg: readFileSync('/proc/loadavg', 'utf8').trim(),
    ...extra,
  };
  writeFileSync(`${RESULTS}/${label}.meta.json`, JSON.stringify(meta, null, 2));
  log(
    `${label}: rps ${res.rps} err ${res.errors} timeouts ${res.timeouts} ` +
      `metaP95 ${res.metadata?.p95} tarP95 ${res.tarballs?.p95} cpu ${meta.serverCpuAvgPct}% ` +
      `rss ${meta.serverRssMaxMiB} MiB seed ${meta.seedDelta} alive ${survived} ` +
      `samples ${JSON.stringify((res.errorSamples ?? []).slice(0, 2))}`,
  );
}

const DATA = '/data/runs';
const scenarioOf = (s: string): { cold: boolean; installs: number } | null => {
  const m = /^(cold|warm)(\d{1,3})$/.exec(s);
  return m?.[1] && m[2] ? { cold: m[1] === 'cold', installs: Number(m[2]) } : null;
};

async function suite(name: Candidate, scenarios: string[]): Promise<void> {
  const spec = CANDIDATES[name];
  const stamp = Date.now().toString(36);
  // A fresh bucket (or data dir) per process: runs never see each other's cache.
  const fresh = (suffix: string): { dir: string; bucket: string | null } => ({
    dir: `${DATA}/${name}-${suffix}`,
    bucket: spec.s3 ? `bench-${name}-${suffix}-${stamp}` : null,
  });
  let server: Started | null = null;
  let warm = fresh('warm');
  let warmedUp = false;
  rmSync(`${DATA}/${name}-warm`, { recursive: true, force: true });

  for (const scenario of scenarios) {
    const parsed = scenarioOf(scenario);
    if (!parsed) throw new Error(`unknown scenario ${scenario}`);
    for (let run = 1; run <= RUNS; run++) {
      const label = `${name}-${scenario}-${run}`;
      if (parsed.cold) {
        // Fresh process, empty cache: the second cold run must not benefit from the first.
        if (server) await stop(server.pid);
        const c = fresh(`${scenario}-${run}`);
        rmSync(c.dir, { recursive: true, force: true });
        server = await start(name, c.dir, label, c.bucket);
        log(`${label}: started pid ${server.pid} in ${server.startupMs} ms`);
        await sleep(SETTLE_MS);
        await measuredRun(server.pid, spec.port, label, parsed.installs, {
          candidate: name,
          startupMs: server.startupMs,
        });
        await stop(server.pid);
        rmSync(c.dir, { recursive: true, force: true });
        server = null;
        continue;
      }
      if (!server || !alive(server.pid)) {
        if (server) log(`${label}: server died earlier, restarting on its warm data`);
        else {
          rmSync(warm.dir, { recursive: true, force: true });
          warm = fresh('warm');
          warmedUp = false;
        }
        server = await start(name, warm.dir, `${name}-warm`, warm.bucket);
        if (!warmedUp) {
          warmedUp = true;
          await measuredRun(server.pid, spec.port, `${name}-warmup`, 1, { candidate: name });
        }
      }
      await sleep(SETTLE_MS);
      await measuredRun(server.pid, spec.port, label, parsed.installs, { candidate: name });
    }
  }
  if (server) await stop(server.pid);
  rmSync(warm.dir, { recursive: true, force: true });
  log(`${name} done`);
}

// ---- seed -------------------------------------------------------------------------------

async function seed(): Promise<void> {
  const dir = '/seed/data';
  mkdirSync(dir, { recursive: true });
  const fd = openSync(`${RESULTS}/server-seed.log`, 'a');
  const child = spawn('node', ['/ts/dist/main.js'], {
    stdio: ['ignore', fd, fd],
    detached: true,
    env: {
      ...process.env,
      MIN_RELEASE_AGE: '0',
      LOG_LEVEL: 'warn',
      WORKERS: '4',
      METADATA_TTL: '365d',
      UPSTREAM_URL: process.env.SEED_UPSTREAM ?? 'https://registry.npmjs.org',
      FS_ROOT: dir,
      PORT: String(SEED_PORT),
      MANAGEMENT_PORT: String(SEED_MANAGEMENT_PORT),
      PUBLIC_URL: `http://127.0.0.1:${SEED_PORT}`,
    },
  });
  child.unref();
  for (let i = 0; i < 2000; i++) {
    if ((await get(`http://127.0.0.1:${SEED_MANAGEMENT_PORT}/readyz`))?.status === 200) break;
    await sleep(10);
  }
  // One install fills it from the real registry; later runs are served from this copy.
  const h = await harness(SEED_PORT, 1, `${RESULTS}/seed-warmup.json`);
  log(`seed warm-up: ${h.output.trim().split('\n').pop()}`);
  writeFileSync('/tmp/seed.pid', String(child.pid));
}

function info(): void {
  const sh = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const environment = {
    date: new Date().toISOString(),
    kernel: sh('uname', ['-r']),
    arch: sh('uname', ['-m']),
    cpus: Number(sh('nproc', [])),
    memTotalMiB: Math.round(Number(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) / 1024),
    node: process.version,
    verdaccio: sh('verdaccio', ['--version']),
    gate: GATE
      ? `minimum age ${MIN_AGE_DAYS} days (Eyniq MIN_RELEASE_AGE, Verdaccio package-filter)`
      : 'off',
    runsPerCell: RUNS,
    verdaccioHeapMiB: VERDACCIO_HEAP_MB,
    eyniqWorkers: process.env.WORKERS ?? '4',
    eyniqLruMaxBytes: process.env.LRU_MAX_BYTES || 'default',
    s3Plugin: existsSync(`${S3_PLUGIN_DIR}/verdaccio-aws-s3-storage/package.json`)
      ? (
          JSON.parse(
            readFileSync(`${S3_PLUGIN_DIR}/verdaccio-aws-s3-storage/package.json`, 'utf8'),
          ) as { version?: string }
        ).version
      : 'not installed',
  };
  writeFileSync(`${RESULTS}/environment.json`, JSON.stringify(environment, null, 2));
  log(`environment: ${JSON.stringify(environment)}`);
}

const [command, arg, arg2] = process.argv.slice(2);
if (command === 'info') {
  info();
} else if (command === 'seed') {
  await seed();
} else if (command === 'suite') {
  if (!isCandidate(arg))
    throw new Error(`candidate must be one of ${Object.keys(CANDIDATES).join(', ')}`);
  await suite(arg, (arg2 ?? 'cold4,warm4,warm16,warm32,warm64').split(','));
} else if (command === 'stopall') {
  for (const entry of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (/dist\/main\.js|verdaccio|load\/run\.ts/.test(cmdline) && Number(entry) !== process.pid) {
        process.kill(Number(entry), 'SIGTERM');
      }
    } catch {
      // process ended while scanning
    }
  }
} else {
  throw new Error('usage: driver.ts info | seed | suite <candidate> [scenarios] | stopall');
}
process.exit(0);
