// npm version ranges for the package filter: comparators, x-ranges, caret, tilde, hyphen ranges
// and `||`. Matching includes prereleases on purpose: a rule that blocks ">=1.0.0 <2.0.0" also
// blocks 1.5.0-beta.1 (npm's install resolution would skip prereleases, but a block list must
// not). Unknown syntax throws instead of guessing. Parsing is bounded in length and size and
// uses no backtracking-prone patterns (every quantifier is bounded), so a hostile rules file
// cannot stall startup and evaluation is plain comparisons.

// Numbers are bigints: the version grammar (isValidVersion) allows numeric parts of any length
// up to the 256-character cap, and a comparison must stay total over that whole grammar.
interface Version {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: ReadonlyArray<string | bigint>;
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: Version;
}

/** OR of ANDs; an empty AND matches every version, including ones that are not semver. */
export type Range = ReadonlyArray<readonly Comparator[]>;

const MAX_LENGTH = 1024;
const MAX_SETS = 32;
const MAX_TOKENS = 16;

// Same grammar as isValidVersion (names.ts): leading zeros and long identifiers are accepted
// (a block rule must still see them); only the total length is capped. Every repetition is
// separated by a literal ".", "-" or "+", so matching is linear.
const NUM = '0|[1-9]\\d*';
const ID = '[0-9A-Za-z-]+';
const PRE = `${ID}(?:\\.${ID})*`;
const BUILD = PRE;
const MAX_VERSION_LENGTH = 256;
const VERSION = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}))?(?:\\+${BUILD})?$`);
const XR = '(?:x|X|\\*|0|[1-9]\\d*)';
const PARTIAL = new RegExp(`^(${XR})(?:\\.(${XR})(?:\\.(${XR})(?:-(${PRE}))?(?:\\+${BUILD})?)?)?$`);

function ids(pre: string): Array<string | bigint> {
  return pre.split('.').map((id) => (/^\d+$/.test(id) ? BigInt(id) : id));
}

function parseVersion(text: string): Version | null {
  if (text.length > MAX_VERSION_LENGTH) return null;
  const m = VERSION.exec(text);
  if (!m) return null;
  return {
    major: BigInt(m[1] as string),
    minor: BigInt(m[2] as string),
    patch: BigInt(m[3] as string),
    prerelease: m[4] ? ids(m[4]) : [],
  };
}

const cmpNum = <T extends number | bigint>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

function compare(a: Version, b: Version): number {
  const core = cmpNum(a.major, b.major) || cmpNum(a.minor, b.minor) || cmpNum(a.patch, b.patch);
  if (core !== 0) return core;
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (pa.length === 0 || pb.length === 0) return cmpNum(pb.length, pa.length);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'bigint' && typeof y === 'bigint') return cmpNum(x, y);
    if (typeof x === 'bigint') return -1;
    if (typeof y === 'bigint') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

interface Partial {
  major: bigint | null;
  minor: bigint | null;
  patch: bigint | null;
  prerelease: ReadonlyArray<string | bigint>;
}

function parsePartial(text: string): Partial {
  const m = PARTIAL.exec(text.length > MAX_VERSION_LENGTH ? '' : text);
  if (!m) throw new Error(`invalid version in range: ${JSON.stringify(text.slice(0, 40))}`);
  const n = (s: string | undefined): bigint | null =>
    s === undefined || s === 'x' || s === 'X' || s === '*' ? null : BigInt(s);
  const major = n(m[1]);
  const minor = major === null ? null : n(m[2]);
  const patch = minor === null ? null : n(m[3]);
  return { major, minor, patch, prerelease: patch !== null && m[4] ? ids(m[4]) : [] };
}

const ver = (
  major: bigint,
  minor: bigint,
  patch: bigint,
  pre: ReadonlyArray<string | bigint> = [],
): Version => ({ major, minor, patch, prerelease: pre });

/** The smallest version of a release line: x.y.z-0 sorts before every other prerelease. */
const floor = (major: bigint, minor: bigint, patch: bigint): Version =>
  ver(major, minor, patch, [0n]);

const lower = (p: Partial): Version =>
  ver(p.major ?? 0n, p.minor ?? 0n, p.patch ?? 0n, p.prerelease);

/** A bare (or `=`) partial version is an x-range. */
function xRange(p: Partial): Comparator[] {
  if (p.major === null) return [];
  if (p.minor === null) {
    return [
      { op: '>=', v: lower(p) },
      { op: '<', v: floor(p.major + 1n, 0n, 0n) },
    ];
  }
  if (p.patch === null) {
    return [
      { op: '>=', v: lower(p) },
      { op: '<', v: floor(p.major, p.minor + 1n, 0n) },
    ];
  }
  return [{ op: '=', v: lower(p) }];
}

function primitive(op: Op, p: Partial): Comparator[] {
  if (op === '=') return xRange(p);
  if (p.major === null) {
    // ">=*" and "<=*" match everything; ">*" and "<*" match nothing.
    return op === '>=' || op === '<=' ? [] : [{ op: '<', v: floor(0n, 0n, 0n) }];
  }
  if (p.minor !== null && p.patch !== null) return [{ op, v: lower(p) }];
  const nextLine =
    p.minor === null ? floor(p.major + 1n, 0n, 0n) : floor(p.major, p.minor + 1n, 0n);
  switch (op) {
    case '>=':
      return [{ op: '>=', v: lower(p) }];
    case '>':
      return [{ op: '>=', v: nextLine }];
    case '<':
      return [{ op: '<', v: floor(p.major, p.minor ?? 0n, 0n) }];
    case '<=':
      return [{ op: '<', v: nextLine }];
  }
}

function caret(p: Partial): Comparator[] {
  if (p.major === null) return [];
  let hi: Version;
  if (p.major > 0n || p.minor === null) hi = floor(p.major + 1n, 0n, 0n);
  else if (p.minor > 0n || p.patch === null) hi = floor(0n, p.minor + 1n, 0n);
  else hi = floor(0n, 0n, p.patch + 1n);
  return [
    { op: '>=', v: lower(p) },
    { op: '<', v: hi },
  ];
}

function tilde(p: Partial): Comparator[] {
  if (p.major === null) return [];
  const hi = p.minor === null ? floor(p.major + 1n, 0n, 0n) : floor(p.major, p.minor + 1n, 0n);
  return [
    { op: '>=', v: lower(p) },
    { op: '<', v: hi },
  ];
}

function hyphenUpper(p: Partial): Comparator[] {
  if (p.major === null) return [];
  if (p.minor === null) return [{ op: '<', v: floor(p.major + 1n, 0n, 0n) }];
  if (p.patch === null) return [{ op: '<', v: floor(p.major, p.minor + 1n, 0n) }];
  return [{ op: '<=', v: lower(p) }];
}

const OPERATORS = new Set(['<', '<=', '>', '>=', '=', '^', '~']);
const PREFIXES = ['<=', '>=', '<', '>', '=', '^', '~'] as const;

function parseSet(text: string): Comparator[] {
  const raw = text.trim().split(/\s+/);
  if (raw.length === 1 && raw[0] === '') return [];
  if (raw.length > MAX_TOKENS) throw new Error('range has too many comparators');
  // "> 1.2.3" style spacing between an operator and its version is joined first.
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] ?? '';
    const next = raw[i + 1];
    if (OPERATORS.has(t) && next !== undefined) {
      tokens.push(t + next);
      i++;
    } else tokens.push(t);
  }
  if (tokens.includes('-')) {
    if (tokens.length !== 3 || tokens[1] !== '-') throw new Error('invalid hyphen range');
    const lo = parsePartial(tokens[0] as string);
    return [
      ...(lo.major === null ? [] : [{ op: '>=' as const, v: lower(lo) }]),
      ...hyphenUpper(parsePartial(tokens[2] as string)),
    ];
  }
  const out: Comparator[] = [];
  for (const token of tokens) {
    const prefix = PREFIXES.find((p) => token.startsWith(p));
    const rest = prefix ? token.slice(prefix.length) : token;
    const p = parsePartial(rest.startsWith('v') ? rest.slice(1) : rest);
    if (prefix === '^') out.push(...caret(p));
    else if (prefix === '~') out.push(...tilde(p));
    else out.push(...primitive(prefix ?? '=', p));
  }
  return out;
}

/** Parses an npm range; throws an Error naming the problem for anything it does not know. */
export function parseRange(text: string): Range {
  if (text.length > MAX_LENGTH) throw new Error('range too long');
  const sets = text.split('||');
  if (sets.length > MAX_SETS) throw new Error('range has too many alternatives');
  // "1.0.0 ||" would otherwise be an empty alternative, which matches everything.
  if (sets.length > 1 && sets.some((set) => set.trim() === '')) {
    throw new Error('range has an empty alternative around "||"');
  }
  return sets.map(parseSet);
}

function holds(c: Comparator, v: Version): boolean {
  const d = compare(v, c.v);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '=':
      return d === 0;
  }
}

/**
 * Whether `version` is in the range (prereleases count); null when the version is outside the
 * version grammar and cannot be compared at all. Callers choose the safe side: block rules treat
 * null as a match, allow rules as no match.
 */
export function matches(range: Range, version: string): boolean | null {
  if (range.some((set) => set.length === 0)) return true;
  const v = parseVersion(version);
  if (v === null) return null;
  return range.some((set) => set.every((c) => holds(c, v)));
}

/** Whether `version` is in the range; prereleases count, unparseable versions do not. */
export function satisfies(range: Range, version: string): boolean {
  return matches(range, version) === true;
}
