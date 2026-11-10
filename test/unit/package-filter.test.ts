import { describe, expect, it } from 'vitest';
import {
  PackageFilterPolicy,
  broadAllowRules,
  parseFilterRules,
} from '../../src/adapters/npm/package-filter.ts';
import { composePolicies } from '../../src/policy/compose.ts';
import { MinReleaseAgePolicy } from '../../src/policy/min-release-age.ts';

const H = 3_600_000;
const now = Date.parse('2026-10-15T12:00:00.000Z');
const input = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  ecosystem: 'npm',
  name,
  version,
  publishedAt: now - 1000 * H,
  now,
  ...extra,
});
const policy = (rules: unknown) => new PackageFilterPolicy(parseFilterRules(JSON.stringify(rules)));

describe('parseFilterRules', () => {
  it('accepts an empty rule set and an empty object', () => {
    expect(parseFilterRules('{}')).toEqual({ block: [], allow: [] });
    expect(parseFilterRules('{"block":[],"allow":[]}')).toEqual({ block: [], allow: [] });
  });

  it('gives rules default ids by position and keeps explicit ids and reasons', () => {
    const r = parseFilterRules(
      JSON.stringify({
        block: [{ package: 'a' }, { id: 'no-b', package: 'b', reason: 'abandoned' }],
        allow: [{ package: 'c' }],
      }),
    );
    expect(r.block.map((x) => x.id)).toEqual(['block-1', 'no-b']);
    expect(r.block[1]?.reason).toBe('abandoned');
    expect(r.allow.map((x) => x.id)).toEqual(['allow-1']);
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['[]', 'must be a JSON object'],
    ['{"blok":[]}', 'unknown key "blok"'],
    ['{"block":{}}', '"block" must be an array'],
    ['{"block":[1]}', 'block rule 1 is not an object'],
    ['{"block":[{}]}', '"package" is required'],
    ['{"block":[{"package":"Bad Name"}]}', 'invalid "package"'],
    ['{"block":[{"package":"@scope/"}]}', 'invalid "package"'],
    ['{"block":[{"package":"a/b"}]}', 'invalid "package"'],
    ['{"block":[{"package":"*x*"}]}', 'invalid "package"'],
    ['{"block":[{"package":"a**"}]}', 'invalid "package"'],
    ['{"block":[{"package":"a","versions":"nope"}]}', 'invalid "versions"'],
    ['{"block":[{"package":"a","versions":"1.0.0 ||"}]}', 'empty alternative'],
    ['{"block":[{"package":"a","versions":"|| 1.0.0"}]}', 'empty alternative'],
    ['{"block":[{"package":"@Scope/*"}]}', 'invalid "package"'],
    ['{"block":[{"package":"Foo*"}]}', 'invalid "package"'],
    ['{"block":[{"package":"a","versions":5}]}', '"versions" must be a string'],
    ['{"block":[{"package":"a","extra":1}]}', 'unknown key "extra"'],
    ['{"block":[{"package":"a","reason":"x\\ny"}]}', 'invalid "reason"'],
    ['{"block":[{"package":"a","id":"has space"}]}', 'invalid "id"'],
    [
      '{"block":[{"id":"x","package":"a"}],"allow":[{"id":"x","package":"b"}]}',
      'duplicate rule id "x"',
    ],
  ])('rejects %s', (text, message) => {
    expect(() => parseFilterRules(text)).toThrow(message);
  });

  it('reports the rule that has the problem', () => {
    expect(() =>
      parseFilterRules('{"allow":[{"package":"a"},{"package":"b","versions":"^"}]}'),
    ).toThrow(/allow rule 2/);
  });

  it('refuses too many rules', () => {
    const block = Array.from({ length: 10_001 }, (_, i) => ({ package: `p${i}` }));
    expect(() => parseFilterRules(JSON.stringify({ block }))).toThrow(/too many/);
  });
});

describe('PackageFilterPolicy', () => {
  it('blocks a package by name, every version, naming the rule', () => {
    const p = policy({ block: [{ id: 'no-left-pad', package: 'left-pad' }] });
    expect(p.evaluate(input('left-pad', '1.3.0'))).toEqual({
      allow: false,
      reason: 'blocked by package filter rule "no-left-pad"',
    });
    expect(p.evaluate(input('other', '1.0.0'))).toEqual({ allow: true });
  });

  it('adds the operator reason to the denial', () => {
    const p = policy({ block: [{ package: 'a', reason: 'license problem' }] });
    expect(p.evaluate(input('a', '1.0.0'))).toMatchObject({
      allow: false,
      reason: 'blocked by package filter rule "block-1": license problem',
    });
  });

  it('blocks by version range only', () => {
    const p = policy({ block: [{ package: 'a', versions: '>=1.2.0 <1.2.5 || 3.x' }] });
    expect(p.evaluate(input('a', '1.1.9')).allow).toBe(true);
    expect(p.evaluate(input('a', '1.2.0')).allow).toBe(false);
    expect(p.evaluate(input('a', '1.2.4')).allow).toBe(false);
    expect(p.evaluate(input('a', '1.2.5')).allow).toBe(true);
    expect(p.evaluate(input('a', '3.4.5')).allow).toBe(false);
    expect(p.evaluate(input('a', '3.1.0-rc.1')).allow).toBe(false);
  });

  it('matches a scope wildcard, a prefix wildcard and "*"', () => {
    const p = policy({
      block: [{ package: '@evil/*' }, { package: 'event-*' }],
    });
    expect(p.evaluate(input('@evil/one', '1.0.0')).allow).toBe(false);
    expect(p.evaluate(input('@evil-twin/one', '1.0.0')).allow).toBe(true);
    expect(p.evaluate(input('@good/one', '1.0.0')).allow).toBe(true);
    expect(p.evaluate(input('event-stream', '3.3.6')).allow).toBe(false);
    expect(p.evaluate(input('events', '3.3.6')).allow).toBe(true);
    const all = policy({ block: [{ package: '*', versions: '<1.0.0' }] });
    expect(all.evaluate(input('x', '0.1.0')).allow).toBe(false);
    expect(all.evaluate(input('x', '1.0.0')).allow).toBe(true);
  });

  it('is case sensitive and does not treat names as patterns', () => {
    const p = policy({ block: [{ package: 'a.b' }] });
    expect(p.evaluate(input('axb', '1.0.0')).allow).toBe(true);
    expect(p.evaluate(input('A.b', '1.0.0')).allow).toBe(true);
  });

  it('ignores other ecosystems', () => {
    const p = policy({ block: [{ package: 'a' }] });
    expect(p.evaluate({ ...input('a', '1.0.0'), ecosystem: 'pypi' }).allow).toBe(true);
  });

  it('lets an allow rule override a block rule and says so', () => {
    const p = policy({
      block: [{ package: 'a', versions: '<2.0.0' }],
      allow: [{ id: 'pinned', package: 'a', versions: '1.5.0', reason: 'reviewed' }],
    });
    expect(p.evaluate(input('a', '1.4.0')).allow).toBe(false);
    expect(p.evaluate(input('a', '1.5.0'))).toEqual({
      allow: true,
      allowlisted: true,
      reason: 'package filter allow rule "pinned": reviewed',
    });
  });

  it('lets an allow rule override the minimum release age gate through composePolicies', () => {
    const rules = parseFilterRules(
      JSON.stringify({ allow: [{ package: 'fresh', versions: '2.0.0', reason: 'hotfix' }] }),
    );
    const filter = new PackageFilterPolicy(rules);
    const gate = new MinReleaseAgePolicy({
      minAgeMs: 72 * H,
      failClosed: true,
      allowlist: [],
      exempt: (i) => filter.exemption(i),
    });
    const chain = composePolicies(filter, gate);
    const young = { publishedAt: now - H };
    expect(chain.evaluate(input('fresh', '2.0.0', young))).toMatchObject({
      allow: true,
      allowlisted: true,
    });
    expect(chain.evaluate(input('fresh', '2.0.1', young)).allow).toBe(false);
    expect(chain.evaluate(input('other', '2.0.0', young)).allow).toBe(false);
    expect(chain.evaluate(input('fresh', '2.0.0', { publishedAt: null })).allow).toBe(true);
  });

  it('does not let an allow rule skip a later policy in the chain', () => {
    const filter = policy({ allow: [{ package: 'a' }] });
    const later = {
      evaluate: () => ({ allow: false as const, reason: 'advisory' }),
    };
    expect(composePolicies(filter, later).evaluate(input('a', '1.0.0')).allow).toBe(false);
  });

  it('a block rule still beats the age gate allowing the version', () => {
    const filter = policy({ block: [{ package: 'a', versions: '1.0.0' }] });
    const chain = composePolicies(
      filter,
      new MinReleaseAgePolicy({ minAgeMs: 72 * H, failClosed: true, allowlist: [] }),
    );
    expect(chain.evaluate(input('a', '1.0.0'))).toMatchObject({
      allow: false,
      reason: 'blocked by package filter rule "block-1"',
    });
  });

  it('matches thousands of rules without scanning all of them per name', () => {
    const block = Array.from({ length: 5000 }, (_, i) => ({ package: `pkg-${i}` }));
    const p = policy({ block });
    const t = Date.now();
    for (let i = 0; i < 20_000; i++) p.evaluate(input('some-other', '1.0.0'));
    expect(Date.now() - t).toBeLessThan(500);
    expect(p.evaluate(input('pkg-4999', '1.0.0')).allow).toBe(false);
  });
});

describe('versions outside the version grammar', () => {
  it('a block rule with a range matches them (fails closed)', () => {
    const p = policy({ block: [{ package: 'a', versions: '>=1.0.0 <2.0.0' }] });
    expect(p.evaluate(input('a', 'not-a-version')).allow).toBe(false);
    expect(p.evaluate(input('a', '1.5.0-01')).allow).toBe(false);
    expect(p.evaluate(input('a', '1.5.0-1234567890123456')).allow).toBe(false);
    expect(p.evaluate(input('a', '2.0.0')).allow).toBe(true);
  });

  it('an allow rule with a range does not match them', () => {
    const p = policy({
      block: [{ package: 'a' }],
      allow: [{ package: 'a', versions: '>=1.0.0' }],
    });
    expect(p.evaluate(input('a', 'not-a-version')).allow).toBe(false);
    expect(p.exemption(input('a', 'not-a-version'))).toBeNull();
    expect(p.evaluate(input('a', '1.5.0-01')).allow).toBe(true);
  });

  it('every generated valid version gets a definite answer from block and allow rules', () => {
    const p = policy({
      block: [{ package: 'a', versions: '>=1.0.0 <2.0.0' }],
      allow: [{ package: 'a', versions: '1.x' }],
    });
    for (const pre of ['01', '00', '0001-0', '1234567890123456', '9'.repeat(40), 'a'.repeat(150)]) {
      const v = `1.5.0-${pre}`;
      expect(p.evaluate(input('a', v))).toMatchObject({ allow: true, allowlisted: true });
    }
  });
});

describe('broadAllowRules', () => {
  it('lists allow rules that lift the age gate for a whole class of packages', () => {
    const r = parseFilterRules(
      JSON.stringify({
        allow: [
          { id: 'all', package: '*' },
          { id: 'scope', package: '@acme/*' },
          { id: 'scoped-versions', package: '@acme/*', versions: '1.x' },
          { id: 'exact', package: 'left-pad' },
        ],
      }),
    );
    expect(broadAllowRules(r).map((x) => x.id)).toEqual(['all', 'scope']);
  });
});

describe('blocksWholePackage', () => {
  it('is true only for name-level blocks that no allow rule could lift', () => {
    const p = policy({
      block: [
        { package: 'left-pad' },
        { package: '@evil/*' },
        { package: 'ranged', versions: '<2.0.0' },
        { package: 'rescued' },
        { package: 'part-rescued' },
      ],
      allow: [
        { package: 'rescued' },
        { package: 'part-rescued', versions: '1.x' },
        { package: '@evil/ok' },
      ],
    });
    expect(p.blocksWholePackage('npm', 'left-pad')).toBe(true);
    expect(p.blocksWholePackage('npm', '@evil/thing')).toBe(true);
    expect(p.blocksWholePackage('npm', '@evil/ok')).toBe(false);
    expect(p.blocksWholePackage('npm', 'ranged')).toBe(false);
    expect(p.blocksWholePackage('npm', 'rescued')).toBe(false);
    expect(p.blocksWholePackage('npm', 'part-rescued')).toBe(false);
    expect(p.blocksWholePackage('npm', 'unrelated')).toBe(false);
  });
});
