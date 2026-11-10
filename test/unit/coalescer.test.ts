import { describe, expect, it } from 'vitest';
import { Coalescer } from '../../src/core/coalescer.ts';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('Coalescer', () => {
  it('runs the task once for concurrent callers of the same key', async () => {
    const c = new Coalescer<number>();
    const d = deferred<number>();
    let calls = 0;
    const task = () => {
      calls++;
      return d.promise;
    };
    const a = c.run('k', task);
    const b = c.run('k', task);
    expect(a.leader).toBe(true);
    expect(b.leader).toBe(false);
    expect(c.size).toBe(1);
    d.resolve(42);
    expect(await a.promise).toBe(42);
    expect(await b.promise).toBe(42);
    expect(calls).toBe(1);
    expect(c.coalesced).toBe(1);
  });

  it('removes the key on settle so the next call runs again', async () => {
    const c = new Coalescer<number>();
    await c.run('k', () => Promise.resolve(1)).promise;
    expect(c.size).toBe(0);
    let calls = 0;
    await c.run('k', () => Promise.resolve(++calls)).promise;
    expect(calls).toBe(1);
  });

  it('shares a rejection with every waiter and then forgets the key', async () => {
    const c = new Coalescer<number>();
    const d = deferred<number>();
    const a = c.run('k', () => d.promise);
    const b = c.run('k', () => d.promise);
    d.reject(new Error('boom'));
    await expect(a.promise).rejects.toThrow('boom');
    await expect(b.promise).rejects.toThrow('boom');
    expect(c.size).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const c = new Coalescer<string>();
    const a = c.run('a', () => Promise.resolve('A'));
    const b = c.run('b', () => Promise.resolve('B'));
    expect(a.leader && b.leader).toBe(true);
    expect([await a.promise, await b.promise]).toEqual(['A', 'B']);
  });

  it('turns a synchronous throw into a shared rejection', async () => {
    const c = new Coalescer<number>();
    const a = c.run('k', () => {
      throw new Error('sync');
    });
    await expect(a.promise).rejects.toThrow('sync');
    expect(c.size).toBe(0);
  });
});
