import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CONTENT_SCANNER,
  type ContentScanner,
} from '../../src/platform/auth/ports/content-scanner.port.js';
import { EVIDENCE_STORE } from '../../src/platform/auth/ports/evidence-store.port.js';
import { METRICS, type Metrics } from '../../src/platform/auth/ports/metrics.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { ContentScannerError } from '../../src/platform/evidence/content-scanner-error.js';
import { EICAR_TEST_FILE } from '../../src/platform/evidence/eicar-test-file.js';
import type { InProcessEvidenceStore } from '../../src/platform/evidence/in-process.evidence-store.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.11, the three evidence operations against a real PostgreSQL and the real application (`createEvidence`, `completeEvidenceUpload`,
 * `createEvidenceRetrievalAuthorization`; `x-permission: owner`; the security matrix's Family N, as far as the in-process stand-in lets it run, and U8):
 *
 * - **The permission is the act's**: the rider that has arrived at the stop and holds `pickup.failure.report` declares and completes a record for it; the staff of the stop's hub
 *   holding `pickup.read` are given a way to read it; an owner with no act, another rider's stop, and every other principal are refused, and the same answer is given for a
 *   stop that is not the rider's as for one that does not exist.
 * - **The scope is derived and the server's values are the server's**: neither scope column, the storage reference, the state nor the retention is accepted from the client.
 * - **What arrived decides, not the client's word** (GBT-N14, N15): a spoofed type, a missing object and a size or hash that is not the declared one never reach `STORED`.
 * - **Capabilities are short and for one object** (GBT-N7 to N10 here, the capability as the operation answers it, redeemed against the stand-in, which judges by the
 *   application's clock; GBT-N5 and N6, the upload capability, are the store's own, in `evidence-store.test.ts`).
 * - **No capability is kept or logged** (GBT-N13, U8): none is in an event or a record of the database.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;
let opsOtherHub: Actor;
let platformAdmin: Actor;
let store: InProcessEvidenceStore;
let scanner: ContentScanner;
let metrics: Metrics;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsOtherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  platformAdmin = await routes.actor(BUNDLE_IDS.platformAdmin, null);
  store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
  scanner = routes.kit.app.app.get<ContentScanner>(CONTENT_SCANNER, { strict: false });
  metrics = routes.kit.app.app.get<Metrics>(METRICS, { strict: false });
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const EVIDENCE = `${API}/evidence`;
const COMPLETE = (id: string) => `${EVIDENCE}/${id}/complete`;
const RETRIEVE = (id: string) => `${EVIDENCE}/${id}/retrieval-authorization`;

/** A few bytes that begin as a JPEG does. */
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const NOT_A_JPEG = new TextEncoder().encode('MZ this is a program, not a picture');
/** The first bytes of a PNG: a file of another type the platform accepts, which is no JPEG. */
const A_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });
const stopId = (arranged: ArrangedRun, index = 0): string => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop.id;
};

const body = (
  owner: string,
  bytes: Uint8Array = JPEG,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  owner_type: 'PICKUP_STOP',
  owner_id: owner,
  purpose: 'COLLECTION_PROOF',
  captured_at: new Date(Date.now() - 60_000).toISOString(),
  content_type: 'image/jpeg',
  byte_size: bytes.length,
  checksum_sha256: sha(bytes),
  ...over,
});

const declare = (
  rider: ArrangedRider,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  rider.client.post(EVIDENCE, payload, { headers: { 'Idempotency-Key': key } });

interface Ticket {
  readonly evidence: Record<string, unknown> & { id: string };
  readonly upload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
}

/** The upload a handset would make with the instruction it was given. */
function upload(ticket: Ticket, bytes: Uint8Array = JPEG, over: Record<string, string> = {}) {
  return store.redeem({
    method: ticket.upload.method,
    url: ticket.upload.url,
    headers: { ...ticket.upload.headers, 'Content-Length': String(bytes.length), ...over },
    body: bytes,
  });
}

const complete = (
  rider: ArrangedRider,
  id: string,
  etag: string | undefined,
): Promise<TestResponse> =>
  rider.client.post(
    COMPLETE(id),
    undefined,
    etag === undefined ? {} : { headers: { 'If-Match': etag } },
  );

const rowOf = (id: string) =>
  routes
    .rows<{
      state: string;
      version: number;
      validated_signature: string | null;
      storage_ref: string;
    }>(`select state, version, validated_signature, storage_ref from evidence where id = $1`, [id])
    .then((rows) => rows[0]);

/** A record the rider declared and uploaded, not yet completed. */
async function uploaded(
  arranged: ArrangedRun,
  bytes: Uint8Array = JPEG,
  over: Record<string, unknown> = {},
) {
  const response = await declare(arranged.rider, body(stopId(arranged), bytes, over));
  expect(response.status, response.text).toBe(200);
  const ticket = response.json() as Ticket;
  expect(upload(ticket, bytes).status).toBe(200);
  return { ticket, etag: response.header('etag') ?? '' };
}

/** A record the rider declared, uploaded and completed. */
async function stored(arranged: ArrangedRun) {
  const { ticket, etag } = await uploaded(arranged);
  const done = await complete(arranged.rider, ticket.evidence.id, etag);
  expect(done.status, done.text).toBe(200);
  return { id: ticket.evidence.id, ticket };
}

/**
 * The window of a record moved into the past, as a test of expiry needs: the guard and the version are switched off for the one statement that does it, so that the version
 * the rider holds is still the current one (it meets the expiry, not a stale version).
 */
async function aged(id: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  await routes.admin.query('alter table evidence disable trigger evidence_version');
  try {
    await routes.admin.query(
      `update evidence set created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour' where id = $1`,
      [id],
    );
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_version');
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined => {
  const violations = (response.json() as { details?: { violations?: { rule?: string }[] } }).details
    ?.violations;
  return violations?.[0]?.rule;
};

describe('createEvidence: the rider declares a record for a stop it has arrived at', () => {
  // Break caught: a record made for a stop that is not the rider's, a scope taken from the client, a storage reference or a state shown to the caller, an upload instruction that is
  // not for one object of the declared type, size and hash, or a window other than the setting's 15 minutes.
  it('declares the record PENDING_UPLOAD with the scope derived, and answers a capability to upload exactly that object', async () => {
    const arranged = await run();
    const response = await declare(arranged.rider, body(stopId(arranged)));
    expect(response.status, response.text).toBe(200);
    const ticket = response.json() as Ticket;
    expect(ticket.evidence).toMatchObject({
      owner_type: 'PICKUP_STOP',
      owner_id: stopId(arranged),
      purpose: 'COLLECTION_PROOF',
      captured_by_actor: arranged.rider.id,
      responsible_hub_id: HUB_A,
      vendor_organization_id: vendorA.row.organizationId,
      state: 'PENDING_UPLOAD',
      access_rule: 'SUBJECT_READERS',
      retention_policy: 'PICKUP_STOP_EVIDENCE',
      content_type: 'image/jpeg',
      byte_size: JPEG.length,
      uploaded_at: null,
    });
    // The record names no storage reference and no declared hash: the one object the capability is for is named by its address, and nothing else tells it.
    const stored = await rowOf(ticket.evidence.id);
    expect(stored?.storage_ref).toMatch(/^ev\/[0-9a-f]{32}$/);
    expect(JSON.stringify(ticket.evidence)).not.toContain(stored?.storage_ref ?? 'x');
    expect(ticket.upload.url).toContain(`/${stored?.storage_ref ?? 'x'}?`);
    expect(Object.keys(ticket.evidence)).not.toContain('storage_ref');
    expect(Object.keys(ticket.evidence)).not.toContain('checksum_sha256');
    expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
    // The answer is a bearer capability to write one object: no intermediary may keep it (finding L3 of the review of Run A), as for the retrieval authorization.
    expect(response.header('cache-control')).toBe('no-store');
    expect(ticket.upload.method).toBe('PUT');
    expect(ticket.upload.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-amz-checksum-sha256': Buffer.from(sha(JPEG), 'hex').toString('base64'),
    });
    // 15 minutes (the setting) from the database's own creation instant, to the second.
    const created = await routes.rows<{ created_at: Date; upload_expires_at: Date }>(
      `select created_at, upload_expires_at from evidence where id = $1`,
      [ticket.evidence.id],
    );
    expect(new Date(ticket.upload.expires_at).getTime()).toBe(
      new Date(created[0]?.upload_expires_at ?? 0).getTime(),
    );
    expect(
      new Date(created[0]?.upload_expires_at ?? 0).getTime() -
        new Date(created[0]?.created_at ?? 0).getTime(),
    ).toBe(900_000);
  });

  it('does not accept what is the server’s from the client: the scope, the storage reference, the state, the retention', async () => {
    const arranged = await run();
    for (const extra of [
      { responsible_hub_id: HUB_B },
      { vendor_organization_id: randomUUID() },
      { storage_ref: 'ev/00000000000000000000000000000000' },
      { state: 'STORED' },
      { access_rule: 'PUBLIC' },
      { retention_policy: 'NONE' },
    ]) {
      const response = await declare(arranged.rider, { ...body(stopId(arranged)), ...extra });
      expect(outcome(response), JSON.stringify(extra)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(
      (await routes.rows(`select 1 from evidence where owner_id = $1`, [stopId(arranged)])).length,
    ).toBe(0);
  });

  it('answers a retry with the same key the same record and the same capability, and another body under that key is a conflict', async () => {
    const arranged = await run();
    const key = randomUUID();
    const payload = body(stopId(arranged));
    const one = await declare(arranged.rider, payload, key);
    expect(one.status, one.text).toBe(200);
    const first = one.json() as Ticket;
    // The same request again: the same record, the same capability (made again from the record) and the same version.
    const retried = await declare(arranged.rider, payload, key);
    expect(retried.status, retried.text).toBe(200);
    expect((retried.json() as Ticket).evidence.id).toBe(first.evidence.id);
    expect((retried.json() as Ticket).upload.url).toBe(first.upload.url);
    expect(retried.header('etag')).toBe(one.header('etag'));
    // The replay carries the capability again, and says no-store again (finding L3).
    expect(retried.header('cache-control')).toBe('no-store');
    // Another request under the same key is a conflict and makes nothing.
    const other = await declare(arranged.rider, { ...payload, byte_size: JPEG.length + 1 }, key);
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(
      (await routes.rows(`select 1 from evidence where owner_id = $1`, [stopId(arranged)])).length,
    ).toBe(1);
    // The capability is made again from the record: no URL was kept anywhere (GBT-N13).
    const kept = await routes.rows<{ text: string }>(
      `select coalesce(convert_from(response_body, 'UTF8'), '') as text from idempotency_record where operation_id = 'createEvidence'`,
    );
    for (const row of kept) {
      expect(row.text).not.toContain('X-Amz-Signature');
      expect(row.text).not.toContain('https://');
    }
  });

  it('refuses a caller who is not the rider under the key of the act, and a stop that is not the rider’s', async () => {
    const arranged = await run();
    const other = await run();
    const payload = body(stopId(arranged));
    // No credential at all; a staff session (the surface the operation does not serve); a record of an owner the platform has no act for.
    expect((await routes.kit.client.post(EVIDENCE, payload)).status).toBe(401);
    expect(
      outcome(
        await ops.client.post(EVIDENCE, payload, {
          origin: OPS,
          headers: { 'Idempotency-Key': randomUUID() },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await declare(arranged.rider, {
          ...payload,
          owner_type: 'ORDER',
          purpose: 'DELIVERY_PROOF',
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    // Another rider's stop and a stop that does not exist are one answer.
    expect(outcome(await declare(arranged.rider, body(stopId(other))))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await declare(arranged.rider, body(randomUUID())))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await declare(arranged.rider, body('not-a-uuid')))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    // A stop not arrived at, and a run that is not in progress.
    const pending = await declare(arranged.rider, body(stopId(arranged, 1)));
    expect(outcome(pending)).toEqual([409, 'STATE_CONFLICT']);
    expect((pending.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'stop_not_arrived',
    );
    const dispatched = await run({ state: 'DISPATCHED', stopStates: ['PENDING', 'PENDING'] });
    const notStarted = await declare(dispatched.rider, body(stopId(dispatched)));
    expect(outcome(notStarted)).toEqual([409, 'STATE_CONFLICT']);
    expect((notStarted.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'run_not_in_progress',
    );
    // None of these refusals made a record.
    expect(
      await routes.rows(`select 1 from evidence where owner_id = any($1::uuid[])`, [
        [stopId(arranged), stopId(arranged, 1), stopId(other), stopId(dispatched)],
      ]),
    ).toHaveLength(0);
  });

  it('refuses what the settings and the record do not allow: a purpose that is not the owner’s, a type or a size outside the limits, a malformed hash or moment', async () => {
    const arranged = await run();
    const owner = stopId(arranged);
    const cases: [string, Record<string, unknown>, string][] = [
      ['a purpose the owner does not have', { purpose: 'CONDITION' }, 'enum'],
      ['a type the settings do not allow', { content_type: 'image/gif' }, 'enum'],
      ['a size above the ceiling', { byte_size: 10_485_761 }, 'maximum'],
      ['a hash that is not a SHA-256', { checksum_sha256: 'abc' }, 'pattern'],
      ['a moment that is not a date', { captured_at: 'yesterday' }, 'format'],
      [
        'a capture in the future',
        { captured_at: new Date(Date.now() + 3_600_000).toISOString() },
        'future',
      ],
    ];
    for (const [label, over, rule] of cases) {
      const response = await declare(arranged.rider, body(owner, JPEG, over));
      expect(outcome(response), label).toEqual([400, 'VALIDATION_FAILED']);
      expect(ruleOf(response), label).toBe(rule);
    }
    // A size of zero is the schema's, and a missing key is the header's.
    expect(outcome(await declare(arranged.rider, body(owner, JPEG, { byte_size: 0 })))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    const noKey = await arranged.rider.client.post(EVIDENCE, body(owner));
    expect(noKey.status).toBe(400);
    expect(await routes.rows(`select 1 from evidence where owner_id = $1`, [owner])).toHaveLength(
      0,
    );
  });
});

describe('completeEvidenceUpload: what arrived decides, and the record is stored under its lock', () => {
  // Break caught: a record stored on the client's word, a stored object whose type is the header's and not the bytes', a size or a hash nobody compared, a stale version
  // accepted, or another rider's record completed.
  it('stores a record whose object is what was declared, with the instant the database took, and tells the next version', async () => {
    const arranged = await run();
    const { ticket, etag } = await uploaded(arranged);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(done.status, done.text).toBe(200);
    const view = done.json() as Record<string, unknown>;
    expect(view).toMatchObject({
      id: ticket.evidence.id,
      state: 'STORED',
      content_type: 'image/jpeg',
    });
    expect(Date.now() - new Date(String(view.uploaded_at)).getTime()).toBeLessThan(60_000);
    expect(done.header('etag')).not.toBe(etag);
    expect(await rowOf(ticket.evidence.id)).toMatchObject({
      state: 'STORED',
      version: 2,
      validated_signature: 'JPEG',
    });
    // Completing a stored record with the version it has answers it again and changes nothing.
    const again = await complete(arranged.rider, ticket.evidence.id, done.header('etag') ?? '');
    expect(again.status).toBe(200);
    expect((await rowOf(ticket.evidence.id))?.version).toBe(2);
  });

  it('refuses a declared image/jpeg whose bytes are not a JPEG, on the signature, and leaves the record pending (GBT-N14)', async () => {
    const arranged = await run();
    const { ticket, etag } = await uploaded(arranged, NOT_A_JPEG);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(outcome(done)).toEqual([400, 'VALIDATION_FAILED']);
    expect(ruleOf(done)).toBe('signature');
    expect((await rowOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
    // A file that is another supported type, declared as a JPEG, is refused the same way: the bytes decide the type, and any recognised signature is not enough.
    const png = await uploaded(arranged, A_PNG);
    const spoofed = await complete(arranged.rider, png.ticket.evidence.id, png.etag);
    expect(outcome(spoofed)).toEqual([400, 'VALIDATION_FAILED']);
    expect(ruleOf(spoofed)).toBe('signature');
    expect((await rowOf(png.ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
  });

  it('refuses an object that is missing, of another size, of another hash or of another type, and never reaches STORED (GBT-N15)', async () => {
    const arranged = await run();
    const declared = await declare(arranged.rider, body(stopId(arranged)));
    const ticket = declared.json() as Ticket;
    const etag = declared.header('etag') ?? '';
    const key = (await rowOf(ticket.evidence.id))?.storage_ref ?? '';
    const attempt = async (rule: string): Promise<void> => {
      const done = await complete(arranged.rider, ticket.evidence.id, etag);
      expect(outcome(done), rule).toEqual([400, 'VALIDATION_FAILED']);
      expect(ruleOf(done)).toBe(rule);
      expect((await rowOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
    };
    await attempt('missing');
    store.plant(key, JPEG.slice(0, 6), { contentType: 'image/jpeg', checksumSha256: sha(JPEG) });
    await attempt('byte_size');
    store.plant(key, Uint8Array.from(JPEG).fill(0, 4), { contentType: 'image/jpeg' });
    await attempt('checksum');
    store.plant(key, JPEG, { contentType: 'image/png' });
    await attempt('content_type');
    store.plant(key, JPEG, { contentType: 'image/jpeg', checksumSha256: null });
    await attempt('checksum');
  });

  it('is judged on the version the caller read, and is the capturing rider’s alone', async () => {
    const arranged = await run();
    const other = await run();
    const { ticket, etag } = await uploaded(arranged);
    const id = ticket.evidence.id;
    expect(outcome(await complete(arranged.rider, id, '"stale"'))).toEqual([409, 'STATE_CONFLICT']);
    // The header is required by the contract: its absence is the validation's, before the record is looked at.
    expect(outcome(await complete(arranged.rider, id, undefined))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(outcome(await complete(other.rider, id, etag))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await complete(arranged.rider, randomUUID(), etag))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await complete(arranged.rider, 'not-a-uuid', etag))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(
      (
        await ops.client.post(COMPLETE(id), undefined, {
          origin: OPS,
          headers: { 'If-Match': etag },
        })
      ).status,
    ).toBe(403);
    expect((await rowOf(id))?.state).toBe('PENDING_UPLOAD');
  });

  it('refuses a record whose upload window has passed, EVIDENCE_UPLOAD_EXPIRED, and keeps it pending', async () => {
    const arranged = await run();
    const { ticket, etag } = await uploaded(arranged);
    await aged(ticket.evidence.id);
    const expired = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(outcome(expired)).toEqual([422, 'EVIDENCE_UPLOAD_EXPIRED']);
    expect(await rowOf(ticket.evidence.id)).toMatchObject({ state: 'PENDING_UPLOAD', version: 1 });
  });
});

describe('createEvidenceRetrievalAuthorization: a way to read one stored object, for the staff of the hub', () => {
  // Break caught: a way to read an object given for a record that is not stored (GBT-N11), to staff of another hub (GBT-N12), to a rider or a vendor, or one that is kept or
  // shown anywhere but in the one answer (GBT-N13, U8); or a capability that outlives its five minutes or reaches another object.
  it('gives the staff of the hub a capability to read the one stored object, uncached, and the bytes are those that were uploaded (GBT-N7)', async () => {
    const arranged = await run();
    const { id } = await stored(arranged);
    const response = await ops.client.post(RETRIEVE(id), undefined, { origin: OPS });
    expect(response.status, response.text).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const capability = response.json() as {
      method: string;
      url: string;
      headers: object;
      expires_at: string;
    };
    expect(capability.method).toBe('GET');
    expect(capability.headers).toEqual({});
    const read = store.redeem({ method: 'GET', url: capability.url, headers: {} });
    expect(read).toMatchObject({ status: 200 });
    expect('body' in read ? Array.from(read.body) : []).toEqual(Array.from(JPEG));
    // Five minutes (the setting) from the instant it was made.
    const lives = new Date(capability.expires_at).getTime() - Date.now();
    expect(lives).toBeGreaterThan(290_000);
    expect(lives).toBeLessThanOrEqual(300_000);
  });

  it('is refused for a record that is not stored (GBT-N11)', async () => {
    const arranged = await run();
    const declared = await declare(arranged.rider, body(stopId(arranged)));
    const id = (declared.json() as Ticket).evidence.id;
    expect(outcome(await ops.client.post(RETRIEVE(id), undefined, { origin: OPS }))).toEqual([
      422,
      'EVIDENCE_NOT_STORED',
    ]);
  });

  it('is refused to the staff of another hub with HUB_SCOPE_VIOLATION, to a missing record with NOT_FOUND, and to a rider (GBT-N12)', async () => {
    const arranged = await run();
    const { id } = await stored(arranged);
    expect(
      outcome(await opsOtherHub.client.post(RETRIEVE(id), undefined, { origin: OPS })),
    ).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(
      outcome(await ops.client.post(RETRIEVE(randomUUID()), undefined, { origin: OPS })),
    ).toEqual([404, 'NOT_FOUND']);
    expect(
      outcome(await ops.client.post(RETRIEVE('not-a-uuid'), undefined, { origin: OPS })),
    ).toEqual([400, 'VALIDATION_FAILED']);
    // A rider holds the write key of the act and not the read of the subject, and the surface is the Ops Portal's.
    expect((await arranged.rider.client.post(RETRIEVE(id), undefined)).status).toBe(403);
    expect((await routes.kit.client.post(RETRIEVE(id), undefined)).status).toBe(401);
  });

  it('expires a capability to read after five minutes, and an address changed to another object is not the one signed (GBT-N8, GBT-N9, GBT-N10)', async () => {
    const arranged = await run();
    const first = await stored(arranged);
    const second = await stored(arranged);
    const response = await ops.client.post(RETRIEVE(first.id), undefined, { origin: OPS });
    const capability = response.json() as { url: string; expires_at: string };
    const otherKey = (await rowOf(second.id))?.storage_ref ?? '';
    const ownKey = (await rowOf(first.id))?.storage_ref ?? '';
    expect(
      store.redeem({ method: 'GET', url: capability.url.replace(ownKey, otherKey), headers: {} }),
    ).toEqual({ status: 403, reason: 'SIGNATURE_MISMATCH' });
    const bucket = new URL(capability.url);
    bucket.pathname = '/evidence/';
    expect(store.redeem({ method: 'GET', url: bucket.toString(), headers: {} })).toMatchObject({
      status: 403,
    });
    // The stand-in judges by the application's clock, which the test moves past the five minutes.
    routes.kit.clock.jumpWallClock(new Date(new Date(capability.expires_at).getTime() + 1000));
    try {
      expect(store.redeem({ method: 'GET', url: capability.url, headers: {} })).toEqual({
        status: 403,
        reason: 'EXPIRED',
      });
    } finally {
      routes.kit.clock.jumpWallClock(new Date('2026-10-10T08:00:00.000Z'));
    }
  });

  it('audits the look at a record in a hub that is not the actor’s own, and writes no capability anywhere (GBT-N13, U8)', async () => {
    const arranged = await run();
    const { id, ticket } = await stored(arranged);
    const own = await ops.client.post(RETRIEVE(id), undefined, { origin: OPS });
    expect(own.status).toBe(200);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and object_id = $1`,
        [id],
      ),
    ).toHaveLength(0);
    const admin = await platformAdmin.client.post(RETRIEVE(id), undefined, { origin: OPS });
    expect(admin.status, admin.text).toBe(200);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and object_id = $1`,
        [id],
      ),
    ).toHaveLength(1);
    // No signed address, in any answer's trace: not in an event, not in a record, not in what the idempotency store keeps.
    const secrets = [
      new URL((own.json() as { url: string }).url).searchParams.get('X-Amz-Signature') ?? 'none',
      new URL(ticket.upload.url).searchParams.get('X-Amz-Signature') ?? 'none',
    ];
    for (const sentinel of secrets) {
      expect(sentinel).toMatch(/^[0-9a-f]{64}$/);
      for (const table of ['audit_event', 'evidence', 'outbox', 'notification']) {
        const hits = await routes.rows<{ n: number }>(
          `select count(*)::int as n from ${table} as t where to_jsonb(t)::text like '%' || $1 || '%'`,
          [sentinel],
        );
        expect(hits[0]?.n, `${table} holds a signature`).toBe(0);
      }
      const kept = await routes.rows<{ n: number }>(
        `select count(*)::int as n from idempotency_record where convert_from(coalesce(response_body, ''::bytea), 'UTF8') like '%' || $1 || '%'`,
        [sentinel],
      );
      expect(kept[0]?.n).toBe(0);
      // Nor in a log line of the application (GBT-N13: every log, trace and error report).
      expect(routes.kit.app.logs.text()).not.toContain(sentinel);
    }
    expect(routes.kit.app.logs.text()).not.toContain('X-Amz-Signature');
  });
});

describe('completeEvidenceUpload: the malicious-content check (Run A2, D-A6; migration 0086)', () => {
  // A spy that outlived a failed assertion would answer the next test in its place: every test starts from the real store, scanner and meter.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What the record holds of the scan: nothing until a clean verdict, then the scanner, the version of its signatures and a moment of the database's. */
  const scanOf = (id: string) =>
    routes
      .rows<{
        state: string;
        scanner: string | null;
        scanner_signature_version: string | null;
        scanned_at: string | null;
        age_seconds: number | null;
      }>(
        `select state, scanner, scanner_signature_version, scanned_at,
                extract(epoch from (now() - scanned_at))::float as age_seconds
           from evidence where id = $1`,
        [id],
      )
      .then((rows) => rows[0]);
  const storageRefOf = async (id: string): Promise<string> => (await rowOf(id))?.storage_ref ?? '';

  // Break caught: a record stored without a verdict on it, or with a moment the writer chose; the stand-in's name and signature version not recorded.
  it('stores a clean file with the verdict recorded: the scanner, the version of its signatures and a moment of the database’s', async () => {
    const arranged = await run();
    const counted = vi.spyOn(metrics, 'increment');
    const { ticket, etag } = await uploaded(arranged);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(done.status, done.text).toBe(200);
    const held = await scanOf(ticket.evidence.id);
    expect(held).toMatchObject({
      state: 'STORED',
      scanner: 'stand-in',
      scanner_signature_version: 'stand-in/1',
    });
    expect(held?.age_seconds).toBeGreaterThanOrEqual(0);
    expect(held?.age_seconds).toBeLessThan(60);
    expect(counted).toHaveBeenCalledWith('evidence_scans_total', { outcome: 'CLEAN' });
    counted.mockRestore();
    // The answer shows the record and not the verdict's facts: they are the platform's.
    expect(JSON.stringify(done.json())).not.toContain('stand-in');
  });

  // Break caught: a flagged file stored, refused for another reason (the signature) so that nobody learns it was malicious, left in the bucket, or left carrying a verdict.
  it('refuses a flagged file as malicious content, takes its object out of the store and keeps the record pending with no verdict', async () => {
    const arranged = await run();
    const eicar = new TextEncoder().encode(EICAR_TEST_FILE);
    const counted = vi.spyOn(metrics, 'increment');
    const { ticket, etag } = await uploaded(arranged, eicar);
    const key = await storageRefOf(ticket.evidence.id);
    expect(store.has(key)).toBe(true);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(outcome(done)).toEqual([400, 'VALIDATION_FAILED']);
    // The reason is the scan's, although these bytes are no JPEG either: the scan precedes the signature.
    expect(ruleOf(done)).toBe('malicious_content');
    expect(store.has(key)).toBe(false);
    expect(await scanOf(ticket.evidence.id)).toMatchObject({
      state: 'PENDING_UPLOAD',
      scanner: null,
      scanner_signature_version: null,
      scanned_at: null,
    });
    expect(counted).toHaveBeenCalledWith('evidence_scans_total', { outcome: 'FLAGGED' });
    expect(counted).toHaveBeenCalledWith('evidence_object_removals_total', { outcome: 'REMOVED' });
    counted.mockRestore();
    // The object is gone: the same completion now finds nothing, and the answer says only that.
    const again = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(ruleOf(again)).toBe('missing');
    // The answer names no signature and no scanner.
    expect(done.text).not.toContain('Eicar');
    expect(done.text).not.toContain('stand-in');
  });

  // Break caught: a refusal that depends on the object being removed, or a removal that fails and is not counted.
  it('refuses a flagged file all the same when its object cannot be removed, and counts that', async () => {
    const arranged = await run();
    const eicar = new TextEncoder().encode(EICAR_TEST_FILE);
    const counted = vi.spyOn(metrics, 'increment');
    const removing = vi
      .spyOn(store, 'remove')
      .mockRejectedValueOnce(new Error('the store is down'));
    const { ticket, etag } = await uploaded(arranged, eicar);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(outcome(done)).toEqual([400, 'VALIDATION_FAILED']);
    expect(ruleOf(done)).toBe('malicious_content');
    expect(counted).toHaveBeenCalledWith('evidence_object_removals_total', { outcome: 'FAILED' });
    expect((await scanOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
    removing.mockRestore();
    counted.mockRestore();
  });

  // Run B, Part 1, item 4 (D-B3, the Product Owner's decision of 13 November 2026): a flagged upload is a security fact, so it writes an enhanced event of its own, committed although the
  // upload is refused. Each of the next tests fails on 6547d90, where nothing was written.
  const flaggedEventsOf = (id: string) =>
    routes.rows<{
      enhanced: boolean;
      outcome: string;
      actor_type: string;
      actor_id: string | null;
      surface_context: string;
      responsible_hub_id: string | null;
      object_type: string;
      previous_state: string | null;
      resulting_state: string | null;
      related_ids: Record<string, string> | null;
      detail: Record<string, unknown> | null;
      before_after: unknown;
      note: string | null;
    }>(
      `select enhanced, outcome, actor_type, actor_id, surface_context, responsible_hub_id, object_type, previous_state, resulting_state, related_ids, detail, before_after, note
         from audit_event where event_code = 'pickup.evidence.flagged' and object_id = $1 order by recorded_at, id`,
      [id],
    );

  // Break caught: a flagged upload that leaves no trace in the ledger, an event rolled back with the refusal, one that names the object's key or carries more than the facts, or a retry that writes a second.
  it('writes one enhanced event for a flagged upload, committed although the upload is refused, naming the record, the rider, the stop and the signature, and never the object key', async () => {
    const arranged = await run();
    const eicar = new TextEncoder().encode(EICAR_TEST_FILE);
    const { ticket, etag } = await uploaded(arranged, eicar);
    const key = await storageRefOf(ticket.evidence.id);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    // The upload is refused, and the event is there all the same.
    expect(ruleOf(done)).toBe('malicious_content');
    const events = await flaggedEventsOf(ticket.evidence.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      enhanced: true,
      outcome: 'REJECTED',
      actor_type: 'RIDER',
      actor_id: arranged.rider.id,
      surface_context: 'RIDER_ANDROID',
      responsible_hub_id: HUB_A,
      object_type: 'Evidence',
      previous_state: 'PENDING_UPLOAD',
      resulting_state: 'PENDING_UPLOAD',
      before_after: null,
      note: null,
      related_ids: { pickup_stop_id: stopId(arranged), rider_id: arranged.rider.id },
      detail: { threat: 'Eicar-Test-Signature', object_removed: true },
    });
    expect(JSON.stringify(events)).not.toContain(key);
    expect(JSON.stringify(events)).not.toContain('X-Amz');
    // The retry finds the object gone, refuses it as missing and writes nothing more.
    expect(ruleOf(await complete(arranged.rider, ticket.evidence.id, etag))).toBe('missing');
    expect(await flaggedEventsOf(ticket.evidence.id)).toHaveLength(1);
  });

  // Break caught: the event left out, or saying the object is gone, when the store could not remove it (what the alert for a failed removal pairs with).
  it('says in the event that the object could not be removed when it could not', async () => {
    const arranged = await run();
    const eicar = new TextEncoder().encode(EICAR_TEST_FILE);
    vi.spyOn(store, 'remove').mockRejectedValueOnce(new Error('the store is down'));
    const { ticket, etag } = await uploaded(arranged, eicar);
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(ruleOf(done)).toBe('malicious_content');
    const events = await flaggedEventsOf(ticket.evidence.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ threat: 'Eicar-Test-Signature', object_removed: false });
  });

  // Break caught: an event written for every upload, or for one the scanner could not decide.
  it('writes no event for a clean upload, nor for one the scanner could not decide', async () => {
    const arranged = await run();
    const clean = await uploaded(arranged);
    expect((await complete(arranged.rider, clean.ticket.evidence.id, clean.etag)).status).toBe(200);
    expect(await flaggedEventsOf(clean.ticket.evidence.id)).toEqual([]);

    const undecided = await uploaded(arranged);
    vi.spyOn(scanner, 'scan').mockRejectedValueOnce(
      new ContentScannerError('SCANNER_UNAVAILABLE', 'timeout'),
    );
    expect(
      (await complete(arranged.rider, undecided.ticket.evidence.id, undecided.etag)).status,
    ).toBe(503);
    expect(await flaggedEventsOf(undecided.ticket.evidence.id)).toEqual([]);
  });

  // Break caught: the event a writer can forge. The ledger admits it to the rider's evidence keys alone, for the rider's own pending record, in the record's hub, bound to its stop, and
  // only as the enhanced rejection the application writes (migration 0091). Written as the runtime login, which row-level security applies to.
  describe('the ledger admits the event only as the application writes it', () => {
    const CODE = 'pickup.evidence.flagged';
    const contextOf = (riderId: string, key: string): SecurityContext => ({
      principalType: 'RIDER',
      principalId: riderId,
      sessionId: randomUUID(),
      surface: 'RIDER_ANDROID',
      riderId,
      authorizationKey: key,
      hubScopeMode: 'SET',
      authorizedHubIds: [],
      correlationId: 'evidence-flagged-event',
    });
    const eventSql = (o: {
      readonly evidence: string;
      readonly rider: string;
      /** The actor the event names, when it is not the rider it is about. */
      readonly actor?: string;
      readonly stop: string;
      readonly hub?: string;
      readonly outcome?: string;
      readonly enhanced?: boolean;
      readonly related?: Record<string, string>;
      readonly code?: string;
    }): string =>
      `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type, object_id, correlation_id,
                               previous_state, resulting_state, outcome, enhanced, related_ids, detail, serialisation_version)
       values (gen_random_uuid(), '${o.code ?? CODE}', now(), 'RIDER', '${o.actor ?? o.rider}'::uuid, 'RIDER_ANDROID', '${o.hub ?? HUB_A}'::uuid, 'Evidence', '${o.evidence}'::uuid,
               'evidence-flagged-event', 'PENDING_UPLOAD', 'PENDING_UPLOAD', '${o.outcome ?? 'REJECTED'}', ${String(o.enhanced ?? true)},
               '${JSON.stringify(o.related ?? { pickup_stop_id: o.stop, rider_id: o.rider })}'::jsonb, '{"threat":"Eicar-Test-Signature","object_removed":true}'::jsonb, 1)`;
    async function writtenAs(context: SecurityContext, statement: string): Promise<string | null> {
      try {
        await routes.built.service.transactionWithContext(context, async (tx) => {
          await tx.execute(sql.raw(statement));
        });
        return null;
      } catch (error) {
        return serverErrorIn(error)?.code ?? 'other';
      }
    }

    it('refuses what the application does not write, and takes what it does', async () => {
      const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
      const other = await arrangedRider(routes.kit, routes.admin);
      const stop = stopId(arranged);
      const otherStop = stopId(arranged, 1);
      const pending = await uploaded(arranged);
      const proof = pending.ticket.evidence.id;
      // A parcel's photo, declared under the count's key and not yet completed.
      const parcel = await declare(arranged.rider, body(stop, JPEG, { purpose: 'PARCEL_PHOTO' }));
      expect(parcel.status, parcel.text).toBe(200);
      const parcelId = (parcel.json() as Ticket).evidence.id;
      const done = await stored(arranged);
      const rider = arranged.rider.id;
      const FAILURE = 'pickup.failure.report';
      const CONFIRM = 'pickup.collection.confirm';
      const genuine = { evidence: proof, rider, stop };

      const refused: readonly (readonly [string, SecurityContext, string])[] = [
        ['another rider’s record', contextOf(other.id, FAILURE), eventSql(genuine)],
        // Each tie to the session's rider is held by its own conjunct, so each is shown alone: the actor the event names (the record and the related ids are the session's own), and another
        // rider who names itself everywhere and a record that is not its own (only the record's capturer refuses it).
        [
          'an actor that is not the session’s rider',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, actor: other.id }),
        ],
        [
          'a rider naming itself for a record that is not its own',
          contextOf(other.id, FAILURE),
          eventSql({ ...genuine, rider: other.id }),
        ],
        ['the key that runs a stop', contextOf(rider, 'pickup.run.execute'), eventSql(genuine)],
        ['the count’s key for a failure’s proof', contextOf(rider, CONFIRM), eventSql(genuine)],
        [
          'the failure’s key for a parcel’s photo',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, evidence: parcelId }),
        ],
        [
          'a record that is already stored',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, evidence: done.id }),
        ],
        [
          'a hub that is not the record’s',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, hub: HUB_B }),
        ],
        [
          'another stop in the related ids',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, related: { pickup_stop_id: otherStop, rider_id: rider } }),
        ],
        [
          'another rider in the related ids',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, related: { pickup_stop_id: stop, rider_id: other.id } }),
        ],
        [
          'an outcome of success',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, outcome: 'SUCCEEDED' }),
        ],
        ['an ordinary tier', contextOf(rider, FAILURE), eventSql({ ...genuine, enhanced: false })],
        [
          'another event of the catalogue',
          contextOf(rider, FAILURE),
          eventSql({ ...genuine, code: 'pickup.stop.arrived' }),
        ],
      ];
      for (const [what, context, statement] of refused) {
        expect(await writtenAs(context, statement), what).toBe('42501');
      }
      expect(await flaggedEventsOf(proof)).toEqual([]);

      // The same writer, the same record, the facts the application writes: taken, for a failure's proof under the failure's key and for a parcel's photo under the count's.
      expect(await writtenAs(contextOf(rider, FAILURE), eventSql(genuine))).toBeNull();
      expect(
        await writtenAs(contextOf(rider, CONFIRM), eventSql({ ...genuine, evidence: parcelId })),
      ).toBeNull();
      expect(await flaggedEventsOf(proof)).toHaveLength(1);
      expect(await flaggedEventsOf(parcelId)).toHaveLength(1);
    });
  });

  // Break caught (fail closed): a scanner that cannot answer read as clean, or as "skipped", or a record left in a state from which the retry cannot store it.
  it('is the fixed 503 when the scanner cannot answer, keeps the record pending, and stores it when the retry is answered', async () => {
    const arranged = await run();
    const { ticket, etag } = await uploaded(arranged);
    const counted = vi.spyOn(metrics, 'increment');
    const scanning = vi
      .spyOn(scanner, 'scan')
      .mockRejectedValueOnce(new ContentScannerError('SCANNER_UNAVAILABLE', 'timeout'));
    const down = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(down.status).toBe(503);
    // The platform's fixed answer: a message and the request's identifier, and no code.
    expect(down.json()).toMatchObject({ message: 'Service unavailable' });
    expect(down.json()).not.toHaveProperty('code');
    expect(await scanOf(ticket.evidence.id)).toMatchObject({
      state: 'PENDING_UPLOAD',
      scanner: null,
    });
    expect(counted).toHaveBeenCalledWith('evidence_scans_total', { outcome: 'UNAVAILABLE' });
    // The retry, with the same version, is answered by the scanner now and stores the record.
    const retried = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(retried.status, retried.text).toBe(200);
    expect((await scanOf(ticket.evidence.id))?.state).toBe('STORED');
    scanning.mockRestore();
    counted.mockRestore();
  });

  it('is the fixed 503 and stores nothing when no scanner is configured', async () => {
    const arranged = await run();
    const { ticket, etag } = await uploaded(arranged);
    const counted = vi.spyOn(metrics, 'increment');
    const scanning = vi
      .spyOn(scanner, 'scan')
      .mockRejectedValue(new ContentScannerError('SCANNER_NOT_CONFIGURED', 'none'));
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(done.status).toBe(503);
    expect(done.json()).toMatchObject({ message: 'Service unavailable' });
    expect(done.json()).not.toHaveProperty('code');
    expect((await scanOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
    expect(counted).toHaveBeenCalledWith('evidence_scans_total', { outcome: 'NOT_CONFIGURED' });
    scanning.mockRestore();
    counted.mockRestore();
  });

  // Break caught: a verdict taken for an object whose bytes are not the declared ones, because the store's own metadata (its size and the hash it recorded) claims they are.
  it('never stores an object whose bytes are not the declared ones, whatever the store’s metadata says', async () => {
    const arranged = await run();
    const declared = await declare(arranged.rider, body(stopId(arranged)));
    const ticket = declared.json() as Ticket;
    const etag = declared.header('etag') ?? '';
    const key = await storageRefOf(ticket.evidence.id);
    // The store holds other bytes of the declared length (a JPEG's signature among them), and says they hash as the declared ones.
    const other = Uint8Array.from(JPEG).reverse();
    other.set(JPEG.slice(0, 3), 0);
    expect(other.length).toBe(JPEG.length);
    store.plant(key, other, { contentType: 'image/jpeg', checksumSha256: sha(JPEG) });
    const done = await complete(arranged.rider, ticket.evidence.id, etag);
    expect(outcome(done)).toEqual([400, 'VALIDATION_FAILED']);
    expect(ruleOf(done)).toBe('checksum');
    expect((await scanOf(ticket.evidence.id))?.state).toBe('PENDING_UPLOAD');
  });
});
