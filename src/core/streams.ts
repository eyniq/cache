import type { Readable } from 'node:stream';

/**
 * Read a stream fully into memory, failing with 502 once it exceeds `maxBytes`. Only used for
 * bounded documents (packuments, pass-through bodies), never for tarballs.
 */
export async function readLimited(
  body: Readable,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      body.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
