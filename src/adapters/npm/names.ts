// npm naming rules (validate-npm-package-name), checked before anything else touches a name.
// Legacy names with uppercase letters or ~'!()* are accepted because they are still
// installable (JSONStream is a common transitive dependency); scopes must be lowercase.

const SCOPE = /^@[a-z0-9~-][a-z0-9._~-]*$/;
const PART = /^[A-Za-z0-9~'!()*-][A-Za-z0-9._~'!()*-]*$/;
const RESERVED = new Set(['node_modules', 'favicon.ico']);
const MAX_NAME_LENGTH = 214;

export function isValidPackageName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length !== 2) return false;
    const [scope, pkg] = parts as [string, string];
    return SCOPE.test(scope) && PART.test(pkg);
  }
  if (RESERVED.has(name.toLowerCase())) return false;
  return PART.test(name);
}

// Semver 2.0 with slightly looser prerelease identifiers (old packages use leading zeros).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isValidVersion(version: string): boolean {
  return version.length <= 256 && SEMVER.test(version);
}

const TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** dist-tag names such as `latest` or `next`; never valid semver. */
export function isValidTag(tag: string): boolean {
  return TAG.test(tag) && !isValidVersion(tag);
}

const TARBALL_FILE = /^[A-Za-z0-9~'!()*-][A-Za-z0-9._~'!()*+-]*\.tgz$/;

export function isValidTarballFile(file: string): boolean {
  return file.length <= 300 && TARBALL_FILE.test(file);
}

/** The package name without its scope: `@types/node` becomes `node`. */
export function unscopedName(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/** npm couchdb-style revisions ("3-abc123"); opaque to the cache, handed to the source. */
export function isValidRev(rev: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(rev);
}
