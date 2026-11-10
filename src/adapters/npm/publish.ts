// npm write bodies (publish, unpublish-by-document, dist-tag) parsed into the generic
// WriteBody of src/core/contracts.ts. Runs in a worker thread (bodies reach MAX_PUBLISH_BYTES).
// Everything a client sends is untrusted: names must match the route, artifacts are decoded
// strictly, digested here and checked against any digest the client claimed, and fields only
// the registry may set (_npmUser, provenance) are dropped.
import { createHash } from 'node:crypto';
import type {
  ArtifactIntegrity,
  PublishedVersion,
  WriteBody,
  WriteRoute,
} from '../../core/contracts.ts';
import { HttpError } from '../../core/errors.ts';
import { parseIntegrity } from './packument.ts';
import { isValidRev, isValidTag, isValidVersion, unscopedName } from './names.ts';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Package-level members that are not part of PublishRequest.document. */
const DOCUMENT_EXCLUDED = new Set([
  '_id',
  '_rev',
  '_attachments',
  'versions',
  'dist-tags',
  'time',
  'users',
]);
/** Set by the registry (from the authenticated identity or its own signing), never a client. */
const REGISTRY_FIELDS = ['_npmUser'] as const;
const REGISTRY_DIST_FIELDS = ['attestations', 'signatures'] as const;

const bad = (message: string): HttpError => new HttpError(400, message);
/** Client-chosen strings echoed in errors are clipped: they end up in responses and logs. */
const clip = (value: string): string =>
  JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw bad('request body is not valid JSON');
  }
}

function decodeAttachment(key: string, value: unknown): Buffer {
  if (!isRecord(value) || typeof value.data !== 'string') {
    throw bad(`attachment ${clip(key)} has no data`);
  }
  const data = value.data;
  // Buffer.from(..., 'base64') silently skips invalid characters; refuse them instead.
  if (data.length % 4 !== 0 || !BASE64.test(data))
    throw bad(`attachment ${clip(key)} is not base64`);
  const bytes = Buffer.from(data, 'base64');
  if (value.length !== undefined && value.length !== bytes.length) {
    throw bad(`attachment ${clip(key)} length does not match its data`);
  }
  if (bytes.length === 0) throw bad(`attachment ${clip(key)} is empty`);
  return bytes;
}

function digests(bytes: Buffer): { sha512: ArtifactIntegrity; sha1hex: string } {
  return {
    sha512: { algorithm: 'sha512', hex: createHash('sha512').update(bytes).digest('hex') },
    sha1hex: createHash('sha1').update(bytes).digest('hex'),
  };
}

const MAX_DEPRECATION = 1024;
/** Printed in client terminals: no control characters, no bidi overrides or isolates. */
const UNPRINTABLE = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;

/** A deprecation message clients may print: text, at most 1024 characters, printable. */
function isDeprecationMessage(message: unknown): message is string {
  return (
    typeof message === 'string' && message.length <= MAX_DEPRECATION && !UNPRINTABLE.test(message)
  );
}

/**
 * `deprecated` of every version that has one; null when none has (not a deprecate). Problems
 * are reported in `invalid` rather than thrown: for a source without deprecate() the body is
 * still the retain body it always was.
 */
function parseDeprecations(
  versions: Record<string, unknown>,
): { deprecations: Record<string, string>; invalid?: string } | null {
  const deprecations: Record<string, string> = {};
  let invalid: string | undefined;
  let any = false;
  for (const [version, value] of Object.entries(versions)) {
    if (!isRecord(value)) {
      invalid ??= `version ${clip(version)} is not an object`;
      continue;
    }
    if (!Object.hasOwn(value, 'deprecated')) continue;
    any = true;
    const message = value.deprecated;
    if (!isDeprecationMessage(message)) {
      invalid ??= `deprecated of ${clip(version)} must be a printable message of at most 1024 characters`;
      continue;
    }
    deprecations[version] = message; // keys were validated as semver, so never "__proto__"
  }
  if (!any) return null;
  return { deprecations, ...(invalid !== undefined ? { invalid } : {}) };
}

function parsePublish(
  route: Extract<WriteRoute, { kind: 'publish' }>,
  doc: Record<string, unknown>,
): WriteBody {
  const name = route.name;
  if (doc.name !== name || (doc._id !== undefined && doc._id !== name)) {
    throw bad('document name does not match the package in the URL');
  }
  const versionsObj = doc.versions ?? {};
  if (!isRecord(versionsObj)) throw bad('versions must be an object');
  for (const version of Object.keys(versionsObj)) {
    if (!isValidVersion(version)) throw bad(`invalid version ${clip(version)}`);
  }
  // Same shape the route grammar accepts; anything else is not passed to the source.
  const rev =
    route.rev ?? (typeof doc._rev === 'string' && isValidRev(doc._rev) ? doc._rev : undefined);

  const attachments = isRecord(doc._attachments) ? doc._attachments : {};
  // Provenance bundles (`<name>-<version>.sigstore`) are not stored by the cache.
  const tarballs = Object.entries(attachments).filter(([key]) => !key.endsWith('.sigstore'));
  if (tarballs.length === 0) {
    // npm deprecate PUTs the whole document to /:name (never with -rev in the path).
    const parsed = route.rev === undefined ? parseDeprecations(versionsObj) : null;
    if (parsed) {
      return {
        type: 'deprecate',
        request: {
          ecosystem: 'npm',
          name,
          deprecations: parsed.deprecations,
          ...(rev ? { rev } : {}),
        },
        versions: Object.keys(versionsObj),
        ...(parsed.invalid !== undefined ? { invalid: parsed.invalid } : {}),
      };
    }
    // No artifacts: npm sends the remaining document to unpublish a version.
    return { type: 'retain', versions: Object.keys(versionsObj), ...(rev ? { rev } : {}) };
  }

  const byFile = new Map<string, unknown>();
  for (const [key, value] of tarballs) {
    // npm keys attachments by `<full name>-<version>.tgz`; clients request the unscoped form.
    byFile.set(key.slice(key.lastIndexOf('/') + 1), value);
  }
  const versions: PublishedVersion[] = [];
  for (const [version, value] of Object.entries(versionsObj)) {
    if (!isRecord(value)) throw bad(`version ${version} is not an object`);
    if (value.name !== name || value.version !== version) {
      throw bad(`manifest of ${version} does not describe ${name}@${version}`);
    }
    // Served as is and printed by clients: the same rules as `npm deprecate`.
    if (Object.hasOwn(value, 'deprecated') && !isDeprecationMessage(value.deprecated)) {
      throw bad(
        `deprecated of ${clip(version)} must be a printable message of at most 1024 characters`,
      );
    }
    const file = `${unscopedName(name)}-${version}.tgz`;
    const attachment = byFile.get(file);
    if (attachment === undefined) throw bad(`version ${version} has no attachment ${file}`);
    byFile.delete(file);
    const data = decodeAttachment(file, attachment);
    const { sha512, sha1hex } = digests(data);

    const dist = isRecord(value.dist) ? { ...value.dist } : {};
    const claimed = parseIntegrity(dist);
    if (dist.integrity !== undefined && claimed === null) {
      throw bad(`version ${version} has an unusable integrity value`);
    }
    if (claimed && claimed.hex !== (claimed.algorithm === 'sha512' ? sha512.hex : sha1hex)) {
      throw bad(`version ${version} does not match its integrity`);
    }
    if (typeof dist.shasum === 'string' && dist.shasum.toLowerCase() !== sha1hex) {
      throw bad(`version ${version} does not match its integrity (shasum)`);
    }
    for (const f of REGISTRY_DIST_FIELDS) Reflect.deleteProperty(dist, f);
    dist.integrity = `sha512-${Buffer.from(sha512.hex, 'hex').toString('base64')}`;
    dist.shasum = sha1hex;
    // Served URLs are rewritten to the cache anyway; never keep a client-chosen host.
    dist.tarball = `/${name}/-/${file}`;
    const manifest: Record<string, unknown> = { ...value, dist };
    for (const f of REGISTRY_FIELDS) Reflect.deleteProperty(manifest, f);
    versions.push({
      version,
      manifest,
      artifact: { file, contentType: 'application/octet-stream', data, integrity: sha512 },
    });
  }
  if (byFile.size > 0) {
    throw bad(`attachment ${clip([...byFile.keys()].join(', '))} belongs to no version`);
  }

  const published = new Set(versions.map((v) => v.version));
  const distTags: Record<string, string> = {};
  const tagsObj = doc['dist-tags'] ?? {};
  if (!isRecord(tagsObj)) throw bad('dist-tags must be an object');
  for (const [tag, target] of Object.entries(tagsObj)) {
    if (!isValidTag(tag)) throw bad(`invalid dist-tag ${clip(tag)}`);
    if (typeof target !== 'string' || !published.has(target)) {
      throw bad(`dist-tag ${tag} must point at a version published in this request`);
    }
    distTags[tag] = target;
  }

  const document: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (DOCUMENT_EXCLUDED.has(k)) continue;
    // defineProperty: a JSON "__proto__" key stays plain data instead of hitting the setter.
    Object.defineProperty(document, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    type: 'publish',
    request: { ecosystem: 'npm', name, versions, distTags, document, ...(rev ? { rev } : {}) },
  };
}

export function parseWriteBody(route: WriteRoute, body: Buffer): WriteBody {
  const parsed = parseJson(body);
  switch (route.kind) {
    case 'dist-tag': {
      // npm sends the target version as a JSON string.
      if (typeof parsed !== 'string' || !isValidVersion(parsed)) {
        throw bad('dist-tag body must be a JSON string with a version');
      }
      return { type: 'dist-tag', version: parsed };
    }
    case 'publish':
      if (!isRecord(parsed)) throw bad('request body must be a JSON object');
      return parsePublish(route, parsed);
    case 'unpublish':
      throw bad('unpublish takes no body');
  }
}
