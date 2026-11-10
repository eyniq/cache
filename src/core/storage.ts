import type { Storage, StorageAdmin } from './contracts.ts';

const MAX_LIST = 1000;

/** StorageAdmin.list limit: clamped to 1..1000; 1000 for anything not a finite number. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_LIST;
  return Math.min(MAX_LIST, Math.max(1, Math.floor(limit)));
}

/** True when a Storage also offers the StorageAdmin operations. */
export function isStorageAdmin(storage: Storage): storage is Storage & StorageAdmin {
  const s = storage as Partial<StorageAdmin>;
  return (
    typeof s.list === 'function' &&
    typeof s.delete === 'function' &&
    typeof s.putIfAbsent === 'function' &&
    typeof s.putIfMatch === 'function' &&
    typeof s.capabilities === 'function'
  );
}

/** A storage request exceeded its I/O timeout (the write may still have landed). */
export class StorageTimeout extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = 'StorageTimeout';
  }
}
