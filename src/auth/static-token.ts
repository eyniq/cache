// Static bearer tokens (DESIGN.md section 11): the file holds { "<name>": "<sha256 hex>" };
// presented tokens are hashed and compared in constant time against every entry. Tokens and
// hashes are never logged, and errors never echo the file contents.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AuthProvider, Identity } from '../core/contracts.ts';

const NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const BEARER = /^Bearer ([\x21-\x7e]{1,4096})$/i;

export function parseTokens(text: string): Map<string, Buffer> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('tokens file is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('tokens file must be a JSON object of name to sha256 hex');
  }
  const tokens = new Map<string, Buffer>();
  for (const [name, hash] of Object.entries(data)) {
    if (!NAME.test(name)) throw new Error('tokens file contains an invalid token name');
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      throw new Error(`token "${name}" must be the sha256 hex of the token, not the token itself`);
    }
    tokens.set(name, Buffer.from(hash, 'hex'));
  }
  if (tokens.size === 0) throw new Error('tokens file contains no tokens');
  return tokens;
}

export function loadTokens(path: string): Map<string, Buffer> {
  return parseTokens(readFileSync(path, 'utf8'));
}

export class StaticTokenAuth implements AuthProvider {
  readonly required: boolean;
  private readonly tokens: Array<[string, Buffer]>;

  /** `required: false` (ANONYMOUS_READ) lets reads through without a token. */
  constructor(tokens: Map<string, Buffer>, opts: { required?: boolean } = {}) {
    this.tokens = [...tokens];
    this.required = opts.required ?? true;
  }

  authenticate(req: IncomingMessage): Promise<Identity | null> {
    const header = req.headers.authorization;
    const m = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!m?.[1]) return Promise.resolve(null);
    const presented = createHash('sha256').update(m[1]).digest();
    // Compare against every entry without an early exit, so timing reveals nothing.
    let match: string | null = null;
    for (const [name, hash] of this.tokens) {
      if (timingSafeEqual(presented, hash) && match === null) match = name;
    }
    return Promise.resolve(match === null ? null : { name: match });
  }
}
