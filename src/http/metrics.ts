// Prometheus text exposition (format 0.0.4), hand-written: no client library dependency.
import { METRICS_PREFIX } from '../constants.ts';
import type { MetricsCounter, MetricsRegistry } from '../core/contracts.ts';

type Labels = Record<string, string>;

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
/** Series an extension counter may create; more would let label values grow the heap. */
const MAX_CUSTOM_SERIES = 1000;

function labelKey(labels: Labels): string {
  // Invalid label names (possible from extensions) are dropped instead of breaking the scrape.
  const entries = Object.entries(labels).filter(([k]) => LABEL_NAME.test(k));
  if (entries.length === 0) return '';
  const escaped = entries.map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return `{${escaped.join(',')}}`;
}

/** HELP text is one exposition line: a newline would inject a sample. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

interface Family {
  render(): string;
}

export class Counter implements Family {
  private readonly values = new Map<string, number>();
  private readonly labelSets = new Map<string, Labels>();
  private readonly name: string;
  private readonly help: string;

  constructor(name: string, help: string) {
    this.name = `${METRICS_PREFIX}${name}`;
    this.help = help;
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const current = this.values.get(key);
    if (current === undefined) this.labelSets.set(key, labels);
    this.values.set(key, (current ?? 0) + by);
  }

  /** Current value per label set (for the stats history; the hot path is unchanged). */
  entries(): Array<[Labels, number]> {
    return [...this.values].map(([key, v]) => [this.labelSets.get(key) ?? {}, v]);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, v] of this.values) lines.push(`${this.name}${key} ${v}`);
    return lines.join('\n');
  }
}

/** A value read at scrape time: a gauge, or a counter owned by another component. */
export class Gauge implements Family {
  private readonly name: string;
  private readonly help: string;
  private readonly type: 'gauge' | 'counter';
  private readonly read: () => Array<[Labels, number]>;

  constructor(
    name: string,
    help: string,
    read: () => number | Array<[Labels, number]>,
    type: 'gauge' | 'counter' = 'gauge',
  ) {
    this.name = `${METRICS_PREFIX}${name}`;
    this.help = help;
    this.type = type;
    this.read = () => {
      const v = read();
      return typeof v === 'number' ? [[{}, v]] : v;
    };
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    let samples: Array<[Labels, number]> = [];
    try {
      samples = this.read();
    } catch {
      // One failing reader (e.g. an extension's) must not fail the whole scrape.
    }
    for (const [labels, v] of samples) lines.push(`${this.name}${labelKey(labels)} ${v}`);
    return lines.join('\n');
  }
}

export class Histogram implements Family {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  private readonly name: string;
  private readonly help: string;
  private readonly buckets: number[];

  constructor(name: string, help: string, buckets: number[]) {
    this.name = `${METRICS_PREFIX}${name}`;
    this.help = help;
    this.buckets = buckets;
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count++;
  }

  /** Cumulative bucket counts per label set (for the stats history). */
  snapshot(): {
    bounds: number[];
    series: Array<{ labels: Labels; counts: number[]; count: number }>;
  } {
    return {
      bounds: [...this.buckets],
      series: [...this.series.values()].map((s) => ({
        labels: s.labels,
        counts: [...s.counts],
        count: s.count,
      })),
    };
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const all =
      this.series.size > 0
        ? [...this.series.values()]
        : [{ labels: {}, counts: this.buckets.map(() => 0), sum: 0, count: 0 }];
    for (const s of all) {
      this.buckets.forEach((b, i) => {
        lines.push(
          `${this.name}_bucket${labelKey({ ...s.labels, le: String(b) })} ${s.counts[i] ?? 0}`,
        );
      });
      lines.push(`${this.name}_bucket${labelKey({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${labelKey(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${labelKey(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

const WRITE_BUCKETS = [0.01, 0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120];
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** All metrics of DESIGN.md section 9. Gauges are wired up by the server at startup. */
export class Metrics implements MetricsRegistry {
  readonly requests = new Counter('http_requests_total', 'HTTP requests by route and status.');
  readonly requestDuration = new Histogram(
    'http_request_duration_seconds',
    'HTTP request duration by route.',
    LATENCY_BUCKETS,
  );
  readonly cacheResults = new Counter(
    'cache_results_total',
    'Cache results (hit, miss, stale, coalesced, ...).',
  );
  readonly coalescedWaiters = new Counter(
    'coalesced_waiters_total',
    'Requests that joined an in-flight upstream fetch.',
  );
  readonly metadataOverloaded = new Counter(
    'metadata_overloaded_total',
    'Metadata lookups refused with 503 because the worker pool queue was full.',
  );
  readonly upstreamRequests = new Counter(
    'upstream_requests_total',
    'Requests sent to the upstream registry.',
  );
  readonly upstreamErrors = new Counter(
    'upstream_errors_total',
    'Upstream requests that failed or returned 5xx.',
  );
  readonly upstreamDuration = new Histogram(
    'upstream_request_duration_seconds',
    'Time to upstream response headers.',
    LATENCY_BUCKETS,
  );
  readonly blockedVersions = new Counter(
    'blocked_versions_total',
    'Artifact requests refused by policy.',
  );
  readonly tarballBytes = new Counter(
    'tarball_bytes_served_total',
    'Artifact bytes sent to clients.',
  );
  readonly storageWriteDuration = new Histogram(
    'storage_write_duration_seconds',
    'Duration of one background storage write attempt by kind (metadata, meta, index, tarball).',
    WRITE_BUCKETS,
  );
  readonly storageWriteFailures = new Counter(
    'storage_write_failures_total',
    'Background storage writes that failed for good, by kind and reason (timeout, error).',
  );
  readonly storageWritesDropped = new Counter(
    'storage_writes_dropped_total',
    'Background storage writes dropped because the write queue was full, by kind.',
  );
  readonly storageWriteRetries = new Counter(
    'storage_write_retries_total',
    'Background storage writes repeated once after a timeout, by kind.',
  );
  private readonly gauges: Gauge[] = [];
  private readonly custom: Counter[] = [];
  /** Built-in families above; extensions cannot register these names again. */
  private readonly names = new Set<string>([
    'http_requests_total',
    'http_request_duration_seconds',
    'cache_results_total',
    'coalesced_waiters_total',
    'upstream_requests_total',
    'upstream_errors_total',
    'upstream_request_duration_seconds',
    'blocked_versions_total',
    'tarball_bytes_served_total',
    'storage_write_duration_seconds',
    'storage_write_failures_total',
    'storage_writes_dropped_total',
    'storage_write_retries_total',
  ]);

  /** Counter owned by an extension (MetricsRegistry): increments are checked and bounded. */
  counter(name: string, help: string): MetricsCounter {
    this.claim(name);
    const c = new Counter(name, oneLine(help));
    this.custom.push(c);
    const series = new Set<string>();
    return {
      inc(labels: Labels = {}, by = 1): void {
        if (!Number.isFinite(by) || by < 0) return;
        const key = labelKey(labels);
        if (!series.has(key)) {
          if (series.size >= MAX_CUSTOM_SERIES) return;
          series.add(key);
        }
        c.inc(labels, by);
      },
    };
  }

  /**
   * Metric names are unprefixed, lowercase snake case, registered once, and never end in a
   * histogram series suffix (they would collide with an existing histogram's lines).
   */
  private claim(name: string): void {
    if (!/^[a-z_][a-z0-9_]{0,99}$/.test(name) || /_(bucket|sum|count)$/.test(name)) {
      throw new Error(`invalid metric name ${name}`);
    }
    if (this.names.has(name)) throw new Error(`metric ${name} is already registered`);
    this.names.add(name);
  }

  gauge(
    name: string,
    help: string,
    read: () => number | Array<[Labels, number]>,
    type: 'gauge' | 'counter' = 'gauge',
  ): void {
    this.claim(name);
    this.gauges.push(new Gauge(name, oneLine(help), read, type));
  }

  render(): string {
    const families: Family[] = [
      this.requests,
      this.requestDuration,
      this.cacheResults,
      this.coalescedWaiters,
      this.metadataOverloaded,
      this.upstreamRequests,
      this.upstreamErrors,
      this.upstreamDuration,
      this.blockedVersions,
      this.tarballBytes,
      this.storageWriteDuration,
      this.storageWriteFailures,
      this.storageWritesDropped,
      this.storageWriteRetries,
      ...this.gauges,
      ...this.custom,
    ];
    return `${families.map((f) => f.render()).join('\n')}\n`;
  }
}
