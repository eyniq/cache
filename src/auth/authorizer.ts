import type {
  AuthorizationAction,
  AuthorizationResource,
  AuthProvider,
  Authorizer,
  Identity,
} from '../core/contracts.ts';

/**
 * Community default. Reads behave exactly as before the hook existed: allowed for any
 * authenticated identity, or for everyone when authentication is not required. The community
 * edition has no write, admin or account roles, so publish, admin and account are always
 * refused: a build that enables a write path, admin routes or token management
 * (ServerDeps.accounts) must bring its own Authorizer (fail closed).
 */
export class DefaultAuthorizer implements Authorizer {
  private readonly auth: Pick<AuthProvider, 'required'>;

  constructor(auth: Pick<AuthProvider, 'required'>) {
    this.auth = auth;
  }

  authorize(
    identity: Identity | null,
    action: AuthorizationAction,
    _resource: AuthorizationResource,
  ): Promise<boolean> {
    if (action !== 'read') return Promise.resolve(false);
    return Promise.resolve(identity !== null || !this.auth.required);
  }
}
