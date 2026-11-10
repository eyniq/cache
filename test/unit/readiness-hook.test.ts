import { afterAll, describe, expect, it } from 'vitest';
import type { Storage } from '../../src/core/contracts.ts';
import { LoopMonitor, ReadinessCheck } from '../../src/http/health.ts';

const storage = { check: () => Promise.resolve() } as unknown as Storage;
const monitor = new LoopMonitor();
afterAll(() => {
  monitor.stop();
});

describe('ReadinessCheck edition hook', () => {
  it('is ready without a hook', async () => {
    expect(await new ReadinessCheck(storage, monitor, 1000).check()).toEqual({ ready: true });
  });

  it('is ready when the hook returns null', async () => {
    const r = new ReadinessCheck(storage, monitor, 1000, () => null);
    expect(await r.check()).toEqual({ ready: true });
  });

  it('reports the hook reason as not ready', async () => {
    const r = new ReadinessCheck(storage, monitor, 1000, () => 'too many pods');
    expect(await r.check()).toEqual({ ready: false, reason: 'too many pods' });
  });

  it('treats a throwing hook as no objection', async () => {
    const r = new ReadinessCheck(storage, monitor, 1000, () => {
      throw new Error('boom');
    });
    expect(await r.check()).toEqual({ ready: true });
  });

  it('keeps the storage reason first', async () => {
    const bad = { check: () => Promise.reject(new Error('x')) } as unknown as Storage;
    const r = new ReadinessCheck(bad, monitor, 1000, () => 'hook');
    expect(await r.check()).toEqual({ ready: false, reason: 'storage unreachable' });
  });

  it('ignores an empty, undefined or promise result', async () => {
    for (const bad of [() => '', () => undefined, () => Promise.resolve('x')]) {
      const r = new ReadinessCheck(storage, monitor, 1000, bad as unknown as () => string | null);
      expect(await r.check()).toEqual({ ready: true });
    }
  });
});
