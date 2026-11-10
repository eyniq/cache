import type { ArtifactIntegrity } from './contracts.ts';

// Ecosystem-agnostic storage-key safety. Keys are always derived from validated names or
// digests; this is the last line of defence before a key reaches a filesystem or bucket.

const SEGMENT = /^[A-Za-z0-9@._~'!()*+-]+$/;
const MAX_KEY_LENGTH = 1024;
/** Built-in digests only: adapter-defined digests get adapter-defined keys. */
const CONTENT_HEX_LENGTH: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    sha512: 128,
    sha256: 64,
    sha1: 40,
  }),
);

export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (!SEGMENT.test(segment)) return false;
  }
  return true;
}

/**
 * Content-addressed key for artifact bytes (DESIGN.md section 7.6): write-once, so pods sharing
 * a volume or bucket need no locking and a duplicate write is harmless.
 */
export function contentKey(integrity: ArtifactIntegrity): string {
  const len = CONTENT_HEX_LENGTH[integrity.algorithm];
  if (len === undefined || !new RegExp(`^[0-9a-f]{${len}}$`).test(integrity.hex)) {
    throw new Error('invalid digest');
  }
  return `tarballs/${integrity.algorithm}/${integrity.hex}`;
}

export function assertSafeKey(key: string): string {
  if (!isSafeKey(key)) throw new Error('unsafe storage key');
  return key;
}
