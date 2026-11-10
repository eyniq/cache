// Worker-thread entry: runs an adapter's processMetadata off the main thread. The adapter
// module is loaded by URL, so this file stays ecosystem-agnostic.
import { parentPort } from 'node:worker_threads';
import type {
  ProcessContext,
  ProcessedMetadata,
  RawMetadata,
  WriteBody,
  WriteRoute,
} from '../core/contracts.ts';
import { isHttpError } from '../core/errors.ts';

export type WorkerRequest =
  | {
      id: number;
      op: 'process';
      module: string;
      raw: { body: Uint8Array; encoding: RawMetadata['encoding']; etag?: string };
      ctx: ProcessContext;
    }
  | { id: number; op: 'write'; module: string; route: WriteRoute; body: Uint8Array };

export type WorkerResponse =
  | { id: number; ok: true; result: ProcessedMetadata | WriteBody }
  | { id: number; ok: false; status: number; message: string; body?: Record<string, unknown> };

type ProcessFn = (raw: RawMetadata, ctx: ProcessContext) => ProcessedMetadata;
type ParseWriteFn = (route: WriteRoute, body: Buffer) => WriteBody;

const modules = new Map<string, Promise<Record<string, unknown>>>();

async function load<T>(url: string, name: 'processMetadata' | 'parseWriteBody'): Promise<T> {
  let mod = modules.get(url);
  if (!mod) {
    mod = import(url) as Promise<Record<string, unknown>>;
    modules.set(url, mod);
  }
  const fn = (await mod)[name];
  if (typeof fn !== 'function') throw new Error(`module has no ${name}`);
  return fn as T;
}

/** Artifact bytes of a parsed publish, so they are moved to the main thread, not copied. */
function writeTransferables(result: WriteBody): ArrayBuffer[] {
  if (result.type !== 'publish') return [];
  const out: ArrayBuffer[] = [];
  for (const v of result.request.versions) transferables(v.artifact.data, out);
  return out;
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Typed arrays that own their whole buffer can be transferred instead of copied. */
function transferables(value: unknown, out: ArrayBuffer[] = [], depth = 0): ArrayBuffer[] {
  if (depth > 3 || value === null || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value)) {
    const buf = value.buffer;
    if (
      buf instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === buf.byteLength
    ) {
      if (!out.includes(buf)) out.push(buf);
    }
    return out;
  }
  for (const v of Object.values(value)) transferables(v, out, depth + 1);
  return out;
}

const port = parentPort;
if (!port) throw new Error('metadata worker must run in a worker thread');

port.on('message', (msg: WorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === 'write') {
        const parse = await load<ParseWriteFn>(msg.module, 'parseWriteBody');
        const result = parse(msg.route, toBuffer(msg.body));
        const reply: WorkerResponse = { id: msg.id, ok: true, result };
        port.postMessage(reply, writeTransferables(result));
        return;
      }
      const process = await load<ProcessFn>(msg.module, 'processMetadata');
      const raw: RawMetadata = {
        body: toBuffer(msg.raw.body),
        encoding: msg.raw.encoding,
        ...(msg.raw.etag !== undefined ? { etag: msg.raw.etag } : {}),
      };
      const result = process(raw, msg.ctx);
      const reply: WorkerResponse = { id: msg.id, ok: true, result };
      port.postMessage(reply, transferables(result.payload));
    } catch (err) {
      const reply: WorkerResponse = isHttpError(err)
        ? {
            id: msg.id,
            ok: false,
            status: err.status,
            message: err.message,
            body: JSON.parse(JSON.stringify(err.body)) as Record<string, unknown>,
          }
        : { id: msg.id, ok: false, status: 502, message: 'metadata processing failed' };
      port.postMessage(reply);
    }
  })();
});
