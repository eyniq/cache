import type {
  AuthorizationAction,
  AuthorizationResource,
  AuthProvider,
  Authorizer,
  Identity,
} from '../core/contracts.ts';
import { matchesAnyPattern } from '../core/patterns.ts';
import { isUserIdentity } from './user-auth.ts';
import type { UsersFile } from './users.ts';

/**
 * Authorizer of the community build with a user store (USERS_FILE):
 * - read: as DefaultAuthorizer (any identity, or everyone when auth is not required);
 * - publish: only identities of user tokens, not read-only ones, for users still in the file,
 *   and only for package names their `packages` patterns allow (absent: any name; the
 *   PackageSource still decides which names this registry owns). Static token identities
 *   (AUTH_TOKENS_PATH) never publish;
 * - account: user identities (managing their own tokens); admin: never.
 */
export class CommunityAuthorizer implements Authorizer {
  private readonly auth: Pick<AuthProvider, 'required'>;
  private readonly users: UsersFile;

  constructor(opts: { auth: Pick<AuthProvider, 'required'>; users: UsersFile }) {
    this.auth = opts.auth;
    this.users = opts.users;
  }

  authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    return Promise.resolve(this.decide(identity, action, resource));
  }

  private decide(
    identity: Identity | null,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): boolean {
    switch (action) {
      case 'read':
        return identity !== null || !this.auth.required;
      case 'account':
        return identity !== null && isUserIdentity(identity);
      case 'publish': {
        if (identity === null || !isUserIdentity(identity)) return false;
        if (identity.claims?.readonly !== false) return false;
        const user = this.users.get(identity.name);
        if (!user || resource.name === undefined) return false;
        return user.packages === undefined || matchesAnyPattern(user.packages, resource.name);
      }
      case 'admin':
        return false;
    }
  }
}
