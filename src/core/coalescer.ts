// Request coalescing (DESIGN.md section 7.1): one in-flight task per key; concurrent callers
// await the same promise; the key is removed when the task settles.

export interface CoalescedRun<T> {
  promise: Promise<T>;
  /** True for the caller that started the task. */
  leader: boolean;
}

export class Coalescer<T> {
  private readonly inflight = new Map<string, Promise<T>>();
  /** Total number of callers that joined an existing task (for metrics). */
  coalesced = 0;

  get size(): number {
    return this.inflight.size;
  }

  run(key: string, task: () => Promise<T>): CoalescedRun<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.coalesced++;
      return { promise: existing, leader: false };
    }
    let started: Promise<T>;
    try {
      started = task();
    } catch (err) {
      started = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const tracked = started.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return { promise: tracked, leader: true };
  }
}
