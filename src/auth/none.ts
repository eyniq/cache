import type { AuthProvider, Identity } from '../core/contracts.ts';

/** Default when AUTH_TOKENS_PATH is unset: registry routes are open, whoami answers 401. */
export class NoAuth implements AuthProvider {
  readonly required = false;

  authenticate(): Promise<Identity | null> {
    return Promise.resolve(null);
  }
}
