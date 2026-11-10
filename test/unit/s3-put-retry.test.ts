// S3Storage against a stub server: versitygw's posix backend answers a PUT with 409
// ExistingObjectIsDirectory when two gateways on one NFS volume create the same new parent
// directory (e.g. npm/packuments/@scope/) at the same time. Nothing was written and nothing is
// in the way, so the PUT is retried with backoff instead of being dropped, and a conditional
// PUT never reports it as a lost race.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/storage/s3.ts';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Handler = (req: Seen, res: ServerResponse) => void;

let server: Server | null = null;
const seen: Seen[] = [];

async function stub(handler: Handler, delays: readonly number[] = [1, 1, 1]): Promise<S3Storage> {
  seen.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return new S3Storage(
    {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'b',
      forcePathStyle: true,
      accessKeyId: 'id',
      secretAccessKey: 'not-a-real-key',
    },
    { conflictRetryDelaysMs: delays },
  );
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

const reply = (res: ServerResponse, status: number, body = ''): void => {
  res.writeHead(status, { etag: '"e1"', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const s3Error = (code: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m</Message></Error>`;
const directoryRace = (res: ServerResponse): void => {
  reply(res, 409, s3Error('ExistingObjectIsDirectory'));
};

/** Answers the capability probe as a backend that enforces conditional writes. */
function probe(req: Seen, res: ServerResponse): boolean {
  if (!req.url.includes('.eyniq-probe')) return false;
  if (req.headers['if-none-match'] === '*' || req.headers['if-match'] === '"0"') reply(res, 412);
  else if (req.method === 'GET') reply(res, 200, 'probe');
  else reply(res, req.method === 'DELETE' ? 204 : 200);
  return true;
}

const KEY = 'npm/packuments/@s/p.json.gz';
// SigV4 path encoding escapes the @ of a scope.
const objectPuts = (): Seen[] =>
  seen.filter((r) => r.method === 'PUT' && r.url === `/b/${KEY.replace('@', '%40')}`);

describe('S3Storage: transient directory race on PUT', () => {
  it('retries a 409 ExistingObjectIsDirectory and resends the whole body', async () => {
    let failures = 2;
    const s3 = await stub((_req, res) => {
      if (failures-- > 0) directoryRace(res);
      else reply(res, 200);
    });
    await s3.put(KEY, Readable.from([Buffer.from('abc'), Buffer.from('def')]));
    expect(objectPuts().map((r) => r.body)).toEqual(['abcdef', 'abcdef', 'abcdef']);
  });

  it('waits between attempts', async () => {
    let failures = 2;
    const s3 = await stub(
      (_req, res) => {
        if (failures-- > 0) directoryRace(res);
        else reply(res, 200);
      },
      [40, 40],
    );
    const started = Date.now();
    await s3.put(KEY, Readable.from([Buffer.from('x')]));
    // Equal jitter: at least half of each delay.
    expect(Date.now() - started).toBeGreaterThanOrEqual(38);
  });

  it('gives up after the last delay with the S3 error code', async () => {
    const s3 = await stub((_req, res) => {
      directoryRace(res);
    });
    await expect(s3.put(KEY, Readable.from([Buffer.from('x')]))).rejects.toThrow(
      'S3 PUT failed: 409 ExistingObjectIsDirectory',
    );
    expect(objectPuts()).toHaveLength(4); // the first attempt and one per delay
  });

  it('does not retry other conflicts', async () => {
    const s3 = await stub((_req, res) => {
      reply(res, 409, s3Error('OperationAborted'));
    });
    await expect(s3.put(KEY, Readable.from([Buffer.from('x')]))).rejects.toThrow(
      'S3 PUT failed: 409 OperationAborted',
    );
    expect(objectPuts()).toHaveLength(1);
  });

  it('retries putIfAbsent instead of reporting a lost race', async () => {
    let failures = 1;
    const s3 = await stub((req, res) => {
      if (probe(req, res)) return;
      if (failures-- > 0) directoryRace(res);
      else reply(res, 200);
    });
    expect(await s3.putIfAbsent(KEY, Buffer.from('x'))).toBe(true);
    expect(objectPuts().map((r) => r.headers['if-none-match'])).toEqual(['*', '*']);
  });

  it('fails a conditional PUT whose directory race outlasts the retries', async () => {
    const s3 = await stub((req, res) => {
      if (probe(req, res)) return;
      directoryRace(res);
    });
    await expect(s3.putIfMatch(KEY, Buffer.from('x'), '"e1"')).rejects.toThrow(
      'S3 conditional PUT failed: 409 ExistingObjectIsDirectory',
    );
  });

  it('still reports a conditional-write conflict as a lost race', async () => {
    const s3 = await stub((req, res) => {
      if (probe(req, res)) return;
      reply(res, 409, s3Error('ConditionalRequestConflict'));
    });
    expect(await s3.putIfAbsent(KEY, Buffer.from('x'))).toBe(false);
    expect(objectPuts()).toHaveLength(1);
  });
});
