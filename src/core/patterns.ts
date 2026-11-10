// Package name patterns for configuration (owned packages, per-user publish rights): an exact
// name, a prefix ending in "*" (`@acme/*`, `internal-*`) or "*" for everything. Matching is
// plain, case-insensitive string comparison (registries such as npm still serve legacy
// mixed-case names, so a claim on a namespace must cover every spelling); pattern text is
// never turned into a regular expression.

const PATTERN = /^[A-Za-z0-9@/._~:+-]{0,214}\*?$/;

export function isNamePattern(pattern: string): boolean {
  return pattern.length > 0 && PATTERN.test(pattern);
}

export function matchesNamePattern(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  return p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p;
}

export function matchesAnyPattern(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => matchesNamePattern(p, name));
}

/** Comma-separated patterns from configuration; null when one is invalid. */
export function parseNamePatterns(raw: string): string[] | null {
  const patterns = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return patterns.every(isNamePattern) ? patterns : null;
}
