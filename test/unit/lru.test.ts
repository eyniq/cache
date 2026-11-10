import { describe, expect, it } from 'vitest';
import { ByteLru } from '../../src/core/lru.ts';

describe('ByteLru', () => {
  it('stores and returns values', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 10);
    expect(lru.get('a')).toBe('A');
    expect(lru.bytes).toBe(10);
    expect(lru.count).toBe(1);
  });

  it('evicts the least recently used entries until under the byte cap', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 40);
    lru.set('b', 'B', 40);
    lru.get('a'); // a is now most recent
    lru.set('c', 'C', 40);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('A');
    expect(lru.get('c')).toBe('C');
    expect(lru.bytes).toBe(80);
    expect(lru.evictions).toBe(1);
  });

  it('never stores an entry larger than the cap', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 50);
    expect(lru.set('huge', 'H', 101)).toBe(false);
    expect(lru.get('huge')).toBeUndefined();
    expect(lru.get('a')).toBe('A');
  });

  it('replaces an entry and adjusts the byte count', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 30);
    lru.set('a', 'A2', 60);
    expect(lru.get('a')).toBe('A2');
    expect(lru.bytes).toBe(60);
    expect(lru.count).toBe(1);
  });

  it('updates the size of an existing entry and evicts if needed', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 30);
    lru.set('b', 'B', 30);
    lru.resize('b', 90);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.bytes).toBe(90);
  });

  it('deletes entries', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 30);
    lru.delete('a');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.bytes).toBe(0);
  });
});
