import { createBrowserApiClient } from '@melarc/api-client/browser';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { sha256Hex } from './file-checksum';
import { ObjectStoreError } from './object-store-upload';
import { createEvidenceUploader, type UploadStep } from './upload-evidence';

/**
 * One file's trip to a stored record: its checksum, its declaration, the `PUT` of its bytes to the address the platform issued, and the completion. **The address of the upload is held by one call
 * and by nothing else**, the declaration goes under a key that a file whose outcome nobody knows keeps (so that its retry makes no second record) and that every other file forgets, and what the bytes
 * are sent with is the instruction's and nothing more: no cookie and no credential.
 */
const OWNER = '1b4d6c0e-3a5f-4b7c-8d9e-0f1a2b3c4d5e';
const RECORD = '93c5e486-b2d7-43f4-a576-8192a3b4c5d6';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const STORE_ORIGIN = 'https://store.example';
const STORE = '/object-store/object-1';
const SECRET = 'signature-that-is-a-bearer-capability';

let api: FakeApi;
let puts: Request[];

beforeEach(() => {
  document.cookie = 'melarc_csrf=csrf-token; path=/';
  // jsdom has no `crypto.subtle`; the browsers the portal runs in all have it.
  vi.stubGlobal('crypto', webcrypto);
  puts = [];
  server();
});
afterEach(() => {
  api.restore();
  vi.unstubAllGlobals();
  document.cookie = 'melarc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

const file = (name = 'door.jpg') =>
  new File([BYTES], name, { type: 'image/jpeg', lastModified: Date.parse('2026-11-01T08:30:00Z') });

const ticketBody = (overrides: object = {}) => ({
  evidence: {
    id: RECORD,
    owner_type: 'PICKUP_INTAKE',
    owner_id: OWNER,
    purpose: 'CONDITION',
    captured_at: '2026-11-01T08:30:00Z',
    captured_by_actor: OWNER,
    state: 'PENDING_UPLOAD',
    access_rule: 'x',
    retention_policy: 'y',
  },
  upload: {
    method: 'PUT',
    url: `${STORE_ORIGIN}${STORE}?sig=${SECRET}`,
    headers: { 'Content-Type': 'image/jpeg' },
    expires_at: '2026-11-14T09:15:00Z',
    ...overrides,
  },
});

interface Setup {
  create?: (request: Request) => Response | Promise<Response>;
  put?: (request: Request) => Response | Promise<Response>;
  complete?: (request: Request) => Response | Promise<Response>;
}
function server(setup: Setup = {}): void {
  api = installFakeApi({
    'POST /evidence': setup.create ?? (() => json(200, ticketBody(), { ETag: '"e1"' })),
    [`PUT ${STORE}`]: (request) => {
      puts.push(request);
      return (setup.put ?? (() => new Response(null, { status: 200 })))(request);
    },
    [`POST /evidence/${RECORD}/complete`]:
      setup.complete ?? (() => json(200, { id: RECORD, state: 'STORED' })),
  });
}
const uploader = (purpose: 'CONDITION' | 'OSD' = 'CONDITION') =>
  createEvidenceUploader(createBrowserApiClient(), { ownerId: OWNER, purpose });
const requestsTo = (method: string, path: string) =>
  api.requests.filter(
    (request) => request.method === method && new URL(request.url).pathname.endsWith(path),
  );

describe('the checksum of a file', () => {
  it('is the 64 hexadecimal digits of its SHA-256', async () => {
    expect(await sha256Hex(new Blob([new TextEncoder().encode('abc')]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('the upload of a file', () => {
  it('declares the file, sends its bytes to the address the platform issued, and completes it on the version of the declaration', async () => {
    server();
    const steps: UploadStep[] = [];

    const stored = await uploader()(file(), (step) => steps.push(step));

    expect(stored).toBe(RECORD);
    expect(steps).toEqual(['hashing', 'declaring', 'sending', 'confirming']);

    const [declaration] = requestsTo('POST', '/evidence');
    expect(declaration?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(declaration?.headers.get('If-Match')).toBeNull();
    expect(await declaration?.clone().json()).toEqual({
      owner_type: 'PICKUP_INTAKE',
      owner_id: OWNER,
      purpose: 'CONDITION',
      captured_at: '2026-11-01T08:30:00.000Z',
      content_type: 'image/jpeg',
      byte_size: 8,
      checksum_sha256: await sha256Hex(file()),
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]?.method).toBe('PUT');
    expect(puts[0]?.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array((await puts[0]?.clone().arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      BYTES,
    );

    const [completion] = requestsTo('POST', `/evidence/${RECORD}/complete`);
    expect(completion?.headers.get('If-Match')).toBe('"e1"');
    expect(completion?.headers.get('Idempotency-Key')).toBeNull();
  });

  it('declares the evidence of an adjudication for the purpose it was made for', async () => {
    server({
      create: () =>
        json(
          200,
          { ...ticketBody(), evidence: { ...ticketBody().evidence, purpose: 'OSD' } },
          { ETag: '"e1"' },
        ),
    });
    await uploader('OSD')(file());
    expect(await requestsTo('POST', '/evidence')[0]?.clone().json()).toMatchObject({
      purpose: 'OSD',
    });
  });

  // Break caught: a capture time in the future (the platform refuses it) or one that is the time of the upload when the file says when it was made.
  it('declares the moment the file was made, and never one later than now', async () => {
    server();
    const future = new File([BYTES], 'later.jpg', {
      type: 'image/jpeg',
      lastModified: Date.now() + 3_600_000,
    });
    const before = Date.now();
    await uploader()(future);
    const body = (await requestsTo('POST', '/evidence')[0]?.clone().json()) as {
      captured_at: string;
    };
    expect(Date.parse(body.captured_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(body.captured_at)).toBeGreaterThanOrEqual(before - 1);
  });

  // Break caught: the platform's session sent to a store that is not the API, or the address kept in what is told of the upload.
  it('sends the bytes with no credentials and no referrer, and no cookie of the portal', async () => {
    server();
    const spy = vi.spyOn(globalThis, 'fetch');
    await uploader()(file());

    const call = spy.mock.calls.find(
      ([input]) => typeof input === 'string' && input.includes(STORE),
    );
    const init = call?.[1];
    expect(init?.credentials).toBe('omit');
    expect(init?.referrerPolicy).toBe('no-referrer');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('PUT');
    expect(JSON.stringify(init?.headers)).not.toContain('csrf');
  });

  it('is told that the store could not be reached, without the address', async () => {
    server({ put: () => Promise.reject(new TypeError(`Failed to fetch ${STORE}?sig=${SECRET}`)) });

    const failure: unknown = await uploader()(file()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ObjectStoreError);
    expect(failure).toMatchObject({ kind: 'unreachable' });
    expect((failure as Error).message).not.toContain(SECRET);
    expect((failure as Error).stack ?? '').not.toContain(SECRET);
  });

  it('is told that the store declined the file, with the status', async () => {
    server({ put: () => new Response('no', { status: 403 }) });
    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'refused', status: 403 });
    // The bytes were refused, so the platform was not told they had landed.
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(0);
  });

  // Break caught: an upload that sends a file to an instruction it cannot follow, or that tells the platform the bytes landed when it never sent them.
  it('does not send a file for an instruction the portal cannot follow, and does not complete it', async () => {
    server({ create: () => json(200, ticketBody({ method: 'POST' }), { ETag: '"e1"' }) });
    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'unexpected-response' });
    expect(puts).toHaveLength(0);
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(0);
  });

  it('does not send a file for a declaration that came with no version to complete it on', async () => {
    server({ create: () => json(200, ticketBody()) });
    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'unexpected-response' });
    expect(puts).toHaveLength(0);
  });

  it('does not take a record as stored that the completion did not say was', async () => {
    server({ complete: () => json(200, { id: RECORD, state: 'PENDING_UPLOAD' }) });
    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'unexpected-response' });
  });

  // Break caught: a retry that makes a second record: the key of a file whose outcome nobody knows is kept, so that the platform answers the record it made.
  it('declares again under the same key when the outcome of the last attempt was not known', async () => {
    server({ put: () => Promise.reject(new TypeError('Failed to fetch')) });
    const upload = uploader();
    const chosen = file();
    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);
    const [first, second] = requestsTo('POST', '/evidence');
    expect(first?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.headers.get('Idempotency-Key')).toBe(second?.headers.get('Idempotency-Key'));
  });

  it('declares again under a new key after the platform refused the file', async () => {
    server({ create: () => errorResponse(422, 'VALIDATION_FAILED') });
    const upload = uploader();
    const chosen = file('refused.jpg');
    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);
    const [one, two] = requestsTo('POST', '/evidence');
    expect(one?.headers.get('Idempotency-Key')).not.toBe(two?.headers.get('Idempotency-Key'));
  });

  it('forgets the key of a file once it is stored, so a second file is a second record', async () => {
    server();
    const upload = uploader();
    await upload(file('one.jpg'));
    await upload(file('two.jpg'));
    const [one, two] = requestsTo('POST', '/evidence');
    expect(one?.headers.get('Idempotency-Key')).not.toBe(two?.headers.get('Idempotency-Key'));
  });
});
