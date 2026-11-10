import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/core/token-bucket.ts';

describe('TokenBucket', () => {
  it('allows a burst, then refills at the configured rate', () => {
    const b = new TokenBucket(2, 3, 0);
    expect([b.tryTake(0), b.tryTake(0), b.tryTake(0), b.tryTake(0)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(b.tryTake(400)).toBe(false);
    expect(b.tryTake(500)).toBe(true);
    expect(b.tryTake(500)).toBe(false);
  });

  it('never holds more than the burst and reports a retry delay of at least a second', () => {
    const b = new TokenBucket(1, 2, 0);
    b.tryTake(0);
    b.tryTake(0);
    expect(b.retryAfterSeconds()).toBe(1);
    expect(b.tryTake(1_000_000)).toBe(true);
    expect(b.tryTake(1_000_000)).toBe(true);
    expect(b.tryTake(1_000_000)).toBe(false);
  });
});
