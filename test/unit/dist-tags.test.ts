import { describe, expect, it } from 'vitest';
import { processMetadata, renderMetadata } from '../../src/adapters/npm/packument.ts';
import { compareVersions, prereleaseChannel } from '../../src/adapters/npm/semver.ts';
import type { ProcessContext, RenderResult } from '../../src/core/contracts.ts';

const versions = ['1.0.0', '1.1.0', '2.0.0', '3.0.0-beta.1', '3.0.0-beta.2', '3.0.0-rc.1'];
const doc = {
  name: 'pkg',
  'dist-tags': { latest: '2.0.0', beta: '3.0.0-beta.2', next: '3.0.0-rc.1', legacy: '1.0.0' },
  versions: Object.fromEntries(
    versions.map((v) => [v, { name: 'pkg', version: v, dist: { shasum: 'a'.repeat(40) } }]),
  ),
  time: {
    modified: '2026-10-15T00:00:00.000Z',
    ...Object.fromEntries(versions.map((v, i) => [v, `2026-0${i + 1}-01T00:00:00.000Z`])),
  },
};
const ctx = (options: Record<string, boolean> = {}): ProcessContext => ({
  name: 'pkg',
  publicBaseUrl: 'https://cache.example',
  upstreamOrigin: 'https://registry.npmjs.org',
  maxBytes: 1 << 20,
  options,
});
const raw = { body: Buffer.from(JSON.stringify(doc)), encoding: 'identity' as const };
const processed = processMetadata(raw, ctx());

function body(r: RenderResult): Record<string, unknown> {
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return JSON.parse(r.body.toString()) as Record<string, unknown>;
}

describe('semver helpers', () => {
  it('orders versions by semver precedence', () => {
    const sorted = [
      '1.0.0',
      '1.0.0-alpha.1',
      '1.0.0-alpha',
      '1.0.0-beta',
      '0.9.9',
      '1.0.0-2',
      '1.0.0-10',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      '0.9.9',
      '1.0.0-2',
      '1.0.0-10',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta',
      '1.0.0',
    ]);
    expect(compareVersions('1.0.0+build.1', '1.0.0')).toBe(0);
    expect(compareVersions('10.0.0', '9.0.0')).toBeGreaterThan(0);
  });

  it('derives the prerelease channel', () => {
    expect(prereleaseChannel('1.0.0')).toBe('');
    expect(prereleaseChannel('3.0.0-beta.2')).toBe('beta');
    expect(prereleaseChannel('3.0.0-rc.1')).toBe('rc');
    expect(prereleaseChannel('1.0.0-0')).toBe('0');
  });
});

describe('dist-tag repointing', () => {
  const allowed = new Set(['1.0.0', '1.1.0', '3.0.0-beta.1']); // 2.0.0, beta.2 and rc.1 blocked

  it('repoints a tag to the newest allowed version of the same channel', () => {
    const out = body(renderMetadata({ processed, allowed, view: 'full' }));
    expect(out['dist-tags']).toEqual({ latest: '1.1.0', beta: '3.0.0-beta.1', legacy: '1.0.0' });
  });

  it('drops a tag when no version of its channel remains', () => {
    const out = body(renderMetadata({ processed, allowed, view: 'abbreviated' }));
    expect(out['dist-tags']).not.toHaveProperty('next');
  });

  it('never repoints the stable latest tag to a prerelease', () => {
    const onlyPre = new Set(['3.0.0-beta.1']);
    const out = body(renderMetadata({ processed, allowed: onlyPre, view: 'full' }));
    expect(out['dist-tags']).toEqual({ beta: '3.0.0-beta.1' });
  });

  it('resolves version documents through repointed tags', () => {
    const v = body(renderMetadata({ processed, allowed, view: 'version', ref: 'latest' }));
    expect(v.version).toBe('1.1.0');
  });

  it('returns 404 naming the policy when every version is blocked', () => {
    const out = renderMetadata({ processed, allowed: new Set(), view: 'full' });
    expect(out.status).toBe(404);
    expect(out.status === 404 && out.error).toMatch(/policy/);
  });
});

describe('ABBREVIATED_INCLUDE_TIME', () => {
  const allowed = new Set(['1.0.0', '1.1.0']);

  it('leaves time out of abbreviated documents by default', () => {
    expect(body(renderMetadata({ processed, allowed, view: 'abbreviated' }))).not.toHaveProperty(
      'time',
    );
  });

  it('adds the filtered time map when the flag is on', () => {
    const withTime = processMetadata(raw, ctx({ abbreviatedIncludeTime: true }));
    const out = body(renderMetadata({ processed: withTime, allowed, view: 'abbreviated' }));
    expect(Object.keys(out.time as object)).toEqual(['modified', '1.0.0', '1.1.0']);
  });
});
