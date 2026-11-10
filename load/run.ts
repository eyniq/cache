// Load-test CLI (DESIGN.md section 12). Procedure in docs/OPERATIONS.md.
//
//   Load:   node load/run.ts --lockfile <pnpm-lock.yaml|package-lock.json> --registry <url>
//             [--installs 20] [--concurrency 16] [--timeout 60000] [--label name] [--out file]
//             [--metrics-url url[,url...]]   Eyniq /metrics of EVERY pod (counters are summed)
//             [--kube namespace/selector]    sample CPU, memory and restarts via kubectl
//             [--pid 1234]                   sample a local process via ps
//           The registry token, if any, is read from LOAD_TOKEN (never from argv).
//   Sample: node load/run.ts --sample-only --kube namespace/selector --out samples.json
//             [--duration 600]  (or Ctrl-C) - for targets the load pod cannot sample itself
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ServerSamples } from './compare.ts';
import { runLoad } from './harness.ts';
import { parseLockfile } from './lockfile.ts';

const exec = promisify(execFile);

function args(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out.set(key.slice(2), 'true');
    } else {
      out.set(key.slice(2), value);
      i++;
    }
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** `namespace/label-selector`, validated so nothing can be smuggled in as a kubectl flag. */
function parseKube(value: string): { ns: string; selector: string } {
  const [ns = '', selector = ''] = value.split('/', 2);
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(ns) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/=,!-]{0,252}$/.test(selector)
  ) {
    fail('--kube must look like namespace/app=name');
  }
  return { ns, selector };
}

/** Sum of every sample of a Prometheus metric family (optionally filtered by a label). */
function promSum(text: string, name: string, label?: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== '{' && rest[0] !== ' ') continue;
    if (label && !rest.includes(label)) continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1)) || 0;
  }
  return sum;
}

/** Scrape every pod; counters must come from all replicas, not whichever pod a Service picks. */
async function scrapeAll(urls: string[]): Promise<string[]> {
  return Promise.all(urls.map((u) => fetch(u).then((r) => r.text())));
}

const MEMORY_UNITS: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };

/** Samples server-side numbers once per second. */
class Sampler {
  readonly samples: ServerSamples = {};
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly opts: {
    metricsUrls: string[];
    kube?: { ns: string; selector: string };
    pid?: string;
  };

  constructor(opts: {
    metricsUrls: string[];
    kube?: { ns: string; selector: string };
    pid?: string;
  }) {
    this.opts = opts;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick().finally(() => (this.busy = false));
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private max(key: keyof ServerSamples, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.samples[key] = Math.max(this.samples[key] ?? 0, value);
  }

  private async tick(): Promise<void> {
    if (this.opts.metricsUrls.length > 0) {
      const texts = await scrapeAll(this.opts.metricsUrls).catch(() => [] as string[]);
      for (const text of texts) {
        const p99 = promSum(text, 'eyniq_cache_event_loop_delay_seconds', 'quantile="0.99"');
        this.max('eventLoopP99Ms', Math.round(p99 * 10_000) / 10);
        this.max('rssMaxBytes', promSum(text, 'eyniq_cache_process_resident_memory_bytes'));
      }
    }
    if (this.opts.pid) {
      const { stdout } = await exec('ps', ['-o', '%cpu=,rss=', '-p', this.opts.pid]).catch(() => ({
        stdout: '',
      }));
      const [cpu, rssKb] = stdout.trim().split(/\s+/).map(Number);
      if (cpu !== undefined) this.max('cpuPercentMax', cpu);
      if (rssKb !== undefined) this.max('rssMaxBytes', rssKb * 1024);
    }
    if (this.opts.kube) {
      const { ns, selector } = this.opts.kube;
      const { stdout } = await exec('kubectl', [
        'top',
        'pods',
        '-n',
        ns,
        '-l',
        selector,
        '--no-headers',
      ]).catch(() => ({ stdout: '' }));
      let cpu = 0;
      let mem = 0;
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const [, c = '0', m = '0'] = line.trim().split(/\s+/);
        cpu += c.endsWith('m') ? Number(c.slice(0, -1)) / 10 : Number(c) * 100; // millicores to %
        const unit = /([KMG]i)$/.exec(m)?.[1] ?? '';
        mem = Math.max(mem, Number(m.replace(/[KMG]i$/, '')) * (MEMORY_UNITS[unit] ?? 1));
      }
      this.max('cpuPercentMax', cpu);
      this.max('rssMaxBytes', mem);
    }
  }
}

async function kubeRestarts(kube: { ns: string; selector: string }): Promise<number> {
  const { stdout } = await exec('kubectl', [
    'get',
    'pods',
    '-n',
    kube.ns,
    '-l',
    kube.selector,
    '-o',
    'jsonpath={.items[*].status.containerStatuses[*].restartCount}',
  ]);
  return stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((a, b) => a + Number(b), 0);
}

async function writeReport(out: string, report: unknown): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
}

async function sampleOnly(a: Map<string, string>): Promise<void> {
  const kubeArg = a.get('kube');
  const pid = a.get('pid');
  if (!kubeArg && !pid) fail('--sample-only needs --kube namespace/selector or --pid');
  if (pid && !/^\d+$/.test(pid)) fail('--pid must be a number');
  const kube = kubeArg ? parseKube(kubeArg) : undefined;
  const out = a.get('out') ?? join('load', 'results', `samples-${Date.now()}.json`);
  const sampler = new Sampler({
    metricsUrls: [],
    ...(kube ? { kube } : {}),
    ...(pid ? { pid } : {}),
  });
  const restartsBefore = kube ? await kubeRestarts(kube) : 0;
  sampler.start();
  process.stderr.write('sampling; stop with Ctrl-C when the load run has finished\n');
  await new Promise<void>((resolve) => {
    const duration = Number(a.get('duration') ?? 0);
    if (duration > 0) setTimeout(resolve, duration * 1000);
    process.once('SIGINT', resolve);
  });
  sampler.stop();
  const server: ServerSamples = { ...sampler.samples };
  if (kube) server.restarts = (await kubeRestarts(kube)) - restartsBefore;
  await writeReport(out, { server });
  process.stdout.write(`samples ${JSON.stringify(server)} -> ${out}\n`);
}

async function load(a: Map<string, string>): Promise<void> {
  const lockfile = a.get('lockfile');
  const registry = a.get('registry');
  if (!lockfile || !registry) {
    fail(
      'usage: node load/run.ts --lockfile <pnpm-lock.yaml|package-lock.json> --registry <url> [options]',
    );
  }
  const pid = a.get('pid');
  if (pid && !/^\d+$/.test(pid)) fail('--pid must be a number');
  const kube = a.get('kube') ? parseKube(a.get('kube') ?? '') : undefined;
  const metricsUrls = (a.get('metrics-url') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const label = a.get('label') ?? 'run';
  const packages = parseLockfile(await readFile(lockfile, 'utf8'), lockfile);
  const sampler = new Sampler({ metricsUrls, ...(kube ? { kube } : {}), ...(pid ? { pid } : {}) });

  const before = await scrapeAll(metricsUrls);
  const restartsBefore = kube ? await kubeRestarts(kube) : 0;
  const installs = Number(a.get('installs') ?? 10);
  process.stderr.write(
    `replaying ${packages.length} packages x ${installs} installs against ${registry}\n`,
  );
  sampler.start();
  const token = process.env.LOAD_TOKEN;
  const result = await runLoad({
    registry,
    packages,
    installs,
    concurrency: Number(a.get('concurrency') ?? 16),
    timeoutMs: Number(a.get('timeout') ?? 60_000),
    ...(token ? { token } : {}),
  });
  sampler.stop();

  const server: ServerSamples = { ...sampler.samples };
  if (metricsUrls.length > 0) {
    const after = await scrapeAll(metricsUrls);
    const delta = (name: string, l?: string) =>
      after.reduce((sum, t, i) => sum + promSum(t, name, l) - promSum(before[i] ?? '', name, l), 0);
    server.upstreamFetches = delta('eyniq_cache_upstream_requests_total');
    const served = delta('eyniq_cache_cache_results_total');
    const fromCache =
      delta('eyniq_cache_cache_results_total', 'result="hit"') +
      delta('eyniq_cache_cache_results_total', 'result="coalesced"') +
      delta('eyniq_cache_cache_results_total', 'result="revalidated"');
    server.hitRatio = served > 0 ? Math.round((fromCache / served) * 1000) / 1000 : 0;
  }
  if (kube) server.restarts = (await kubeRestarts(kube)) - restartsBefore;

  const report = { label, packages: packages.length, installs, ...result, server };
  const out =
    a.get('out') ??
    join('load', 'results', `${label}-${result.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeReport(out, report);
  process.stdout.write(
    `${label}: ${result.requests} requests, ${result.rps} req/s, errors ${result.errors}, timeouts ${result.timeouts}, ` +
      `metadata p95 ${result.metadata.p95} ms, tarballs p95 ${result.tarballs.p95} ms -> ${out}\n`,
  );
  process.exit(result.errors + result.timeouts > 0 ? 1 : 0);
}

const a = args();
(a.get('sample-only') === 'true' ? sampleOnly(a) : load(a)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
