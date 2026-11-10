// Minimum release age gate (DESIGN.md section 8). Pure and synchronous: it runs when metadata
// is (re)filtered, never on the cache-hit path. `validUntil` tells the metadata service when a
// decision can change, so re-filtering happens once per change instead of per request.
import type { Policy, PolicyDecision, PolicyInput } from '../core/contracts.ts';
import { log } from '../core/log.ts';
import type { AllowlistEntry } from './allowlist.ts';

export interface MinReleaseAgeOptions {
  minAgeMs: number;
  failClosed: boolean;
  allowlist: AllowlistEntry[];
  /**
   * Also gate packages published to this registry (PolicyInput.origin "local"). Default
   * false: the gate protects against fresh third-party releases, and a team's own publish
   * must be installable at once. Community builds have no local packages.
   */
  gateLocal?: boolean;
  /**
   * Lifts the gate for a version (an explicit exception such as a package filter allow rule):
   * returns the reason, or null. Only consulted when the gate would deny.
   */
  exempt?: (input: PolicyInput) => string | null;
}

const BLOCKED = 'blocked by minimum release age';
const MAX_WARNED = 10_000;

export class MinReleaseAgePolicy implements Policy {
  private readonly minAgeMs: number;
  private readonly failClosed: boolean;
  private readonly gateLocal: boolean;
  private readonly exempt: ((input: PolicyInput) => string | null) | undefined;
  private readonly allowlist = new Map<string, AllowlistEntry>();
  /** Fail-open decisions are logged once per version, not on every re-filter. */
  private readonly warned = new Set<string>();

  constructor(opts: MinReleaseAgeOptions) {
    this.minAgeMs = opts.minAgeMs;
    this.failClosed = opts.failClosed;
    this.gateLocal = opts.gateLocal ?? false;
    this.exempt = opts.exempt;
    for (const e of opts.allowlist) {
      this.allowlist.set(`${e.ecosystem ?? 'npm'}:${e.package}@${e.version}`, e);
    }
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const d = this.gate(input);
    if (d.allow || this.exempt === undefined) return d;
    const reason = this.exempt(input);
    return reason === null ? d : { allow: true, reason, allowlisted: true };
  }

  private gate(input: PolicyInput): PolicyDecision {
    if (this.minAgeMs === 0) return { allow: true };
    if (input.origin === 'local' && !this.gateLocal) return { allow: true };

    const entry = this.allowlist.get(`${input.ecosystem}:${input.name}@${input.version}`);
    if (entry && input.now < entry.expires) {
      return {
        allow: true,
        reason: `allowlisted: ${entry.reason}`,
        allowlisted: true,
        validUntil: entry.expires,
      };
    }
    if (entry) this.warnOnce(input, 'allowlist entry expired; the version is gated again');

    if (input.publishedAt === null) {
      if (this.failClosed) return { allow: false, reason: 'unknown publish time (fail closed)' };
      this.warnOnce(input, 'allowing a version with unknown publish time (FAIL_CLOSED=false)');
      return { allow: true, reason: 'unknown publish time (fail open)' };
    }

    const allowedAfter = input.publishedAt + this.minAgeMs;
    if (input.now >= allowedAfter) return { allow: true };
    return { allow: false, reason: BLOCKED, allowedAfter, validUntil: allowedAfter };
  }

  private warnOnce(input: PolicyInput, message: string): void {
    const key = `${message}|${input.ecosystem}:${input.name}@${input.version}`;
    if (this.warned.has(key)) return;
    if (this.warned.size >= MAX_WARNED) this.warned.clear();
    this.warned.add(key);
    log.warn(message, {
      ecosystem: input.ecosystem,
      name: input.name,
      version: input.version,
    });
  }
}
