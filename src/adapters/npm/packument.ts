// npm packument processing. processMetadata runs in a worker thread: it parses the full
// document once and pre-serializes every version as a JSON byte fragment. renderMetadata runs
// on the main thread and only concatenates the fragments of allowed versions, so filtering
// (and re-filtering when the age cutoff moves) never parses JSON again.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type {
  ArtifactInfo,
  ArtifactIntegrity,
  ProcessContext,
  ProcessedMetadata,
  RawMetadata,
  RenderInput,
  RenderResult,
  VersionInfo,
} from '../../core/contracts.ts';
import { HttpError } from '../../core/errors.ts';
import { compareVersions, prereleaseChannel } from './semver.ts';
import { isValidPackageName, isValidTarballFile, isValidVersion, unscopedName } from './names.ts';

// The worker loads this module by URL; write-body parsing runs there too.
export { parseWriteBody } from './publish.ts';

export const FULL_CONTENT_TYPE = 'application/json';
export const ABBREVIATED_CONTENT_TYPE = 'application/vnd.npm.install-v1+json';

// Version members kept in the abbreviated ("corgi") document: everything an installer needs.
const ABBREVIATED_FIELDS = [
  'name',
  'version',
  'deprecated',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'acceptDependencies',
  'bin',
  'directories',
  'dist',
  'engines',
  '_hasShrinkwrap',
  'hasInstallScript',
  'cpu',
  'os',
  'libc',
  'funding',
] as const;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/** Adapter-private payload; only typed arrays and plain data so it survives postMessage. */
export interface NpmPayload {
  /** Top-level members except versions, time and dist-tags, serialized without braces. */
  head: string;
  distTags: Record<string, string>;
  /** created / modified from the time map, if present. */
  created: string | null;
  modified: string | null;
  /** Raw publish-time strings per version, as upstream sent them. */
  times: Record<string, string>;
  /** Full version documents; start/end pairs in the order of ProcessedMetadata.versions. */
  full: Uint8Array;
  fullOffsets: Uint32Array;
  /** Abbreviated version documents, same layout. */
  abbreviated: Uint8Array;
  abbreviatedOffsets: Uint32Array;
  /** Add the filtered time map to abbreviated documents (ABBREVIATED_INCLUDE_TIME). */
  includeTime: boolean;
}

const tooLarge = (): HttpError =>
  new HttpError(502, 'upstream packument exceeds MAX_PACKUMENT_BYTES');
const invalid = (why: string): HttpError =>
  new HttpError(502, `invalid upstream packument: ${why}`);

function decode(raw: RawMetadata, maxBytes: number): string {
  if (raw.encoding === 'gzip') {
    try {
      return gunzipSync(raw.body, { maxOutputLength: maxBytes }).toString('utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
      throw invalid('bad gzip data');
    }
  }
  if (raw.body.length > maxBytes) throw tooLarge();
  return raw.body.toString('utf8');
}

// Only strict ISO-8601 with an explicit zone counts as a publish time. Date.parse also accepts
// '2020', '1' or 'Jan 1 2000', which would turn an unknown time into an old, allowed one.
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

function parsePublishTime(value: string): number {
  return ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// When dist.integrity is present it is authoritative: an unparseable value never silently
// downgrades to the legacy sha1 shasum. The shasum is only used by old packages that have no
// integrity field at all (DESIGN.md section 5).
export function parseIntegrity(dist: Record<string, unknown>): ArtifactIntegrity | null {
  if (dist.integrity !== undefined) {
    if (typeof dist.integrity !== 'string') return null;
    let sha1: ArtifactIntegrity | null = null;
    for (const token of dist.integrity.trim().split(/\s+/)) {
      const dash = token.indexOf('-');
      const algo = token.slice(0, dash);
      const hex = Buffer.from(token.slice(dash + 1), 'base64').toString('hex');
      if (algo === 'sha512' && hex.length === 128) return { algorithm: 'sha512', hex };
      if (algo === 'sha1' && hex.length === 40) sha1 = { algorithm: 'sha1', hex };
    }
    return sha1;
  }
  if (typeof dist.shasum === 'string' && /^[0-9a-fA-F]{40}$/.test(dist.shasum)) {
    return { algorithm: 'sha1', hex: dist.shasum.toLowerCase() };
  }
  return null;
}

/** File name from the registry URL; the host and path are deliberately ignored. */
function tarballFile(name: string, version: string, dist: Record<string, unknown>): string {
  if (typeof dist.tarball === 'string') {
    const last = dist.tarball.slice(dist.tarball.lastIndexOf('/') + 1);
    let file = last;
    try {
      file = decodeURIComponent(last);
    } catch {
      // fall through to the conventional name
    }
    // The file must belong to this version, so a hostile document cannot map one version's
    // tarball request onto another version (and its policy decision).
    if (isValidTarballFile(file) && file.endsWith(`-${version}.tgz`)) return file;
  }
  return `${unscopedName(name)}-${version}.tgz`;
}

export function processMetadata(raw: RawMetadata, ctx: ProcessContext): ProcessedMetadata {
  const text = decode(raw, ctx.maxBytes);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  if (!isRecord(doc)) throw invalid('not an object');
  // The document must describe exactly the requested, validated name: `name` ends up in the
  // upstream tarball path and in every rewritten tarball URL.
  if (doc.name !== ctx.name || !isValidPackageName(ctx.name)) {
    throw invalid('name does not match the requested package');
  }
  const name = ctx.name;
  const versionsObj = doc.versions ?? {};
  if (!isRecord(versionsObj)) throw invalid('versions is not an object');
  const timeObj = isRecord(doc.time) ? doc.time : {};
  const tagsObj = isRecord(doc['dist-tags']) ? doc['dist-tags'] : {};

  const versions: VersionInfo[] = [];
  const fragments: Buffer[] = [];
  const times: Record<string, string> = {};
  const abbreviatedFragments: Buffer[] = [];
  const files = new Set<string>();
  for (const [version, value] of Object.entries(versionsObj)) {
    if (!isValidVersion(version) || !isRecord(value)) continue;
    const dist = isRecord(value.dist) ? value.dist : {};
    const file = tarballFile(name, version, dist);
    // Ambiguous file names (e.g. 1.0.0 and 1.0.0+build) would map one request to two versions.
    if (files.has(file)) continue;
    files.add(file);
    const artifact: ArtifactInfo = {
      file,
      upstreamPath: `/${name}/-/${file}`,
      integrity: parseIntegrity(dist),
    };
    // Every served tarball URL points at the cache, never at the upstream or a foreign host.
    value.dist = { ...dist, tarball: `${ctx.publicBaseUrl}/${name}/-/${file}` };
    const rawTime = timeObj[version];
    const parsed = typeof rawTime === 'string' ? parsePublishTime(rawTime) : Number.NaN;
    if (typeof rawTime === 'string') times[version] = rawTime;
    versions.push({
      version,
      publishedAt: Number.isNaN(parsed) ? null : parsed,
      artifact,
      facts: versionFacts(value, dist),
    });
    fragments.push(Buffer.from(JSON.stringify(value)));
    abbreviatedFragments.push(Buffer.from(JSON.stringify(abbreviate(value))));
  }

  addHistoryFacts(versions);

  const distTags: Record<string, string> = {};
  for (const [tag, target] of Object.entries(tagsObj)) {
    if (typeof target === 'string') distTags[tag] = target;
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== 'versions' && k !== 'time' && k !== 'dist-tags') rest[k] = v;
  }
  const head = JSON.stringify(rest).slice(1, -1);

  const [full, fullOffsets] = pack(fragments);
  const [abbreviated, abbreviatedOffsets] = pack(abbreviatedFragments);

  const payload: NpmPayload = {
    head,
    distTags,
    created: typeof timeObj.created === 'string' ? timeObj.created : null,
    modified: typeof timeObj.modified === 'string' ? timeObj.modified : null,
    times,
    full,
    fullOffsets,
    abbreviated,
    abbreviatedOffsets,
    includeTime: ctx.options.abbreviatedIncludeTime === true,
  };
  return {
    name,
    // Hash the decoded document: gzip bytes differ between upstream, CDN and our stored copy,
    // and ETags must stay stable across pods and restarts.
    digest: createHash('sha256').update(text).digest('hex'),
    versions,
    payload,
    byteSize:
      full.length +
      abbreviated.length +
      head.length * 2 +
      versions.length * 512 +
      fullOffsets.byteLength * 2,
  };
}

/**
 * Facts for policies (VersionFacts), read before the document is rewritten. Values are what
 * the registry published; for upstream packages the registry sets _npmUser and dist
 * attestations/signatures, for local ones the PackageSource does (clients cannot, see
 * publish.ts).
 */
function versionFacts(
  value: Record<string, unknown>,
  dist: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const npmUser = isRecord(value._npmUser) ? value._npmUser : {};
  const license = isRecord(value.license) ? value.license.type : value.license;
  const scripts = isRecord(value.scripts) ? value.scripts : {};
  return {
    publisher: typeof npmUser.name === 'string' ? npmUser.name : null,
    maintainers: Array.isArray(value.maintainers) ? value.maintainers.length : 0,
    hasInstallScript:
      value.hasInstallScript === true ||
      INSTALL_SCRIPTS.some((s) => typeof scripts[s] === 'string'),
    license: typeof license === 'string' ? license : null,
    deprecated: typeof value.deprecated === 'string' && value.deprecated.length > 0,
    hasAttestations: isRecord(dist.attestations),
    hasSignatures: Array.isArray(dist.signatures) && dist.signatures.length > 0,
  };
}

/**
 * Facts that need the whole version history (a Policy sees one version at a time):
 *   previousPublisher   publisher of the closest earlier version by semver precedence; null
 *                       when there is none or it has no known publisher
 *   publisherFirstSeen  publish time (epoch ms) of the earliest version by this version's
 *                       publisher; null when the publisher or all of its times are unknown
 * Computed over every version in the document, including ones a policy will block.
 */
function addHistoryFacts(versions: VersionInfo[]): void {
  const publisherOf = (v: VersionInfo): string | null =>
    typeof v.facts?.publisher === 'string' ? v.facts.publisher : null;
  const firstSeen = new Map<string, number>();
  for (const v of versions) {
    const publisher = publisherOf(v);
    if (publisher === null || v.publishedAt === null) continue;
    const seen = firstSeen.get(publisher);
    if (seen === undefined || v.publishedAt < seen) firstSeen.set(publisher, v.publishedAt);
  }
  // Build metadata does not count for precedence (1.0.0+a equals 1.0.0+b): break ties by the
  // version string so the order never depends on the document's key order.
  const ordered = [...versions].sort(
    (a, b) =>
      compareVersions(a.version, b.version) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
  let previous: string | null = null;
  for (const v of ordered) {
    const publisher = publisherOf(v);
    v.facts = {
      ...v.facts,
      previousPublisher: previous,
      publisherFirstSeen: publisher === null ? null : (firstSeen.get(publisher) ?? null),
    };
    previous = publisher;
  }
}

function abbreviate(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ABBREVIATED_FIELDS) {
    if (value[field] !== undefined) out[field] = value[field];
  }
  // The registry computes this for newer versions; derive it for older documents.
  const scripts = isRecord(value.scripts) ? value.scripts : {};
  if (out.hasInstallScript === undefined && INSTALL_SCRIPTS.some((s) => s in scripts)) {
    out.hasInstallScript = true;
  }
  return out;
}

/**
 * Concatenate fragments into one buffer plus start/end offsets. The buffer gets its own
 * ArrayBuffer: small Buffers share Node's 8 KB pool, which postMessage would copy whole.
 */
function pack(fragments: Buffer[]): [Uint8Array, Uint32Array] {
  const bytes = new Uint8Array(Buffer.concat(fragments));
  const offsets = new Uint32Array(fragments.length * 2);
  let offset = 0;
  fragments.forEach((f, i) => {
    offsets[i * 2] = offset;
    offset += f.length;
    offsets[i * 2 + 1] = offset;
  });
  return [bytes, offsets];
}

function slice(bytes: Uint8Array, offsets: Uint32Array, i: number): Buffer {
  const start = offsets[i * 2] ?? 0;
  const end = offsets[i * 2 + 1] ?? 0;
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start);
}

/**
 * The version a dist-tag (or search result) pointing at `target` shows once filtering removed
 * it: the newest allowed version of the same prerelease channel (stable never moves to a
 * prerelease), or null when there is none. An allowed target stays.
 */
export function repointVersion(
  processed: ProcessedMetadata,
  allowed: ReadonlySet<string>,
  target: string,
): string | null {
  if (allowed.has(target)) return target;
  const channel = prereleaseChannel(target);
  let best: string | null = null;
  for (const v of processed.versions) {
    if (!allowed.has(v.version) || prereleaseChannel(v.version) !== channel) continue;
    if (best === null || compareVersions(v.version, best) > 0) best = v.version;
  }
  return best;
}

/**
 * dist-tags after filtering (DESIGN.md section 8): a tag whose version was removed is
 * repointed (repointVersion); without such a version the tag is dropped.
 */
function filterTags(input: RenderInput): Record<string, string> {
  const p = input.processed.payload as NpmPayload;
  const tags: Record<string, string> = {};
  for (const [tag, target] of Object.entries(p.distTags)) {
    const version = repointVersion(input.processed, input.allowed, target);
    if (version !== null) tags[tag] = version;
  }
  return tags;
}

function filteredTime(input: RenderInput, withCreated: boolean): Record<string, string> {
  const p = input.processed.payload as NpmPayload;
  const time: Record<string, string> = {};
  if (withCreated && p.created !== null) time.created = p.created;
  if (p.modified !== null) time.modified = p.modified;
  for (const v of input.processed.versions) {
    const t = p.times[v.version];
    if (t !== undefined && input.allowed.has(v.version)) time[v.version] = t;
  }
  return time;
}

/** Appends `"v":{...},...` for every allowed version. */
function pushVersions(
  parts: Buffer[],
  input: RenderInput,
  bytes: Uint8Array,
  offsets: Uint32Array,
): void {
  let first = true;
  input.processed.versions.forEach((v, i) => {
    if (!input.allowed.has(v.version)) return;
    parts.push(Buffer.from(`${first ? '' : ','}${JSON.stringify(v.version)}:`));
    parts.push(slice(bytes, offsets, i));
    first = false;
  });
}

function renderFull(input: RenderInput): Buffer {
  const p = input.processed.payload as NpmPayload;
  const parts: Buffer[] = [Buffer.from(p.head ? `{${p.head},` : '{')];
  parts.push(Buffer.from(`"dist-tags":${JSON.stringify(filterTags(input))},"versions":{`));
  pushVersions(parts, input, p.full, p.fullOffsets);
  parts.push(Buffer.from(`},"time":${JSON.stringify(filteredTime(input, true))}}`));
  return Buffer.concat(parts);
}

function renderAbbreviated(input: RenderInput): Buffer {
  const p = input.processed.payload as NpmPayload;
  const modified = p.modified !== null ? `"modified":${JSON.stringify(p.modified)},` : '';
  const parts: Buffer[] = [
    Buffer.from(
      `{"name":${JSON.stringify(input.processed.name)},${modified}"dist-tags":${JSON.stringify(filterTags(input))},"versions":{`,
    ),
  ];
  pushVersions(parts, input, p.abbreviated, p.abbreviatedOffsets);
  // ABBREVIATED_INCLUDE_TIME: lets pnpm's minimumReleaseAge skip a second, full request.
  const time = p.includeTime ? `,"time":${JSON.stringify(filteredTime(input, true))}` : '';
  parts.push(Buffer.from(`}${time}}`));
  return Buffer.concat(parts);
}

function renderVersion(input: RenderInput): RenderResult {
  const p = input.processed.payload as NpmPayload;
  const ref = input.ref ?? '';
  const target = filterTags(input)[ref] ?? ref;
  const i = input.processed.versions.findIndex((v) => v.version === target);
  if (i === -1 || !input.allowed.has(target)) return { status: 404, error: 'version not found' };
  return { status: 200, body: slice(p.full, p.fullOffsets, i), contentType: FULL_CONTENT_TYPE };
}

export function renderMetadata(input: RenderInput): RenderResult {
  const { versions } = input.processed;
  if (versions.length > 0 && !versions.some((v) => input.allowed.has(v.version))) {
    return {
      status: 404,
      error: 'no version of this package is allowed by policy (minimum release age)',
    };
  }
  switch (input.view) {
    case 'full':
      return { status: 200, body: renderFull(input), contentType: FULL_CONTENT_TYPE };
    case 'abbreviated':
      return { status: 200, body: renderAbbreviated(input), contentType: ABBREVIATED_CONTENT_TYPE };
    case 'version':
      return renderVersion(input);
    case 'dist-tags':
      return {
        status: 200,
        body: Buffer.from(JSON.stringify(filterTags(input))),
        contentType: FULL_CONTENT_TYPE,
      };
    default:
      return { status: 404, error: 'unknown metadata view' };
  }
}
