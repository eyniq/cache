// Test fixture for WorkerPool: a processor that kills its worker thread.
export function processMetadata(raw: { body: Uint8Array }): never {
  if (Buffer.from(raw.body).toString() === 'exit') process.exit(1);
  throw new Error('unexpected input');
}
