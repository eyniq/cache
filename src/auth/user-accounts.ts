// AccountProvider of the community user store (C3): npm password login (`npm login
// --auth-type=legacy`, and npm's automatic fallback when web login is not offered), optional
// self-registration (`npm adduser`), `npm token list|create|revoke` and `npm logout`.
// - Every failure is the core's one indistinguishable 401. Unknown names cost the same scrypt
//   work as a wrong password (burnPasswordCheck), and LoginLimiter counts them alike. A full
//   scrypt queue answers 503 (retry later), never 401: the client did nothing wrong.
// - Every check reserves its attempt in LoginLimiter first; throttled attempts fail without
//   a password check (and without counting again).
// - Self-registration is off by default; when on, a new name with an acceptable password is
//   created read-only (`packages: []`) while the file holds fewer than `maxUsers` users. A
//   refused registration costs the same scrypt work as a login.
// - Tokens carry the user's generation from the record the password was checked against. A
//   user holds at most MAX_TOKENS_PER_USER tokens from `npm token create` (more are refused)
//   and as many from logins (a login beyond that revokes the user's oldest login token).
// - A created token never outlives the token used to create it, a read-only token creates
//   only read-only tokens and deletes only read-only tokens, and creating one needs the
//   account password (so a stolen token cannot mint fresh ones).
// - CIDR-restricted tokens are refused (behind an ingress the source address is not the
//   client's), never silently ignored.
import { HttpError } from '../core/errors.ts';
import type {
  AccountContext,
  AccountProvider,
  AccountToken,
  Identity,
  TokenCreateRequest,
  UserLoginRequest,
} from '../core/contracts.ts';
import { errorFields, log } from '../core/log.ts';
import type { LoginLimiter } from './login-limiter.ts';
import {
  PasswordBusyError,
  burnPasswordCheck,
  checkPasswordPolicy,
  hashParams,
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from './password.ts';
import { isUserIdentity } from './user-auth.ts';
import {
  hashToken,
  isTokenHash,
  isUserToken,
  RevocationLimitedError,
  type StoredUserToken,
  type UserTokenStore,
} from './user-tokens.ts';
import {
  generationOf,
  isValidUserName,
  nextGeneration,
  type UserRecord,
  type UsersFile,
} from './users.ts';

/**
 * Active tokens from `npm token create` one user may hold (creating more is refused), and
 * active tokens from logins (a login beyond it revokes the user's oldest login token).
 */
export const MAX_TOKENS_PER_USER = 100;
const DAY_MS = 86_400_000;

export interface UserAccountsOptions {
  users: UsersFile;
  tokens: UserTokenStore;
  limiter: LoginLimiter;
  /** Lifetime of tokens issued by a login, and the longest lifetime of created tokens. */
  tokenTtlMs: number;
  /** Self-registration through npm adduser. */
  registration: { enabled: boolean; maxUsers: number };
  /** For tests; production uses DEFAULT_SCRYPT. */
  hashParams?: ScryptParams;
  /** For tests; production uses MAX_TOKENS_PER_USER. */
  maxTokensPerUser?: number;
  /** Tokens of users removed or changed since are refused (UserAuth.stillValid). */
  stillValid: (record: StoredUserToken['record']) => boolean;
}

const invalid = (): HttpError => new HttpError(401, 'invalid credentials');

/** The scrypt queue is full: a 503 the account routes pass on (it is about no user). */
export function passwordBusy(): HttpError {
  const message = 'too many password checks in progress; retry shortly';
  return new HttpError(503, message, { error: message }, { 'retry-after': '1' });
}

/** Logout refused by the LookupLimiter before the token was read (it is about no token). */
function logoutThrottled(retryAfterSeconds: number): HttpError {
  const message = 'logout is rate limited, retry later';
  return new HttpError(
    429,
    message,
    { error: message },
    { 'retry-after': String(retryAfterSeconds) },
  );
}

function toAccountToken({ hash, record }: StoredUserToken): AccountToken {
  return {
    key: hash,
    preview: record.preview,
    ...(record.label !== undefined ? { name: record.label } : {}),
    readonly: record.readonly === true,
    cidrWhitelist: [],
    created: record.created,
  };
}

function cleanLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const s = value.trim();
  if (s.length === 0) return undefined;
  if (s.length > 128 || /[\p{Cc}\p{Cf}]/u.test(s)) {
    throw new HttpError(400, 'token names are printable and at most 128 characters');
  }
  return s;
}

type LoginResult = { name: string; token: string } | null;

export class UserAccounts implements AccountProvider {
  private readonly opts: UserAccountsOptions;
  private readonly maxTokens: number;

  constructor(opts: UserAccountsOptions) {
    this.opts = opts;
    this.maxTokens = opts.maxTokensPerUser ?? MAX_TOKENS_PER_USER;
  }

  /** Scrypt parameters for the dummy check: those of the users' own hashes. */
  private dummyParams(): ScryptParams | undefined {
    const first = this.opts.users.entries()[0];
    return (first ? hashParams(first[1].password) : null) ?? this.opts.hashParams;
  }

  /**
   * Checks a password with the brute-force limits; true only for the right password of an
   * existing user. Used by login, token creation and the web catalog login. Throws a 503
   * HttpError (passwordBusy) when the scrypt queue is full.
   */
  async checkPassword(
    name: string,
    password: string,
    address: string | undefined,
  ): Promise<boolean> {
    return (await this.verify(name, password, address)) !== null;
  }

  /**
   * The user record the password was checked against, or null (see checkPassword); its
   * generation is what tokens and sessions issued for this check must carry.
   */
  async passwordUser(
    name: string,
    password: string,
    address: string | undefined,
  ): Promise<UserRecord | null> {
    return this.verify(name, password, address);
  }

  private async verify(
    name: string,
    password: string,
    address: string | undefined,
  ): Promise<UserRecord | null> {
    if (this.opts.limiter.addressBusy(address)) {
      log.warn('login refused: too many password checks in progress for this client');
      throw passwordBusy();
    }
    const attempt = this.opts.limiter.reserve(name, address);
    if (!attempt) {
      log.warn('login throttled', address !== undefined ? { client: address } : {});
      return null;
    }
    const user = isValidUserName(name) ? this.opts.users.get(name) : undefined;
    let ok = false;
    try {
      if (user) ok = await verifyPassword(password, user.password);
      else await burnPasswordCheck(password, this.dummyParams());
    } catch (err) {
      attempt.released(); // not counted: the client did nothing wrong
      if (err instanceof PasswordBusyError) {
        log.warn('login refused: too many password checks in progress');
        throw passwordBusy();
      }
      throw err;
    }
    if (ok && user) {
      attempt.succeeded();
      return user;
    }
    attempt.failed();
    return null;
  }

  /**
   * Issues a login token under `generation`. Beyond MAX_TOKENS_PER_USER login tokens the
   * oldest are revoked first: repeated `npm login` (CI) keeps working without an unbounded
   * number of records per user.
   */
  private async issue(name: string, generation: number): Promise<string> {
    const { tokens, tokenTtlMs } = this.opts;
    const logins = (await tokens.listActive(name))
      .filter((t) => t.record.login === true)
      .sort((a, b) => a.record.created.localeCompare(b.record.created));
    const excess = logins.length - (this.maxTokens - 1);
    for (const old of logins.slice(0, Math.max(0, excess))) {
      await tokens.revoke(old.hash);
    }
    const created = await tokens.create(name, tokens.currentTime() + tokenTtlMs, {
      generation,
      login: true,
    });
    return created.token;
  }

  async login(request: UserLoginRequest, ctx: AccountContext): Promise<LoginResult> {
    const name = request.name;
    const { users, registration } = this.opts;
    if (registration.enabled && isValidUserName(name) && users.get(name) === undefined) {
      return this.register(name, request.password, ctx);
    }
    return this.loginExisting(name, request.password, ctx);
  }

  private async loginExisting(
    name: string,
    password: string,
    ctx: AccountContext,
  ): Promise<LoginResult> {
    const user = await this.verify(name, password, ctx.clientAddress);
    return user ? { name, token: await this.issue(name, generationOf(user)) } : null;
  }

  private async register(
    name: string,
    password: string,
    ctx: AccountContext,
  ): Promise<LoginResult> {
    const { users, registration, limiter } = this.opts;
    if (limiter.addressBusy(ctx.clientAddress)) throw passwordBusy();
    const attempt = limiter.reserve(name, ctx.clientAddress);
    if (!attempt) {
      log.warn('registration throttled', ctx.clientAddress ? { client: ctx.clientAddress } : {});
      return null;
    }
    let encoded: string;
    try {
      if (checkPasswordPolicy(password) !== null || users.count() >= registration.maxUsers) {
        // The same scrypt work as a login: the answer time tells nothing.
        await burnPasswordCheck(password, this.dummyParams());
        attempt.failed();
        return null;
      }
      encoded = await hashPassword(password, this.opts.hashParams);
    } catch (err) {
      attempt.released();
      if (err instanceof PasswordBusyError) throw passwordBusy();
      throw err;
    }
    const outcome: { record: UserRecord | null } = { record: null };
    try {
      await users.update((data) => {
        // Re-checked under the lock: another pod may have registered the name or filled the cap.
        if (Object.hasOwn(data.users, name)) return null;
        if (Object.keys(data.users).length >= registration.maxUsers) return null;
        const now = new Date().toISOString();
        const record: UserRecord = {
          password: encoded,
          created: now,
          changed: now,
          generation: nextGeneration(),
          packages: [],
        };
        data.users[name] = record;
        outcome.record = record;
        return data;
      });
    } catch (err) {
      attempt.released();
      throw err;
    }
    if (!outcome.record) {
      // Lost a race: the name exists now (or the cap is reached), so this is a login.
      attempt.released();
      return this.loginExisting(name, password, ctx);
    }
    attempt.succeeded();
    limiter.charge(ctx.clientAddress);
    ctx.audit('auth.user.registered', { user: name });
    log.info('user registered', { user: name });
    return { name, token: await this.issue(name, generationOf(outcome.record)) };
  }

  async listTokens(identity: Identity): Promise<AccountToken[]> {
    if (!isUserIdentity(identity)) return [];
    const active = await this.opts.tokens.listActive(identity.name);
    return active.filter((t) => this.opts.stillValid(t.record)).map(toAccountToken);
  }

  async createToken(
    identity: Identity,
    request: TokenCreateRequest,
    ctx: AccountContext,
  ): Promise<{ token: string; info: AccountToken }> {
    if (!isUserIdentity(identity)) {
      throw new HttpError(403, 'only user accounts can create tokens');
    }
    if (request.cidrWhitelist.length > 0) {
      throw new HttpError(400, 'CIDR-restricted tokens are not supported by this registry');
    }
    if (identity.claims?.readonly === true && !request.readonly) {
      throw new HttpError(403, 'a read-only token can only create read-only tokens');
    }
    const label = cleanLabel(request.name);
    if (request.password === undefined) {
      throw new HttpError(401, 'the account password is required to create a token');
    }
    const user = await this.verify(identity.name, request.password, ctx.clientAddress);
    if (!user) throw invalid();
    const { tokens, tokenTtlMs } = this.opts;
    const created = (await tokens.listActive(identity.name)).filter((t) => t.record.login !== true);
    if (created.length >= this.maxTokens) {
      throw new HttpError(429, `at most ${this.maxTokens} active tokens; revoke one first`);
    }
    const now = tokens.currentTime();
    const parentExpires = Date.parse(String(identity.claims?.expires));
    let expiresAt = Math.min(now + tokenTtlMs, Number.isNaN(parentExpires) ? now : parentExpires);
    if (request.expiresInDays !== undefined) {
      expiresAt = Math.min(expiresAt, now + request.expiresInDays * DAY_MS);
    }
    if (expiresAt <= now) throw new HttpError(403, 'the token used has expired');
    const issued = await tokens.create(identity.name, expiresAt, {
      generation: generationOf(user),
      readonly: request.readonly,
      ...(label !== undefined ? { label } : {}),
    });
    return { token: issued.token, info: toAccountToken(issued) };
  }

  async deleteToken(identity: Identity, key: string): Promise<boolean> {
    if (!isUserIdentity(identity)) return false;
    // npm sends either the listed key or the token itself.
    const hash = isUserToken(key) ? hashToken(key) : key.toLowerCase();
    if (!isTokenHash(hash)) return false;
    const { tokens } = this.opts;
    const record = await tokens.get(hash);
    // Never another user's token, and the same answer whether it exists or not.
    if (!record || record.user !== identity.name || !tokens.isActive(record)) return false;
    // A stolen read-only token must not take away the user's other credentials.
    if (identity.claims?.readonly === true && record.readonly !== true) return false;
    return tokens.revoke(hash);
  }

  async logout(token: string, ctx?: Pick<AccountContext, 'clientAddress'>): Promise<void> {
    if (!isUserToken(token)) return;
    try {
      // Unauthenticated: reads for unknown tokens come out of the LookupLimiter budget. A
      // refused read fails visibly (429): the token may be real, so a 200 would be a false
      // "logged out".
      await this.opts.tokens.revoke(hashToken(token), { address: ctx?.clientAddress });
    } catch (err) {
      if (err instanceof RevocationLimitedError) throw logoutThrottled(err.retryAfterSeconds);
      log.error('logout could not revoke the token', errorFields(err));
      throw err;
    }
  }
}
