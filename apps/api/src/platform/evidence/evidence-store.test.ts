import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UploadCapabilityRequest } from '../auth/ports/evidence-store.port.js';
import { Secret } from '../config/secret.js';
import { CONTENT_TYPE_SIGNATURE, signatureOf, SIGNATURE_BYTES } from './evidence-vocabulary.js';
import { EvidenceStoreError } from './evidence-store-error.js';
import { InProcessEvidenceStore, STAND_IN_HOST } from './in-process.evidence-store.adapter.js';
import { checksumBase64Of, checksumHexOf } from './object-capability.js';
import {
  R2EvidenceStore,
  type R2StreamTransport,
  type R2Transport,
} from './r2.evidence-store.adapter.js';
import { amzDateOf, authorizeRequest, EMPTY_PAYLOAD_SHA256, presignRequest } from './sigv4.js';

/**
 * The evidence store, at its two adapters (S1.11; the security matrix's Family N as far as a stand-in lets it run, and the R2 adapter's requests): the capability is for one
 * object and one operation, it lives for the seconds it was given and no longer, an address changed to another object is not the one that was signed, an upload that is not the
 * declared size, type or hash is refused by the store, and nothing in this file makes a network call. The credentials here are made up for the test and are not a credential.
 */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const KEY = `ev/${'0123456789abcdef'.repeat(2)}`;
const OTHER_KEY = `ev/${'fedcba9876543210'.repeat(2)}`;
const ISSUED = new Date('2026-11-12T09:00:00.000Z');

const uploadRequest = (over: Partial<UploadCapabilityRequest> = {}): UploadCapabilityRequest => ({
  key: KEY,
  contentType: 'image/jpeg',
  byteSize: JPEG.length,
  checksumSha256: sha(JPEG),
  issuedAt: ISSUED,
  ttlSeconds: 900,
  ...over,
});
const uploadCall = (
  url: string,
  over: Partial<{ headers: Record<string, string>; body: Uint8Array }> = {},
) => ({
  method: 'PUT',
  url,
  headers: {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(JPEG.length),
    'x-amz-checksum-sha256': checksumBase64Of(sha(JPEG)),
    ...over.headers,
  },
  body: over.body ?? JPEG,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the file signatures', () => {
  it('recognises a JPEG, a PNG and a PDF by their first bytes and nothing else', () => {
    expect(signatureOf(JPEG)).toBe('JPEG');
    expect(signatureOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'PNG',
    );
    expect(signatureOf(new TextEncoder().encode('%PDF-1.7\n'))).toBe('PDF');
    expect(signatureOf(new TextEncoder().encode('MZ'))).toBeUndefined();
    expect(signatureOf(new TextEncoder().encode('GIF89a'))).toBeUndefined();
    expect(signatureOf(Uint8Array.from([0xff, 0xd8]))).toBeUndefined();
    expect(signatureOf(new Uint8Array())).toBeUndefined();
  });

  it('reads as many bytes as the longest signature needs, and names a signature for each supported type', () => {
    expect(SIGNATURE_BYTES).toBeGreaterThanOrEqual(8);
    expect(CONTENT_TYPE_SIGNATURE).toEqual({
      'image/jpeg': 'JPEG',
      'image/png': 'PNG',
      'application/pdf': 'PDF',
    });
  });

  it('converts a checksum between the hex of the platform and the base64 of the store, and refuses what is neither', () => {
    const hex = sha(JPEG);
    expect(checksumHexOf(checksumBase64Of(hex))).toBe(hex);
    expect(() => checksumBase64Of('ABC')).toThrow(RangeError);
    expect(checksumHexOf('not base64 of 32 bytes')).toBeUndefined();
    expect(checksumHexOf(undefined)).toBeUndefined();
  });
});

describe('the in-process stand-in (Family N, as far as a stand-in lets it run)', () => {
  const standIn = (now: () => Date = () => new Date(ISSUED.getTime() + 1000)) =>
    new InProcessEvidenceStore({ now });

  it('GBT-N5: a capability uploads exactly one object, which the store then reports as it holds it', async () => {
    const store = standIn();
    const capability = store.presignUpload(uploadRequest());
    expect(capability.method).toBe('PUT');
    expect(capability.expiresAt.toISOString()).toBe('2026-11-12T09:15:00.000Z');
    expect(new URL(capability.url).host).toBe(STAND_IN_HOST);
    expect(capability.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-amz-checksum-sha256': checksumBase64Of(sha(JPEG)),
    });
    expect(store.redeem(uploadCall(capability.url))).toMatchObject({ status: 200 });
    const facts = await store.inspect(KEY, 8);
    expect(facts).toEqual({
      byteSize: JPEG.length,
      checksumSha256: sha(JPEG),
      contentType: 'image/jpeg',
      head: JPEG.slice(0, 8),
    });
    expect(store.has(OTHER_KEY)).toBe(false);
    expect(await store.inspect(OTHER_KEY, 8)).toBeUndefined();
  });

  it('GBT-N6: an upload capability is refused after 15 minutes, and not before', () => {
    let now = new Date(ISSUED.getTime() + 899_000);
    const store = standIn(() => now);
    const capability = store.presignUpload(uploadRequest());
    now = new Date(ISSUED.getTime() + 900_000);
    expect(store.redeem(uploadCall(capability.url))).toEqual({ status: 403, reason: 'EXPIRED' });
    now = new Date(ISSUED.getTime() + 899_000);
    expect(store.redeem(uploadCall(capability.url))).toMatchObject({ status: 200 });
  });

  it('GBT-N7 and GBT-N8: a retrieval capability reads exactly one object, for 5 minutes', () => {
    let now = new Date(ISSUED.getTime() + 1000);
    const store = standIn(() => now);
    const upload = store.presignUpload(uploadRequest());
    expect(store.redeem(uploadCall(upload.url))).toMatchObject({ status: 200 });
    const retrieval = store.presignRetrieval({ key: KEY, issuedAt: ISSUED, ttlSeconds: 300 });
    expect(retrieval.method).toBe('GET');
    expect(retrieval.expiresAt.toISOString()).toBe('2026-11-12T09:05:00.000Z');
    expect(store.redeem({ method: 'GET', url: retrieval.url, headers: {} })).toEqual({
      status: 200,
      body: JPEG,
    });
    now = new Date(ISSUED.getTime() + 300_000);
    expect(store.redeem({ method: 'GET', url: retrieval.url, headers: {} })).toEqual({
      status: 403,
      reason: 'EXPIRED',
    });
  });

  it('GBT-N9: an address changed to another object is not the one that was signed', () => {
    const store = standIn();
    const capability = store.presignUpload(uploadRequest());
    const changed = capability.url.replace(KEY, OTHER_KEY);
    expect(changed).not.toBe(capability.url);
    expect(store.redeem(uploadCall(changed))).toEqual({
      status: 403,
      reason: 'SIGNATURE_MISMATCH',
    });
    expect(store.has(OTHER_KEY)).toBe(false);
    // A capability to read is not a capability to write, and the reverse.
    const retrieval = store.presignRetrieval({ key: KEY, issuedAt: ISSUED, ttlSeconds: 300 });
    const crossed = store.redeem({ ...uploadCall(retrieval.url) });
    expect(crossed.status).toBe(403);
    expect(['HEADER_NOT_SIGNED', 'SIGNATURE_MISMATCH']).toContain(
      'reason' in crossed ? crossed.reason : undefined,
    );
  });

  it('GBT-N10: no capability lists the bucket: the address names one object, and a prefix is not one', () => {
    const store = standIn();
    const capability = store.presignUpload(uploadRequest());
    const url = new URL(capability.url);
    url.pathname = '/evidence/';
    expect(store.redeem({ method: 'GET', url: url.toString(), headers: {} })).toMatchObject({
      status: 403,
    });
    url.pathname = '/evidence/ev/';
    expect(store.redeem({ method: 'GET', url: url.toString(), headers: {} })).toMatchObject({
      status: 403,
    });
  });

  it('refuses an upload that is not the signed one: another type, another size, a body that is not the declared hash', () => {
    const store = standIn();
    const capability = store.presignUpload(uploadRequest());
    expect(
      store.redeem(uploadCall(capability.url, { headers: { 'Content-Type': 'image/png' } })),
    ).toEqual({ status: 403, reason: 'SIGNATURE_MISMATCH' });
    expect(
      store.redeem(uploadCall(capability.url, { headers: { 'Content-Length': '999' } })),
    ).toEqual({ status: 403, reason: 'SIGNATURE_MISMATCH' });
    // The right headers and another body: the store verifies the size and the hash on receipt.
    expect(store.redeem(uploadCall(capability.url, { body: JPEG.slice(0, 5) }))).toEqual({
      status: 400,
      reason: 'SIZE_MISMATCH',
    });
    const forged = Uint8Array.from(JPEG);
    forged[9] = 0;
    expect(store.redeem(uploadCall(capability.url, { body: forged }))).toEqual({
      status: 400,
      reason: 'CHECKSUM_MISMATCH',
    });
    // A signed header that is not sent at all.
    const without = Object.fromEntries(
      Object.entries(uploadCall(capability.url).headers).filter(
        ([name]) => name !== 'x-amz-checksum-sha256',
      ),
    );
    expect(store.redeem({ ...uploadCall(capability.url), headers: without })).toEqual({
      status: 403,
      reason: 'HEADER_NOT_SIGNED',
    });
    expect(store.has(KEY)).toBe(false);
  });

  it('does not accept the capability of another process: each stand-in signs with its own credential', () => {
    const one = standIn();
    const other = standIn();
    const capability = one.presignUpload(uploadRequest());
    expect(other.redeem(uploadCall(capability.url))).toEqual({ status: 400, reason: 'MALFORMED' });
  });

  it('plants an object a test says the store holds, as the store would report it', async () => {
    const store = standIn();
    store.plant(KEY, JPEG, { contentType: 'image/jpeg', checksumSha256: null });
    expect(await store.inspect(KEY, 4)).toEqual({
      byteSize: JPEG.length,
      checksumSha256: undefined,
      contentType: 'image/jpeg',
      head: JPEG.slice(0, 4),
    });
  });

  // Break caught: a read that returns the bytes in one piece (a test of the stream would see one frame), reorders them, or invents an object that is not held.
  it('reads an object as a stream of frames whose bytes are the object, and nothing when nothing is held (Run A2)', async () => {
    const store = standIn();
    const big = Buffer.alloc(20_000);
    for (let at = 0; at < big.length; at += 1) big[at] = at % 253;
    store.plant(KEY, big);
    const object = await store.read(KEY);
    if (object === undefined) throw new Error('the object was held');
    const frames: Uint8Array[] = [];
    for await (const frame of object) frames.push(frame);
    expect(frames.length).toBeGreaterThan(1);
    expect(Buffer.concat(frames).equals(big)).toBe(true);
    expect(await store.read(OTHER_KEY)).toBeUndefined();
    store.plant(OTHER_KEY, new Uint8Array());
    const none = await store.read(OTHER_KEY);
    const emptied: Uint8Array[] = [];
    for await (const frame of none ?? []) emptied.push(frame);
    expect(emptied).toEqual([]);
  });

  // Break caught: a removal that leaves the object where an inspection or a read can still find it, or that fails for an object that is already gone.
  it('removes an object, and removing what is not there is not a failure (Run A2)', async () => {
    const store = standIn();
    store.plant(KEY, JPEG);
    expect(store.has(KEY)).toBe(true);
    await store.remove(KEY);
    expect(store.has(KEY)).toBe(false);
    expect(await store.inspect(KEY, 4)).toBeUndefined();
    expect(await store.read(KEY)).toBeUndefined();
    await expect(store.remove(KEY)).resolves.toBeUndefined();
  });
});

describe('the R2 adapter, through a fake transport (no network)', () => {
  const SECRET = 'TEST-ONLY-NOT-A-CREDENTIAL-0000000000000000';
  const options = (transport: R2Transport) => ({
    accountId: 'testaccount',
    bucket: 'test-evidence',
    accessKeyId: 'TESTONLYACCESSKEY',
    secretAccessKey: new Secret(SECRET),
    transport,
    now: () => ISSUED,
  });
  const never: R2Transport = () => Promise.reject(new Error('no call expected'));

  it('makes no network call: signing is pure, and a look at the store goes through the transport it was given', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
    const store = new R2EvidenceStore(
      options((request) => {
        calls.push({ method: request.method, url: request.url, headers: { ...request.headers } });
        const answer: Awaited<ReturnType<R2Transport>> =
          request.method === 'HEAD'
            ? {
                status: 200,
                headers: {
                  'content-length': String(JPEG.length),
                  'content-type': 'image/jpeg',
                  'x-amz-checksum-sha256': checksumBase64Of(sha(JPEG)),
                },
                body: new Uint8Array(),
              }
            : { status: 206, headers: {}, body: JPEG.slice(0, 8) };
        return Promise.resolve(answer);
      }),
    );
    store.presignUpload(uploadRequest());
    store.presignRetrieval({ key: KEY, issuedAt: ISSUED, ttlSeconds: 300 });
    expect(calls).toHaveLength(0);
    const facts = await store.inspect(KEY, 8);
    expect(facts).toEqual({
      byteSize: JPEG.length,
      checksumSha256: sha(JPEG),
      contentType: 'image/jpeg',
      head: JPEG.slice(0, 8),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The two server-side calls: a look at the object and a ranged read of its first bytes, each signed in the header form.
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['HEAD', `https://testaccount.r2.cloudflarestorage.com/test-evidence/${KEY}`],
      ['GET', `https://testaccount.r2.cloudflarestorage.com/test-evidence/${KEY}`],
    ]);
    expect(calls[0]?.headers['x-amz-checksum-mode']).toBe('ENABLED');
    expect(calls[1]?.headers.range).toBe('bytes=0-7');
    for (const call of calls) {
      expect(call.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=TESTONLYACCESSKEY\/20261112\/auto\/s3\/aws4_request,SignedHeaders=.*host.*x-amz-content-sha256.*x-amz-date.*,Signature=[0-9a-f]{64}$/,
      );
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
  });

  it('signs a look at an object as the published algorithm does for the same request', async () => {
    let seen = '';
    const store = new R2EvidenceStore(
      options((request) => {
        seen = request.headers.authorization ?? '';
        return Promise.resolve({ status: 404, headers: {}, body: new Uint8Array() });
      }),
    );
    expect(await store.inspect(KEY, 8)).toBeUndefined();
    const expected = authorizeRequest(
      { accessKeyId: 'TESTONLYACCESSKEY', secretAccessKey: SECRET },
      ISSUED,
      { region: 'auto', service: 's3' },
      {
        method: 'HEAD',
        path: `/test-evidence/${KEY}`,
        query: {},
        headers: {
          host: 'testaccount.r2.cloudflarestorage.com',
          'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
          'x-amz-date': amzDateOf(ISSUED),
          'x-amz-checksum-mode': 'ENABLED',
        },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
    );
    expect(seen).toBe(expected.authorization);
  });

  it('makes an upload capability for one object that signs the type, the exact size and the hash, for the seconds given', () => {
    const store = new R2EvidenceStore(options(never));
    const capability = store.presignUpload(uploadRequest());
    expect(capability.method).toBe('PUT');
    expect(capability.expiresAt.toISOString()).toBe('2026-11-12T09:15:00.000Z');
    const url = new URL(capability.url);
    expect(url.host).toBe('testaccount.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/test-evidence/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;x-amz-checksum-sha256',
    );
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'TESTONLYACCESSKEY/20261112/auto/s3/aws4_request',
    );
    expect(capability.url).not.toContain(SECRET);
    // The same inputs make the same address (a retry is told what the first was told), and it is the published algorithm's own signature.
    expect(store.presignUpload(uploadRequest()).url).toBe(capability.url);
    const independent = presignRequest(
      { accessKeyId: 'TESTONLYACCESSKEY', secretAccessKey: SECRET },
      ISSUED,
      { region: 'auto', service: 's3' },
      {
        method: 'PUT',
        host: 'testaccount.r2.cloudflarestorage.com',
        path: `/test-evidence/${KEY}`,
        signedHeaders: {
          'content-type': 'image/jpeg',
          'content-length': String(JPEG.length),
          'x-amz-checksum-sha256': checksumBase64Of(sha(JPEG)),
        },
        expiresSeconds: 900,
      },
    );
    expect(capability.url).toBe(independent.url);
    expect(capability.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-amz-checksum-sha256': checksumBase64Of(sha(JPEG)),
    });
    // Another key is another signature (GBT-N9); another declared hash or size is another signature too.
    expect(store.presignUpload(uploadRequest({ key: OTHER_KEY })).url).not.toBe(capability.url);
    expect(store.presignUpload(uploadRequest({ byteSize: JPEG.length + 1 })).url).not.toBe(
      capability.url,
    );
  });

  it('makes a retrieval capability that reads one object for 5 minutes and carries no header', () => {
    const store = new R2EvidenceStore(options(never));
    const capability = store.presignRetrieval({ key: KEY, issuedAt: ISSUED, ttlSeconds: 300 });
    expect(capability.method).toBe('GET');
    expect(capability.headers).toEqual({});
    const url = new URL(capability.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.pathname).toBe(`/test-evidence/${KEY}`);
  });

  it('says only what the store answered when it is unavailable, and never the address or the credential', async () => {
    const down = new R2EvidenceStore(options(() => Promise.reject(new Error(`boom ${SECRET}`))));
    const error = await down.inspect(KEY, 8).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceStoreError);
    expect(error).toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).message).not.toContain('r2.cloudflarestorage.com');
    const refusing = new R2EvidenceStore(
      options(() => Promise.resolve({ status: 500, headers: {}, body: new Uint8Array() })),
    );
    await expect(refusing.inspect(KEY, 8)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    const nothing = new R2EvidenceStore(
      options(() =>
        Promise.resolve({
          status: 200,
          headers: { 'content-length': 'x' },
          body: new Uint8Array(),
        }),
      ),
    );
    await expect(nothing.inspect(KEY, 8)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });

  // The bytes of an object, as a store would send them: in frames, as an async iterable.
  async function* sent(...parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      await Promise.resolve();
      yield part;
    }
  }
  const withStream = (stream: R2StreamTransport) => ({
    ...options(never),
    streamTransport: stream,
  });

  // Break caught: a read that is not signed as the published algorithm signs it, that carries a range, or that hands on the bytes in any order but the store's.
  it('reads an object as a stream through the stream transport, signed in the header form (Run A2)', async () => {
    const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
    const store = new R2EvidenceStore(
      withStream((request) => {
        calls.push({ method: request.method, url: request.url, headers: { ...request.headers } });
        return Promise.resolve({
          status: 200,
          headers: {},
          body: sent(JPEG.slice(0, 4), JPEG.slice(4)),
        });
      }),
    );
    const object = await store.read(KEY);
    if (object === undefined) throw new Error('the object was there');
    const taken: Uint8Array[] = [];
    for await (const frame of object) taken.push(frame);
    expect(Buffer.concat(taken).equals(Buffer.from(JPEG))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`https://testaccount.r2.cloudflarestorage.com/test-evidence/${KEY}`);
    expect(calls[0]?.headers.range).toBeUndefined();
    const expected = authorizeRequest(
      { accessKeyId: 'TESTONLYACCESSKEY', secretAccessKey: SECRET },
      ISSUED,
      { region: 'auto', service: 's3' },
      {
        method: 'GET',
        path: `/test-evidence/${KEY}`,
        query: {},
        headers: {
          host: 'testaccount.r2.cloudflarestorage.com',
          'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
          'x-amz-date': amzDateOf(ISSUED),
        },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
    );
    expect(calls[0]?.headers.authorization).toBe(expected.authorization);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('reads nothing when the store has nothing, and says only the status for any other answer', async () => {
    const absent = new R2EvidenceStore(
      withStream(() => Promise.resolve({ status: 404, headers: {}, body: undefined })),
    );
    expect(await absent.read(KEY)).toBeUndefined();
    for (const status of [403, 500, 503]) {
      const refusing = new R2EvidenceStore(
        withStream(() => Promise.resolve({ status, headers: {}, body: undefined })),
      );
      const error = await refusing.read(KEY).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'STORE_UNAVAILABLE' });
      expect((error as Error).message).toContain(String(status));
      expect((error as Error).message).not.toContain('r2.cloudflarestorage.com');
    }
    const headless = new R2EvidenceStore(
      withStream(() => Promise.resolve({ status: 200, headers: {}, body: undefined })),
    );
    await expect(headless.read(KEY)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });

  // Break caught: a transport's network error reaching a caller as it is (it may name the address), or a store that stops sending half-way read as an object that is complete.
  it('turns a transport that fails, and a body that breaks off, into the store’s own failure without their words', async () => {
    const down = new R2EvidenceStore(
      withStream(() => Promise.reject(new Error(`boom ${SECRET} r2.cloudflarestorage.com`))),
    );
    const refused = await down.read(KEY).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect((refused as Error).message).not.toContain(SECRET);
    expect((refused as Error).message).not.toContain('r2.cloudflarestorage.com');

    async function* breaking(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield JPEG.slice(0, 4);
      throw new Error(`terminated ${SECRET}`);
    }
    const store = new R2EvidenceStore(
      withStream(() => Promise.resolve({ status: 200, headers: {}, body: breaking() })),
    );
    const object = await store.read(KEY);
    if (object === undefined) throw new Error('the object was there');
    const reading = (async () => {
      for await (const frame of object) void frame;
    })();
    const error = await reading.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EvidenceStoreError);
    expect(error).toMatchObject({ code: 'STORE_UNAVAILABLE' });
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('cannot read an object without a stream transport, and says so', async () => {
    const store = new R2EvidenceStore(options(never));
    await expect(store.read(KEY)).rejects.toMatchObject({ code: 'STORE_NOT_CONFIGURED' });
  });

  // Break caught: a removal that is not signed, goes to another object, or fails for an object that is already gone.
  it('removes an object with a signed DELETE, and an object already gone is no failure (Run A2)', async () => {
    const calls: { method: string; url: string; authorization: string | undefined }[] = [];
    const answers = [204, 200, 404];
    const store = new R2EvidenceStore(
      options((request) => {
        calls.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        return Promise.resolve({
          status: answers[calls.length - 1] ?? 500,
          headers: {},
          body: new Uint8Array(),
        });
      }),
    );
    await store.remove(KEY);
    await store.remove(KEY);
    await store.remove(KEY);
    expect(calls.map((call) => [call.method, call.url])).toEqual(
      Array.from({ length: 3 }, () => [
        'DELETE',
        `https://testaccount.r2.cloudflarestorage.com/test-evidence/${KEY}`,
      ]),
    );
    const expected = authorizeRequest(
      { accessKeyId: 'TESTONLYACCESSKEY', secretAccessKey: SECRET },
      ISSUED,
      { region: 'auto', service: 's3' },
      {
        method: 'DELETE',
        path: `/test-evidence/${KEY}`,
        query: {},
        headers: {
          host: 'testaccount.r2.cloudflarestorage.com',
          'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
          'x-amz-date': amzDateOf(ISSUED),
        },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
    );
    expect(calls[0]?.authorization).toBe(expected.authorization);
    const failing = new R2EvidenceStore(
      options(() => Promise.resolve({ status: 500, headers: {}, body: new Uint8Array() })),
    );
    await expect(failing.remove(KEY)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
  });

  it('is not configured without an account, a bucket and an access key', () => {
    for (const bad of [{ accountId: '' }, { bucket: '' }, { accessKeyId: '' }, { bucket: 'a/b' }]) {
      let caught: unknown;
      try {
        new R2EvidenceStore({ ...options(never), ...bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'STORE_NOT_CONFIGURED' });
    }
  });

  it('prints the credential as redacted through every ordinary route', () => {
    const secret = new Secret(SECRET);
    expect(JSON.stringify({ secret })).not.toContain(SECRET);
    expect(String(secret)).toBe('[REDACTED]');
  });
});
