export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile; 0 for an empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const round = (n: number): number => Math.round(n * 100) / 100;

export function summarize(values: number[]): Summary {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    // reduce, not Math.max(...values): spreading 100k+ samples overflows the call stack.
    max: round(values.reduce((m, v) => (v > m ? v : m), 0)),
    mean: round(values.length ? sum / values.length : 0),
  };
}
