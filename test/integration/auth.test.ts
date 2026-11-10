import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../src/core/log.ts';
import { startCache, type TestCache } from '../helpers/cache.ts';
import { json, send } from '../helpers/http.ts';

const TOKEN = 'ci-token-0123456789abcdef';
let cache: TestCache;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eyniq-auth-'));
  const tokens = join(dir, 'tokens.json');
  await writeFile(tokens, JSON.stringify({ ci: createHash('sha256').update(TOKEN).digest('hex') }));
  cache = await startCache({ AUTH_TOKENS_PATH: tokens, LOG_LEVEL: 'info' });
  cache.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
});

afterAll(async () => {
  await cache.close();
  await rm(dir, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('slice 5: static token auth', () => {
  it('rejects registry requests without a valid token', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const res = await send(cache.url, { path: '/lodash', headers });
      expect(res.status).toBe(401);
      expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer/);
    }
    expect(cache.upstream.countPath('/lodash')).toBe(0);
  });

  it('serves registry requests with a valid token', async () => {
    expect((await send(cache.url, { path: '/lodash', headers: bearer })).status).toBe(200);
    const tgz = await send(cache.url, { path: '/lodash/-/lodash-4.17.21.tgz', headers: bearer });
    expect(tgz.status).toBe(200);
  });

  it('answers whoami with the token name', async () => {
    const res = await send(cache.url, { path: '/-/whoami', headers: bearer });
    expect(json(res)).toEqual({ username: 'ci' });
    expect((await send(cache.url, { path: '/-/whoami' })).status).toBe(401);
  });

  it('keeps probes and metrics open on the management port', async () => {
    for (const path of ['/livez', '/readyz', '/metrics']) {
      expect((await send(cache.managementUrl, { path })).status).toBe(200);
    }
  });

  it('never logs the token', async () => {
    const logs = captureLogs();
    try {
      await send(cache.url, { path: '/lodash', headers: bearer });
      await send(cache.url, {
        path: '/lodash',
        headers: { authorization: 'Bearer wrong-token-xyz' },
      });
    } finally {
      logs.restore();
    }
    const all = JSON.stringify(logs.lines);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('wrong-token-xyz');
    expect(logs.lines.some((l) => l.type === 'auth.denied')).toBe(true);
  });

  it('refuses to start with an invalid tokens file', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"ci":"plain-text-token"}');
    await expect(startCache({ AUTH_TOKENS_PATH: bad })).rejects.toThrow(/AUTH_TOKENS_PATH/);
  });
});
