import { describe, expect, it, vi } from 'vitest';
import { processMetadata } from '../../src/adapters/npm/packument.ts';
import {
  composeSearch,
  parseSearchQuery,
  parseSearchUpstream,
} from '../../src/adapters/npm/search.ts';
import type {
  ProcessContext,
  SearchComposeInput,
  SearchPackageView,
  SearchQuery,
} from '../../src/core/contracts.ts';

describe('parseSearchQuery', () => {
  it('forwards text, size and from in a canonical order and fills defaults', () => {
    expect(parseSearchQuery('?size=5&text=left%20pad')).toEqual({
      text: 'left pad',
      size: 5,
      from: 0,
      upstreamPath: '/-/v1/search?text=left+pad&size=5',
    });
    expect(parseSearchQuery('')).toMatchObject({
      text: '',
      size: 20,
      from: 0,
      upstreamPath: '/-/v1/search?text=',
    });
  });

  it('keeps the ranking weights and drops unknown parameters', () => {
    expect(
      parseSearchQuery('?text=x&quality=0.5&popularity=1&maintenance=0&evil=1&token=abc')
        ?.upstreamPath,
    ).toBe('/-/v1/search?text=x&quality=0.5&popularity=1&maintenance=0');
  });

  it.each([
    '?size=0',
    '?size=251',
    '?size=-1',
    '?size=1e2',
    '?size=abc',
    '?from=10001',
    '?from=-1',
    '?quality=2',
    '?quality=abc',
    '?quality=0.1234567',
    '?text=a&text=b',
    '?size=1&size=2',
    `?text=${'a'.repeat(513)}`,
  ])('refuses %s', (q) => {
    expect(parseSearchQuery(q)).toBeNull();
  });
});

const ctx: ProcessContext = {
  name: 'pkg',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 1 << 20,
  options: {},
};

function view(versions: string[], tags: Record<string, string>, allowed: string[]) {
  const doc = {
    name: 'pkg',
    'dist-tags': tags,
    versions: Object.fromEntries(
      versions.map((v) => [v, { name: 'pkg', version: v, dist: { shasum: 'a'.repeat(40) } }]),
    ),
    time: Object.fromEntries(versions.map((v, i) => [v, `2026-0${i + 1}-01T00:00:00.000Z`])),
  };
  const processed = processMetadata(
    { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' },
    ctx,
  );
  return { processed, allowed: new Set(allowed) } satisfies SearchPackageView;
}

interface Composed {
  objects: Array<{ package: { name: string; version: string; date?: string; scope?: string } }>;
  total: number;
}
const query: SearchQuery = { text: 'x', size: 20, from: 0, upstreamPath: '/-/v1/search?text=x' };
const hit = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  package: { name, version, date: '2026-01-01T00:00:00.000Z', links: { npm: 'x' } },
  score: { final: 0.5 },
  searchScore: 1,
  ...extra,
});
const upstreamBody = (objects: unknown[], total = objects.length) =>
  Buffer.from(JSON.stringify({ objects, total, time: 'Mon' }));

function compose(
  over: Partial<Omit<SearchComposeInput, 'upstream'>> & { upstream?: Buffer | null },
): Composed | null {
  const { upstream = upstreamBody([]), ...rest } = over;
  const out = composeSearch({
    query,
    upstream: upstream === null ? null : parseSearchUpstream(upstream),
    local: [],
    view: () => null,
    isOwned: () => false,
    isBlocked: () => false,
    ...rest,
  });
  return out ? (JSON.parse(out.toString()) as Composed) : null;
}

describe('composeSearch', () => {
  it('passes unknown packages and extra fields through untouched', () => {
    const res = compose({ upstream: upstreamBody([hit('a', '1.0.0')], 99) });
    expect(res?.objects).toEqual([hit('a', '1.0.0')]);
    expect(res?.total).toBe(99);
  });

  it('keeps the version of a cached package when the policy allows it', () => {
    const v = view(['1.0.0', '2.0.0'], { latest: '2.0.0' }, ['1.0.0', '2.0.0']);
    expect(
      compose({ upstream: upstreamBody([hit('pkg', '2.0.0')]), view: () => v })?.objects[0]?.package
        .version,
    ).toBe('2.0.0');
  });

  it('rewrites a blocked version to the newest allowed one, with its date', () => {
    const v = view(['1.0.0', '1.5.0', '2.0.0'], { latest: '2.0.0' }, ['1.0.0', '1.5.0']);
    const res = compose({ upstream: upstreamBody([hit('pkg', '2.0.0')]), view: () => v });
    expect(res?.objects[0]?.package).toMatchObject({
      version: '1.5.0',
      date: '2026-02-01T00:00:00.000Z',
    });
  });

  it('does not move a stable result onto a prerelease', () => {
    const v = view(['1.0.0', '2.0.0-beta.1', '2.0.0'], { latest: '2.0.0' }, ['2.0.0-beta.1']);
    const res = compose({
      upstream: upstreamBody([hit('pkg', '2.0.0'), hit('other', '1.0.0')], 2),
      view: (n) => (n === 'pkg' ? v : null),
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['other']);
    expect(res?.total).toBe(1);
  });

  it('drops results whose package has no allowed version', () => {
    const v = view(['1.0.0'], { latest: '1.0.0' }, []);
    const res = compose({ upstream: upstreamBody([hit('pkg', '1.0.0')], 10), view: () => v });
    expect(res).toMatchObject({ objects: [], total: 9 });
  });

  it('drops upstream results for names the source owns and malformed results', () => {
    const res = compose({
      upstream: upstreamBody(
        [hit('@acme/lib', '1.0.0'), { nope: 1 }, hit('ok', '1.0.0'), 5, null],
        5,
      ),
      isOwned: (n) => n.startsWith('@acme/'),
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['ok']);
  });

  it('puts local hits first on the first page, trims to size and counts them in total', () => {
    const res = compose({
      query: { ...query, size: 2 },
      upstream: upstreamBody([hit('a', '1.0.0'), hit('b', '1.0.0')], 40),
      local: [{ name: '@acme/lib', version: '1.2.3', description: 'private', keywords: ['k'] }],
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['@acme/lib', 'a']);
    expect(res?.objects[0]?.package).toMatchObject({
      scope: 'acme',
      version: '1.2.3',
      description: 'private',
      keywords: ['k'],
    });
    expect(res?.total).toBe(41);
  });

  it('gives local hits the maintainers list npm search reads', () => {
    const res = compose({
      upstream: null,
      local: [
        { name: 'priv', version: '1.0.0', publisher: 'alice' },
        { name: 'anon', version: '1.0.0' },
      ],
    });
    const pkgs = res?.objects.map((o) => o.package as unknown as { maintainers: unknown });
    expect(pkgs?.map((p) => p.maintainers)).toEqual([[{ username: 'alice' }], []]);
  });

  it('adds local hits only to the first page', () => {
    const res = compose({
      query: { ...query, from: 20 },
      upstream: upstreamBody([hit('a', '1.0.0')], 40),
      local: [{ name: 'priv', version: '1.0.0' }],
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['a']);
    expect(res?.total).toBe(41);
  });

  it('ignores invalid local hits', () => {
    const res = compose({
      local: [
        { name: 'Bad Name', version: '1.0.0' },
        { name: 'ok', version: 'latest' },
        { name: 'fine', version: '1.0.0' },
      ],
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['fine']);
  });

  it('serves local hits alone when upstream failed or sent garbage', () => {
    const local = [{ name: 'priv', version: '1.0.0' }];
    expect(compose({ upstream: null, local })?.objects).toHaveLength(1);
    expect(compose({ upstream: Buffer.from('not json'), local })?.total).toBe(1);
    expect(compose({ upstream: Buffer.from('{"objects":"x"}'), local })?.objects).toHaveLength(1);
  });

  it('has nothing to answer without upstream and local hits', () => {
    expect(compose({ upstream: null })).toBeNull();
    expect(compose({ upstream: Buffer.from('not json') })).toBeNull();
    expect(compose({ upstream: Buffer.from('[]') })).toBeNull();
    expect(compose({ upstream: Buffer.from('{"total":1}') })).toBeNull();
  });
});

describe('parseSearchUpstream and cache hits', () => {
  it('parses once: composing a parsed result does not call JSON.parse', () => {
    const parsed = parseSearchUpstream(upstreamBody([hit('a', '1.0.0'), hit('b', '1.0.0')], 5));
    expect(parsed).not.toBeNull();
    const outputs: Buffer[] = [];
    const spy = vi.spyOn(JSON, 'parse');
    try {
      for (let i = 0; i < 3; i++) {
        const out = composeSearch({
          query,
          upstream: parsed,
          local: [],
          view: () => null,
          isOwned: (n) => n === 'b',
          isBlocked: () => false,
        });
        if (out) outputs.push(out);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    for (const out of outputs) {
      const body = JSON.parse(out.toString()) as Composed;
      expect(body.objects.map((o) => o.package.name)).toEqual(['a']);
    }
    // The shared parsed value was not mutated by per-request filtering.
    expect(parsed?.objects).toHaveLength(2);
  });

  it.each(['not json', '[]', '{"total":1}', '{"objects":"x"}'])('rejects %s', (body) => {
    expect(parseSearchUpstream(Buffer.from(body))).toBeNull();
  });

  it('drops blocked packages by name even when the metadata cache has nothing', () => {
    const res = compose({
      upstream: upstreamBody([hit('gone', '1.0.0'), hit('ok', '1.0.0')], 2),
      isBlocked: (n) => n === 'gone',
    });
    expect(res?.objects.map((o) => o.package.name)).toEqual(['ok']);
    expect(res?.total).toBe(1);
  });
});
