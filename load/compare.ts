// Compare a candidate load report with a baseline (DESIGN.md section 12: Eyniq Cache must be
// better than the Verdaccio baseline on every metric). Usage:
//   node load/compare.ts load/results/verdaccio.json load/results/eyniq.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Summary } from './stats.ts';

export interface ServerSamples {
  cpuPercentMax?: number;
  rssMaxBytes?: number;
  eventLoopP99Ms?: number;
  upstreamFetches?: number;
  hitRatio?: number;
  restarts?: number;
}

export interface Report {
  label: string;
  rps: number;
  errors: number;
  timeouts: number;
  metadata: Summary;
  tarballs: Summary;
  server?: ServerSamples;
}

export interface Row {
  metric: string;
  baseline: number;
  candidate: number;
  verdict: 'better' | 'equal' | 'worse';
}

type Pick = (r: Report) => number | undefined;
const METRICS: Array<[string, Pick, 'lower' | 'higher']> = [
  ['rps', (r) => r.rps, 'higher'],
  ['errors', (r) => r.errors, 'lower'],
  ['timeouts', (r) => r.timeouts, 'lower'],
  ['metadata.p50', (r) => r.metadata.p50, 'lower'],
  ['metadata.p95', (r) => r.metadata.p95, 'lower'],
  ['metadata.p99', (r) => r.metadata.p99, 'lower'],
  ['tarballs.p50', (r) => r.tarballs.p50, 'lower'],
  ['tarballs.p95', (r) => r.tarballs.p95, 'lower'],
  ['tarballs.p99', (r) => r.tarballs.p99, 'lower'],
  ['server.cpuPercentMax', (r) => r.server?.cpuPercentMax, 'lower'],
  ['server.rssMaxBytes', (r) => r.server?.rssMaxBytes, 'lower'],
  ['server.eventLoopP99Ms', (r) => r.server?.eventLoopP99Ms, 'lower'],
  ['server.upstreamFetches', (r) => r.server?.upstreamFetches, 'lower'],
  ['server.restarts', (r) => r.server?.restarts, 'lower'],
  ['server.hitRatio', (r) => r.server?.hitRatio, 'higher'],
];

export function compareReports(
  baseline: Report,
  candidate: Report,
): { pass: boolean; rows: Row[]; notCompared: string[] } {
  const rows: Row[] = [];
  const notCompared: string[] = [];
  for (const [metric, pick, better] of METRICS) {
    const b = pick(baseline);
    const c = pick(candidate);
    if (b === undefined || c === undefined) {
      notCompared.push(metric);
      continue;
    }
    const verdict: Row['verdict'] =
      b === c ? 'equal' : (better === 'lower' ? c < b : c > b) ? 'better' : 'worse';
    rows.push({ metric, baseline: b, candidate: c, verdict });
  }
  return { pass: rows.every((r) => r.verdict !== 'worse'), rows, notCompared };
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const [baselinePath, candidatePath] = positional;
  if (!baselinePath || !candidatePath) {
    process.stderr.write(
      'usage: node load/compare.ts <baseline.json> <candidate.json> ' +
        '[--baseline-samples samples.json] [--candidate-samples samples.json]\n',
    );
    process.exit(2);
  }
  const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
  // Server samples taken separately (run.ts --sample-only) are merged into the reports.
  const withSamples = (r: Report, p: string | undefined): Report => {
    if (!p) return r;
    const samples = (read(p) as { server?: ServerSamples }).server ?? {};
    return { ...r, server: { ...samples, ...r.server } };
  };
  const baseline = withSamples(read(baselinePath) as Report, flag('--baseline-samples'));
  const candidate = withSamples(read(candidatePath) as Report, flag('--candidate-samples'));
  const { pass, rows, notCompared } = compareReports(baseline, candidate);
  const lines = [
    `metric                    ${baseline.label.padEnd(14)} ${candidate.label.padEnd(14)} verdict`,
  ];
  for (const r of rows) {
    lines.push(
      `${r.metric.padEnd(25)} ${String(r.baseline).padEnd(14)} ${String(r.candidate).padEnd(14)} ${r.verdict}`,
    );
  }
  if (notCompared.length > 0) {
    lines.push(`not compared (missing in a report; compare by hand): ${notCompared.join(', ')}`);
  }
  lines.push(
    pass ? 'PASS: not worse on any compared metric' : 'FAIL: worse on at least one metric',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
