// Extract name@version pairs from a lockfile without a YAML dependency: pnpm-lock.yaml
// (v5, v6, v9) and package-lock.json (v1, v2, v3).
import { basename } from 'node:path';

export interface PackageRef {
  name: string;
  version: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseLockfile(text: string, filename: string): PackageRef[] {
  const base = basename(filename);
  if (base.endsWith('.yaml') || base.endsWith('.yml')) return dedupe(parsePnpm(text));
  if (base.endsWith('.json')) return dedupe(parseNpm(text));
  throw new Error(`unsupported lockfile ${base}: use pnpm-lock.yaml or package-lock.json`);
}

function dedupe(refs: PackageRef[]): PackageRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.name}@${r.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One `packages:` key, e.g. `'@babel/core@7.24.0'`, `/react-dom@18.2.0(react@18.2.0)`, `/lodash/4.17.21`. */
function parsePnpmKey(raw: string): PackageRef | null {
  let key = raw.trim().replace(/^['"]|['"]$/g, '');
  if (key.startsWith('/')) key = key.slice(1);
  const paren = key.indexOf('(');
  if (paren !== -1) key = key.slice(0, paren);
  // v5: name/version_peer
  const v5 = /^(@[^/]+\/[^/]+|[^@/][^/]*)\/(\d[^/_]*)/.exec(key);
  if (v5?.[1] && v5[2] && SEMVER.test(v5[2])) return { name: v5[1], version: v5[2] };
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  return SEMVER.test(version) ? { name, version } : null;
}

function parsePnpm(text: string): PackageRef[] {
  const out: PackageRef[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(\S.*):\s*$/.exec(line);
    if (!m?.[1]) continue;
    const ref = parsePnpmKey(m[1]);
    if (ref) out.push(ref);
  }
  return out;
}

interface NpmLock {
  packages?: Record<string, { name?: string; version?: string; link?: boolean }>;
  dependencies?: Record<string, NpmV1Dep>;
}
interface NpmV1Dep {
  version?: string;
  dependencies?: Record<string, NpmV1Dep>;
}

function parseNpm(text: string): PackageRef[] {
  const lock = JSON.parse(text) as NpmLock;
  const out: PackageRef[] = [];
  if (lock.packages) {
    for (const [path, info] of Object.entries(lock.packages)) {
      if (path === '' || info.link || !info.version || !SEMVER.test(info.version)) continue;
      const name =
        info.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ name, version: info.version });
    }
    return out;
  }
  const walk = (deps: Record<string, NpmV1Dep> | undefined): void => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (dep.version && SEMVER.test(dep.version)) out.push({ name, version: dep.version });
      walk(dep.dependencies);
    }
  };
  walk(lock.dependencies);
  return out;
}
