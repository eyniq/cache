// npm side of the read-only web catalog (C5): turns a processed packument into the generic
// CatalogPackage. Runs on the main thread per catalog request, bounded: package-level fields
// come from the pre-serialized head (parsed only up to MAX_HEAD_BYTES), and only the one
// detailed version's fragment is parsed. Links are reduced to absolute http(s) URLs without
// credentials (repository shorthands and git URLs are normalized to https); everything else is
// plain text that the client renders as text.
import type {
  CatalogInput,
  CatalogPackage,
  CatalogProtocol,
  CatalogSearchResult,
  CatalogVersion,
  CatalogVersionDetail,
} from '../../core/contracts.ts';
import type { NpmPayload } from './packument.ts';
import { repointVersion } from './packument.ts';
import { isValidPackageName } from './names.ts';
import { compareVersions } from './semver.ts';

const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_FRAGMENT_BYTES = 1024 * 1024;
const MAX_VERSIONS_LISTED = 500;
const MAX_LIST = 50;
const MAX_DEPENDENCIES = 500;
const DEPENDENCY_KINDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
] as const;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, max);
}

function parseObj(bytes: string | Buffer, max: number): Obj {
  if (bytes.length > max) return {};
  try {
    const v: unknown = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** An absolute http(s) URL without credentials, normalized; else undefined. */
export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

/** Repository field (string or { url }) as an https web URL where possible. */
function repositoryUrl(value: unknown): string | undefined {
  const raw = isObj(value) ? value.url : value;
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (shorthand) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[
      (shorthand[1] ?? 'github') as 'github' | 'gitlab' | 'bitbucket'
    ];
    s = `https://${host}/${shorthand[2] ?? ''}/${shorthand[3] ?? ''}`;
  }
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(s);
  if (scp) s = `https://${scp[1] ?? ''}/${scp[2] ?? ''}`;
  s = s
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://');
  const url = safeHttpUrl(s);
  return url?.replace(/\.git$/, '');
}

function bugsUrl(value: unknown): string | undefined {
  return safeHttpUrl(isObj(value) ? value.url : value);
}

function license(value: unknown): string | undefined {
  return text(isObj(value) ? value.type : value, 200);
}

function maintainerName(value: unknown): string | undefined {
  if (isObj(value)) return text(value.name, 100);
  // "Name <email> (url)" strings: keep the name only.
  return text(typeof value === 'string' ? value.replace(/\s*[<(].*$/, '') : undefined, 100);
}

function payloadOf(input: CatalogInput): NpmPayload {
  return input.processed.payload as NpmPayload;
}

function headOf(p: NpmPayload): Obj {
  return p.head.length <= MAX_HEAD_BYTES ? parseObj(`{${p.head}}`, MAX_HEAD_BYTES + 2) : {};
}

function fragment(p: NpmPayload, i: number): Obj {
  const start = p.fullOffsets[i * 2] ?? 0;
  const end = p.fullOffsets[i * 2 + 1] ?? 0;
  if (end - start > MAX_FRAGMENT_BYTES) return {};
  return parseObj(
    Buffer.from(p.full.buffer, p.full.byteOffset + start, end - start),
    MAX_FRAGMENT_BYTES,
  );
}

function servedTags(input: CatalogInput): Array<{ tag: string; version: string }> {
  const tags: Array<{ tag: string; version: string }> = [];
  for (const [tag, target] of Object.entries(payloadOf(input).distTags)) {
    const version = repointVersion(input.processed, input.allowed, target);
    if (version !== null) tags.push({ tag, version });
  }
  return tags.sort((a, b) =>
    a.tag === 'latest' ? -1 : b.tag === 'latest' ? 1 : a.tag.localeCompare(b.tag),
  );
}

function versionEntry(input: CatalogInput, version: string): CatalogVersion {
  const time = payloadOf(input).times[version];
  const blocked = input.blocked.get(version);
  return {
    version,
    ...(time !== undefined && ISO.test(time) ? { published: new Date(time).toISOString() } : {}),
    ...(blocked
      ? {
          blocked: {
            reason: blocked.reason.slice(0, 500),
            ...(blocked.allowedAfter !== undefined
              ? { allowedAfter: new Date(blocked.allowedAfter).toISOString() }
              : {}),
          },
        }
      : {}),
  };
}

function dependencies(manifest: Obj): CatalogVersionDetail['dependencies'] {
  const groups: CatalogVersionDetail['dependencies'] = [];
  for (const kind of DEPENDENCY_KINDS) {
    const deps = manifest[kind];
    if (!isObj(deps)) continue;
    const entries = Object.entries(deps)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .slice(0, MAX_DEPENDENCIES)
      .map(([name, range]) => ({ name: name.slice(0, 214), range: range.slice(0, 200) }));
    if (entries.length > 0) groups.push({ kind, entries });
  }
  return groups;
}

function detail(input: CatalogInput, version: string): CatalogVersionDetail | null {
  const p = payloadOf(input);
  const i = input.processed.versions.findIndex((v) => v.version === version);
  if (i === -1) return null;
  const manifest = fragment(p, i);
  const dist = isObj(manifest.dist) ? manifest.dist : {};
  const user = isObj(manifest._npmUser) ? text(manifest._npmUser.name, 100) : undefined;
  const deprecated = text(manifest.deprecated, 1024);
  const lic = license(manifest.license);
  const url = input.allowed.has(version) ? safeHttpUrl(dist.tarball) : undefined;
  const integrity = text(dist.integrity, 200);
  return {
    ...versionEntry(input, version),
    ...(deprecated !== undefined ? { deprecated } : {}),
    ...(user !== undefined ? { publisher: user } : {}),
    ...(lic !== undefined ? { license: lic } : {}),
    dependencies: dependencies(manifest),
    ...(url !== undefined
      ? { download: { url, ...(integrity !== undefined ? { integrity } : {}) } }
      : {}),
  };
}

function describe(input: CatalogInput): CatalogPackage {
  const name = input.processed.name;
  const head = headOf(payloadOf(input));
  const tags = servedTags(input);
  const ordered = input.processed.versions
    .map((v) => v.version)
    .sort((a, b) => compareVersions(b, a));
  const latestAllowed = ordered.find((v) => input.allowed.has(v));
  const chosen =
    input.version ?? tags.find((t) => t.tag === 'latest')?.version ?? latestAllowed ?? ordered[0];
  const selected = chosen !== undefined ? detail(input, chosen) : null;
  const keywords = Array.isArray(head.keywords)
    ? head.keywords
        .flatMap((k) => (typeof k === 'string' ? [k.slice(0, 100)] : []))
        .slice(0, MAX_LIST)
    : [];
  const maintainers = Array.isArray(head.maintainers)
    ? head.maintainers.flatMap((m) => {
        const n = maintainerName(m);
        return n !== undefined ? [n] : [];
      })
    : [];
  const homepage = safeHttpUrl(head.homepage);
  const repository = repositoryUrl(head.repository);
  const bugs = bugsUrl(head.bugs);
  const description = text(head.description, 2000);
  const lic = license(head.license);
  const installable =
    selected !== null && selected.blocked === undefined && input.allowed.has(selected.version);
  const spec = selected ? `${name}@${selected.version}` : name;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(lic !== undefined ? { license: lic } : {}),
    keywords,
    maintainers: maintainers.slice(0, MAX_LIST),
    links: {
      ...(homepage !== undefined ? { homepage } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(bugs !== undefined ? { bugs } : {}),
    },
    distTags: tags,
    versions: ordered.slice(0, MAX_VERSIONS_LISTED).map((v) => versionEntry(input, v)),
    versionCount: ordered.length,
    selected,
    install: installable
      ? [
          { label: 'npm', command: `npm install ${spec}` },
          { label: 'pnpm', command: `pnpm add ${spec}` },
          { label: 'yarn', command: `yarn add ${spec}` },
        ]
      : [],
  };
}

function readme(input: CatalogInput): string | null {
  const p = payloadOf(input);
  const head = headOf(p);
  const top = typeof head.readme === 'string' ? head.readme : '';
  // The registry writes this placeholder when a publish had no README.
  if (top.trim() !== '' && top !== 'ERROR: No README data found!') return top;
  const latest = repointVersion(input.processed, input.allowed, p.distTags.latest ?? '');
  const i = input.processed.versions.findIndex((v) => v.version === latest);
  if (i === -1) return null;
  const fromVersion = fragment(p, i).readme;
  return typeof fromVersion === 'string' && fromVersion.trim() !== '' ? fromVersion : null;
}

function searchResults(body: Buffer): CatalogSearchResult {
  const doc = parseObj(body, 16 * 1024 * 1024);
  const results: CatalogSearchResult['results'] = [];
  for (const o of Array.isArray(doc.objects) ? doc.objects : []) {
    const pkg = isObj(o) && isObj(o.package) ? o.package : null;
    if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
    if (!isValidPackageName(pkg.name)) continue;
    const description = text(pkg.description, 500);
    const date = typeof pkg.date === 'string' && ISO.test(pkg.date) ? pkg.date : undefined;
    results.push({
      name: pkg.name,
      version: pkg.version.slice(0, 100),
      ...(description !== undefined ? { description } : {}),
      ...(date !== undefined ? { date } : {}),
    });
  }
  const total =
    typeof doc.total === 'number' && Number.isFinite(doc.total) ? doc.total : results.length;
  return { total, results };
}

export const npmCatalog: CatalogProtocol = {
  isValidName: isValidPackageName,
  describe,
  readme,
  searchResults,
};
