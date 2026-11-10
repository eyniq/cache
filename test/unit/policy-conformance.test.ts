// The shared Policy conformance suite, run against the community MinReleaseAgePolicy in its
// main configurations. Any Policy implementation (including downstream ones) must pass it.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { captureLogs, type CapturedLogs } from '../../src/core/log.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';
import { policyConformance } from '../../src/testing/index.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T00:00:00Z');

const configurations = {
  'gate off': () => new MinReleaseAgePolicy({ minAgeMs: 0, failClosed: true, allowlist: [] }),
  '3d, fail closed': () =>
    new MinReleaseAgePolicy({ minAgeMs: 3 * DAY, failClosed: true, allowlist: [] }),
  '3d, fail open': () =>
    new MinReleaseAgePolicy({ minAgeMs: 3 * DAY, failClosed: false, allowlist: [] }),
  '3d with an allowlist entry': () =>
    new MinReleaseAgePolicy({
      minAgeMs: 3 * DAY,
      failClosed: true,
      allowlist: [{ package: 'fresh', version: '1.0.0', reason: 'hotfix', expires: NOW + DAY }],
    }),
};

let logs: CapturedLogs;
beforeAll(() => {
  logs = captureLogs();
});
afterAll(() => {
  logs.restore();
});

for (const [label, create] of Object.entries(configurations)) {
  describe(`Policy conformance: MinReleaseAgePolicy (${label})`, () => {
    for (const c of policyConformance(create, { now: NOW })) it(c.name, c.run);
  });
}
