// Dispatches adapter routes to the ecosystem-agnostic services.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArtifactService } from '../../artifacts/service.ts';
import { STALE_HEADER } from '../../constants.ts';
import type { AdapterRoute, EcosystemAdapter, Identity, Upstream } from '../../core/contracts.ts';
import { HttpError, notFound } from '../../core/errors.ts';
import type { RequestContext } from '../../core/request.ts';
import type { MetadataService } from '../../metadata/service.ts';
import { acceptsGzip, gzipEtag, type MetadataCompressor } from '../compress.ts';
import { etagMatches } from '../etag.ts';
import type { PublicUrls } from '../public-url.ts';
import { sendJson } from '../respond.ts';
import { handlePassthrough } from './passthrough.ts';
import { createSearchHandler, type SearchHandlerDeps, type SearchService } from './search.ts';

export interface RegistryHandlerDeps {
  metadata: MetadataService;
  artifacts: ArtifactService;
  /** The upstream of an adapter (ServerDeps.upstreams, else ServerDeps.upstream). */
  upstreamFor: (adapter: EcosystemAdapter) => Upstream;
  config: SearchHandlerDeps['config'];
  /** Shared with the web catalog, so both use one search cache and rate limit. */
  search?: SearchService;
  /** PUBLIC_URL_ALIASES: documents for an alias host carry that base (public-url.ts). */
  publicUrls?: PublicUrls;
  /** COMPRESS_METADATA: gzip for metadata responses; absent = never compress. */
  compressor?: MetadataCompressor | undefined;
}

export function createRegistryHandler(deps: RegistryHandlerDeps) {
  const handleSearch = createSearchHandler(deps, deps.search);
  return async function handleRegistry(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: EcosystemAdapter,
    route: AdapterRoute,
    ctx: RequestContext,
    identity: Identity | null,
  ): Promise<void> {
    switch (route.kind) {
      case 'reject':
        throw new HttpError(route.status, route.message);
      case 'ping':
        sendJson(res, 200, {}, ctx);
        return;
      case 'whoami': {
        // The server authenticated this request already; whoami only reports the result.
        if (!identity) {
          throw new HttpError(
            401,
            'authentication required',
            { error: 'authentication required' },
            { 'www-authenticate': 'Bearer realm="eyniq-cache"' },
          );
        }
        sendJson(res, 200, { username: identity.name }, ctx);
        return;
      }
      case 'passthrough': {
        if (route.search === true && adapter.search) {
          await handleSearch(req, res, adapter, route, ctx, identity);
          return;
        }
        // With a package source, bodies are redacted by the adapter (or refused without one).
        const redact = deps.metadata.sourceFor(adapter)
          ? (body: Buffer) =>
              adapter.redactPassthrough
                ? adapter.redactPassthrough(
                    route,
                    body,
                    (name) => deps.metadata.ownerOf(adapter, name) !== null,
                  )
                : null
          : undefined;
        await handlePassthrough(req, res, route, deps.upstreamFor(adapter), ctx, redact);
        return;
      }
      case 'metadata': {
        const { entry, cache } = await deps.metadata.lookup(adapter, route.name);
        ctx.cache = cache;
        if (!entry) throw notFound('package not found');
        const rendered = deps.metadata.render(entry, route.view, route.ref);
        const alias = deps.publicUrls?.forHost(req.headers.host) ?? null;
        const etag = alias ? alias.etag(rendered.etag) : rendered.etag;
        // Set only when this response is sent gzipped.
        const gzip =
          rendered.status === 200 &&
          deps.compressor?.worthCompressing(rendered.body) === true &&
          acceptsGzip(req.headers['accept-encoding'])
            ? deps.compressor
            : undefined;
        const sentEtag = gzip ? gzipEtag(etag) : etag;
        const headers: Record<string, string | number> = {
          etag: sentEtag,
          vary: 'Accept, Accept-Encoding',
          ...(cache === 'stale' ? { [STALE_HEADER]: '1' } : {}),
        };
        // Hot path: a cache hit only compares strings and writes a pre-serialized Buffer.
        // Either ETag revalidates: both encodings carry the same document.
        const inm = req.headers['if-none-match'];
        if (
          rendered.status === 200 &&
          (etagMatches(inm, etag) || (gzip !== undefined && etagMatches(inm, sentEtag)))
        ) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        const plain = alias ? alias.rewrite(rendered.body) : rendered.body;
        // The gzip key is the sent ETag, which identifies the exact (alias-rewritten) body.
        const body = gzip ? await gzip.gzip(sentEtag, plain) : plain;
        res.writeHead(rendered.status, {
          ...headers,
          'content-type': rendered.contentType,
          'content-length': body.length,
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(body);
        if (req.method !== 'HEAD') ctx.bytes += body.length;
        return;
      }
      case 'artifact':
        await deps.artifacts.serve(req, res, adapter, route, ctx);
        return;
    }
  };
}
