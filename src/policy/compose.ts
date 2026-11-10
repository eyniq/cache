// Policy chain: several policies act as one (e.g. release age, advisories, licenses).
import type { Policy, PolicyDecision, PolicyInput } from '../core/contracts.ts';

/**
 * The first deny wins and later policies are not evaluated. An allow carries the first reason
 * given (e.g. "allowlisted") and the earliest validUntil of all members; a deny is valid only
 * until the earliest validUntil of the members evaluated before it, because any of those may
 * flip. revision is the sum of the members' revisions (each only grows), and onChange
 * subscribes to every member that offers it.
 */
export function composePolicies(...policies: Policy[]): Policy {
  return {
    evaluate(input: PolicyInput): PolicyDecision {
      let validUntil = Number.POSITIVE_INFINITY;
      let reason: string | undefined;
      let allowlisted = false;
      for (const policy of policies) {
        const d = policy.evaluate(input);
        if (!d.allow) {
          const until = Math.min(validUntil, d.validUntil ?? Number.POSITIVE_INFINITY);
          return {
            allow: false,
            reason: d.reason,
            ...(d.allowedAfter !== undefined ? { allowedAfter: d.allowedAfter } : {}),
            ...(until !== Number.POSITIVE_INFINITY ? { validUntil: until } : {}),
          };
        }
        if (d.validUntil !== undefined) validUntil = Math.min(validUntil, d.validUntil);
        // An exception's reason wins: it is what the policy.allowlisted audit should name.
        if (d.allowlisted === true && !allowlisted) {
          allowlisted = true;
          reason = d.reason;
        } else if (!allowlisted) {
          reason ??= d.reason;
        }
      }
      return {
        allow: true,
        ...(reason !== undefined ? { reason } : {}),
        ...(allowlisted ? { allowlisted } : {}),
        ...(validUntil !== Number.POSITIVE_INFINITY ? { validUntil } : {}),
      };
    },
    blocksWholePackage(ecosystem: string, name: string): boolean {
      return policies.some((p) => p.blocksWholePackage?.(ecosystem, name) === true);
    },
    get revision(): number {
      return policies.reduce((sum, p) => sum + (p.revision ?? 0), 0);
    },
    onChange(listener: () => void): () => void {
      const offs = policies.map((p) => p.onChange?.(listener));
      return () => {
        for (const off of offs) off?.();
      };
    },
  };
}
