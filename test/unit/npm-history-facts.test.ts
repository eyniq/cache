// Version-history facts of the npm adapter: previousPublisher and publisherFirstSeen, which a
// per-version Policy.evaluate cannot compute itself (it sees one version at a time).
import { describe, expect, it } from 'vitest';
import { processMetadata } from '../../src/adapters/npm/packument.ts';
import type { ProcessContext, VersionInfo } from '../../src/core/contracts.ts';

const ctx: ProcessContext = {
  name: 'pkg',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 10 * 1024 * 1024,
  options: {},
};

/** [version, publisher (or null for no _npmUser), ISO publish time (or null)] */
type Row = [string, string | null, string | null];

function process(rows: Row[]): Map<string, VersionInfo> {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const [version, publisher, at] of rows) {
    versions[version] = {
      name: 'pkg',
      version,
      ...(publisher !== null ? { _npmUser: { name: publisher, email: 'x@example.com' } } : {}),
      dist: { tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz` },
    };
    if (at !== null) time[version] = at;
  }
  const body = Buffer.from(JSON.stringify({ name: 'pkg', versions, time }));
  const p = processMetadata({ body, encoding: 'identity' }, ctx);
  return new Map(p.versions.map((v) => [v.version, v]));
}

const facts = (m: Map<string, VersionInfo>, v: string) => m.get(v)?.facts;

describe('npm version-history facts', () => {
  it('names the publisher of the closest earlier version by semver precedence', () => {
    // Document order and publish order deliberately differ from semver order: a backport
    // (1.0.1) published after 2.0.0 still follows 1.0.0.
    const m = process([
      ['2.0.0', 'bob', '2020-03-01T00:00:00.000Z'],
      ['1.0.0', 'alice', '2020-01-01T00:00:00.000Z'],
      ['1.0.1', 'mallory', '2020-04-01T00:00:00.000Z'],
      ['2.0.0-rc.1', 'bob', '2020-02-01T00:00:00.000Z'],
    ]);
    expect(facts(m, '1.0.0')?.previousPublisher).toBeNull();
    expect(facts(m, '1.0.1')?.previousPublisher).toBe('alice');
    expect(facts(m, '2.0.0-rc.1')?.previousPublisher).toBe('mallory');
    expect(facts(m, '2.0.0')?.previousPublisher).toBe('bob');
  });

  it('dates the first version of each publisher (by publish time, not semver)', () => {
    const m = process([
      ['1.0.0', 'alice', '2020-01-01T00:00:00.000Z'],
      ['1.1.0', 'bob', '2021-06-01T00:00:00.000Z'],
      ['1.0.1', 'bob', '2021-05-01T00:00:00.000Z'],
      ['1.2.0', 'alice', '2022-01-01T00:00:00.000Z'],
    ]);
    expect(facts(m, '1.0.0')?.publisherFirstSeen).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
    expect(facts(m, '1.2.0')?.publisherFirstSeen).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
    expect(facts(m, '1.1.0')?.publisherFirstSeen).toBe(Date.parse('2021-05-01T00:00:00.000Z'));
    expect(facts(m, '1.0.1')?.publisherFirstSeen).toBe(Date.parse('2021-05-01T00:00:00.000Z'));
  });

  it('answers null when the publisher or the publish times are unknown', () => {
    const m = process([
      ['1.0.0', null, '2020-01-01T00:00:00.000Z'],
      ['1.1.0', 'carol', null],
      ['1.2.0', 'dave', '2020-03-01T00:00:00.000Z'],
    ]);
    // The closest earlier version has no publisher: null, not a skip to an older one.
    expect(facts(m, '1.1.0')?.previousPublisher).toBeNull();
    expect(facts(m, '1.2.0')?.previousPublisher).toBe('carol');
    expect(facts(m, '1.0.0')?.publisherFirstSeen).toBeNull();
    // carol has no version with a known publish time.
    expect(facts(m, '1.1.0')?.publisherFirstSeen).toBeNull();
    expect(facts(m, '1.2.0')?.publisherFirstSeen).toBe(Date.parse('2020-03-01T00:00:00.000Z'));
  });

  it('orders versions that differ only in build metadata by their string, not key order', () => {
    const rows = (order: string[]): Row[] =>
      order.map((v, i) => [v, `p${v}`, new Date(1e12 + i).toISOString()] as Row);
    const a = process(rows(['1.0.0+b', '1.0.0+a', '1.0.1']));
    const b = process(rows(['1.0.1', '1.0.0+a', '1.0.0+b']));
    for (const m of [a, b]) {
      expect(facts(m, '1.0.0+a')?.previousPublisher).toBeNull();
      expect(facts(m, '1.0.0+b')?.previousPublisher).toBe('p1.0.0+a');
      expect(facts(m, '1.0.1')?.previousPublisher).toBe('p1.0.0+b');
    }
  });

  it('stays fast on documents with thousands of versions', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push([`1.${i}.0`, i % 2 ? 'odd' : 'even', new Date(1e12 + i * 1000).toISOString()]);
    }
    const started = performance.now();
    const m = process(rows);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(facts(m, '1.4999.0')?.previousPublisher).toBe('even');
    expect(facts(m, '1.1.0')?.publisherFirstSeen).toBe(1e12 + 1000);
  });
});
