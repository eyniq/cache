// Allowlist for the minimum release age gate (DESIGN.md section 8): a JSON array of
// { "package", "version", "reason", "expires" } plus an optional "ecosystem" (adapter id;
// entries without one are npm entries). Expired entries are ignored and reported.
import { readFileSync } from 'node:fs';

export interface AllowlistEntry {
  /** Adapter id the entry applies to; absent means npm. */
  ecosystem?: string;
  package: string;
  version: string;
  reason: string;
  /** Epoch ms; the entry no longer applies from this moment. */
  expires: number;
}

export interface ParsedAllowlist {
  entries: AllowlistEntry[];
  expired: AllowlistEntry[];
}

// Ecosystem-agnostic shape checks (adapters validate names strictly at request time).
const NAME = /^@?[A-Za-z0-9~'!()*-][A-Za-z0-9._~'!()*/-]{0,213}$/;
const EXPIRES = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d))?$/;
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,240}$/;
const ECOSYSTEM = /^[a-z][a-z0-9-]{0,31}$/;
/** Exact versions of other ecosystems (Go `v1.2.3`, PEP 440 `2!1.0.post1`, OCI tags, ...). */
const OTHER_VERSION = /^[A-Za-z0-9_][A-Za-z0-9._+!~-]{0,255}$/;

export function parseAllowlist(text: string, now: number): ParsedAllowlist {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('allowlist is not valid JSON');
  }
  if (!Array.isArray(data)) throw new Error('allowlist must be a JSON array');
  const entries: AllowlistEntry[] = [];
  const expired: AllowlistEntry[] = [];
  data.forEach((raw: unknown, i) => {
    const where = `allowlist entry ${i}`;
    if (typeof raw !== 'object' || raw === null) throw new Error(`${where} is not an object`);
    const { ecosystem, package: pkg, version, reason, expires } = raw as Record<string, unknown>;
    if (ecosystem !== undefined && (typeof ecosystem !== 'string' || !ECOSYSTEM.test(ecosystem))) {
      throw new Error(`${where}: invalid "ecosystem"`);
    }
    const npm = ecosystem === undefined || ecosystem === 'npm';
    // Maven coordinates (group:artifact) are names too; npm names never contain ":".
    const shape = typeof pkg === 'string' && !npm ? pkg.replace(':', '/') : pkg;
    if (
      typeof pkg !== 'string' ||
      typeof shape !== 'string' ||
      !NAME.test(shape) ||
      pkg.includes('..')
    ) {
      throw new Error(`${where}: invalid "package"`);
    }
    if (
      typeof version !== 'string' ||
      !(npm ? VERSION : OTHER_VERSION).test(version) ||
      (!npm && version.includes('..'))
    ) {
      throw new Error(`${where}: invalid "version" (an exact version is required)`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${where}: "reason" is required`);
    }
    // A date means the start of that day in UTC; a timestamp must carry its zone.
    const at =
      typeof expires === 'string' && EXPIRES.test(expires) ? Date.parse(expires) : Number.NaN;
    if (Number.isNaN(at)) {
      throw new Error(
        `${where}: "expires" must be a date like 2026-11-01 or an ISO timestamp with a zone`,
      );
    }
    const entry: AllowlistEntry = {
      ...(ecosystem !== undefined ? { ecosystem } : {}),
      package: pkg,
      version,
      reason,
      expires: at,
    };
    (at > now ? entries : expired).push(entry);
  });
  return { entries, expired };
}

export function loadAllowlist(path: string, now: number): ParsedAllowlist {
  return parseAllowlist(readFileSync(path, 'utf8'), now);
}
