// AWS Signature Version 4 (own implementation: no AWS SDK, DESIGN.md section 3).
import { createHash, createHmac } from 'node:crypto';

export interface SignInput {
  method: string;
  /** Path must already be URI-encoded (see encodeKeyPath); it is signed as-is. */
  url: URL;
  headers: Record<string, string>;
  /** Hex sha256 of the body. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
  /** S3 requires x-amz-content-sha256; other services do not use it. Default: service === 's3'. */
  includeContentHash?: boolean;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key segment by segment, keeping the slashes. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(rfc3986).join('/');
}

export function deriveSigningKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) pairs.push([rfc3986(k), rfc3986(v)]);
  pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Returns the request headers to send, including host, x-amz-date and authorization. */
export function signRequest(input: SignInput): { headers: Record<string, string> } {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers.host = input.url.host;
  headers['x-amz-date'] = amzDate;
  if (input.includeContentHash ?? input.service === 's3') {
    headers['x-amz-content-sha256'] = input.payloadHash;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    input.url.pathname || '/',
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = deriveSigningKey(input.secretAccessKey, day, input.region, input.service);
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers };
}
