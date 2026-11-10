// Compact text summary of a stats result, for `node dist/main.js stats`.
import type { StatsResult } from './reader.ts';

function bytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function ms(seconds: number): string {
  return `${Math.round(seconds * 1000)} ms`;
}

export function formatSummary(r: StatsResult): string {
  const t = r.totals;
  const lines: string[] = [];
  const when = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16) + 'Z';
  lines.push(`Eyniq Cache statistics, last ${r.range} (${when(r.from)} to ${when(r.to)})`);
  if (r.series.length === 0) {
    lines.push('No statistics recorded in this range.');
    return `${lines.join('\n')}\n`;
  }
  const seconds = Math.max(1, r.to - r.from);
  const errors = Object.entries(t.classes)
    .filter(([c]) => c === '4xx' || c === '5xx')
    .map(([c, n]) => `${n} ${c}`)
    .join(', ');
  lines.push(
    `Requests:        ${t.requests} (${(t.requests / seconds).toFixed(2)}/s average)${errors ? `, of which ${errors}` : ''}`,
  );
  lines.push(
    `Cache hit ratio: ${t.hitRatio === null ? 'n/a' : `${(t.hitRatio * 100).toFixed(1)}%`}` +
      ` (${t.coalesced} coalesced waiters)`,
  );
  lines.push(`Upstream:        ${t.upstreamRequests} fetches, ${t.upstreamErrors} errors`);
  lines.push(`Blocked versions: ${t.blocked}`);
  lines.push(`Tarball traffic: ${bytes(t.bytes)}`);
  lines.push(
    `Latency:         ${t.latency ? `p95 ${ms(t.latency.p95)}, p99 ${ms(t.latency.p99)} (worst pod and route)` : 'n/a'}`,
  );
  lines.push(
    `Memory peak:     ${bytes(t.gauges.rss.max)} resident, ${bytes(t.gauges.heap.max)} heap`,
  );
  lines.push(`Pods:            ${r.pods.length > 0 ? r.pods.join(', ') : 'none'}`);
  if (r.truncated) lines.push('Note: the range was truncated to bound the work.');
  if (r.skipped > 0) lines.push(`Note: ${r.skipped} unreadable objects were skipped.`);
  return `${lines.join('\n')}\n`;
}
