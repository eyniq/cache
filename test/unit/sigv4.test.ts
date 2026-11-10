// AWS Signature Version 4 against the worked examples published by AWS.
import { describe, expect, it } from 'vitest';
import { deriveSigningKey, encodeKeyPath, signRequest } from '../../src/storage/sigv4.ts';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('SigV4 signing key', () => {
  it('matches the AWS example signing key', () => {
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20150830',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });
});

describe('SigV4 request signing', () => {
  it('matches the AWS IAM ListUsers example', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      payloadHash: EMPTY_SHA256,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'iam',
      date: new Date('2015-08-30T12:36:00Z'),
      includeContentHash: false,
    });
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('matches the AWS S3 GetObject example', () => {
    const signed = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('never puts the secret in any header', () => {
    const secret = 'super-secret-key-value';
    const signed = signRequest({
      method: 'PUT',
      url: new URL('http://minio:9000/bucket/key'),
      headers: {},
      payloadHash: EMPTY_SHA256,
      accessKeyId: 'id',
      secretAccessKey: secret,
      region: 'us-east-1',
      service: 's3',
      date: new Date(),
    });
    expect(JSON.stringify(signed)).not.toContain(secret);
  });
});

describe('S3 key path encoding', () => {
  it('encodes each segment per RFC 3986 and keeps the slashes', () => {
    expect(encodeKeyPath('npm/packuments/@types/node.json.gz')).toBe(
      'npm/packuments/%40types/node.json.gz',
    );
    expect(encodeKeyPath("a/fn-args'(x)*!~.tgz")).toBe('a/fn-args%27%28x%29%2A%21~.tgz');
  });
});
