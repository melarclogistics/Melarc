import { describe, expect, it } from 'vitest';

import {
  amzDateOf,
  authorizeRequest,
  canonicalPathOf,
  canonicalQueryOf,
  EMPTY_PAYLOAD_SHA256,
  presignRequest,
  sha256Hex,
  uriEncode,
  type SigV4Credentials,
  type SigV4Scope,
} from './sigv4.js';

/**
 * Signature Version 4, proved against the worked examples AWS publishes for Amazon S3 (documentation: "Signature Calculations for the Authorization Header:
 * Transferring Payload in a Single Chunk" for the first four, and "Authenticating Requests: Using Query Parameters" for the last). They use the documentation's own
 * example credentials (a published, non-secret pair), bucket `examplebucket`, region `us-east-1` and the instant `20130524T000000Z`. Passing them is what lets the R2
 * adapter claim its signing is right without a bucket or a network call (S1.11, the owner's decision of 29 October 2026).
 */
const CREDENTIALS: SigV4Credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const SCOPE: SigV4Scope = { region: 'us-east-1', service: 's3' };
const INSTANT = new Date('2013-05-24T00:00:00.000Z');
const HOST = 'examplebucket.s3.amazonaws.com';

describe('the worked examples of the AWS documentation', () => {
  it('GET Object, with a Range header', () => {
    const authorized = authorizeRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      path: '/test.txt',
      query: {},
      headers: {
        host: HOST,
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(authorized.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(authorized.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object, with a body, a date header, a storage class and a "$" in the key', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = sha256Hex(body);
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const authorized = authorizeRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'PUT',
      path: '/test$file.text',
      query: {},
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        host: HOST,
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': payloadHash,
      },
      payloadHash,
    });
    expect(authorized.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
    expect(authorized.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
  });

  it('GET Bucket Lifecycle, a query name with no value', () => {
    const authorized = authorizeRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      path: '/',
      query: { lifecycle: '' },
      headers: {
        host: HOST,
        'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(authorized.signature).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('GET Bucket (List Objects), two query parameters in sorted order', () => {
    const authorized = authorizeRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      path: '/',
      query: { prefix: 'J', 'max-keys': '2' },
      headers: {
        host: HOST,
        'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(authorized.signature).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('a presigned GET URL, valid for 86400 seconds', () => {
    const presigned = presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      host: HOST,
      path: '/test.txt',
      expiresSeconds: 86400,
    });
    expect(presigned.signature).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(presigned.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});

describe('what a presigned URL grants', () => {
  const upload = (path: string, signedHeaders: Record<string, string> = {}) =>
    presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'PUT',
      host: HOST,
      path,
      expiresSeconds: 900,
      signedHeaders,
    });

  it('is for one object: another key gives another signature (GBT-N9)', () => {
    const a = upload('/ev/aaaa');
    const b = upload('/ev/aaab');
    expect(a.signature).not.toBe(b.signature);
    // The signature in the URL is the one for its own path: moving it to another path leaves a URL whose signature is not that path's.
    expect(a.url.replace('/ev/aaaa', '/ev/aaab')).not.toBe(b.url);
  });

  it('signs the method: the URL of a PUT is not the URL of a GET', () => {
    const put = presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'PUT',
      host: HOST,
      path: '/ev/x',
      expiresSeconds: 900,
    });
    const get = presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      host: HOST,
      path: '/ev/x',
      expiresSeconds: 900,
    });
    expect(put.signature).not.toBe(get.signature);
  });

  it('signs the lifetime: a longer URL is a different signature', () => {
    const short = presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      host: HOST,
      path: '/ev/x',
      expiresSeconds: 300,
    });
    const long = presignRequest(CREDENTIALS, INSTANT, SCOPE, {
      method: 'GET',
      host: HOST,
      path: '/ev/x',
      expiresSeconds: 900,
    });
    expect(short.signature).not.toBe(long.signature);
    expect(short.url).toContain('X-Amz-Expires=300');
    expect(long.url).toContain('X-Amz-Expires=900');
  });

  it('signs the headers the client must send, in sorted order, and names them', () => {
    const presigned = upload('/ev/x', {
      'x-amz-checksum-sha256': 'abc=',
      'Content-Type': 'image/jpeg',
    });
    expect(presigned.url).toContain(
      'X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-checksum-sha256',
    );
    // A different value of a signed header is a different signature: the store refuses a request that is not the one that was authorised.
    expect(
      upload('/ev/x', { 'x-amz-checksum-sha256': 'abd=', 'Content-Type': 'image/jpeg' }).signature,
    ).not.toBe(presigned.signature);
    expect(
      upload('/ev/x', { 'x-amz-checksum-sha256': 'abc=', 'Content-Type': 'image/png' }).signature,
    ).not.toBe(presigned.signature);
  });

  it('lives a whole number of seconds, at least one', () => {
    for (const expiresSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        presignRequest(CREDENTIALS, INSTANT, SCOPE, {
          method: 'GET',
          host: HOST,
          path: '/ev/x',
          expiresSeconds,
        }),
      ).toThrow(RangeError);
    }
  });

  it('carries no secret access key in the URL', () => {
    const presigned = upload('/ev/x');
    expect(presigned.url).not.toContain(CREDENTIALS.secretAccessKey);
    expect(presigned.url).toContain(encodeURIComponent(CREDENTIALS.accessKeyId));
  });
});

describe('the encodings of Signature Version 4', () => {
  it('encodes everything but the unreserved characters, in upper case, and a space as %20', () => {
    expect(uriEncode('a b/c~d-e_f.g')).toBe('a%20b%2Fc~d-e_f.g');
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('é')).toBe('%C3%A9');
    expect(uriEncode('+=&')).toBe('%2B%3D%26');
  });

  it('encodes each segment of a path once and keeps the slashes', () => {
    expect(canonicalPathOf('/ev/a b/$x')).toBe('/ev/a%20b/%24x');
  });

  it('sorts the query by name and then by value, and keeps a name with no value', () => {
    expect(canonicalQueryOf({ b: '2', a: '1', lifecycle: '' })).toBe('a=1&b=2&lifecycle=');
  });

  it('writes the instant as x-amz-date does, in UTC and without milliseconds', () => {
    expect(amzDateOf(new Date('2026-11-12T09:05:07.123Z'))).toBe('20261112T090507Z');
  });
});
