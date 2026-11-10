// npm deprecate in the write path: `npm deprecate` PUTs the whole document back to /:name
// with `deprecated` set on versions; the adapter turns it into a DeprecateRequest so a
// PackageSource does not have to diff documents.
import { describe, expect, it } from 'vitest';
import { parseWriteBody } from '../../src/adapters/npm/publish.ts';
import type { WriteRoute } from '../../src/core/contracts.ts';
import { HttpError } from '../../src/core/errors.ts';

const route: WriteRoute = { kind: 'publish', name: '@acme/lib' };

function doc(versions: Record<string, Record<string, unknown>>, over = {}): Buffer {
  const full: Record<string, unknown> = {};
  for (const [v, extra] of Object.entries(versions)) {
    full[v] = { name: '@acme/lib', version: v, dist: { shasum: 'a'.repeat(40) }, ...extra };
  }
  return Buffer.from(
    JSON.stringify({
      _id: '@acme/lib',
      _rev: '3-mem',
      name: '@acme/lib',
      'dist-tags': { latest: '1.1.0' },
      versions: full,
      ...over,
    }),
  );
}

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  return 0;
}

describe('npm deprecate bodies', () => {
  it('reads a document with deprecated fields as a deprecate request', () => {
    const body = doc({ '1.0.0': { deprecated: 'use 1.1.0' }, '1.1.0': {} });
    expect(parseWriteBody(route, body)).toEqual({
      type: 'deprecate',
      request: {
        ecosystem: 'npm',
        name: '@acme/lib',
        deprecations: { '1.0.0': 'use 1.1.0' },
        rev: '3-mem',
      },
      versions: ['1.0.0', '1.1.0'],
    });
  });

  it('passes an empty message through (npm deprecate pkg@v "" removes it)', () => {
    const body = doc({ '1.0.0': { deprecated: '' } }, { _rev: undefined });
    expect(parseWriteBody(route, body)).toMatchObject({
      type: 'deprecate',
      request: { deprecations: { '1.0.0': '' } },
    });
    expect(parseWriteBody(route, body)).not.toHaveProperty('request.rev');
  });

  it('keeps a document without deprecated fields a retain body (as before)', () => {
    expect(parseWriteBody(route, doc({ '1.0.0': {} }))).toEqual({
      type: 'retain',
      versions: ['1.0.0'],
      rev: '3-mem',
    });
  });

  it('leaves npm unpublish (PUT /:name/-rev/:rev) a retain body even with deprecations', () => {
    const body = doc({ '1.0.0': { deprecated: 'old' } });
    expect(parseWriteBody({ ...route, rev: '3-mem' }, body)).toMatchObject({ type: 'retain' });
  });

  it.each([
    ['a non-string message', { deprecated: true }],
    ['a message with control characters', { deprecated: 'see \u001b[31mhere' }],
    ['a message with bidi overrides', { deprecated: 'safe‮' }],
    ['a message longer than 1024 characters', { deprecated: 'x'.repeat(1025) }],
  ])('marks %s invalid (400 for a source with deprecate, retain otherwise)', (_label, extra) => {
    const out = parseWriteBody(route, doc({ '1.0.0': extra }));
    expect(out).toMatchObject({ type: 'deprecate', versions: ['1.0.0'] });
    expect(out.type === 'deprecate' ? out.invalid : '').toMatch(/printable message/);
  });

  it('refuses a document for another package and marks non-object versions invalid', () => {
    const other = doc({ '1.0.0': { deprecated: 'x' } }, { name: 'other', _id: 'other' });
    expect(status(() => parseWriteBody(route, other))).toBe(400);
    const body = Buffer.from(
      JSON.stringify({ name: '@acme/lib', versions: { '1.0.0': { deprecated: 'x' }, '1.1.0': 7 } }),
    );
    const out = parseWriteBody(route, body);
    expect(out.type === 'deprecate' ? out.invalid : '').toMatch(/not an object/);
  });
});
