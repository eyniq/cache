// P7: S3Storage admin operations against a stub server: conditional-write detection for
// backends that ignore or reject the headers, and ListObjectsV2 parsing.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConditionalWritesUnsupported } from '../../src/core/errors.ts';
import { isStorageAdmin } from '../../src/core/storage.ts';
import { S3Storage } from '../../src/storage/s3.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | null = null;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }> = [];

async function stub(handler: Handler): Promise<S3Storage> {
  seen.length = 0;
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return new S3Storage({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    bucket: 'b',
    forcePathStyle: true,
    accessKeyId: 'id',
    secretAccessKey: 'not-a-real-key',
  });
}

afterEach(async () => {
  const s = server;
  server = null;
  if (s)
    await new Promise<void>((r) =>
      s.close(() => {
        r();
      }),
    );
});

const ok = (res: ServerResponse, status = 200, body = ''): void => {
  res.writeHead(status, { etag: '"e1"', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

describe('P7: S3Storage admin', () => {
  it('is a StorageAdmin', async () => {
    expect(
      isStorageAdmin(
        await stub((_q, r) => {
          ok(r);
        }),
      ),
    ).toBe(true);
  });

  it('detects a backend that silently ignores conditional headers and refuses CAS on it', async () => {
    const s3 = await stub((_req, res) => {
      ok(res, _req.method === 'DELETE' ? 204 : 200);
    });
    expect((await s3.capabilities()).conditionalWrites).toBe(false);
    await expect(s3.putIfAbsent('k', Buffer.from('x'))).rejects.toBeInstanceOf(
      ConditionalWritesUnsupported,
    );
    await expect(s3.putIfMatch('k', Buffer.from('x'), '"e1"')).rejects.toBeInstanceOf(
      ConditionalWritesUnsupported,
    );
    // The probe object is cleaned up.
    expect(seen.some((r) => r.method === 'DELETE' && r.url.includes('.eyniq-probe'))).toBe(true);
  });

  it('detects 501 Not Implemented as unsupported', async () => {
    const s3 = await stub((req, res) => {
      if (req.headers['if-none-match'] || req.headers['if-match']) ok(res, 501);
      else ok(res, req.method === 'DELETE' ? 204 : 200);
    });
    expect((await s3.capabilities()).conditionalWrites).toBe(false);
  });

  it('maps 412 to false and signs the condition headers', async () => {
    const s3 = await stub((req, res) => {
      if (req.headers['if-none-match'] === '*' || req.headers['if-match'] === '"0"') ok(res, 412);
      else if (req.headers['if-match'] === '"stale"') ok(res, 412);
      else if (req.method === 'GET') ok(res, 200, 'probe');
      else ok(res, req.method === 'DELETE' ? 204 : 200);
    });
    expect((await s3.capabilities()).conditionalWrites).toBe(true);
    expect(await s3.putIfAbsent('k', Buffer.from('x'))).toBe(false);
    expect(await s3.putIfMatch('k', Buffer.from('x'), '"stale"')).toBe(false);
    expect(await s3.putIfMatch('k', Buffer.from('x'), '"fresh"')).toBe(true);
    expect(await s3.putIfMatch('k', Buffer.from('x'), 'not quoted')).toBe(false);
    const signed = String(seen.at(-1)?.headers.authorization);
    expect(signed).toMatch(/SignedHeaders=[^,]*if-match/);
  });

  it('parses ListObjectsV2 pages, unescaping keys and skipping internal ones', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>b</Name><IsTruncated>true</IsTruncated>
<Contents><Key>index/npm/a&apos;b/1.0.0</Key><Size>12</Size><ETag>&quot;abc&quot;</ETag></Contents>
<Contents><Key>.eyniq-probe/x</Key><Size>5</Size><ETag>"p"</ETag></Contents>
<Contents><Key>index/npm/z/2.0.0+b</Key><Size>3</Size><ETag>"def"</ETag></Contents>
</ListBucketResult>`;
    const s3 = await stub((_req, res) => {
      ok(res, 200, xml);
    });
    const page = await s3.list('index/npm/', { limit: 3, cursor: 'index/npm/0' });
    expect(page).toEqual({
      entries: [
        { key: "index/npm/a'b/1.0.0", size: 12, etag: '"abc"' },
        { key: 'index/npm/z/2.0.0+b', size: 3, etag: '"def"' },
      ],
      cursor: 'index/npm/z/2.0.0+b',
    });
    const url = new URL(seen[0]?.url ?? '', 'http://x');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('index/npm/');
    expect(url.searchParams.get('max-keys')).toBe('3');
    expect(url.searchParams.get('start-after')).toBe('index/npm/0');
  });

  it('is strict about the probe: a backend that overwrites despite 412 is not trusted', async () => {
    // Answers 412 but the GET shows the object was replaced anyway.
    const s3 = await stub((req, res) => {
      if (req.headers['if-none-match'] || req.headers['if-match'] === '"0"') ok(res, 412);
      else if (req.method === 'GET') ok(res, 200, 'x');
      else ok(res, req.method === 'DELETE' ? 204 : 200);
    });
    expect((await s3.capabilities()).conditionalWrites).toBe(false);
  });

  it('fails putIfAbsent on a 404 (wrong bucket) instead of reporting a lost race', async () => {
    const s3 = await stub((req, res) => {
      if (req.headers['if-none-match'] === '*' && req.url?.includes('/k')) ok(res, 404);
      else if (req.headers['if-none-match'] || req.headers['if-match'] === '"0"') ok(res, 412);
      else if (req.method === 'GET') ok(res, 200, 'probe');
      else ok(res, req.method === 'DELETE' ? 204 : 200);
    });
    await expect(s3.putIfAbsent('k', Buffer.from('x'))).rejects.toThrow(/404/);
  });

  it('refuses a listing that does not advance past the cursor, and skips broken entities', async () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated>
<Contents><Key>a&#x110000;b</Key><Size>1</Size></Contents>
<Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>`;
    const s3 = await stub((_req, res) => {
      ok(res, 200, xml);
    });
    await expect(s3.list('', { cursor: 'b' })).rejects.toThrow(/did not advance/);
    const first = await s3.list('');
    expect(first.entries.map((e) => e.key)).toEqual(['a']);
  });

  it('treats a missing object as deleted', async () => {
    const s3 = await stub((_req, res) => {
      ok(res, 404);
    });
    await expect(s3.delete('gone')).resolves.toBeUndefined();
  });
});
