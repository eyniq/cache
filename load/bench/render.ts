// Renders the benchmark result tables (markdown) from a results directory written by
// load/bench/run.sh:  node load/bench/render.ts <results-dir>
// Cells with several runs show `run 1 / run 2`; latency cells are p50-p95-p99 in ms.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node load/bench/render.ts <results-dir>\n');
  process.exit(2);
}

const CANDIDATES: ReadonlyArray<[string, string]> = [
  ['eyniq-fs', 'Eyniq, filesystem'],
  ['eyniq-s3', 'Eyniq, S3 (versitygw)'],
  ['verdaccio-fs', 'Verdaccio 6.10.5, filesystem'],
  ['verdaccio-s3', 'Verdaccio 6.10.5, S3 (versitygw)'],
];
const SCENARIOS: ReadonlyArray<[string, string]> = [
  ['cold4', 'Cold, 4 installs (fresh process and empty cache per run)'],
  ['warm4', 'Warm, 4 installs'],
  ['warm16', 'Warm, 16 installs'],
  ['warm32', 'Warm, 32 installs'],
  ['warm64', 'Warm, 64 installs'],
];

interface Summary {
  p50: number;
  p95: number;
  p99: number;
}
interface Result {
  rps: number;
  errors: number;
  timeouts: number;
  errorSamples?: string[];
  metadata: Summary;
  tarballs: Summary;
}
interface Meta {
  alive: boolean;
  serverCpuAvgPct: number | null;
  serverRssMaxMiB: number;
  seedDelta: number;
  harnessCpuPct: number;
}

function read(file: string): unknown {
  const path = join(dir ?? '.', file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const num = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? 'n/a'
    : Math.round(v).toLocaleString('en-US');
const dec = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? 'n/a'
    : (Math.round(v * 10) / 10).toString();
const lat = (s: Summary): string => `${num(s.p50)}-${num(s.p95)}-${num(s.p99)}`;

function errorKinds(r: Result): string {
  const kinds = new Set((r.errorSamples ?? []).map((s) => s.replace(/^.*?: /, '')));
  return kinds.size > 0 ? ` (${[...kinds].join(', ')})` : '';
}

function table(scenario: string): string | null {
  const rows: string[] = [];
  for (const [key, name] of CANDIDATES) {
    const runs: Array<{ r: Result; m: Meta }> = [];
    for (let run = 1; run <= 9; run++) {
      const r = read(`${key}-${scenario}-${run}.json`) as Result | null;
      const m = read(`${key}-${scenario}-${run}.meta.json`) as Meta | null;
      if (r && m) runs.push({ r, m });
    }
    if (runs.length === 0) continue;
    const cell = (f: (x: { r: Result; m: Meta }) => string): string => runs.map(f).join(' / ');
    rows.push(
      `| ${name} | ${cell((x) => dec(x.r.rps))} | ${cell((x) => lat(x.r.metadata))} | ` +
        `${cell((x) => lat(x.r.tarballs))} | ${cell((x) => num(x.r.errors) + errorKinds(x.r))} | ` +
        `${cell((x) => num(x.r.timeouts))} | ${cell((x) => dec(x.m.serverCpuAvgPct))} | ` +
        `${cell((x) => num(x.m.serverRssMaxMiB))} | ${cell((x) => num(x.m.seedDelta))} | ` +
        `${cell((x) => dec(x.m.harnessCpuPct))} | ${cell((x) => (x.m.alive ? 'yes' : 'NO'))} |`,
    );
  }
  if (rows.length === 0) return null;
  return [
    '| Candidate | req/s | metadata p50-p95-p99 ms | tarball p50-p95-p99 ms | errors | timeouts | server CPU% avg | server RSS max MiB | upstream fetches | harness CPU% | server survived |',
    `|${' --- |'.repeat(11)}`,
    ...rows,
  ].join('\n');
}

const out: string[] = [];
const env = read('environment.json');
if (env) {
  out.push('```json', JSON.stringify(env, null, 2), '```', '');
}
for (const [scenario, title] of SCENARIOS) {
  const t = table(scenario);
  if (t) out.push(`#### ${title}`, '', t, '');
}
// A smoke run (one install) is not one of the named scenarios.
const smoke = table('cold1');
if (smoke) out.push('#### Smoke, 1 install (plumbing check only)', '', smoke, '');
const text = out.join('\n');
writeFileSync(join(dir, 'tables.md'), text);
process.stdout.write(`${text}\n`);
