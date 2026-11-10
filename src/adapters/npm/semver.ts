// Just enough semver for dist-tag repointing: precedence (semver 2.0 section 11) and the
// prerelease channel. Build metadata is ignored, as the spec requires.

const PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(v: string): Parsed | null {
  const m = PARTS.exec(v);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = compareIdentifiers(x, y);
    if (d !== 0) return d;
  }
  return 0;
}

/** '' for a stable release, otherwise the first prerelease identifier (beta, rc, canary...). */
export function prereleaseChannel(v: string): string {
  return parse(v)?.pre[0] ?? '';
}
