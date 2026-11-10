// S3Storage against a real S3-compatible server. Runs when S3_TEST_ENDPOINT is set, e.g. with
// versitygw (the MinIO images are no longer published on Docker Hub or Quay):
//   docker run -d --rm --name eyniq-s3-test -p 127.0.0.1:19000:7070 versity/versitygw:latest \
//     --access eyniq --secret eyniq-secret --port :7070 posix /tmp
//   S3_TEST_ENDPOINT=http://127.0.0.1:19000 pnpm test:integration
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/storage/s3.ts';
import { startCache } from '../helpers/cache.ts';
import { send } from '../helpers/http.ts';

const endpoint = process.env.S3_TEST_ENDPOINT;
const creds = {
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'eyniq',
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'eyniq-secret',
};
const bucket = `eyniq-test-${randomUUID().slice(0, 8)}`;

describe.skipIf(!endpoint)('slice 5: S3Storage against an S3-compatible server', () => {
  let storage: S3Storage;

  beforeAll(async () => {
    storage = new S3Storage({
      endpoint: endpoint!,
      region: 'us-east-1',
      bucket,
      forcePathStyle: true,
      ...creds,
    });
    await storage.createBucketForTests();
  });

  it('round-trips an object, including scoped-name keys', async () => {
    const key = 'npm/packuments/@types/node.json.gz';
    await storage.put(key, Readable.from([Buffer.from('hello '), Buffer.from('world')]));
    expect(await storage.head(key)).toMatchObject({ size: 11 });
    expect(await text((await storage.get(key))!)).toBe('hello world');
    const opened = await storage.open(key);
    expect(opened?.size).toBe(11);
  });

  it('returns null for missing objects', async () => {
    expect(await storage.get('nope/missing')).toBeNull();
    expect(await storage.head('nope/missing')).toBeNull();
  });

  it('stores nothing when the body stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
        this.destroy(new Error('upstream broke'));
      },
    });
    await expect(storage.put('tarballs/sha512/broken', failing)).rejects.toThrow();
    expect(await storage.head('tarballs/sha512/broken')).toBeNull();
  });

  it('handles objects larger than one upload part', async () => {
    const big = Buffer.alloc(12 * 1024 * 1024, 3);
    await storage.put('tarballs/sha512/big', Readable.from([big]));
    const back = await storage.get('tarballs/sha512/big');
    const chunks: Buffer[] = [];
    for await (const c of back! as AsyncIterable<Buffer>) chunks.push(c);
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(
      createHash('sha256').update(big).digest('hex'),
    );
  });

  it('passes the readiness check and fails it with wrong credentials', async () => {
    await expect(storage.check()).resolves.toBeUndefined();
    const wrong = new S3Storage({
      endpoint: endpoint!,
      region: 'us-east-1',
      bucket,
      forcePathStyle: true,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: 'wrong-secret',
    });
    await expect(wrong.check()).rejects.toThrow();
  });

  it('serves installs end to end with STORAGE=s3', async () => {
    const cache = await startCache({
      STORAGE: 's3',
      S3_ENDPOINT: endpoint!,
      S3_REGION: 'us-east-1',
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: creds.accessKeyId,
      S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
    });
    try {
      cache.upstream.addPackage('lodash', [{ version: '4.17.21' }]);
      const path = '/lodash/-/lodash-4.17.21.tgz';
      expect((await send(cache.url, { path })).status).toBe(200);
      const again = await send(cache.url, { path });
      expect(again.body.equals(cache.upstream.tarballs.get(path)!)).toBe(true);
      expect(cache.upstream.countPath(path)).toBe(1);
    } finally {
      await cache.close();
    }
  });
});
