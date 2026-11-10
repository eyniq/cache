// AuthProvider for the community user store: bearer tokens issued to users (eyc_...), with
// the static tokens of AUTH_TOKENS_PATH accepted next to them. A user token is valid while
// its record is active, the user is still in USERS_FILE and the token was issued under the
// user's current generation (users.ts; it changes with every password change): removing a
// user or changing a password ends every token of that user (within the users file reload
// interval), with no clock comparison between the CLI host and the pods. Passwords are never accepted
// on registry requests (no Basic auth): every request would cost a scrypt hash.
import type { IncomingMessage } from 'node:http';
import type { AuthProvider, Identity } from '../core/contracts.ts';
import type { StoredUserToken, UserTokenRecord, UserTokenStore } from './user-tokens.ts';
import { generationOf, type UsersFile } from './users.ts';

const BEARER = /^Bearer ([\x21-\x7e]{1,4096})$/i;

/** Claims of a user-token identity; `via` tells it apart from other identities. */
export interface UserClaims {
  via: 'user-token';
  readonly: boolean;
  /** ISO expiry of the token used: tokens created with it never outlive it. */
  expires: string;
  /** sha256 of the token used (the key `npm token list` shows), for audit events. */
  tokenId: string;
}

export function isUserIdentity(identity: Identity): boolean {
  return identity.claims?.via === 'user-token';
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const m = typeof header === 'string' ? BEARER.exec(header) : null;
  return m?.[1] ?? null;
}

export interface UserAuthOptions {
  users: UsersFile;
  tokens: UserTokenStore;
  /** Static tokens (AUTH_TOKENS_PATH), tried when the bearer is not a valid user token. */
  fallback?: AuthProvider;
  /** Registry routes need an identity (false with ANONYMOUS_READ). */
  required: boolean;
  /** The client's address, for the budget of unknown tokens (UserTokenStore lookups). */
  addressOf?: (req: IncomingMessage) => string | undefined;
}

export class UserAuth implements AuthProvider {
  readonly required: boolean;
  private readonly users: UsersFile;
  private readonly tokens: UserTokenStore;
  private readonly fallback: AuthProvider | undefined;
  private readonly addressOf: ((req: IncomingMessage) => string | undefined) | undefined;

  constructor(opts: UserAuthOptions) {
    this.required = opts.required;
    this.users = opts.users;
    this.tokens = opts.tokens;
    this.fallback = opts.fallback;
    this.addressOf = opts.addressOf;
  }

  /**
   * The identity of a user token, or null; static tokens are not consulted. `address` gives
   * the client's address when a storage read is needed.
   */
  async identify(token: string, address?: () => string | undefined): Promise<Identity | null> {
    const found = await this.tokens.find(token, address);
    return found ? this.identityOf(found) : null;
  }

  /** Whether a token record still stands for its user (exists, same generation). */
  stillValid(record: UserTokenRecord): boolean {
    const user = this.users.get(record.user);
    return user !== undefined && record.generation === generationOf(user);
  }

  private identityOf({ hash, record }: StoredUserToken): Identity | null {
    if (!this.stillValid(record)) return null;
    const claims: UserClaims = {
      via: 'user-token',
      readonly: record.readonly === true,
      expires: record.expires,
      tokenId: hash,
    };
    return { name: record.user, claims: { ...claims } };
  }

  async authenticate(req: IncomingMessage): Promise<Identity | null> {
    const token = bearerToken(req);
    if (token !== null) {
      const addressOf = this.addressOf;
      const identity = await this.identify(token, addressOf ? () => addressOf(req) : undefined);
      if (identity) return identity;
    }
    return this.fallback ? this.fallback.authenticate(req) : null;
  }
}
