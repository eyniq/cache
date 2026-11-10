// Bounds the storage reads that unknown credentials can cause. A bearer token or session id
// that misses the per-pod cache costs a storage read (an S3 GET); a client sending made-up
// values would turn every request into one. Each cache miss takes a token from the client's
// bucket (IPv6 per /64) and from a global bucket before the read, and gets it back when the
// credential turns out to exist: only lookups of unknown credentials use up the budget. When
// either bucket is empty the lookup fails without a read (the request gets the usual 401).
// Known credentials in the cache never reach this. Trade-off: while a flood empties the
// global bucket, credentials that are not cached yet fail too, until it refills.
import { TokenBucket } from '../core/token-bucket.ts';
import { addressLimitKey } from './address-key.ts';

export interface LookupLimiterOptions {
  /** Per client address: refill per second and burst. Default 2/s, 60. */
  perAddressRate?: number;
  perAddressBurst?: number;
  /** All clients together. Default 100/s, 1,000. */
  globalRate?: number;
  globalBurst?: number;
  /** Client buckets kept; the least recently used goes first. Default 10,000. */
  maxAddresses?: number;
  now?: () => number;
}

export class LookupLimiter {
  private readonly now: () => number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly maxAddresses: number;
  private readonly global: TokenBucket;
  private readonly addresses = new Map<string, TokenBucket>();

  constructor(opts: LookupLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rate = opts.perAddressRate ?? 2;
    this.burst = opts.perAddressBurst ?? 60;
    this.maxAddresses = opts.maxAddresses ?? 10_000;
    this.global = new TokenBucket(opts.globalRate ?? 100, opts.globalBurst ?? 1_000, this.now());
  }

  private bucket(address: string | undefined, create: boolean): TokenBucket | undefined {
    if (address === undefined) return undefined;
    const key = addressLimitKey(address);
    let b = this.addresses.get(key);
    if (b) {
      this.addresses.delete(key);
      this.addresses.set(key, b);
      return b;
    }
    if (!create) return undefined;
    b = new TokenBucket(this.rate, this.burst, this.now());
    this.addresses.set(key, b);
    while (this.addresses.size > this.maxAddresses) {
      const oldest = this.addresses.keys().next().value;
      if (oldest === undefined) break;
      this.addresses.delete(oldest);
    }
    return b;
  }

  /** Takes one lookup from the client's and the global budget; false when either is empty. */
  take(address: string | undefined): boolean {
    const now = this.now();
    const own = this.bucket(address, true);
    if (own && !own.tryTake(now)) return false;
    if (!this.global.tryTake(now)) {
      own?.refund();
      return false;
    }
    return true;
  }

  /** Whole seconds (at least 1) until `address` may look up again after a refused take. */
  retryAfterSeconds(address: string | undefined): number {
    const own = this.bucket(address, false)?.retryAfterSeconds() ?? 1;
    return Math.max(own, this.global.retryAfterSeconds());
  }

  /** The lookup found a real credential: its budget comes back. */
  refund(address: string | undefined): void {
    this.bucket(address, false)?.refund();
    this.global.refund();
  }
}
