// The shared Storage conformance suite against an S3-compatible server; runs when
// S3_TEST_ENDPOINT is set (see test/integration/s3.test.ts for a local versitygw command).
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { S3Storage } from '../../src/storage/s3.ts';
import { storageConformance } from '../../src/testing/index.ts';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = `eyniq-conf-${randomUUID().slice(0, 8)}`;
let created: Promise<S3Storage> | null = null;

function storage(): Promise<S3Storage> {
  created ??= (async () => {
    const s = new S3Storage({
      endpoint: endpoint ?? '',
      region: 'us-east-1',
      bucket,
      forcePathStyle: true,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'eyniq',
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'eyniq-secret',
    });
    await s.createBucketForTests();
    return s;
  })();
  return created;
}

describe.skipIf(!endpoint)('Storage conformance: S3Storage', () => {
  for (const c of storageConformance(storage)) it(c.name, c.run);
});
