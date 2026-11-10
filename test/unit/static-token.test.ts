import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { StaticTokenAuth, parseTokens } from '../../src/auth/static-token.ts';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const req = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;

describe('parseTokens', () => {
  it('parses name to sha256 mappings', () => {
    const tokens = parseTokens(JSON.stringify({ ci: sha('a'), laptop: sha('b').toUpperCase() }));
    expect([...tokens.keys()]).toEqual(['ci', 'laptop']);
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[]'],
    ['empty', '{}'],
    ['not a sha256', '{"ci":"abc"}'],
    ['plain-text token by mistake', '{"ci":"my-secret-token"}'],
    ['bad name', '{"c i":"' + 'a'.repeat(64) + '"}'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseTokens(text)).toThrow();
  });

  it('never echoes file contents in errors', () => {
    try {
      parseTokens('{"ci":"my-secret-token"}');
    } catch (err) {
      expect((err as Error).message).not.toContain('my-secret-token');
    }
  });
});

describe('StaticTokenAuth', () => {
  const auth = new StaticTokenAuth(parseTokens(JSON.stringify({ ci: sha('s3cr3t') })));

  it('is required', () => {
    expect(auth.required).toBe(true);
  });

  it('accepts a matching bearer token and names the identity', async () => {
    expect(await auth.authenticate(req('Bearer s3cr3t'))).toEqual({ name: 'ci' });
    expect(await auth.authenticate(req('bearer s3cr3t'))).toEqual({ name: 'ci' });
  });

  it.each([
    undefined,
    'Bearer wrong',
    'Bearer ',
    'Basic czNjcjN0',
    's3cr3t',
    'Bearer s3cr3t extra',
  ])('rejects %j', async (header) => {
    expect(await auth.authenticate(req(header))).toBeNull();
  });
});
