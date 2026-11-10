import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVerifier, isBuiltinDigest } from '../../src/artifacts/integrity.ts';

const data = Buffer.from('hello tarball');

describe('integrity verifier', () => {
  it('accepts matching sha512 across chunks', () => {
    const v = createVerifier({
      algorithm: 'sha512',
      hex: createHash('sha512').update(data).digest('hex'),
    });
    v.update(data.subarray(0, 5));
    v.update(data.subarray(5));
    expect(v.matches()).toBe(true);
  });

  it('accepts matching sha1', () => {
    const v = createVerifier({
      algorithm: 'sha1',
      hex: createHash('sha1').update(data).digest('hex'),
    });
    v.update(data);
    expect(v.matches()).toBe(true);
  });

  it('accepts matching sha256', () => {
    const v = createVerifier({
      algorithm: 'sha256',
      hex: createHash('sha256').update(data).digest('hex'),
    });
    v.update(data.subarray(0, 3));
    v.update(data.subarray(3));
    expect(v.matches()).toBe(true);
  });

  it('rejects a sha256 mismatch and a sha256 of the wrong length', () => {
    const wrong = createVerifier({ algorithm: 'sha256', hex: '00'.repeat(32) });
    wrong.update(data);
    expect(wrong.matches()).toBe(false);
    const short = createVerifier({ algorithm: 'sha256', hex: '00'.repeat(20) });
    short.update(data);
    expect(short.matches()).toBe(false);
  });

  it('never accepts an adapter-defined digest (only the adapter can verify it)', () => {
    const v = createVerifier({
      algorithm: 'go-h1',
      hex: createHash('sha256').update(data).digest('hex'),
    });
    v.update(data);
    expect(v.matches()).toBe(false);
    expect(isBuiltinDigest('go-h1')).toBe(false);
    expect(['sha512', 'sha256', 'sha1'].every(isBuiltinDigest)).toBe(true);
  });

  it('rejects a mismatch', () => {
    const v = createVerifier({ algorithm: 'sha512', hex: '00'.repeat(64) });
    v.update(data);
    expect(v.matches()).toBe(false);
  });

  it('rejects a digest of the wrong length', () => {
    const v = createVerifier({ algorithm: 'sha1', hex: 'abc' });
    v.update(data);
    expect(v.matches()).toBe(false);
  });

  it('always reports the computed sha512 for content addressing', () => {
    const v = createVerifier({
      algorithm: 'sha1',
      hex: createHash('sha1').update(data).digest('hex'),
    });
    v.update(data);
    v.matches();
    expect(v.sha512Hex()).toBe(createHash('sha512').update(data).digest('hex'));
  });
});
