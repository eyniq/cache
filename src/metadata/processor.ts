import type {
  EcosystemAdapter,
  ProcessContext,
  ProcessedMetadata,
  RawMetadata,
  WriteBody,
  WriteRoute,
} from '../core/contracts.ts';
import { HttpError } from '../core/errors.ts';

/** Where packument processing runs: inline (tests, tiny deployments) or in a worker pool. */
export interface MetadataProcessor {
  /**
   * True while new work would be refused (a full queue). Callers check it before reading or
   * fetching a document for processing; absent means never.
   */
  readonly overloaded?: boolean;
  process(
    adapter: EcosystemAdapter,
    raw: RawMetadata,
    ctx: ProcessContext,
  ): Promise<ProcessedMetadata>;
  /** Parse a write body with adapter.parseWriteBody; absent means it runs inline. */
  parseWriteBody?(adapter: EcosystemAdapter, route: WriteRoute, body: Buffer): Promise<WriteBody>;
  close(): Promise<void>;
}

/** Calls adapter.parseWriteBody on the current thread; 405 when the adapter has none. */
export function parseWriteInline(
  adapter: EcosystemAdapter,
  route: WriteRoute,
  body: Buffer,
): Promise<WriteBody> {
  try {
    if (!adapter.parseWriteBody) throw new HttpError(405, 'method not allowed');
    return Promise.resolve(adapter.parseWriteBody(route, body));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export class InlineProcessor implements MetadataProcessor {
  process(
    adapter: EcosystemAdapter,
    raw: RawMetadata,
    ctx: ProcessContext,
  ): Promise<ProcessedMetadata> {
    return Promise.resolve(adapter.processMetadata(raw, ctx));
  }

  parseWriteBody(adapter: EcosystemAdapter, route: WriteRoute, body: Buffer): Promise<WriteBody> {
    return parseWriteInline(adapter, route, body);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
