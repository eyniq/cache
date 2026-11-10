// Policy conformance suite: the properties the metadata service relies on (DESIGN.md sections
// 7.3 and 15). evaluate() runs when metadata is (re)filtered, so it must be synchronous, pure
// for a given configuration, never throw on odd input, and honour its own validUntil.
import assert from 'node:assert/strict';
import type { Policy, PolicyDecision, PolicyInput } from '../core/contracts.ts';
import type { ConformanceCase } from './conformance.ts';

export interface PolicyConformanceOptions {
  /** Evaluation time used by the generated inputs (epoch ms). Default: now. */
  now?: number;
  /** Extra inputs to check on top of the built-in samples. */
  samples?: PolicyInput[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

function builtInSamples(now: number): PolicyInput[] {
  const base = { ecosystem: 'npm', now };
  return [
    { ...base, name: 'old', version: '1.0.0', publishedAt: now - 10 * YEAR },
    { ...base, name: 'fresh', version: '1.0.0', publishedAt: now - HOUR },
    { ...base, name: 'fresh', version: '2.0.0-beta.1', publishedAt: now - 1 },
    { ...base, name: 'week', version: '3.1.4', publishedAt: now - 7 * DAY },
    { ...base, name: 'notime', version: '0.0.1', publishedAt: null },
    { ...base, name: 'future', version: '9.9.9', publishedAt: now + DAY },
    { ...base, name: '@scope/pkg', version: '1.2.3+build.5', publishedAt: now - 2 * DAY },
    { ...base, ecosystem: 'unknown-ecosystem', name: 'x', version: '1', publishedAt: now },
    { ...base, name: 'local', version: '0.1.0', publishedAt: now - 1, origin: 'local' },
    {
      ...base,
      name: 'with-facts',
      version: '1.0.0',
      publishedAt: now - 30 * DAY,
      facts: { publisher: 'someone', hasInstallScript: true, license: null, maintainers: 3 },
    },
  ];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function assertWellFormed(d: PolicyDecision, input: PolicyInput): void {
  const label = `${input.name}@${input.version}`;
  assert.equal(typeof d.allow, 'boolean', `${label}: allow must be a boolean`);
  if (!d.allow) {
    assert.equal(typeof d.reason, 'string', `${label}: a deny needs a reason`);
    assert.ok(d.reason.length > 0, `${label}: a deny needs a non-empty reason`);
    if (d.allowedAfter !== undefined) {
      assert.ok(Number.isFinite(d.allowedAfter), `${label}: allowedAfter must be finite`);
    }
  }
  if (d.validUntil !== undefined) {
    assert.ok(Number.isFinite(d.validUntil), `${label}: validUntil must be finite`);
    // A validUntil at or before now would make the service re-filter on every request.
    assert.ok(d.validUntil > input.now, `${label}: validUntil must lie after now`);
  }
}

export function policyConformance(
  create: () => Policy,
  opts: PolicyConformanceOptions = {},
): ConformanceCase[] {
  const now = opts.now ?? Date.now();
  const samples = (): PolicyInput[] => [...builtInSamples(now), ...(opts.samples ?? [])];
  const sync = (fn: () => void): (() => Promise<void>) => {
    return () => {
      fn();
      return Promise.resolve();
    };
  };

  return [
    {
      name: 'evaluate is synchronous and returns well-formed decisions',
      run: sync(() => {
        const policy = create();
        for (const input of samples()) {
          const d = policy.evaluate(input);
          assert.ok(
            typeof (d as unknown as { then?: unknown }).then !== 'function',
            'evaluate must not return a promise',
          );
          assertWellFormed(d, input);
        }
      }),
    },
    {
      name: 'evaluate is deterministic for the same input and configuration',
      run: sync(() => {
        const policy = create();
        for (const input of samples()) {
          assert.deepEqual(policy.evaluate(input), policy.evaluate({ ...input }));
        }
      }),
    },
    {
      name: 'evaluate does not mutate its input',
      run: sync(() => {
        const policy = create();
        for (const input of samples()) policy.evaluate(deepFreeze(structuredClone(input)));
      }),
    },
    {
      name: 'a decision holds until its validUntil (or forever without one)',
      run: sync(() => {
        const policy = create();
        for (const input of samples()) {
          const d = policy.evaluate(input);
          const later = d.validUntil !== undefined ? d.validUntil - 1 : input.now + 10 * YEAR;
          const again = policy.evaluate({ ...input, now: later });
          assert.equal(
            again.allow,
            d.allow,
            `${input.name}@${input.version} changed before validUntil`,
          );
        }
      }),
    },
    {
      name: 'never throws on unusual names, versions or publish times',
      run: sync(() => {
        const policy = create();
        const odd: PolicyInput[] = [
          { ecosystem: 'npm', name: '', version: '', publishedAt: null, now },
          { ecosystem: 'npm', name: 'x'.repeat(500), version: '1.0.0', publishedAt: 0, now },
          { ecosystem: '', name: 'x', version: 'not-semver', publishedAt: -1, now },
          { ecosystem: 'npm', name: 'x', version: '1.0.0', publishedAt: now, now: 0 },
          { ecosystem: 'npm', name: 'x', version: '1.0.0', publishedAt: null, now, facts: {} },
        ];
        for (const input of odd) policy.evaluate(input);
      }),
    },
  ];
}
