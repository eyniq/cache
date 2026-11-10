// Probes that tell the truth (DESIGN.md section 7.7): /livez never does I/O; /readyz reports
// 503 when the event loop is saturated or storage is unreachable, so Kubernetes stops routing
// to a busy pod instead of killing it.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Storage } from '../core/contracts.ts';

const WINDOW_MS = 10_000;
const STORAGE_CHECK_TTL_MS = 2_000;
const STORAGE_CHECK_TIMEOUT_MS = 2_000;

/** Event-loop delay over a rolling window of 10 to 20 seconds. */
export class LoopMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private previous = { p50: 0, p99: 0 };
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.histogram = monitorEventLoopDelay({ resolution: 10 });
    this.histogram.enable();
    this.timer = setInterval(() => {
      this.previous = this.current();
      this.histogram.reset();
    }, WINDOW_MS);
    this.timer.unref();
  }

  private current(): { p50: number; p99: number } {
    if (this.histogram.count === 0) return { p50: 0, p99: 0 };
    return {
      p50: this.histogram.percentile(50) / 1e6,
      p99: this.histogram.percentile(99) / 1e6,
    };
  }

  /** Milliseconds; the worse of the previous and the current window. */
  p99Ms(): number {
    return Math.max(this.previous.p99, this.current().p99);
  }

  p50Ms(): number {
    return Math.max(this.previous.p50, this.current().p50);
  }

  stop(): void {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}

export type Readiness = { ready: true } | { ready: false; reason: string };

export class ReadinessCheck {
  private storageOk: { at: number; ok: boolean; pending?: Promise<boolean> } = { at: 0, ok: true };
  private readonly storage: Storage;
  private readonly monitor: LoopMonitor;
  private readonly maxLagMs: number;
  private readonly hook: (() => string | null) | undefined;

  constructor(
    storage: Storage,
    monitor: LoopMonitor,
    maxLagMs: number,
    hook?: () => string | null,
  ) {
    this.hook = hook;
    this.storage = storage;
    this.monitor = monitor;
    this.maxLagMs = maxLagMs;
  }

  async check(): Promise<Readiness> {
    const lag = this.monitor.p99Ms();
    if (lag > this.maxLagMs) {
      return { ready: false, reason: `event loop delay p99 ${lag.toFixed(0)} ms` };
    }
    if (!(await this.storageReachable())) return { ready: false, reason: 'storage unreachable' };
    const reason = this.hookReason();
    if (reason !== null) return { ready: false, reason };
    return { ready: true };
  }

  /** The edition hook is synchronous and cheap; a throwing hook never makes a pod unready. */
  private hookReason(): string | null {
    if (!this.hook) return null;
    try {
      const reason: unknown = this.hook();
      return typeof reason === 'string' && reason !== '' ? reason : null;
    } catch {
      return null;
    }
  }

  /** Cached briefly so frequent probes do not hammer a shared volume or bucket. */
  private storageReachable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.storageOk.at < STORAGE_CHECK_TTL_MS) return Promise.resolve(this.storageOk.ok);
    if (this.storageOk.pending) return this.storageOk.pending;
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, STORAGE_CHECK_TIMEOUT_MS).unref();
    });
    const pending = Promise.race([
      this.storage.check().then(
        () => true,
        () => false,
      ),
      timeout,
    ]).then((ok) => {
      this.storageOk = { at: Date.now(), ok };
      return ok;
    });
    this.storageOk.pending = pending;
    return pending;
  }
}
