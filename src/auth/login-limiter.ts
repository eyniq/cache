// Brute-force limits for password checks (npm login, token creation, web catalog login).
// Per user name (case-insensitive): a few free failures, then an exponentially growing delay
// (1 s, 2 s, 4 s, ... up to a cap) during which every attempt for that name fails without a
// password check. Per client address (IPv6 per /64, see address-key.ts): at most N failures
// in a sliding window, whatever names they try. A success resets the user. Unknown names are
// tracked exactly like real ones, so the limits reveal nothing about which users exist.
//
// Every password check first reserves an attempt (reserve()). A reservation counts as a
// failure until it is resolved (failed, succeeded or released), so a burst of concurrent
// requests cannot all pass the check before the first failure is counted: per user at most
// the free failures (one at a time once they are used up) run a password check at once.
//
// Memory is bounded without letting a flood of made-up names or addresses erase real
// lockouts: an entry is only dropped once it is idle (nothing pending, not blocked, its
// failures forgotten). When a map is full of live entries, new names and addresses share
// a fixed number of overflow buckets (keyed hash of the name), which are always checked as
// well. The trade-off: during such a flood, names that fall into a blocked bucket are
// throttled too (a lockout, never a bypass). State is per process (per pod): with several
// replicas an attacker gets the budget once per pod.
import { createHmac, randomBytes } from 'node:crypto';
import { addressLimitKey } from './address-key.ts';

export interface LoginLimiterOptions {
  now?: () => number;
  /** Failures per user before delays start. Default 5. */
  userFreeFailures?: number;
  /** Longest delay per user. Default 15 min. */
  userMaxDelayMs?: number;
  /** A user's failures are forgotten after this long without one. Default 1 h. */
  userForgetMs?: number;
  /** Failures per client address within the window. Default 30. */
  addressMaxFailures?: number;
  /** Default 15 min. */
  addressWindowMs?: number;
  /**
   * Password checks one client address may have in progress (or queued) at once. Default 4:
   * a few addresses cannot fill the shared scrypt queue.
   */
  addressMaxPending?: number;
  /** Entries per map before names share overflow buckets. Default 10,000. */
  maxEntries?: number;
  /** Overflow buckets per map. Default 1,024. */
  buckets?: number;
}

interface UserState {
  failures: number;
  /** Attempts before this epoch ms are refused. */
  blockedUntil: number;
  /** Time of the last failure. */
  last: number;
  /** Reserved attempts not resolved yet. */
  pending: number;
}

interface AddressState {
  /** Failure times, oldest first. */
  times: number[];
  pending: number;
}

/** One reserved password check; the first of the three calls wins, later ones do nothing. */
export interface LoginAttempt {
  /** The password was right: the user's failures are cleared. */
  succeeded(): void;
  /** The password was wrong (or the name unknown). */
  failed(): void;
  /** The check did not run (e.g. too busy): nothing is counted. */
  released(): void;
}

export class LoginLimiter {
  private readonly now: () => number;
  private readonly freeFailures: number;
  private readonly maxDelayMs: number;
  private readonly forgetMs: number;
  private readonly addressMax: number;
  private readonly windowMs: number;
  private readonly addressMaxPending: number;
  private readonly maxEntries: number;
  private readonly bucketCount: number;
  private readonly bucketKey = randomBytes(16);
  private readonly users = new Map<string, UserState>();
  private readonly addresses = new Map<string, AddressState>();
  private readonly userBuckets = new Map<number, UserState>();
  private readonly addressBuckets = new Map<number, AddressState>();

  constructor(opts: LoginLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.freeFailures = opts.userFreeFailures ?? 5;
    this.maxDelayMs = opts.userMaxDelayMs ?? 15 * 60_000;
    this.forgetMs = opts.userForgetMs ?? 60 * 60_000;
    this.addressMax = opts.addressMaxFailures ?? 30;
    this.windowMs = opts.addressWindowMs ?? 15 * 60_000;
    this.addressMaxPending = Math.max(1, opts.addressMaxPending ?? 4);
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.bucketCount = Math.max(1, opts.buckets ?? 1024);
  }

  /** Entries in the per-name and per-address maps (overflow buckets not counted). */
  get size(): number {
    return this.users.size + this.addresses.size;
  }

  private userKey(name: string): string {
    return name.toLowerCase().slice(0, 256);
  }

  private bucketOf(key: string): number {
    return (
      createHmac('sha256', this.bucketKey).update(key).digest().readUInt32BE(0) % this.bucketCount
    );
  }

  // --- user state ---

  private userIdle(s: UserState, now: number): boolean {
    return s.pending === 0 && now >= s.blockedUntil && this.userFailures(s, now) === 0;
  }

  /** Failures that still count (forgotten after forgetMs without one). */
  private userFailures(s: UserState, now: number): number {
    return now - s.last < this.forgetMs ? s.failures : 0;
  }

  /** Whether one more check may start for this state. */
  private userOpen(s: UserState | undefined, now: number): boolean {
    if (!s) return true;
    if (now < s.blockedUntil) return false;
    // Pending checks count as failures; once the free failures are used up, one at a time.
    return this.userFailures(s, now) + s.pending < this.freeFailures || s.pending === 0;
  }

  /** The state a new attempt for `key` records into: its own entry, a new one, or a bucket. */
  private userSlot(key: string, now: number): UserState {
    const own = this.users.get(key);
    if (own) return own;
    sweep(this.users, (s) => this.userIdle(s, now));
    if (this.users.size < this.maxEntries) {
      const s: UserState = { failures: 0, blockedUntil: 0, last: 0, pending: 0 };
      this.users.set(key, s);
      return s;
    }
    const b = this.bucketOf(`u:${key}`);
    let s = this.userBuckets.get(b);
    if (!s) {
      s = { failures: 0, blockedUntil: 0, last: 0, pending: 0 };
      this.userBuckets.set(b, s);
    }
    return s;
  }

  // --- address state ---

  private recent(s: AddressState, now: number): number {
    while (s.times.length > 0 && now - (s.times[0] ?? 0) >= this.windowMs) s.times.shift();
    return s.times.length;
  }

  private addressIdle(s: AddressState, now: number): boolean {
    return s.pending === 0 && this.recent(s, now) === 0;
  }

  private addressOpen(s: AddressState | undefined, now: number): boolean {
    return (
      !s ||
      (this.recent(s, now) + s.pending < this.addressMax && s.pending < this.addressMaxPending)
    );
  }

  private addressSlot(key: string, now: number): AddressState {
    const own = this.addresses.get(key);
    if (own) return own;
    sweep(this.addresses, (s) => this.addressIdle(s, now));
    if (this.addresses.size < this.maxEntries) {
      const s: AddressState = { times: [], pending: 0 };
      this.addresses.set(key, s);
      return s;
    }
    const b = this.bucketOf(`a:${key}`);
    let s = this.addressBuckets.get(b);
    if (!s) {
      s = { times: [], pending: 0 };
      this.addressBuckets.set(b, s);
    }
    return s;
  }

  private addFailure(s: AddressState, now: number): void {
    this.recent(s, now);
    s.times.push(now);
    if (s.times.length > this.addressMax) s.times.splice(0, s.times.length - this.addressMax);
  }

  /**
   * The address has as many password checks in progress as it may (addressMaxPending): a
   * transient overload, which callers answer with 503 instead of a failed login.
   */
  addressBusy(address: string | undefined): boolean {
    if (address === undefined) return false;
    const key = addressLimitKey(address);
    const s =
      this.addresses.get(key) ??
      (this.addressBuckets.size > 0
        ? this.addressBuckets.get(this.bucketOf(`a:${key}`))
        : undefined);
    return s !== undefined && s.pending >= this.addressMaxPending;
  }

  /**
   * Reserves a password check for this name and client address, or null while either is
   * throttled. The caller must resolve the attempt exactly once.
   */
  reserve(name: string, address: string | undefined): LoginAttempt | null {
    const now = this.now();
    const userKey = this.userKey(name);
    const addressKey = address !== undefined ? addressLimitKey(address) : undefined;
    if (!this.userOpen(this.users.get(userKey), now)) return null;
    if (
      this.userBuckets.size > 0 &&
      !this.userOpen(this.userBuckets.get(this.bucketOf(`u:${userKey}`)), now)
    ) {
      return null;
    }
    if (addressKey !== undefined) {
      if (!this.addressOpen(this.addresses.get(addressKey), now)) return null;
      if (
        this.addressBuckets.size > 0 &&
        !this.addressOpen(this.addressBuckets.get(this.bucketOf(`a:${addressKey}`)), now)
      ) {
        return null;
      }
    }
    const user = this.userSlot(userKey, now);
    const addr = addressKey !== undefined ? this.addressSlot(addressKey, now) : undefined;
    // A slot found through userSlot may be a bucket that is closed for this attempt.
    if (!this.userOpen(user, now) || (addr && !this.addressOpen(addr, now))) return null;
    user.pending++;
    if (addr) addr.pending++;
    touch(this.users, userKey, user);
    if (addressKey !== undefined && addr) touch(this.addresses, addressKey, addr);
    let done = false;
    const settle = (outcome: 'success' | 'failure' | 'release'): void => {
      if (done) return;
      done = true;
      const at = this.now();
      user.pending--;
      if (addr) addr.pending--;
      if (outcome === 'failure') {
        const failures = this.userFailures(user, at) + 1;
        const over = failures - this.freeFailures;
        const delay = over > 0 ? Math.min(this.maxDelayMs, 1000 * 2 ** Math.min(over - 1, 30)) : 0;
        user.failures = failures;
        user.blockedUntil = Math.max(user.blockedUntil, at + delay);
        user.last = at;
        touch(this.users, userKey, user);
        if (addr && addressKey !== undefined) {
          this.addFailure(addr, at);
          touch(this.addresses, addressKey, addr);
        }
      } else if (outcome === 'success' && this.users.get(userKey) === user) {
        // Only the name's own entry is cleared: a shared bucket keeps its failures.
        user.failures = 0;
        user.blockedUntil = 0;
        if (user.pending === 0) this.users.delete(userKey);
      }
    };
    return {
      succeeded: () => {
        settle('success');
      },
      failed: () => {
        settle('failure');
      },
      released: () => {
        settle('release');
      },
    };
  }

  /**
   * Counts an attempt against the address without blaming a user name (e.g. a successful
   * self-registration, so one address cannot fill MAX_USERS in a burst).
   */
  charge(address: string | undefined): void {
    if (address === undefined) return;
    const now = this.now();
    const key = addressLimitKey(address);
    const s = this.addressSlot(key, now);
    this.addFailure(s, now);
    touch(this.addresses, key, s);
  }
}

/** Moves the name's own entry (not a bucket) to the back: maps stay in order of activity. */
function touch<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.get(key) !== value) return;
  map.delete(key);
  map.set(key, value);
}

/** Drops entries from the front (least recently active) while they are idle. */
function sweep<T>(map: Map<string, T>, idle: (value: T) => boolean): void {
  for (const [key, value] of map) {
    if (!idle(value)) return;
    map.delete(key);
  }
}
