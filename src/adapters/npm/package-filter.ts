// Package filter (Verdaccio @verdaccio/package-filter parity, DESIGN.md section 16): block
// packages by name, scope wildcard or version range, with allow rules that override blocks and
// the minimum release age gate. A JSON rules file (FILTER_RULES_PATH) validated strictly at
// startup. Pure and synchronous like every Policy; names are matched with plain string
// comparison (no regular expressions built from rule text), ranges with range.ts.
//
// File format:
//   { "block": [ { "id"?, "package", "versions"?, "reason"? } ],
//     "allow": [ { "id"?, "package", "versions"?, "reason"? } ] }
// "package" is an exact name, "@scope/*", "prefix*" or "*"; "versions" is an npm range (all
// versions when absent). Dist-tags of filtered versions are repointed by the render step, the
// same as for the age gate: this policy only decides per version.
import { readFileSync, statSync } from 'node:fs';
import type { Policy, PolicyDecision, PolicyInput } from '../../core/contracts.ts';
import { isValidPackageName } from './names.ts';
import { matches, parseRange, type Range } from './range.ts';

export interface FilterRule {
  id: string;
  /** The pattern exactly as written. */
  package: string;
  /** Set for "prefix*" patterns (and "@scope/*"); the empty string for "*". */
  prefix: string | null;
  versions: Range | null;
  reason: string | null;
  /** Position in the file, to pick the first matching rule deterministically. */
  order: number;
}

export interface FilterRules {
  block: FilterRule[];
  allow: FilterRule[];
}

const MAX_RULES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_REASON = 200;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PREFIX = /^@?[A-Za-z0-9._~-]{1,214}(?:\/[A-Za-z0-9._~-]{0,214})?$/;
const RULE_KEYS = new Set(['id', 'package', 'versions', 'reason']);

// Rule names are case-sensitive. Wildcard patterns must be lowercase: new packages and every
// scope are lowercase, and "Foo*" would silently match nothing that npm still publishes.
function parsePattern(pattern: string): string | null | undefined {
  if (pattern === '*') return '';
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return PREFIX.test(prefix) && prefix === prefix.toLowerCase() ? prefix : undefined;
  }
  return isValidPackageName(pattern) ? null : undefined;
}

function parseRule(raw: unknown, kind: 'block' | 'allow', index: number): FilterRule {
  const where = `${kind} rule ${index + 1}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} is not an object`);
  }
  const rule = raw as Record<string, unknown>;
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) throw new Error(`${where}: unknown key ${JSON.stringify(key)}`);
  }
  if (typeof rule.package !== 'string') throw new Error(`${where}: "package" is required`);
  const prefix = parsePattern(rule.package);
  if (prefix === undefined) {
    throw new Error(
      `${where}: invalid "package" (use an exact name, lowercase "@scope/*" or "prefix*", or "*")`,
    );
  }
  let id = `${kind}-${index + 1}`;
  if (rule.id !== undefined) {
    if (typeof rule.id !== 'string' || !ID.test(rule.id)) throw new Error(`${where}: invalid "id"`);
    id = rule.id;
  }
  let versions: Range | null = null;
  if (rule.versions !== undefined) {
    if (typeof rule.versions !== 'string') throw new Error(`${where}: "versions" must be a string`);
    try {
      versions = parseRange(rule.versions);
    } catch (err) {
      throw new Error(
        `${where}: invalid "versions" (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
  }
  let reason: string | null = null;
  if (rule.reason !== undefined) {
    // The reason is printed by npm in a terminal: printable ASCII only.
    if (
      typeof rule.reason !== 'string' ||
      rule.reason.length > MAX_REASON ||
      !/^[\x20-\x7e]*$/.test(rule.reason)
    ) {
      throw new Error(`${where}: invalid "reason" (printable ASCII, at most ${MAX_REASON} chars)`);
    }
    reason = rule.reason === '' ? null : rule.reason;
  }
  return { id, package: rule.package, prefix, versions, reason, order: index };
}

export function parseFilterRules(text: string): FilterRules {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('filter rules are not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('filter rules must be a JSON object');
  }
  const doc = data as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (key !== 'block' && key !== 'allow') {
      throw new Error(`unknown key ${JSON.stringify(key)} (expected "block" and "allow")`);
    }
  }
  const out: FilterRules = { block: [], allow: [] };
  const seen = new Set<string>();
  let total = 0;
  for (const kind of ['block', 'allow'] as const) {
    const list = doc[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`"${kind}" must be an array`);
    total += list.length;
    if (total > MAX_RULES) throw new Error(`too many rules (at most ${MAX_RULES})`);
    list.forEach((raw: unknown, i) => {
      const rule = parseRule(raw, kind, i);
      if (seen.has(rule.id)) throw new Error(`duplicate rule id ${JSON.stringify(rule.id)}`);
      seen.add(rule.id);
      out[kind].push(rule);
    });
  }
  return out;
}

export function loadFilterRules(path: string): FilterRules {
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error('filter rules file is too large');
  return parseFilterRules(readFileSync(path, 'utf8'));
}

/**
 * Allow rules that disable the age gate for every version of a whole class of packages
 * ("*" or a wildcard without `versions`); logged at startup because that is rarely intended.
 */
export function broadAllowRules(rules: FilterRules): FilterRule[] {
  return rules.allow.filter((r) => r.prefix !== null && r.versions === null);
}

/** Rules indexed by exact name; wildcard rules are checked by prefix. */
class RuleIndex {
  private readonly exact = new Map<string, FilterRule[]>();
  private readonly wildcard: FilterRule[] = [];

  constructor(rules: readonly FilterRule[]) {
    for (const r of rules) {
      if (r.prefix === null) {
        const list = this.exact.get(r.package);
        if (list) list.push(r);
        else this.exact.set(r.package, [r]);
      } else this.wildcard.push(r);
    }
  }

  /** Whether a rule for this name exists; `wholePackage` limits it to rules without `versions`. */
  covers(name: string, wholePackage: boolean): boolean {
    const matchesRule = (r: FilterRule): boolean => !wholePackage || r.versions === null;
    if ((this.exact.get(name) ?? []).some(matchesRule)) return true;
    return this.wildcard.some((r) => name.startsWith(r.prefix as string) && matchesRule(r));
  }

  /**
   * The first rule in file order that matches the name and version, or null. A version outside
   * the version grammar cannot be compared: `unparseable` says whether such a version matches a
   * rule that has a version range (true for block rules, false for allow rules).
   */
  find(name: string, version: string, unparseable: boolean): FilterRule | null {
    const hit = (r: FilterRule): boolean =>
      r.versions === null || (matches(r.versions, version) ?? unparseable);
    let best: FilterRule | null = null;
    for (const r of this.exact.get(name) ?? []) {
      if (hit(r)) {
        best = r;
        break;
      }
    }
    for (const r of this.wildcard) {
      if (best !== null && r.order > best.order) break;
      if (name.startsWith(r.prefix as string) && hit(r)) {
        best = r;
        break;
      }
    }
    return best;
  }
}

function label(kind: string, rule: FilterRule): string {
  return `${kind} "${rule.id}"${rule.reason !== null ? `: ${rule.reason}` : ''}`;
}

export class PackageFilterPolicy implements Policy {
  private readonly block: RuleIndex;
  private readonly allow: RuleIndex;

  constructor(rules: FilterRules) {
    this.block = new RuleIndex(rules.block);
    this.allow = new RuleIndex(rules.allow);
  }

  evaluate(input: PolicyInput): PolicyDecision {
    if (input.ecosystem !== 'npm') return { allow: true };
    const blocked = this.block.find(input.name, input.version, true);
    if (blocked === null) return { allow: true };
    const allowed = this.allow.find(input.name, input.version, false);
    if (allowed !== null) {
      return {
        allow: true,
        allowlisted: true,
        reason: `package filter ${label('allow rule', allowed)}`,
      };
    }
    return { allow: false, reason: `blocked by package filter ${label('rule', blocked)}` };
  }

  /**
   * Whether every version of the package is blocked no matter what, decided from the name
   * alone (no packument): a block rule without `versions` matches and no allow rule could
   * lift any version of it. Lets search hide such packages without fetching metadata.
   */
  blocksWholePackage(ecosystem: string, name: string): boolean {
    return ecosystem === 'npm' && this.block.covers(name, true) && !this.allow.covers(name, false);
  }

  /**
   * The reason of the allow rule that matches this version, or null. The age gate calls it
   * (MinReleaseAgeOptions.exempt) so an allow rule lifts the gate for that version only.
   */
  exemption(input: PolicyInput): string | null {
    if (input.ecosystem !== 'npm') return null;
    const allowed = this.allow.find(input.name, input.version, false);
    return allowed === null ? null : `package filter ${label('allow rule', allowed)}`;
  }
}
