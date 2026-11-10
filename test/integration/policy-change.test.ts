// P4: policies see per-version facts, and a change notification re-filters cached metadata
// at once (before METADATA_TTL), without a new upstream fetch.
import { afterEach, describe, expect, it } from 'vitest';
import type { Policy, PolicyDecision, PolicyInput } from '../../src/core/contracts.ts';
import { json, send } from '../helpers/http.ts';
import { startServer, type TestServer } from '../helpers/server.ts';

class Denylist implements Policy {
  readonly denied = new Set<string>();
  readonly seen: PolicyInput[] = [];
  revision = 0;
  private readonly listeners = new Set<() => void>();

  evaluate(input: PolicyInput): PolicyDecision {
    this.seen.push(input);
    return this.denied.has(`${input.name}@${input.version}`)
      ? { allow: false, reason: 'denied by advisory' }
      : { allow: true };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  deny(spec: string): void {
    this.denied.add(spec);
    this.revision++;
    for (const l of this.listeners) l();
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('P4: policy facts and change notification', () => {
  it('passes facts and origin to the policy', async () => {
    const policy = new Denylist();
    server = await startServer({ deps: { policy } });
    server.upstream.addPackage('scripted', [
      { version: '1.0.0', scripts: { postinstall: 'echo hi' }, deprecated: 'old' },
    ]);
    await send(server.url, { path: '/scripted' });
    expect(policy.seen[0]).toMatchObject({
      name: 'scripted',
      version: '1.0.0',
      origin: 'upstream',
      facts: { hasInstallScript: true, deprecated: true, maintainers: 0 },
    });
  });

  it('re-filters cached metadata and blocks tarballs as soon as the policy changes', async () => {
    const policy = new Denylist();
    server = await startServer({ deps: { policy } });
    server.upstream.addPackage('pkg', [{ version: '1.0.0' }, { version: '1.1.0' }]);
    const before = json(await send(server.url, { path: '/pkg' }));
    expect(Object.keys(before.versions as object)).toEqual(['1.0.0', '1.1.0']);

    policy.deny('pkg@1.1.0');
    const after = await send(server.url, { path: '/pkg' });
    expect(Object.keys(json(after).versions as object)).toEqual(['1.0.0']);
    expect(json(after)['dist-tags']).toEqual({ latest: '1.0.0' });
    expect((await send(server.url, { path: '/pkg/-/pkg-1.1.0.tgz' })).status).toBe(403);
    // Served from the cached document: the change did not cost an upstream fetch.
    expect(server.upstream.countPath('/pkg')).toBe(1);
  });

  it('does not re-evaluate the policy on cache hits when nothing changed', async () => {
    const policy = new Denylist();
    server = await startServer({ deps: { policy } });
    server.upstream.addPackage('pkg', [{ version: '1.0.0' }]);
    await send(server.url, { path: '/pkg' });
    const evaluations = policy.seen.length;
    for (let i = 0; i < 5; i++) await send(server.url, { path: '/pkg' });
    expect(policy.seen.length).toBe(evaluations);
  });
});
