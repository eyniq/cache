/** Per-request bookkeeping for the access log. */
export interface RequestContext {
  /** Path without query string. */
  path: string;
  cache: 'none' | 'hit' | 'miss' | 'stale' | 'coalesced' | 'revalidated' | 'passthrough';
  bytes: number;
  /** Metrics label: the adapter route kind, or livez/readyz/metrics/unknown. */
  route: string;
  /** X-Request-Id from the client when well-formed, otherwise a random UUID. */
  requestId: string;
  identity?: string;
  /** Set by the artifact service once the version is known (artifact.served audit). */
  artifact?: { ecosystem: string; name: string; version: string; file: string };
}
