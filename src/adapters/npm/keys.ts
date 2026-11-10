// Storage keys for npm objects, derived only from validated names (DESIGN.md section 11).
import { assertSafeKey } from '../../core/names.ts';
import { isValidPackageName, isValidVersion } from './names.ts';

function assertName(name: string): void {
  if (!isValidPackageName(name)) throw new Error('invalid package name for storage key');
}

/** Raw upstream packument (always stored gzip-compressed). */
export function packumentKey(name: string): string {
  assertName(name);
  return assertSafeKey(`npm/packuments/${name}.json.gz`);
}

/** Write-once index entry `index/npm/<name>/<version>` holding `<algorithm>-<hex>`. */
export function indexKey(name: string, version: string): string {
  assertName(name);
  if (!isValidVersion(version)) throw new Error('invalid version for storage key');
  return assertSafeKey(`index/npm/${name}/${version}`);
}
