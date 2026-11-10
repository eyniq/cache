import { describe, expect, it } from 'vitest';
import { parseAllowlist } from '../../src/policy/allowlist.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';

const H = 3_600_000;
const now = Date.parse('2026-10-15T12:00:00.000Z');
const base = { ecosystem: 'npm', name: 'pkg', version: '1.0.0', now };

const policy = (o: Partial<ConstructorParameters<typeof MinReleaseAgePolicy>[0]> = {}) =>
  new MinReleaseAgePolicy({ minAgeMs: 72 * H, failClosed: true, allowlist: [], ...o });

describe('MinReleaseAgePolicy', () => {
  it('lets locally published versions through unless gateLocal is set (P3)', () => {
    const fresh = { ...base, publishedAt: now - H };
    expect(policy().evaluate({ ...fresh, origin: 'local' }).allow).toBe(true);
    expect(policy().evaluate({ ...fresh, origin: 'upstream' }).allow).toBe(false);
    expect(policy({ gateLocal: true }).evaluate({ ...fresh, origin: 'local' }).allow).toBe(false);
  });

  it('allows versions older than the minimum age', () => {
    expect(policy().evaluate({ ...base, publishedAt: now - 100 * H })).toMatchObject({
      allow: true,
    });
  });

  it('allows a version exactly at the boundary', () => {
    expect(policy().evaluate({ ...base, publishedAt: now - 72 * H }).allow).toBe(true);
  });

  it('blocks younger versions and says when they become allowed', () => {
    const publishedAt = now - 10 * H;
    expect(policy().evaluate({ ...base, publishedAt })).toEqual({
      allow: false,
      reason: 'blocked by minimum release age',
      allowedAfter: publishedAt + 72 * H,
      validUntil: publishedAt + 72 * H,
    });
  });

  it('allows everything when the minimum age is 0', () => {
    const p = policy({ minAgeMs: 0 });
    expect(p.evaluate({ ...base, publishedAt: now }).allow).toBe(true);
    expect(p.evaluate({ ...base, publishedAt: null }).allow).toBe(true);
  });

  it('blocks unknown publish times when failing closed, allows them when failing open', () => {
    const closed = policy().evaluate({ ...base, publishedAt: null });
    expect(closed.allow).toBe(false);
    expect(closed.allow ? '' : closed.reason).toMatch(/unknown publish time/);
    expect(policy({ failClosed: false }).evaluate({ ...base, publishedAt: null }).allow).toBe(true);
  });

  it('treats a publish time in the future as too young', () => {
    expect(policy().evaluate({ ...base, publishedAt: now + H }).allow).toBe(false);
  });

  describe('allowlist', () => {
    const expires = Date.parse('2026-11-01T00:00:00.000Z');
    const allowlist = [{ package: 'pkg', version: '1.0.0', reason: 'security fix', expires }];

    it('allows an allowlisted young version until the entry expires', () => {
      const d = policy({ allowlist }).evaluate({ ...base, publishedAt: now - H });
      expect(d).toEqual({
        allow: true,
        reason: 'allowlisted: security fix',
        allowlisted: true,
        validUntil: expires,
      });
    });

    it('allows an allowlisted version with an unknown publish time', () => {
      expect(policy({ allowlist }).evaluate({ ...base, publishedAt: null }).allow).toBe(true);
    });

    it('is exact per package and version', () => {
      const p = policy({ allowlist });
      expect(p.evaluate({ ...base, version: '1.0.1', publishedAt: now - H }).allow).toBe(false);
      expect(p.evaluate({ ...base, name: 'other', publishedAt: now - H }).allow).toBe(false);
    });

    it('applies an entry only to its own ecosystem (npm when it names none)', () => {
      const p = policy({
        allowlist: [
          ...allowlist,
          { ecosystem: 'pypi', package: 'requests', version: '2.32.0', reason: 'fix', expires },
        ],
      });
      const young = { publishedAt: now - H };
      expect(p.evaluate({ ...base, ...young }).allow).toBe(true);
      expect(p.evaluate({ ...base, ...young, ecosystem: 'pypi' }).allow).toBe(false);
      const pypi = { ecosystem: 'pypi', name: 'requests', version: '2.32.0', now, ...young };
      expect(p.evaluate(pypi).allow).toBe(true);
      expect(p.evaluate({ ...pypi, ecosystem: 'npm' }).allow).toBe(false);
    });

    it('ignores an entry once it has expired', () => {
      const p = policy({ allowlist });
      expect(p.evaluate({ ...base, now: expires, publishedAt: expires - H }).allow).toBe(false);
    });
  });
});

describe('parseAllowlist', () => {
  it('parses entries and separates expired ones', () => {
    const { entries, expired } = parseAllowlist(
      JSON.stringify([
        { package: 'lodash', version: '4.17.22', reason: 'security fix', expires: '2026-11-01' },
        { package: '@s/x', version: '1.0.0', reason: 'old', expires: '2026-01-01' },
      ]),
      now,
    );
    expect(entries).toEqual([
      {
        package: 'lodash',
        version: '4.17.22',
        reason: 'security fix',
        expires: Date.parse('2026-11-01T00:00:00.000Z'),
      },
    ]);
    expect(expired.map((e) => e.package)).toEqual(['@s/x']);
  });

  it("parses an ecosystem and that ecosystem's version syntax", () => {
    const { entries } = parseAllowlist(
      JSON.stringify([
        {
          ecosystem: 'go',
          package: 'golang.org/x/net',
          version: 'v0.30.0',
          reason: 'r',
          expires: '2026-11-01',
        },
        {
          ecosystem: 'pypi',
          package: 'django',
          version: '5.1',
          reason: 'r',
          expires: '2026-11-01',
        },
        {
          ecosystem: 'oci',
          package: 'library/node',
          version: '22-alpine',
          reason: 'r',
          expires: '2026-11-01',
        },
        {
          ecosystem: 'maven',
          package: 'org.slf4j:slf4j-api',
          version: '2.0.16',
          reason: 'r',
          expires: '2026-11-01',
        },
      ]),
      now,
    );
    expect(entries.map((e) => `${e.ecosystem}:${e.package}@${e.version}`)).toEqual([
      'go:golang.org/x/net@v0.30.0',
      'pypi:django@5.1',
      'oci:library/node@22-alpine',
      'maven:org.slf4j:slf4j-api@2.0.16',
    ]);
  });

  it('keeps npm entries without an ecosystem exactly as before', () => {
    const { entries } = parseAllowlist(
      '[{"package":"x","version":"1.0.0","reason":"r","expires":"2026-11-01"}]',
      now,
    );
    expect(entries[0]).not.toHaveProperty('ecosystem');
  });

  it.each([
    ['not JSON', '{'],
    [
      'an invalid ecosystem',
      '[{"ecosystem":"Go!","package":"x","version":"1.0.0","reason":"x","expires":"2027-01-01"}]',
    ],
    [
      'a version with a path',
      '[{"ecosystem":"go","package":"x","version":"../v1","reason":"x","expires":"2027-01-01"}]',
    ],
    [
      'a semver-less npm version',
      '[{"ecosystem":"npm","package":"x","version":"1.0","reason":"x","expires":"2027-01-01"}]',
    ],
    ['not an array', '{}'],
    [
      'a colon in an npm name',
      '[{"package":"foo:bar","version":"1.0.0","reason":"x","expires":"2027-01-01"}]',
    ],
    ['missing package', '[{"version":"1.0.0","reason":"x","expires":"2027-01-01"}]'],
    ['invalid name', '[{"package":"../x","version":"1.0.0","reason":"x","expires":"2027-01-01"}]'],
    ['invalid version', '[{"package":"x","version":"latest","reason":"x","expires":"2027-01-01"}]'],
    ['missing reason', '[{"package":"x","version":"1.0.0","expires":"2027-01-01"}]'],
    ['invalid date', '[{"package":"x","version":"1.0.0","reason":"x","expires":"soon"}]'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseAllowlist(text, now)).toThrow();
  });
});
