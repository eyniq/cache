// Token bucket for small in-process limits (no timers: tokens are computed on demand).

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;

  /** `ratePerSecond` tokens refill per second, up to `burst`. */
  constructor(ratePerSecond: number, burst: number, now: number = Date.now()) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  /** Takes one token if there is one. */
  tryTake(now: number = Date.now()): boolean {
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((now - this.last) / 1000) * this.ratePerSecond,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Gives back a token taken by tryTake (never above the burst). */
  refund(): void {
    this.tokens = Math.min(this.burst, this.tokens + 1);
  }

  /** Seconds until the next token is available (at least 1). */
  retryAfterSeconds(): number {
    const missing = Math.max(1 - this.tokens, 0);
    return Math.max(1, Math.ceil(missing / this.ratePerSecond));
  }
}
