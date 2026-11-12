import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EVIDENCE_STORE } from '../../src/platform/auth/ports/evidence-store.port.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import type { InProcessEvidenceStore } from '../../src/platform/evidence/in-process.evidence-store.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
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

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsOtherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  platformAdmin = await routes.actor(BUNDLE_IDS.platformAdmin, null);
  store = routes.kit.app.app.get<InProcessEvidenceStore>(EVIDENCE_STORE, { strict: false });
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
    }
  });
});
