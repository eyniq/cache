// P4: policy composition and per-version facts.
import { describe, expect, it } from 'vitest';
import { processMetadata } from '../../src/adapters/npm/packument.ts';
import type { Policy, PolicyDecision, PolicyInput } from '../../src/core/contracts.ts';
import { composePolicies } from '../../src/policy/compose.ts';
import { policyConformance } from '../../src/testing/index.ts';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const input: PolicyInput = {
  ecosystem: 'npm',
  name: 'x',
  version: '1.0.0',
  publishedAt: NOW - 1000,
  now: NOW,
};

class Fixed implements Policy {
  calls = 0;
  revision = 0;
  private readonly decision: PolicyDecision;
  private readonly listeners = new Set<() => void>();

  constructor(decision: PolicyDecision) {
    this.decision = decision;
  }

  evaluate(): PolicyDecision {
    this.calls++;
    return this.decision;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bump(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }
}

describe('P4: composePolicies', () => {
  it('allows when every policy allows, carrying the earliest validUntil', () => {
    const p = composePolicies(
      new Fixed({ allow: true, validUntil: NOW + 5000 }),
      new Fixed({ allow: true, reason: 'allowlisted: hotfix', validUntil: NOW + 2000 }),
      new Fixed({ allow: true }),
    );
    expect(p.evaluate(input)).toEqual({
      allow: true,
      reason: 'allowlisted: hotfix',
      validUntil: NOW + 2000,
    });
  });

  it('returns the first deny and stops evaluating', () => {
    const later = new Fixed({ allow: false, reason: 'second' });
    const p = composePolicies(
      new Fixed({ allow: true, validUntil: NOW + 1000 }),
      new Fixed({
        allow: false,
        reason: 'first',
        allowedAfter: NOW + 9000,
        validUntil: NOW + 9000,
      }),
      later,
    );
    expect(p.evaluate(input)).toEqual({
      allow: false,
      reason: 'first',
      allowedAfter: NOW + 9000,
      // An earlier allow may flip sooner, so the composite decision is only valid until then.
      validUntil: NOW + 1000,
    });
    expect(later.calls).toBe(0);
  });

  it('allows with no policies', () => {
    expect(composePolicies().evaluate(input)).toEqual({ allow: true });
  });

  it('sums revisions and forwards change notifications from every member', () => {
    const a = new Fixed({ allow: true });
    const b = new Fixed({ allow: true });
    const plain: Policy = { evaluate: () => ({ allow: true }) };
    const p = composePolicies(a, plain, b);
    let changes = 0;
    const off = p.onChange?.(() => changes++);
    a.bump();
    b.bump();
    expect(changes).toBe(2);
    expect(p.revision).toBe(2);
    off?.();
    a.bump();
    expect(changes).toBe(2);
  });

  describe('conformance of a composite', () => {
    const create = () =>
      composePolicies(
        {
          evaluate: (i) =>
            i.publishedAt === null ? { allow: false, reason: 'no time' } : { allow: true },
        },
        {
          evaluate: (i) =>
            i.facts?.hasInstallScript === true
              ? { allow: false, reason: 'install scripts are not allowed' }
              : { allow: true },
        },
      );
    for (const c of policyConformance(create, { now: NOW })) it(c.name, c.run);
  });
});

describe('P4: npm per-version facts', () => {
  const ctx = {
    name: 'pkg',
    publicBaseUrl: 'https://cache.example',
    upstreamOrigin: 'https://registry.npmjs.org',
    maxBytes: 1 << 20,
    options: {},
  };

  it('extracts publisher, maintainers, install scripts, license, deprecation and attestations', () => {
    const doc = {
      name: 'pkg',
      versions: {
        '1.0.0': {
          name: 'pkg',
          version: '1.0.0',
          _npmUser: { name: 'alice', email: 'a@example.invalid' },
          maintainers: [{ name: 'alice' }, { name: 'bob' }],
          scripts: { postinstall: 'node evil.js' },
          license: 'MIT',
          deprecated: 'use 2.x',
          dist: {
            shasum: 'a'.repeat(40),
            attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/pkg@1.0.0' },
            signatures: [{ keyid: 'SHA256:x', sig: 'y' }],
          },
        },
        '2.0.0': {
          name: 'pkg',
          version: '2.0.0',
          hasInstallScript: true,
          license: { type: 'Apache-2.0' },
          dist: { shasum: 'b'.repeat(40), signatures: [] },
        },
      },
    };
    const p = processMetadata(
      { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' },
      ctx,
    );
    expect(p.versions.map((v) => v.facts)).toEqual([
      {
        publisher: 'alice',
        maintainers: 2,
        hasInstallScript: true,
        license: 'MIT',
        deprecated: true,
        hasAttestations: true,
        hasSignatures: true,
        previousPublisher: null,
        publisherFirstSeen: null,
      },
      {
        publisher: null,
        maintainers: 0,
        hasInstallScript: true,
        license: 'Apache-2.0',
        deprecated: false,
        hasAttestations: false,
        hasSignatures: false,
        previousPublisher: 'alice',
        publisherFirstSeen: null,
      },
    ]);
  });
});
