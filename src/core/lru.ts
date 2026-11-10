// LRU capped in bytes, not entries (DESIGN.md section 7.4): one 30 MB packument must count
// as much as thousands of small ones. Map iteration order is insertion order, so re-inserting
// on access keeps the least recently used entry first.

interface Slot<V> {
  value: V;
  bytes: number;
}

export class ByteLru<V> {
  private readonly map = new Map<string, Slot<V>>();
  private readonly maxBytes: number;
  bytes = 0;
  evictions = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get count(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    this.map.delete(key);
    this.map.set(key, slot);
    return slot.value;
  }

  /** Returns false (and stores nothing) when the entry alone exceeds the cap. */
  set(key: string, value: V, bytes: number): boolean {
    this.delete(key);
    if (bytes > this.maxBytes) return false;
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    this.evict();
    return true;
  }

  /**
   * Update the accounted size of an entry (e.g. after a render was added to it). With
   * `expected`, only if the key still holds that exact value (it may have been replaced).
   */
  resize(key: string, bytes: number, expected?: V): void {
    const slot = this.map.get(key);
    if (!slot || (expected !== undefined && slot.value !== expected)) return;
    this.bytes += bytes - slot.bytes;
    slot.bytes = bytes;
    if (bytes > this.maxBytes) this.delete(key);
    else this.evict();
  }

  delete(key: string): void {
    const slot = this.map.get(key);
    if (!slot) return;
    this.map.delete(key);
    this.bytes -= slot.bytes;
  }

  private evict(): void {
    for (const [key, slot] of this.map) {
      if (this.bytes <= this.maxBytes) return;
      this.map.delete(key);
      this.bytes -= slot.bytes;
      this.evictions++;
    }
  }
}
