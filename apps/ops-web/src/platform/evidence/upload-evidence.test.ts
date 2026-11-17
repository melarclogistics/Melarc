import { createBrowserApiClient } from '@melarc/api-client/browser';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { sha256Hex } from './file-checksum';
import { ObjectStoreError } from './object-store-upload';
import { createBoundedQueue } from '../api/bounded-queue';
import { ReadHold } from '../query/read-hold';
import {
  createEvidenceUploader,
  EvidenceRefusedError,
  UPLOAD_BUDGETS,
  UPLOAD_CONCURRENCY,
  UploadAddressExpiredError,
  UploadTimeoutError,
  type UploaderOptions,
  type UploadStep,
} from './upload-evidence';

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

/** An instant a number of seconds from now: the address a platform just made lives for minutes from the moment it is made, and the portal judges it by the clock. */
const inSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

const ticketBody = (overrides: object = {}, evidence: object = {}) => ({
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
    ...evidence,
  },
  upload: {
    method: 'PUT',
    url: `${STORE_ORIGIN}${STORE}?sig=${SECRET}`,
    headers: { 'Content-Type': 'image/jpeg' },
    expires_at: inSeconds(900),
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
const uploader = (purpose: 'CONDITION' | 'OSD' = 'CONDITION', options?: UploaderOptions) =>
  createEvidenceUploader(createBrowserApiClient(), { ownerId: OWNER, purpose }, options);
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

const LIMITS = { allowedTypes: ['image/jpeg', 'image/png'], maxBytes: 4 } as const;
const keysOfDeclarations = () =>
  requestsTo('POST', '/evidence').map((request) => request.headers.get('Idempotency-Key'));

/** A file that is `size` bytes as far as the platform's limits can tell, whatever bytes it really holds: the portal judges what it knows before it reads anything. */
const claiming = (size: number, name = 'big.jpg') => {
  const chosen = file(name);
  Object.defineProperty(chosen, 'size', { value: size });
  return chosen;
};

describe('the upload judges what it can before it reads the file', () => {
  // Break caught: the whole file read (the checksum reads every byte) for a photo the platform will refuse for its size anyway: a tablet that holds a 40 MB file in memory to be told it is too large.
  it('refuses a file above the size the platform allows before the file is read, and sends nothing', async () => {
    server();
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    const steps: UploadStep[] = [];

    const failure: unknown = await uploader('CONDITION', { limits: LIMITS })(file(), (step) =>
      steps.push(step),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EvidenceRefusedError);
    expect(failure).toMatchObject({ kind: 'too_large', size: 8, limit: 4 });
    expect(digest).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it('refuses a type the platform does not take before the file is read, and sends nothing', async () => {
    server();
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    const pdf = new File([BYTES], 'form.pdf', { type: 'application/pdf' });

    const failure: unknown = await uploader('CONDITION', {
      limits: { allowedTypes: ['image/jpeg'], maxBytes: 100 },
    })(pdf).catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: 'type_not_allowed', type: 'application/pdf' });
    expect(digest).not.toHaveBeenCalled();
    expect(api.requests).toEqual([]);
  });

  it('takes a file at the size the platform allows', async () => {
    server();
    expect(await uploader('CONDITION', { limits: { ...LIMITS, maxBytes: 8 } })(file())).toBe(
      RECORD,
    );
  });

  // Break caught: a size invented when the limits could not be read, which refuses a file the platform takes or waves through one it will not (the platform refuses it, and says why).
  it('judges nothing when the limits are not known, and leaves the refusal to the platform', async () => {
    server();
    const large = claiming(11 * 1024 * 1024);

    expect(await uploader()(large)).toBe(RECORD);
    const [declaration] = requestsTo('POST', '/evidence');
    expect(await declaration?.clone().json()).toMatchObject({ byte_size: 11 * 1024 * 1024 });
  });
});

describe('the upload of a file whose answer was lost', () => {
  // Break caught: a file that is stored and cannot be told so: the retry is answered with the record as it is now (stored), the portal calls that "not the API's answer", and "Try again" never ends.
  it('takes a record that is stored already as stored, and sends and completes nothing more', async () => {
    server({ complete: () => Promise.reject(new TypeError('Failed to fetch')) });
    const upload = uploader();
    const chosen = file();
    // The bytes landed and the platform completed the record, and the answer was lost on the way back.
    await expect(upload(chosen)).rejects.toBeDefined();
    expect(puts).toHaveLength(1);
    api.on('POST /evidence', () =>
      json(200, ticketBody({}, { state: 'STORED' }), { ETag: '"e2"' }),
    );
    const steps: UploadStep[] = [];

    expect(await upload(chosen, (step) => steps.push(step))).toBe(RECORD);

    expect(puts).toHaveLength(1);
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(1);
    expect(steps).toEqual(['hashing', 'declaring']);
    // It was the same declaration under the same key: the platform made no second record.
    const [first, second] = keysOfDeclarations();
    expect(second).toBe(first);
  });

  // Break caught: a stored file whose key is kept, so the next file chosen with the same bytes is told the record of the first.
  it('forgets the key of a file it found stored, so that the next file is a new record', async () => {
    server({ create: () => json(200, ticketBody({}, { state: 'STORED' }), { ETag: '"e2"' }) });
    const upload = uploader();
    await upload(file('one.jpg'));
    await upload(file('two.jpg'));
    const [one, two] = keysOfDeclarations();
    expect(one).not.toBe(two);
  });
});

describe('the upload address of a file has run out', () => {
  const expiredAddress = () => ticketBody({ expires_at: inSeconds(-60) });

  // Break caught: bytes sent to an address the store would refuse, and a file that can never be sent because the same record keeps coming back with the same address.
  it('asks for a new record, once and under a new key, and sends the bytes to the fresh address', async () => {
    let asked = 0;
    server({
      create: () =>
        json(200, (asked += 1) === 1 ? expiredAddress() : ticketBody(), { ETag: '"e1"' }),
    });

    expect(await uploader()(file())).toBe(RECORD);

    const [first, second] = keysOfDeclarations();
    expect(keysOfDeclarations()).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(puts).toHaveLength(1);
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(1);
  });

  it('counts an address that is about to run out as run out, and one with a minute left as good', async () => {
    let asked = 0;
    server({
      create: () =>
        json(200, ticketBody({ expires_at: inSeconds((asked += 1) === 1 ? 5 : 60) }), {
          ETag: '"e1"',
        }),
    });
    await uploader()(file());
    expect(keysOfDeclarations()).toHaveLength(2);

    asked = 1;
    api.requests.length = 0;
    await uploader()(file());
    expect(keysOfDeclarations()).toHaveLength(1);
  });

  it('asks again, once, for a record the platform says has expired', async () => {
    let asked = 0;
    server({
      create: () =>
        json(200, ticketBody({}, (asked += 1) === 1 ? { state: 'EXPIRED' } : {}), {
          ETag: '"e1"',
        }),
    });

    expect(await uploader()(file())).toBe(RECORD);
    expect(keysOfDeclarations()).toHaveLength(2);
    expect(puts).toHaveLength(1);
  });

  // Break caught: a loop of declarations (a new record for each, for ever) when the platform keeps answering with addresses that have run out: the person is told, and the next attempt is theirs.
  it('is told when a fresh address has run out too, and sends nothing, after exactly two declarations', async () => {
    server({ create: () => json(200, expiredAddress(), { ETag: '"e1"' }) });

    await expect(uploader()(file())).rejects.toBeInstanceOf(UploadAddressExpiredError);

    expect(keysOfDeclarations()).toHaveLength(2);
    expect(puts).toHaveLength(0);
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(0);
  });
});

/** A request that gets no answer until it is abandoned: the network a tablet meets in a loading bay. */
const hangsUntilAborted = (request: Request): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

describe('the budgets of the steps', () => {
  // Break caught: a budget that drifts (the tests below follow the constants, so the numbers themselves are pinned here, where a reviewer reads them): provisional values, the platform sets none.
  it('are provisional values held in one place: 20 s for a call, half a minute to five for the bytes', () => {
    expect(UPLOAD_BUDGETS).toEqual({
      declareMs: 20_000,
      confirmMs: 20_000,
      sendMinMs: 30_000,
      sendBytesPerSecond: 64 * 1024,
      sendMaxMs: 300_000,
    });
  });
});

describe('the time a step of the upload may take', () => {
  /**
   * How long a test waits, on the real clock, for what the upload does next. **A deadline, and never a count of turns of the event loop**: the first step of an upload is the SHA-256 of the file, a real asynchronous
   * digest on the platform's thread pool whose duration is the machine's, and a count of 500 turns (a few milliseconds) ended the wait before the digest had answered whenever the thread that makes it was not
   * given a core (CI run 43910214408: four of these tests failed on a loaded runner; with the process pinned to one core, half the runs failed). What these tests prove is that **the budget of a step is counted from the
   * moment its timer was made**, which has nothing to do with how fast a machine is. The fake clock does not move this one (`performance` is not faked, only the timers and `Date`), and it is far under the test's own
   * timeout, which stays the ceiling that ends a test that is really stuck. The budgets of the product are not changed.
   */
  const REAL_WAIT_MS = 10_000;

  /** Waits for what the upload does next on the real event loop, which moves no fake clock: the budget of a step is then counted from the moment its timer was made. */
  const until = async (seen: () => boolean, waitMs = REAL_WAIT_MS): Promise<void> => {
    const deadline = performance.now() + waitMs;
    while (!seen() && performance.now() < deadline) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(
      seen(),
      `the upload did not come to its next step in ${String(waitMs)} ms of real time`,
    ).toBe(true);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Break caught: a wait that never ends (a test that hangs until the runner kills it) or that ends without saying what it waited for, or one that counts by the fake clock, which these tests move by hand and which would
  // never reach the deadline.
  it('waits for the next step on the real clock, and says what it waited for when the step does not come', async () => {
    const started = performance.now();
    const clock = Date.now();

    await expect(until(() => false, 50)).rejects.toThrow(
      /did not come to its next step in 50 ms of real time/,
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(49);
    expect(Date.now()).toBe(clock);
  });

  // Break caught: an upload that waits for ever for an answer that is not coming, with a spinner the officer cannot tell from work.
  it('tells a declaration that gets no answer as a timeout of that step, and not a minute sooner', async () => {
    server({ create: hangsUntilAborted });
    let settled = false;
    const outcome = uploader()(file()).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await until(() => requestsTo('POST', '/evidence').length === 1);

    await vi.advanceTimersByTimeAsync(UPLOAD_BUDGETS.declareMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(UploadTimeoutError);
    expect(failure).toMatchObject({ step: 'declaring' });
    expect(puts).toHaveLength(0);
  });

  it('tells the bytes that do not arrive as a timeout of their own, which is at least half a minute', async () => {
    server({ put: hangsUntilAborted });
    let settled = false;
    const outcome = uploader()(file()).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await until(() => puts.length === 1);

    await vi.advanceTimersByTimeAsync(UPLOAD_BUDGETS.sendMinMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(UploadTimeoutError);
    expect(failure).toMatchObject({ step: 'sending' });
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(0);
  });

  // Break caught: a budget for the bytes that is the same for a 40 KB photo and a 9 MB one, so that a slow link ends the one it could have finished.
  it('gives a larger file longer to arrive, in proportion to its size and no more than a limit', async () => {
    server({ put: hangsUntilAborted });
    const size = 8 * 1024 * 1024;
    const wanted = Math.ceil((size / UPLOAD_BUDGETS.sendBytesPerSecond) * 1000);
    expect(wanted).toBeGreaterThan(UPLOAD_BUDGETS.sendMinMs);
    expect(wanted).toBeLessThanOrEqual(UPLOAD_BUDGETS.sendMaxMs);
    let settled = false;
    const outcome = uploader()(claiming(size)).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await until(() => puts.length === 1);

    await vi.advanceTimersByTimeAsync(wanted - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ step: 'sending' });
  });

  it('never gives the bytes longer than the largest budget, however large the file claims to be', async () => {
    server({ put: hangsUntilAborted });
    let settled = false;
    const outcome = uploader()(claiming(2 ** 40)).catch((error: unknown) => error);
    void outcome.then(() => {
      settled = true;
    });
    await until(() => puts.length === 1);

    // A budget above what a timer can hold would fire at once, which is no budget at all: the cap is exact.
    await vi.advanceTimersByTimeAsync(UPLOAD_BUDGETS.sendMaxMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({ step: 'sending' });
  });

  it('tells a confirmation that gets no answer as a timeout of that step', async () => {
    server({ complete: hangsUntilAborted });
    const outcome = uploader()(file()).catch((error: unknown) => error);
    await until(() => requestsTo('POST', `/evidence/${RECORD}/complete`).length === 1);

    await vi.advanceTimersByTimeAsync(UPLOAD_BUDGETS.confirmMs);

    expect(await outcome).toMatchObject({ step: 'confirming' });
  });

  // Break caught: a timeout that makes a second record on the retry: the outcome is not known (the platform may have it), so the key is kept and the retry is told the record that was made.
  it('keeps the key of a file that timed out, and does not try again by itself', async () => {
    server({ put: hangsUntilAborted });
    const upload = uploader();
    const chosen = file();
    const first = upload(chosen).catch((error: unknown) => error);
    await until(() => puts.length === 1);
    await vi.advanceTimersByTimeAsync(UPLOAD_BUDGETS.sendMinMs);
    await first;
    // Nothing happens by itself afterwards.
    await vi.advanceTimersByTimeAsync(10 * UPLOAD_BUDGETS.sendMaxMs);
    expect(keysOfDeclarations()).toHaveLength(1);

    api.on(`PUT ${STORE}`, () => new Response(null, { status: 200 }));
    expect(await upload(chosen)).toBe(RECORD);
    const [one, two] = keysOfDeclarations();
    expect(two).toBe(one);
  });

  // Break caught: the officer's own "leave out" reported as a timeout, or a timer left running after the upload was abandoned.
  it('is not a timeout when the file is abandoned, and leaves no timer behind', async () => {
    server({ put: hangsUntilAborted });
    const controller = new AbortController();
    const outcome = uploader()(file(), undefined, controller.signal).catch(
      (error: unknown) => error,
    );
    await until(() => puts.length === 1);

    controller.abort();
    const failure = await outcome;

    expect(failure).not.toBeInstanceOf(UploadTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer of a step that finished in time', async () => {
    server();
    await uploader()(file());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('an upload the browser’s own policy blocked', () => {
  const violation = (directive: string, blocked: string): Event =>
    Object.assign(new Event('securitypolicyviolation'), {
      effectiveDirective: directive,
      blockedURI: blocked,
    });

  // Break caught: a policy that does not allow the bucket told as "check the connection", which sends an officer to retry a button that can never work.
  it('is told as blocked, not as a store that could not be reached', async () => {
    server({
      put: () => {
        window.dispatchEvent(violation('connect-src', STORE_ORIGIN));
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    });

    const failure: unknown = await uploader()(file()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ObjectStoreError);
    expect(failure).toMatchObject({ kind: 'blocked' });
    expect((failure as Error).message).not.toContain(SECRET);
  });

  // Break caught: a verdict taken before the browser has reported the violation (a queued event can arrive after the request has already failed).
  it('is told as blocked when the browser reports it just after the request failed', async () => {
    server({
      put: () => {
        setTimeout(() => window.dispatchEvent(violation('connect-src', STORE_ORIGIN)), 0);
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    });

    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'blocked' });
  });

  // Break caught: any violation of the page, of any directive or any address, taken for this upload's.
  it.each([
    ['another directive', violation('img-src', STORE_ORIGIN)],
    ['another address', violation('connect-src', 'https://elsewhere.example')],
    ['no address', violation('connect-src', '')],
  ])('is not told as blocked for a violation of %s', async (_name, event) => {
    server({
      put: () => {
        window.dispatchEvent(event);
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    });

    await expect(uploader()(file())).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('stops listening for violations once the request is over', async () => {
    server();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    await uploader()(file());

    const added = add.mock.calls.filter(([type]) => type === 'securitypolicyviolation').length;
    const removed = remove.mock.calls.filter(([type]) => type === 'securitypolicyviolation').length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

/**
 * What the review of 17 November 2026 found in a file's trip, each with the break it catches (the tests above were already there, and none of them is changed): a later refusal that threw away the key of an
 * unanswered declaration; a `captured_at` worked out again at each attempt; an address judged by a device clock that was minutes out, and a store that said it had run out and was believed good; a file
 * started twice; and a hundred files started at once.
 */
/** No hold: these tests are of a file's own journey, and a refusal of rate in them must not hold the files of the next test. */
const noWait: UploaderOptions = {};
const rateLimited = (seconds?: number): Response =>
  new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'x', request_id: 'req-test-1' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      ...(seconds === undefined ? {} : { 'Retry-After': String(seconds) }),
    },
  });
const bodyOfDeclaration = async (index: number): Promise<{ captured_at: string }> =>
  JSON.parse((await requestsTo('POST', '/evidence')[index]?.clone().text()) ?? '{}') as {
    captured_at: string;
  };

describe('the key of a file whose declaration was not answered', () => {
  // Break caught: a refusal of a limit of rate, made to the retry of an unanswered declaration, taken as proof that the first one never committed: the key was dropped, the next attempt made a second record
  // for the same file, and the first stayed behind.
  it('is kept through a request refused for being too fast, so that the next attempt is a replay', async () => {
    let calls = 0;
    server({
      create: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
        if (calls === 2) return rateLimited();
        return json(200, ticketBody(), { ETag: '"e1"' });
      },
    });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await expect(upload(chosen)).rejects.toBeDefined();
    await expect(upload(chosen)).rejects.toMatchObject({ status: 429 });
    expect(await upload(chosen)).toBe(RECORD);

    const [first, second, third] = keysOfDeclarations();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  // Break caught: the same with a refusal that is final for its own request (a permission, a validation): it does not say whether the first declaration committed either.
  it.each([
    ['a refused permission', 403, 'PERMISSION_DENIED'],
    ['a malformed request', 422, 'VALIDATION_FAILED'],
    ['a version that moved', 409, 'STATE_CONFLICT'],
  ])('is kept through %s answered to the retry', async (_name, status, code) => {
    let calls = 0;
    server({
      create: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
        if (calls === 2) return errorResponse(status, code);
        return json(200, ticketBody(), { ETag: '"e1"' });
      },
    });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);
    await upload(chosen);

    expect(new Set(keysOfDeclarations()).size).toBe(1);
  });

  // Break caught: a request that never left the browser, taken as an answer: it says nothing of the declaration that is in doubt.
  it('is kept through an attempt that did not get an answer, however often', async () => {
    let calls = 0;
    server({
      create: () => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new TypeError('Failed to fetch'));
        return json(200, ticketBody(), { ETag: '"e1"' });
      },
    });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);
    await upload(chosen);

    expect(new Set(keysOfDeclarations()).size).toBe(1);
  });

  // Break caught: the first attempt of a file that the platform refused kept for ever: it was answered, nothing is in doubt, and the next attempt is a new one (the rule that was already there, held beside the
  // new one so that neither swallows the other).
  it('is let go when the first attempt is refused and nothing was in doubt', async () => {
    server({ create: () => errorResponse(403, 'PERMISSION_DENIED') });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);

    const [one, two] = keysOfDeclarations();
    expect(two).not.toBe(one);
  });

  it('is let go when the platform refuses the completion of a record it answered', async () => {
    server({ complete: () => errorResponse(400, 'VALIDATION_FAILED') });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);

    const [one, two] = keysOfDeclarations();
    expect(two).not.toBe(one);
  });
});

describe('the moment a file was made', () => {
  // Break caught: a file with no moment of its own (a `lastModified` of nothing) declared with the clock's time at each attempt, so that the retry under the same key carried another body, which the
  // platform answers as a conflict.
  it('is worked out once, and is the same in every declaration of the file', async () => {
    server({ put: () => Promise.reject(new TypeError('Failed to fetch')) });
    const upload = uploader('CONDITION', noWait);
    const chosen = new File([BYTES], 'no-date.jpg', { type: 'image/jpeg', lastModified: 0 });

    await upload(chosen).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await upload(chosen).catch(() => undefined);

    const [one, two] = [await bodyOfDeclaration(0), await bodyOfDeclaration(1)];
    expect(two.captured_at).toBe(one.captured_at);
    expect(new Set(keysOfDeclarations()).size).toBe(1);
  });

  // Break caught: a new record for an address that ran out made with another capture time: the photo was taken once.
  it('is kept when the address ran out and a new record is asked for', async () => {
    let calls = 0;
    server({
      create: () => {
        calls += 1;
        return json(200, ticketBody(calls === 1 ? { expires_at: inSeconds(-60) } : {}), {
          ETag: '"e1"',
        });
      },
    });
    const chosen = new File([BYTES], 'no-date.jpg', { type: 'image/jpeg', lastModified: 0 });

    await uploader('CONDITION', noWait)(chosen);

    const [one, two] = [await bodyOfDeclaration(0), await bodyOfDeclaration(1)];
    expect(two.captured_at).toBe(one.captured_at);
    expect(new Set(keysOfDeclarations()).size).toBe(2);
  });
});

describe('the end of an upload address, judged by the server’s clock', () => {
  const REAL_NOW = Date.now();
  // The device's clock is set by a spy in these tests, and a spy that stayed would hold every later test of the file to a clock that does not move.
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const serverDate = (at: number): Record<string, string> => ({
    ETag: '"e1"',
    Date: new Date(at).toUTCString(),
  });

  // Break caught: an address judged by a device clock that is twenty minutes fast, which read every address as run out, asked for a second and read that as run out too, and sent nothing: the file could never
  // be uploaded from that device (the address lives fifteen minutes).
  it('uploads from a device whose clock is twenty minutes fast', async () => {
    server({
      create: () =>
        json(
          200,
          ticketBody({ expires_at: new Date(REAL_NOW + 15 * 60_000).toISOString() }),
          serverDate(REAL_NOW),
        ),
    });
    vi.spyOn(Date, 'now').mockReturnValue(REAL_NOW + 20 * 60_000);

    expect(await uploader('CONDITION', noWait)(file())).toBe(RECORD);
    expect(puts).toHaveLength(1);
    expect(requestsTo('POST', '/evidence')).toHaveLength(1);
  });

  // Break caught: an address that has run out, believed good by a device clock twenty minutes slow: the bytes went to a dead address at each retry under one key, and never to a new record.
  it('asks for a new record, once, from a device whose clock is twenty minutes slow, and sends nothing to a dead address', async () => {
    server({
      create: () =>
        json(
          200,
          ticketBody({ expires_at: new Date(REAL_NOW - 60_000).toISOString() }),
          serverDate(REAL_NOW),
        ),
    });
    vi.spyOn(Date, 'now').mockReturnValue(REAL_NOW - 20 * 60_000);

    await expect(uploader('CONDITION', noWait)(file())).rejects.toBeInstanceOf(
      UploadAddressExpiredError,
    );

    expect(puts).toHaveLength(0);
    expect(requestsTo('POST', '/evidence')).toHaveLength(2);
    expect(new Set(keysOfDeclarations()).size).toBe(2);
  });

  // The rule that was there is what stands when an answer has no `Date` (a proxy that strips it): the device's own clock.
  it('judges by the device’s clock when the answer carries no date', async () => {
    server({
      create: () => json(200, ticketBody({ expires_at: inSeconds(-60) }), { ETag: '"e1"' }),
    });

    await expect(uploader('CONDITION', noWait)(file())).rejects.toBeInstanceOf(
      UploadAddressExpiredError,
    );
    expect(puts).toHaveLength(0);
  });
});

describe('an address the store says has run out', () => {
  // Break caught: a `403` of the store, which is what an address that ran out is answered with, told as a store that "declined": the next attempt sent the bytes to the same dead address under the same key, for ever.
  it('is asked for again once, as a new record under a new key, and the bytes are sent to the new address', async () => {
    let calls = 0;
    server({
      put: () => {
        calls += 1;
        return calls === 1
          ? new Response('expired', { status: 403 })
          : new Response(null, { status: 200 });
      },
    });

    expect(await uploader('CONDITION', noWait)(file())).toBe(RECORD);

    expect(puts).toHaveLength(2);
    const [one, two] = keysOfDeclarations();
    expect(two).not.toBe(one);
  });

  it('is told as the store’s refusal when the fresh address is refused too, after exactly two sendings', async () => {
    server({ put: () => new Response('no', { status: 403 }) });

    await expect(uploader('CONDITION', noWait)(file())).rejects.toMatchObject({
      kind: 'refused',
      status: 403,
    });

    expect(puts).toHaveLength(2);
    expect(requestsTo('POST', '/evidence')).toHaveLength(2);
  });

  // Break caught: any refusal of the store taken for an address that ran out, which would send a file the store refused for what it is (a size, a type) to a second record.
  it.each([400, 404, 413, 500])(
    'is not asked for again when the store answers %i',
    async (status) => {
      server({ put: () => new Response('no', { status }) });

      await expect(uploader('CONDITION', noWait)(file())).rejects.toMatchObject({ status });

      expect(puts).toHaveLength(1);
      expect(requestsTo('POST', '/evidence')).toHaveLength(1);
    },
  );
});

describe('a file that is on its way', () => {
  // Break caught: a double press (or a retry pressed while the first is still going) that starts the file twice: two declarations, two sendings and a completion of a record that is already stored, which the
  // platform answers as a version that moved.
  it('is not started twice: a second call is the same journey', async () => {
    server();
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    const [one, two] = await Promise.all([upload(chosen), upload(chosen)]);

    expect(one).toBe(RECORD);
    expect(two).toBe(RECORD);
    expect(requestsTo('POST', '/evidence')).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(requestsTo('POST', `/evidence/${RECORD}/complete`)).toHaveLength(1);
  });

  it('can be sent again once the journey has ended', async () => {
    server({ put: () => Promise.reject(new TypeError('Failed to fetch')) });
    const upload = uploader('CONDITION', noWait);
    const chosen = file();

    await upload(chosen).catch(() => undefined);
    await upload(chosen).catch(() => undefined);

    expect(requestsTo('POST', '/evidence')).toHaveLength(2);
  });
});

describe('many files at once', () => {
  // Break caught: every file chosen at once started at once (a hundred photos from a gallery: each read whole into memory, two calls each, the session's limit gone in seconds).
  it('begins at most as many files as the portal allows at a time, and finishes every one', async () => {
    let now = 0;
    let most = 0;
    server({
      put: async () => {
        now += 1;
        most = Math.max(most, now);
        await new Promise((resolve) => setTimeout(resolve, 15));
        now -= 1;
        return new Response(null, { status: 200 });
      },
    });
    const upload = uploader('CONDITION', noWait);
    const files = Array.from({ length: 10 }, (_, index) => file(`photo-${String(index)}.jpg`));

    const stored = await Promise.all(files.map((one) => upload(one)));

    expect(stored).toHaveLength(10);
    expect(most).toBe(UPLOAD_CONCURRENCY);
  });

  it('says a file that has not begun is waiting for its turn, and then goes on in the usual steps', async () => {
    server();
    const upload = uploader('CONDITION', { ...noWait, queue: createBoundedQueue(1) });
    const first: UploadStep[] = [];
    const second: UploadStep[] = [];

    await Promise.all([
      upload(file('a.jpg'), (step) => first.push(step)),
      upload(file('b.jpg'), (step) => second.push(step)),
    ]);

    expect(first).toEqual(['hashing', 'declaring', 'sending', 'confirming']);
    expect(second).toEqual(['waiting', 'hashing', 'declaring', 'sending', 'confirming']);
  });

  // Break caught: a file that was left out while it waited, started all the same.
  it('does not begin a file that was left out while it waited for its turn', async () => {
    let release = (): void => undefined;
    server({
      put: () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(new Response(null, { status: 200 }));
          };
        }),
    });
    const upload = uploader('CONDITION', { ...noWait, queue: createBoundedQueue(1) });
    const first = upload(file('a.jpg'));
    await vi.waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    const left = new AbortController();
    const second = upload(file('b.jpg'), undefined, left.signal);
    left.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;

    expect(requestsTo('POST', '/evidence')).toHaveLength(1);
  });
});

describe('a request refused for being too fast', () => {
  // Break caught: a refusal that is retried by the uploader itself (the portal's rule is that nothing is tried again by itself) or one that lets the files behind it run into the same limit.
  it('is told as it is, is not retried, and holds the files that have not begun for the wait it asked', async () => {
    let calls = 0;
    server({
      create: () => {
        calls += 1;
        return calls === 1 ? rateLimited(1) : json(200, ticketBody(), { ETag: '"e1"' });
      },
    });
    const hold = new ReadHold();
    const upload = uploader('CONDITION', { hold, queue: createBoundedQueue(1) });
    const second: UploadStep[] = [];

    const first = upload(file('a.jpg')).then(
      () => 'stored',
      (failure: unknown) => failure,
    );
    const later = upload(file('b.jpg'), (step) => second.push(step));
    const failure = await first;
    const failedAt = Date.now();
    await later;
    const began = Date.now();

    expect(failure).toMatchObject({ status: 429 });
    // The refused file was not sent again by itself: one declaration for it, one for the other.
    expect(requestsTo('POST', '/evidence')).toHaveLength(2);
    // The file that had not begun waited out the second the API asked for.
    expect(began - failedAt).toBeGreaterThanOrEqual(900);
    expect(second).toContain('waiting');
  });
});
