// The npm ecosystem adapter: the only place that knows npm's protocol.
import type { IncomingMessage } from 'node:http';
import type {
  AdapterRoute,
  ArtifactRef,
  EcosystemAdapter,
  MatchContext,
  MetadataFetchOptions,
  MetadataFetchResult,
  ProcessedMetadata,
  Upstream,
} from '../../core/contracts.ts';
import { badGateway, badRequest } from '../../core/errors.ts';
import { siblingModule } from '../../core/modules.ts';
import { readLimited } from '../../core/streams.ts';
import { contentKey } from '../../core/names.ts';
import { npmCatalog } from './catalog.ts';
import { npmAccountProtocol } from './account.ts';
import { indexKey, packumentKey } from './keys.ts';
import { parseWriteBody, processMetadata, renderMetadata } from './packument.ts';
import { matchNpmPath } from './routes.ts';
import { composeSearch, parseSearchQuery, parseSearchUpstream } from './search.ts';

/** `@scope/name` is requested from npm as `@scope%2fname`. */
function upstreamName(name: string): string {
  return name.replace('/', '%2f');
}

export class NpmAdapter implements EcosystemAdapter {
  readonly id = 'npm';
  readonly mountPath = '/npm';
  readonly processorModule = siblingModule('./packument', import.meta.url).href;
  readonly processMetadata = processMetadata;
  readonly renderMetadata = renderMetadata;
  readonly parseWriteBody = parseWriteBody;
  readonly accounts = npmAccountProtocol;
  readonly catalog = npmCatalog;
  readonly search = {
    parseQuery: parseSearchQuery,
    parseUpstream: parseSearchUpstream,
    compose: composeSearch,
  };
  readonly forwardHeaders = ['npm-command'] as const;
  readonly processOptions: Record<string, boolean>;

  constructor(opts: { abbreviatedIncludeTime?: boolean } = {}) {
    this.processOptions = { abbreviatedIncludeTime: opts.abbreviatedIncludeTime ?? false };
  }

  match(req: IncomingMessage, path: string, ctx?: MatchContext): AdapterRoute | null {
    return matchNpmPath(
      req.method ?? 'GET',
      path,
      req.headers.accept ?? '',
      ctx?.writable === true,
      ctx?.accountActions,
    );
  }

  async fetchMetadata(
    name: string,
    upstream: Upstream,
    opts: MetadataFetchOptions,
  ): Promise<MetadataFetchResult> {
    // Always the full document: abbreviated packuments carry no publish times (section 8).
    const res = await upstream.request({
      path: `/${upstreamName(name)}`,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        ...(opts.etag ? { 'if-none-match': opts.etag } : {}),
      },
    });
    if (res.status === 304) {
      res.body.resume();
      return { status: 'not-modified' };
    }
    if (res.status === 404) {
      res.body.resume();
      return { status: 'not-found' };
    }
    if (res.status !== 200) {
      res.body.resume();
      throw badGateway(`upstream returned ${res.status}`);
    }
    const encoding = res.headers['content-encoding'] ?? 'identity';
    if (encoding !== 'gzip' && encoding !== 'identity') {
      res.body.resume();
      throw badGateway('unsupported upstream content-encoding');
    }
    const body = await readLimited(res.body, opts.maxBytes, () =>
      badGateway('upstream packument exceeds MAX_PACKUMENT_BYTES'),
    );
    const etag = res.headers.etag;
    return { status: 'ok', raw: { body, encoding, ...(etag ? { etag } : {}) } };
  }

  /**
   * With a package source, `npm audit` would send every dependency name (private ones too) to
   * the public registry. The bulk advisory body is a `{ name: versions[] }` map: owned names
   * are removed. The older tree-shaped audit endpoints are refused; npm uses the bulk one.
   */
  redactPassthrough(
    route: Extract<AdapterRoute, { kind: 'passthrough' }>,
    body: Buffer,
    isOwned: (name: string) => boolean,
  ): Buffer | null {
    if (route.upstreamPath !== '/-/npm/v1/security/advisories/bulk') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw badRequest('audit body is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw badRequest('audit body must be a JSON object');
    }
    const kept: Record<string, unknown> = {};
    for (const [name, versions] of Object.entries(parsed)) {
      if (isOwned(name) || isOwned(name.toLowerCase())) continue;
      Object.defineProperty(kept, name, { value: versions, enumerable: true });
    }
    return Buffer.from(JSON.stringify(kept));
  }

  metadataKey(name: string): string {
    return packumentKey(name);
  }

  artifactKey(
    route: Extract<AdapterRoute, { kind: 'artifact' }>,
    metadata: ProcessedMetadata,
  ): ArtifactRef {
    const info = metadata.versions.find((v) => v.artifact?.file === route.file);
    if (!info?.artifact) return { status: 'not-found' };
    return {
      status: 'ok',
      version: info.version,
      artifact: info.artifact,
      // Without an advertised digest the core refuses the artifact before touching storage.
      storageKey: info.artifact.integrity ? contentKey(info.artifact.integrity) : '',
      indexKey: indexKey(route.name, info.version),
      contentType: 'application/octet-stream',
    };
  }
}
