import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { refusalReleasedFor } from '../../src/pickup/attempt-ceiling.js';
import { PICKUP_FAILURE_CATEGORIES } from '../../src/pickup/pickup-vocabulary.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { photoOf } from './support/evidence-photo.js';
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
 * S1.28, `reportPickupFailure` (`pickup.failure.report`; `AC-SLICE-001-30` to `-33` and `-36`; pickup-failure.md; state-machines.md section 5): the part of the
 * failure flow that stands alone. Against a real PostgreSQL and the real application, each claim:
 *
 * - **The stop becomes `FAILED`** with its fixed category and the snapshot of its reason as the catalogue holds it (the label and the attribution, the note, the
 *   contact attempts), at the database's own moment; it keeps its place, its arrival and its claim; the request is not written; and one event is written in the
 *   rider's name, bound to the stored stop. A run whose last stop failed with nothing collected is completed by the system, and no other run is.
 * - **The category is one of the four, the reason is the catalogue's and belongs to that category, and what else is mandatory is read from the reason**: the note, a
 *   contact attempt and a photo (the pairings in pickup-failure-category.db.test.ts, the photo in pickup-failure-photo.db.test.ts). Nothing is made by a refusal.
 * - **Only the assigned rider, on a started run, on an arrived stop, on the stop's current version**; a stop with a count is never failed.
 * - **Physical failure is terminal** (`AC-SLICE-001-32`): nothing moves a failed stop back, for any writer.
 * - **A refused collection is escalation-only** (`AC-SLICE-001-33`): the office cannot reschedule it, whatever the cap, until hub Senior Ops force-extends it; it
 *   can escalate it at once; an ordinary failure reschedules at once and needs no extension.
 * - **Zero collection arrives here** (`AC-SLICE-001-36`): `recordCollection` refuses zero, and the failure is then reported with a category.
 * - **Replay-safe**: the same key returns the original answer and one failure; another body is `IDEMPOTENCY_KEY_CONFLICT`.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let senior: Actor;

const CANCEL_REASON = 'FIXTURE_FAILURE_RESCHEDULE';

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution) values ($1, 'PICKUP_CANCELLATION', 'Fixture reason', 'CUSTOMER')`,
    [CANCEL_REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const FAIL = (id: string) => `${STOP(id)}/fail`;
const COLLECT = (id: string) => `${STOP(id)}/collect`;
const REQUEST = (id: string) => `${API}/pickup-requests/${id}`;
const NOTE = 'The parcels were not packed when the rider came';
const REASON = 'The vendor refused and the rider asked for a Senior Ops decision';
const REFUSED = {
  category: 'REFUSED_COLLECTION',
  reason_code: 'VENDOR_REFUSED_HANDOVER',
  note: 'The vendor would not hand the parcels over',
} as const;
const ORDINARY = {
  category: 'PARCEL_NOT_READY',
  reason_code: 'PARCELS_NOT_PACKED',
  note: NOTE,
} as const;

interface StopBody {
  readonly id: string;
  readonly state: string;
  readonly arrived_at: string | null;
  readonly failure_category: string | null;
  readonly failure: { reason_code: string; note?: string; reported_at: string } | null;
  readonly skipped: unknown;
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;

/** A run in progress whose first stop the rider has arrived at (the stop declares three packages), and a second still to be worked. */
const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });
const first = (arranged: ArrangedRun): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

/** The token the report takes as `If-Match`: the stop as the rider reads it. */
const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

async function fail(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown> = { ...ORDINARY },
  over: { etag?: string; key?: string } = {},
): Promise<TestResponse> {
  const etag = over.etag ?? (await tokenOf(rider, stopId));
  return rider.client.post(FAIL(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': over.key ?? randomUUID() },
  });
}

interface StopRecord {
  state: string;
  version: number;
  sequence: number;
  arrived_at: Date | null;
  resolved_at: Date | null;
  released_at: Date | null;
  failure_category: string | null;
  failure_reason_snapshot: Record<string, unknown> | null;
}
const stopOf = (id: string) =>
  routes
    .rows<StopRecord>(
      `select state, version, sequence, arrived_at, resolved_at, released_at, failure_category, failure_reason_snapshot from pickup_stop where id = $1`,
      [id],
    )
    .then((rows) => {
      const row = rows[0];
      if (row === undefined) throw new Error('no stop');
      return row;
    });
const requestOf = (id: string) =>
  routes
    .rows<{ state: string; version: number; rider_assigned: boolean; escalated_at: Date | null }>(
      `select state, version, rider_assigned, escalated_at from pickup_request where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const manifestOf = (id: string) =>
  routes
    .rows<{ state: string; completed_at: Date | null }>(
      `select state, completed_at from pickup_manifest where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_type: string;
    actor_id: string | null;
    object_type: string;
    responsible_hub_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    reason_code: string | null;
    reason_label: string | null;
    note: string | null;
    related_ids: Record<string, string> | null;
    detail: Record<string, unknown> | null;
    enhanced: boolean;
  }>(
    `select actor_type, actor_id, object_type, responsible_hub_id, previous_state, resulting_state, reason_code, reason_label, note, related_ids, detail,
            enhanced
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );
const databaseMilliseconds = async (): Promise<number> =>
  Number(
    (
      await routes.rows<{ ms: string }>(
        `select (extract(epoch from clock_timestamp()) * 1000)::text as ms`,
      )
    )[0]?.ms,
  );

describe('reportPickupFailure: the stop becomes FAILED', () => {
  // Break caught: a failure that leaves the stop arrived, loses the category or the reason, takes the moment from the device or the application, releases the claim,
  // moves the place or the arrival, writes the request, answers with more than the contract states, or writes an event the stored stop does not bear out.
  it('records a failure: FAILED, the category and the reason as the catalogue holds them, the database’s moment, the request untouched, one event in the rider’s name', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await stopOf(stop.id);
    const requestBefore = await requestOf(stop.requestId);
    const token = await tokenOf(arranged.rider, stop.id);

    const sentAt = await databaseMilliseconds();
    const response = await fail(arranged.rider, stop.id, { ...ORDINARY });
    const answeredAt = await databaseMilliseconds();
    expect(response.status).toBe(200);
    const body = response.json() as StopBody;
    expect(body).toMatchObject({
      id: stop.id,
      state: 'FAILED',
      failure_category: 'PARCEL_NOT_READY',
      skipped: null,
    });
    expect(Object.keys(body.failure ?? {}).toSorted()).toEqual([
      'note',
      'reason_code',
      'reported_at',
    ]);
    expect(body.failure).toMatchObject({ reason_code: 'PARCELS_NOT_PACKED', note: NOTE });
    expect(response.header('etag')).not.toBe(token);
    expect(response.header('etag')).toBe(await tokenOf(arranged.rider, stop.id));

    const after = await stopOf(stop.id);
    expect(after).toMatchObject({
      state: 'FAILED',
      failure_category: 'PARCEL_NOT_READY',
      sequence: before.sequence,
      released_at: null,
      version: before.version + 1,
    });
    expect(after.arrived_at).toEqual(before.arrived_at);
    const snapshot = after.failure_reason_snapshot ?? {};
    expect(snapshot).toMatchObject({
      reason_code: 'PARCELS_NOT_PACKED',
      label: 'Parcels not packed',
      attribution: 'CUSTOMER',
      note: NOTE,
    });
    expect(Object.keys(snapshot).toSorted()).toEqual([
      'attribution',
      'label',
      'note',
      'reason_code',
      'reported_at',
    ]);
    // The moment is the database's own: the stop's moment of resolution, named by the snapshot and by the answer, and taken during the call.
    const resolved = after.resolved_at?.getTime() ?? 0;
    expect(new Date(String(snapshot.reported_at)).getTime()).toBe(resolved);
    expect(body.failure?.reported_at).toBe(snapshot.reported_at);
    expect(resolved).toBeGreaterThanOrEqual(Math.floor(sentAt));
    expect(resolved).toBeLessThanOrEqual(Math.ceil(answeredAt));

    // The request is not written: it stays CONFIRMED, committed to the rider, with its claim held by the failed stop.
    expect(await requestOf(stop.requestId)).toEqual(requestBefore);

    const written = await events('pickup.stop.failed', stop.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      actor_type: 'RIDER',
      actor_id: arranged.rider.id,
      object_type: 'PickupStop',
      responsible_hub_id: HUB_A,
      previous_state: 'ARRIVED',
      resulting_state: 'FAILED',
      reason_code: 'PARCELS_NOT_PACKED',
      reason_label: 'Parcels not packed',
      note: null,
      related_ids: {
        pickup_manifest_id: arranged.manifest.id,
        pickup_request_id: stop.requestId,
        rider_id: arranged.rider.id,
      },
      detail: { failure_category: 'PARCEL_NOT_READY', contact_attempts: 0 },
      enhanced: false,
    });
    // The run has another stop to be worked, so it is not completed.
    expect((await manifestOf(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
  });

  // Break caught: contact attempts lost, kept as the device sent them (an offset, no millisecond), put on the wire, or left out of the event's count.
  it('keeps the contact attempts on the stop as instants in UTC, not on the wire, and counts them in the event', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const response = await fail(arranged.rider, stop.id, {
      category: 'VENDOR_UNAVAILABLE',
      reason_code: 'VENDOR_NOT_AT_LOCATION',
      note: 'The vendor was not at the shop',
      contact_attempts: [
        { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00+00:00', outcome: 'No answer' },
        {
          method: 'SMS',
          attempted_at: '2026-11-04T10:15:30.5+02:00',
          outcome: 'Phone switched off',
          note: 'Sent the pickup reference',
        },
        {
          method: 'IN_PERSON',
          attempted_at: '2026-11-04T10:20:00Z',
          outcome: 'Shop shut',
          note: '   ',
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(Object.keys((response.json() as StopBody).failure ?? {}).toSorted()).toEqual([
      'note',
      'reason_code',
      'reported_at',
    ]);
    const snapshot = (await stopOf(stop.id)).failure_reason_snapshot ?? {};
    // A blank note is no note; the others are kept as given, with their method.
    expect(snapshot.contact_attempts).toEqual([
      { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00.000Z', outcome: 'No answer' },
      {
        method: 'SMS',
        attempted_at: '2026-11-04T08:15:30.500Z',
        outcome: 'Phone switched off',
        note: 'Sent the pickup reference',
      },
      { method: 'IN_PERSON', attempted_at: '2026-11-04T10:20:00.000Z', outcome: 'Shop shut' },
    ]);
    const [event] = await events('pickup.stop.failed', stop.id);
    expect(event?.detail).toEqual({ failure_category: 'VENDOR_UNAVAILABLE', contact_attempts: 3 });
  });

  // Break caught: a category refused or mapped to another (AC-SLICE-001-30: the four are accepted). Each is reported with a reason of its own (D-A4: the catalogue binds a reason to
  // one category, and the pairings are tried one by one in pickup-failure-category.db.test.ts); the two access refusals ask for a photo, and the vendor-unavailable ones for a contact attempt.
  it.each(PICKUP_FAILURE_CATEGORIES)('accepts the fixed category %s', async (category) => {
    const arranged = await run();
    const stop = first(arranged);
    const body = {
      VENDOR_UNAVAILABLE: {
        reason_code: 'VENDOR_UNREACHABLE_BY_PHONE',
        contact_attempts: [
          { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00Z', outcome: 'No answer' },
        ],
      },
      ACCESS_DENIED: {
        reason_code: 'LOCATION_CLOSED',
        evidence_ids: [(await photoOf(routes, arranged.rider, stop.id)).id],
      },
      PARCEL_NOT_READY: { reason_code: 'PARCELS_NOT_PACKED' },
      REFUSED_COLLECTION: { reason_code: 'PARCEL_NOT_ACCEPTABLE' },
    }[category];
    const response = await fail(arranged.rider, stop.id, { category, note: NOTE, ...body });
    expect(response.status, response.text).toBe(200);
    expect((response.json() as StopBody).failure_category).toBe(category);
    expect((await stopOf(stop.id)).failure_category).toBe(category);
  });

  // Break caught: a run that is never completed after its last stop failed (no hub handover can close it), one completed with a stop still to be worked, and one
  // completed after something was collected (the hub handover closes that).
  it('completes the run by the system when the failed stop was its last and nothing was collected, and no other run', async () => {
    const last = await run({ stops: 1, stopStates: ['ARRIVED'] });
    expect((await fail(last.rider, first(last).id)).status).toBe(200);
    const done = await manifestOf(last.manifest.id);
    expect(done?.state).toBe('COMPLETED');
    expect(done?.completed_at).not.toBeNull();
    const [completion] = await events('pickup.manifest.completed', last.manifest.id);
    expect(completion).toMatchObject({
      actor_type: 'RIDER',
      actor_id: last.rider.id,
      previous_state: 'IN_PROGRESS',
      resulting_state: 'COMPLETED',
      related_ids: { rider_id: last.rider.id },
      detail: { completed_by: 'SYSTEM', cause: 'LAST_STOP_FAILED' },
    });

    const more = await run();
    expect((await fail(more.rider, first(more).id)).status).toBe(200);
    expect((await manifestOf(more.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await events('pickup.manifest.completed', more.manifest.id)).toEqual([]);

    const collected = await run({ stopStates: ['ARRIVED', 'COLLECTED'] });
    expect((await fail(collected.rider, first(collected).id)).status).toBe(200);
    expect((await manifestOf(collected.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await events('pickup.manifest.completed', collected.manifest.id)).toEqual([]);
  });

  // Break caught (AC-SLICE-001-36): a zero count that closes the stop as collected or is not routed here; a sender set or a hub handover made by the failure.
  it('is where a count of zero goes: recordCollection refuses it, and the failure is then reported with a category', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const zero = await arranged.rider.client.post(
      COLLECT(stop.id),
      { collected_count: 0 },
      {
        headers: {
          'If-Match': await tokenOf(arranged.rider, stop.id),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(outcome(zero)).toEqual([422, 'ZERO_COLLECTION_IS_FAILURE']);
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');

    const reported = await fail(arranged.rider, stop.id, {
      ...ORDINARY,
      category: 'PARCEL_NOT_READY',
    });
    expect(reported.status).toBe(200);
    expect((await stopOf(stop.id)).state).toBe('FAILED');
    const records = await routes.rows<{ n: string }>(
      `select count(*)::text as n from collection_record where pickup_stop_id = $1`,
      [stop.id],
    );
    expect(records[0]?.n).toBe('0');
  });
});

describe('reportPickupFailure: what the body and the reason must say', () => {
  // Break caught: a failure accepted with no category or an invented one (AC-SLICE-001-30), with no reason or one the catalogue refuses, with the note, the
  // contact attempt or the photo its metadata asks for left out (AC-SLICE-001-31), with evidence that cannot be stored, or with text the ledger could not keep.
  it.each([
    ['no category', { reason_code: 'PARCELS_NOT_PACKED', note: NOTE }, 400, 'VALIDATION_FAILED'],
    ['an invented category', { ...ORDINARY, category: 'CLOSED' }, 400, 'VALIDATION_FAILED'],
    [
      'a category in the wrong case',
      { ...ORDINARY, category: 'access_denied' },
      400,
      'VALIDATION_FAILED',
    ],
    ['a member the contract does not have', { ...ORDINARY, extra: true }, 400, 'VALIDATION_FAILED'],
    ['no reason', { category: 'PARCEL_NOT_READY', note: NOTE }, 400, 'VALIDATION_FAILED'],
    ['an empty reason', { ...ORDINARY, reason_code: '' }, 422, 'REASON_REQUIRED'],
    ['an unknown reason', { ...ORDINARY, reason_code: 'NO_SUCH_REASON' }, 422, 'REASON_NOT_ACTIVE'],
    [
      'a reason of another domain',
      { ...ORDINARY, reason_code: 'SOME_PARCELS_NOT_READY' },
      422,
      'REASON_NOT_ACTIVE',
    ],
    [
      'no note',
      { category: 'PARCEL_NOT_READY', reason_code: 'PARCELS_NOT_PACKED' },
      422,
      'REASON_REQUIRED',
    ],
    ['a blank note', { ...ORDINARY, note: '   ' }, 422, 'REASON_REQUIRED'],
    [
      'a reason that asks for a contact attempt, with none',
      { category: 'VENDOR_UNAVAILABLE', reason_code: 'VENDOR_NOT_AT_LOCATION', note: NOTE },
      422,
      'REASON_REQUIRED',
    ],
    [
      'a reason that asks for a contact attempt, with an empty list',
      {
        category: 'VENDOR_UNAVAILABLE',
        reason_code: 'VENDOR_UNREACHABLE_BY_PHONE',
        note: NOTE,
        contact_attempts: [],
      },
      422,
      'REASON_REQUIRED',
    ],
    [
      'a reason that asks for a photo, with none',
      { category: 'ACCESS_DENIED', reason_code: 'LOCATION_CLOSED', note: NOTE },
      422,
      'REASON_REQUIRED',
    ],
    [
      'a reason reported under a category that is not its own',
      { ...ORDINARY, category: 'ACCESS_DENIED' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a reference to evidence nobody stored',
      { ...ORDINARY, evidence_ids: [randomUUID()] },
      422,
      'EVIDENCE_NOT_STORED',
    ],
    [
      'an evidence id that is not an identifier',
      { ...ORDINARY, evidence_ids: ['x'] },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a note the ledger cannot keep',
      { ...ORDINARY, note: 'two\nlines' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a note with an address in it',
      { ...ORDINARY, note: 'Write to the vendor at vendor@example.com' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt on a day that does not exist',
      {
        ...ORDINARY,
        contact_attempts: [
          { method: 'PHONE_CALL', attempted_at: '2026-02-30T10:00:00Z', outcome: 'No answer' },
        ],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt whose outcome the ledger could not keep',
      {
        ...ORDINARY,
        contact_attempts: [
          { method: 'PHONE_CALL', attempted_at: '2026-11-04T10:00:00Z', outcome: 'two\nlines' },
        ],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt with a blank outcome',
      {
        ...ORDINARY,
        contact_attempts: [
          { method: 'PHONE_CALL', attempted_at: '2026-11-04T10:00:00Z', outcome: '  ' },
        ],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt with no method',
      { ...ORDINARY, contact_attempts: [{ attempted_at: '2026-11-04T10:00:00Z', outcome: 'x' }] },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt with a method outside the three',
      {
        ...ORDINARY,
        contact_attempts: [{ method: 'CALL', attempted_at: '2026-11-04T10:00:00Z', outcome: 'x' }],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt that reports its own wait',
      {
        ...ORDINARY,
        contact_attempts: [
          { method: 'SMS', attempted_at: '2026-11-04T10:00:00Z', outcome: 'x', wait_minutes: 12 },
        ],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a contact attempt with a note the ledger could not keep',
      {
        ...ORDINARY,
        contact_attempts: [
          {
            method: 'SMS',
            attempted_at: '2026-11-04T10:00:00Z',
            outcome: 'x',
            note: 'Rang vendor@example.com',
          },
        ],
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'eleven contact attempts',
      {
        ...ORDINARY,
        contact_attempts: Array.from({ length: 11 }, () => ({
          method: 'PHONE_CALL',
          attempted_at: '2026-11-04T10:00:00Z',
          outcome: 'No answer',
        })),
      },
      400,
      'VALIDATION_FAILED',
    ],
  ] as const)('refuses %s and makes nothing', async (_what, body, status, code) => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await stopOf(stop.id);
    const requestBefore = await requestOf(stop.requestId);
    expect(outcome(await fail(arranged.rider, stop.id, { ...body }))).toEqual([status, code]);
    expect(await stopOf(stop.id)).toEqual(before);
    expect(await requestOf(stop.requestId)).toEqual(requestBefore);
    expect(await events('pickup.stop.failed', stop.id)).toEqual([]);
    expect((await manifestOf(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
  });

  // Break caught: the details of a refusal that do not say which rule of the reason was not met, so that the app cannot tell the rider what to add.
  it('says which rule of the reason was not met', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const contact = await fail(arranged.rider, stop.id, {
      category: 'VENDOR_UNAVAILABLE',
      reason_code: 'VENDOR_NOT_AT_LOCATION',
      note: NOTE,
    });
    expect(ruleOf(contact)).toBe('contact_attempt');
    const photo = await fail(arranged.rider, stop.id, {
      category: 'ACCESS_DENIED',
      reason_code: 'ENTRY_REFUSED_BY_SECURITY',
      note: NOTE,
    });
    expect(ruleOf(photo)).toBe('photo');
  });

  // Break caught: a blank note kept as a note (a stop whose failure says nothing, in the words of a space) where the reason does not ask for one.
  it('keeps no note when the rider sent a blank one and the reason asks for none', async () => {
    const arranged = await run();
    const stop = first(arranged);
    try {
      await routes.admin.query(
        `update reason_code set requires_note = false where code = 'PARCELS_NOT_PACKED'`,
      );
      const response = await fail(arranged.rider, stop.id, { ...ORDINARY, note: '   ' });
      expect(response.status).toBe(200);
      expect(Object.keys((response.json() as StopBody).failure ?? {}).toSorted()).toEqual([
        'reason_code',
        'reported_at',
      ]);
      const snapshot = (await stopOf(stop.id)).failure_reason_snapshot ?? {};
      expect(Object.keys(snapshot).toSorted()).toEqual([
        'attribution',
        'label',
        'reason_code',
        'reported_at',
      ]);
    } finally {
      await routes.admin.query(
        `update reason_code set requires_note = true where code = 'PARCELS_NOT_PACKED'`,
      );
    }
  });

  // Break caught (AC-SLICE-001-31): a requirement hard-coded for a reason instead of read from the catalogue. The catalogue is changed under the test and put back.
  it('reads what is mandatory from the reason record, not from the code', async () => {
    const arranged = await run({ stops: 3, stopStates: ['ARRIVED', 'ARRIVED', 'ARRIVED'] });
    const [one, two, three] = arranged.stops;
    try {
      // A reason that asked for nothing now asks for a contact attempt, and one that asked for one does not.
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = true where code = 'PARCELS_NOT_PACKED'`,
      );
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = false where code = 'VENDOR_NOT_AT_LOCATION'`,
      );
      const nowAsks = await fail(arranged.rider, one?.id ?? '', { ...ORDINARY });
      expect(outcome(nowAsks)).toEqual([422, 'REASON_REQUIRED']);
      expect(ruleOf(nowAsks)).toBe('contact_attempt');
      const nowAsksNot = await fail(arranged.rider, two?.id ?? '', {
        category: 'VENDOR_UNAVAILABLE',
        reason_code: 'VENDOR_NOT_AT_LOCATION',
        note: NOTE,
      });
      expect(nowAsksNot.status).toBe(200);
      // A retired reason is refused.
      await routes.admin.query(
        `update reason_code set active = false where code = 'PARCEL_NOT_ACCEPTABLE'`,
      );
      expect(
        outcome(
          await fail(arranged.rider, three?.id ?? '', {
            category: 'REFUSED_COLLECTION',
            reason_code: 'PARCEL_NOT_ACCEPTABLE',
            note: NOTE,
          }),
        ),
      ).toEqual([422, 'REASON_NOT_ACTIVE']);
    } finally {
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = false where code = 'PARCELS_NOT_PACKED'`,
      );
      await routes.admin.query(
        `update reason_code set requires_contact_attempt = true where code = 'VENDOR_NOT_AT_LOCATION'`,
      );
      await routes.admin.query(
        `update reason_code set active = true where code = 'PARCEL_NOT_ACCEPTABLE'`,
      );
    }
  });
});

describe('reportPickupFailure: whose stop, which run, which state, which version', () => {
  // Break caught: a stop that is not the rider’s told apart from one that does not exist; a stop not arrived at or already worked failed; a stale token accepted;
  // a second failure made under another key.
  it('judges the rider’s own work, the stop and the token, and says which', async () => {
    const arranged = await run({ stops: 3, stopStates: ['ARRIVED', 'PENDING', 'SKIPPED'] });
    const [arrived, pending, skipped] = arranged.stops;
    const other = await arrangedRider(routes.kit, routes.admin);

    // Not the rider's, and not there: one answer.
    expect(outcome(await fail(other, arrived?.id ?? '', { ...ORDINARY }, { etag: '"x"' }))).toEqual(
      [422, 'NOT_ASSIGNED_RIDER'],
    );
    expect(
      outcome(await fail(arranged.rider, randomUUID(), { ...ORDINARY }, { etag: '"x"' })),
    ).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    // Not arrived at, and already worked.
    const early = await fail(arranged.rider, pending?.id ?? '');
    expect(outcome(early)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(early)).toBe('stop_not_arrived');
    const done = await fail(arranged.rider, skipped?.id ?? '');
    expect(outcome(done)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(done)).toBe('stop_resolved');
    // A token that is not the stop's current one.
    expect(
      outcome(await fail(arranged.rider, arrived?.id ?? '', { ...ORDINARY }, { etag: '"stale"' })),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect((await stopOf(arrived?.id ?? '')).state).toBe('ARRIVED');

    // The failure, and then a second one under another key: the stop is terminal.
    expect((await fail(arranged.rider, arrived?.id ?? '')).status).toBe(200);
    const again = await fail(arranged.rider, arrived?.id ?? '');
    expect(outcome(again)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(again)).toBe('stop_resolved');
    expect(await events('pickup.stop.failed', arrived?.id ?? '')).toHaveLength(1);
  });

  // Break caught: a failure reported on a run that has only been dispatched, or one that is over.
  it('refuses a run that has not started and a run that is over', async () => {
    const dispatched = await run({ state: 'DISPATCHED', stopStates: ['PENDING', 'PENDING'] });
    expect(
      outcome(
        await fail(
          dispatched.rider,
          first(dispatched).id,
          { ...ORDINARY },
          { etag: await tokenOf(dispatched.rider, first(dispatched).id) },
        ),
      ),
    ).toEqual([422, 'MANIFEST_NOT_STARTED']);
    // A run that is over, with the stop's own current token: it is the run that is refused, and says so.
    const over = await run({ state: 'COMPLETED', stopStates: ['ARRIVED', 'PENDING'] });
    const refused = await fail(over.rider, first(over).id);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(refused)).toBe('run_not_in_progress');
    expect((await stopOf(first(over).id)).state).toBe('ARRIVED');
  });

  // Break caught: a stop whose count was recorded failed afterwards, which would leave a record of parcels taken at the door on a failed pickup.
  it('never fails a stop that has a record of a count', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const counted = await arranged.rider.client.post(
      COLLECT(stop.id),
      { collected_count: 3 },
      {
        headers: {
          'If-Match': await tokenOf(arranged.rider, stop.id),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(counted.status).toBe(200);
    const refused = await fail(arranged.rider, stop.id);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(refused)).toBe('collection_recorded');
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
    expect(await events('pickup.stop.failed', stop.id)).toEqual([]);
  });

  // Break caught: an officer, a vendor or a caller with no session let in.
  it('is the assigned rider’s: an officer, a vendor and a caller with no session never reach it', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const headers = {
      'If-Match': await tokenOf(arranged.rider, stop.id),
      'Idempotency-Key': randomUUID(),
    };
    expect(
      outcome(await ops.client.post(FAIL(stop.id), { ...ORDINARY }, { origin: OPS, headers })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await browser.post(FAIL(stop.id), { ...ORDINARY }, { headers }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect((await routes.kit.client.post(FAIL(stop.id), { ...ORDINARY }, { headers })).status).toBe(
      401,
    );
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
  });
});

describe('reportPickupFailure: a retry is not a second failure', () => {
  // Break caught: a retry that records a second failure or event, answers differently, or is judged against the stop that has since changed.
  it('replays the answer for the same key, once', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const token = await tokenOf(arranged.rider, stop.id);
    const key = randomUUID();
    const sent = await fail(arranged.rider, stop.id, { ...ORDINARY }, { etag: token, key });
    expect(sent.status).toBe(200);
    const version = (await stopOf(stop.id)).version;
    // The retry carries the token the first request carried, which the stop has since left.
    const retried = await fail(arranged.rider, stop.id, { ...ORDINARY }, { etag: token, key });
    expect(retried.status).toBe(200);
    expect(retried.json()).toEqual(sent.json());
    expect(retried.header('etag')).toBe(sent.header('etag'));
    expect((await stopOf(stop.id)).version).toBe(version);
    expect(await events('pickup.stop.failed', stop.id)).toHaveLength(1);
  });

  // Break caught: one key reused for another body treated as a retry.
  it('refuses the same key with another body', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const token = await tokenOf(arranged.rider, stop.id);
    const key = randomUUID();
    expect(
      (await fail(arranged.rider, stop.id, { ...ORDINARY }, { etag: token, key })).status,
    ).toBe(200);
    const other = await fail(
      arranged.rider,
      stop.id,
      { ...ORDINARY, category: 'ACCESS_DENIED' },
      { etag: token, key },
    );
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect((await stopOf(stop.id)).failure_category).toBe('PARCEL_NOT_READY');
  });

  // Break caught: a key that is not a key, or none.
  it('needs an Idempotency-Key in the form the contract states', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const etag = await tokenOf(arranged.rider, stop.id);
    const none = await arranged.rider.client.post(
      FAIL(stop.id),
      { ...ORDINARY },
      { headers: { 'If-Match': etag } },
    );
    expect(none.status).toBe(400);
    const bad = await arranged.rider.client.post(
      FAIL(stop.id),
      { ...ORDINARY },
      { headers: { 'If-Match': etag, 'Idempotency-Key': 'k'.repeat(129) } },
    );
    expect(bad.status).toBe(400);
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
  });
});

describe('the door wait (pickup-collection.md: a vendor who is simply busy is no fallback trigger)', () => {
  const UNAVAILABLE = {
    category: 'VENDOR_UNAVAILABLE',
    reason_code: 'VENDOR_NOT_AT_LOCATION',
    note: NOTE,
    contact_attempts: [
      { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00Z', outcome: 'No answer' },
    ],
  } as const;
  const arrivedAgo = (stopId: string, interval: string) =>
    routes.admin.query(
      `update pickup_stop set arrived_at = clock_timestamp() - $2::interval where id = $1`,
      [stopId, interval],
    );
  const detailsOf = (response: TestResponse) =>
    (response.json() as { details?: Record<string, unknown> }).details ?? {};

  // Break caught: a vendor who is "unavailable" accepted at the moment the rider arrived (the wait is the point), or refused with nothing said of when the report is allowed.
  it('refuses a report of unavailability made before the hub’s door wait, and says when it is allowed', async () => {
    const arranged = await run();
    const stop = first(arranged);
    await arrivedAgo(stop.id, '3 minutes');
    const before = await stopOf(stop.id);

    const early = await fail(arranged.rider, stop.id, { ...UNAVAILABLE });

    expect(outcome(early)).toEqual([422, 'PICKUP_DOOR_WAIT_NOT_ELAPSED']);
    const details = detailsOf(early);
    expect(details.door_wait_minutes).toBe(10);
    expect(details.retry_after_seconds).toBeGreaterThan(6 * 60);
    expect(details.retry_after_seconds).toBeLessThanOrEqual(7 * 60);
    const arrived = (await stopOf(stop.id)).arrived_at?.getTime() ?? 0;
    expect(new Date(String(details.available_at)).getTime()).toBe(arrived + 10 * 60 * 1000);
    // Nothing was written: the stop, its events and the run are as they were.
    expect(await stopOf(stop.id)).toEqual(before);
    expect(await events('pickup.stop.failed', stop.id)).toEqual([]);
    expect((await manifestOf(arranged.manifest.id))?.state).toBe('IN_PROGRESS');
  });

  // Break caught: the boundary moved (accepted a second early, or refused a second late), measured from the device's clock, or from anything but the recorded arrival.
  it.each([
    ['one minute short of the wait', '9 minutes', 422],
    ['thirty seconds short of the wait', '9 minutes 30 seconds', 422],
    ['just past the wait', '10 minutes 2 seconds', 200],
    ['long past the wait', '3 hours', 200],
  ] as const)('is measured from the arrival: %s', async (_what, ago, status) => {
    const arranged = await run();
    const stop = first(arranged);
    await arrivedAgo(stop.id, ago);

    const response = await fail(arranged.rider, stop.id, { ...UNAVAILABLE });

    expect(response.status).toBe(status);
    expect((await stopOf(stop.id)).state).toBe(status === 200 ? 'FAILED' : 'ARRIVED');
  });

  // Break caught: the wait imposed on every failure, so that a rider at a door security will not open, or whose vendor refuses, is held for ten minutes it cannot use.
  it.each([
    ['a parcel that is not ready', { ...ORDINARY }],
    ['a collection the vendor refuses', { ...REFUSED }],
  ] as const)('does not hold %s', async (_what, body) => {
    const arranged = await run();
    const stop = first(arranged);
    await arrivedAgo(stop.id, '5 seconds');

    expect((await fail(arranged.rider, stop.id, { ...body })).status).toBe(200);
  });

  // Break caught: a pairing that is judged after the wait (a reason of another category told to wait as though it were a vendor-unavailable failure, or accepted once the wait has
  // passed), or a refusal that outranks the reason's own. Since D-A4 the wait follows the reason, which belongs to one category (pickup-failure-category.db.test.ts goes through the pairings).
  it('judges the pairing and the body before it tells the rider to wait', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const [one, two] = arranged.stops;
    await arrivedAgo(one?.id ?? '', '2 minutes');
    await arrivedAgo(two?.id ?? '', '2 minutes');

    const other = await fail(arranged.rider, one?.id ?? '', {
      ...UNAVAILABLE,
      reason_code: 'PARCELS_NOT_PACKED',
    });
    expect(outcome(other)).toEqual([400, 'VALIDATION_FAILED']);
    // No note where the reason asks for one: the missing note is the first thing said.
    const noNote = await fail(arranged.rider, two?.id ?? '', {
      category: 'VENDOR_UNAVAILABLE',
      reason_code: 'VENDOR_NOT_AT_LOCATION',
      contact_attempts: UNAVAILABLE.contact_attempts,
    });
    expect(outcome(noNote)).toEqual([422, 'REASON_REQUIRED']);
  });

  // Break caught: the wait read from another hub's value, or from a default, or a hub with no door wait silently told none (the wait would never be enforced there).
  it('reads the wait of the stop’s own hub, and fails closed in a hub that has none', async () => {
    const elsewhere = await run({ hubId: HUB_B, stops: 1, stopStates: ['ARRIVED'] });
    const stop = first(elsewhere);
    await arrivedAgo(stop.id, '2 hours');
    // Hub B holds no door wait (only the launch hub is configured): the report of this category is an operational failure, with no wait invented and nothing written.
    const missing = await fail(elsewhere.rider, stop.id, { ...UNAVAILABLE });
    expect(missing.status).toBe(503);
    expect((await stopOf(stop.id)).state).toBe('ARRIVED');
    // The other categories never read it.
    const ordinary = await run({ hubId: HUB_B, stops: 1, stopStates: ['ARRIVED'] });
    expect((await fail(ordinary.rider, first(ordinary).id, { ...ORDINARY })).status).toBe(200);

    // Hub B is given one: its own value decides, not the launch hub's.
    await routes.admin.query(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       values (gen_random_uuid(), $1, 'rider_door_wait_minutes', '', 1, '45'::jsonb, 'minutes', clock_timestamp() - interval '1 hour', gen_random_uuid())`,
      [HUB_B],
    );
    await arrivedAgo(stop.id, '30 minutes');
    const held = await fail(elsewhere.rider, stop.id, { ...UNAVAILABLE });
    expect(outcome(held)).toEqual([422, 'PICKUP_DOOR_WAIT_NOT_ELAPSED']);
    expect(detailsOf(held).door_wait_minutes).toBe(45);
    await arrivedAgo(stop.id, '46 minutes');
    expect((await fail(elsewhere.rider, stop.id, { ...UNAVAILABLE })).status).toBe(200);
  });
});

describe('physical failure is terminal (AC-SLICE-001-32)', () => {
  // Break caught: a failed stop that any actor can move back to ARRIVED or on to a collected state, by an operation or by a statement.
  it('is not moved back or on by anyone: not by the rider, the office, or a statement', async () => {
    const arranged = await run();
    const stop = first(arranged);
    expect((await fail(arranged.rider, stop.id)).status).toBe(200);
    const token = await tokenOf(arranged.rider, stop.id);

    const arrive = await arranged.rider.client.post(`${STOP(stop.id)}/arrive`, undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(arrive.status).toBe(409);
    const collect = await arranged.rider.client.post(
      COLLECT(stop.id),
      { collected_count: 3 },
      { headers: { 'If-Match': token, 'Idempotency-Key': randomUUID() } },
    );
    expect(outcome(collect)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(collect)).toBe('stop_resolved');
    const skip = await ops.client.post(
      `${STOP(stop.id)}/skip`,
      { reason_code: 'RUN_CUT_SHORT' },
      {
        origin: OPS,
        headers: {
          'If-Match': (await ops.client.get(STOP(stop.id))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(outcome(skip)).toEqual([409, 'STATE_CONFLICT']);

    // And no statement does it, whoever writes it: the guard of the stop holds it for every login, the administrator's included.
    for (const text of [
      `update pickup_stop set state = 'ARRIVED', failure_category = null, failure_reason_snapshot = null, resolved_at = null where id = $1`,
      `update pickup_stop set state = 'COLLECTED', failure_category = null, failure_reason_snapshot = null where id = $1`,
      `update pickup_stop set failure_category = 'ACCESS_DENIED' where id = $1`,
      `update pickup_stop set failure_reason_snapshot = failure_reason_snapshot || '{"note":"changed"}'::jsonb where id = $1`,
    ]) {
      await expect(routes.admin.query(text, [stop.id]), text).rejects.toMatchObject({
        code: '23514',
      });
    }
    const after = await stopOf(stop.id);
    expect(after.state).toBe('FAILED');
    expect(after.failure_category).toBe('PARCEL_NOT_READY');
  });
});

describe('a refused collection is escalation-only (AC-SLICE-001-33)', () => {
  const NO_ATTEMPT = 'Fixture escalation note: the vendor refused to hand the parcels over';
  const escalate = async (who: Actor, requestId: string): Promise<TestResponse> =>
    who.client.post(
      `${REQUEST(requestId)}/escalate`,
      { note: NO_ATTEMPT },
      {
        origin: OPS,
        headers: {
          'If-Match': (await who.client.get(REQUEST(requestId))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
  const reschedule = async (requestId: string): Promise<TestResponse> =>
    ops.client.post(
      `${REQUEST(requestId)}/cancel`,
      {
        reason_code: CANCEL_REASON,
        create_replacement: true,
        apply_charge: false,
        charge_reason_code: CANCEL_REASON,
      },
      {
        origin: OPS,
        headers: {
          'If-Match': (await ops.client.get(REQUEST(requestId))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
  const extend = async (who: Actor, requestId: string): Promise<TestResponse> =>
    who.client.post(
      `${REQUEST(requestId)}/attempt-extension`,
      { reason: REASON },
      {
        origin: OPS,
        headers: {
          'If-Match': (await who.client.get(REQUEST(requestId))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );

  // Break caught: a refused collection that Ops reschedules by ordinary action, whatever the cap says; one that no force-extension opens; an extension that opens
  // more than one further attempt, or that can be made twice; and an ordinary failure that is held back.
  it('is refused a reschedule as PICKUP_ATTEMPT_LIMIT_REACHED until Senior Ops force-extends it, once, and then opens', async () => {
    const refused = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop = first(refused);
    expect((await fail(refused.rider, stop.id, { ...REFUSED })).status).toBe(200);
    expect((await stopOf(stop.id)).failure_category).toBe('REFUSED_COLLECTION');
    const before = await requestOf(stop.requestId);

    const blocked = await reschedule(stop.requestId);
    expect(outcome(blocked)).toEqual([422, 'PICKUP_ATTEMPT_LIMIT_REACHED']);
    expect(await requestOf(stop.requestId)).toEqual(before);

    // Ops has no authority to extend; Senior Ops has, once.
    expect(outcome(await extend(ops, stop.requestId))).toEqual([403, 'PERMISSION_DENIED']);
    const extended = await extend(senior, stop.requestId);
    expect(extended.status).toBe(200);
    expect(outcome(await extend(senior, stop.requestId))).toEqual([409, 'STATE_CONFLICT']);
    // The ceiling was not what stood in the way (the first attempt of three), so the record states no ceiling: it states the release of the restriction.
    const record = await routes.rows<{
      ceiling_before: number | null;
      ceiling_after: number | null;
      releases_refused_collection: boolean;
    }>(
      `select e.ceiling_before, e.ceiling_after, e.releases_refused_collection from pickup_attempt_extension e where e.pickup_request_id = $1`,
      [stop.requestId],
    );
    expect(record).toEqual([
      { ceiling_before: null, ceiling_after: null, releases_refused_collection: true },
    ]);
    // The event says the same, truthfully: a restriction released for one attempt, and no ceiling moved.
    const [event] = await routes.rows<{
      before_after: Record<string, unknown>;
      detail: Record<string, unknown>;
      enhanced: boolean;
    }>(
      `select before_after, detail, enhanced from audit_event where event_code = 'pickup.attempt.extended' and object_id = $1`,
      [stop.requestId],
    );
    expect(event?.enhanced).toBe(true);
    expect(Object.keys(event?.before_after ?? {}).toSorted()).toEqual([
      'attempt_extension_id',
      'refused_collection_restriction',
    ]);
    expect(event?.before_after.refused_collection_restriction).toEqual({
      before: 'ESCALATION_ONLY',
      after: 'RELEASED_FOR_ONE_ATTEMPT',
    });
    expect(event?.detail).toEqual({
      permission: 'pickup.attempt.extend',
      lifts_attempt_ceiling: false,
      releases_refused_collection: true,
    });

    const rescheduled = await reschedule(stop.requestId);
    expect(rescheduled.status).toBe(200);
    expect((await requestOf(stop.requestId))?.state).toBe('CANCELLED');
    // The failed stop is left exactly as it was.
    expect((await stopOf(stop.id)).state).toBe('FAILED');
  });

  // Break caught: a refused collection at the cap taken for one that needs two extensions, or whose single extension records only one of the two things it did.
  it('is lifted and released by one extension at the cap, which records both', async () => {
    const refused = await run({ stops: 1, stopStates: ['ARRIVED'], attemptNumber: 3 });
    const stop = first(refused);
    expect((await fail(refused.rider, stop.id, { ...REFUSED })).status).toBe(200);
    expect(outcome(await reschedule(stop.requestId))).toEqual([
      422,
      'PICKUP_ATTEMPT_LIMIT_REACHED',
    ]);

    expect((await extend(senior, stop.requestId)).status).toBe(200);
    const record = await routes.rows<{
      ceiling_before: number | null;
      ceiling_after: number | null;
      releases_refused_collection: boolean;
    }>(
      `select ceiling_before, ceiling_after, releases_refused_collection from pickup_attempt_extension where pickup_request_id = $1`,
      [stop.requestId],
    );
    expect(record).toEqual([
      { ceiling_before: 3, ceiling_after: 4, releases_refused_collection: true },
    ]);
    const [event] = await routes.rows<{
      before_after: Record<string, unknown>;
      detail: Record<string, unknown>;
    }>(
      `select before_after, detail from audit_event where event_code = 'pickup.attempt.extended' and object_id = $1`,
      [stop.requestId],
    );
    expect(event?.before_after.attempt_ceiling).toEqual({ before: 3, after: 4 });
    expect(event?.before_after.refused_collection_restriction).toBeDefined();
    expect(event?.detail).toMatchObject({
      lifts_attempt_ceiling: true,
      releases_refused_collection: true,
    });
    // Nothing is left to extend, and the reschedule opens.
    expect(outcome(await extend(senior, stop.requestId))).toEqual([409, 'STATE_CONFLICT']);
    expect((await reschedule(stop.requestId)).status).toBe(200);
  });

  // Break caught: the release carried to a clone by its source's extension, so that a second refusal of the replacement is let through without an authority of its own.
  it('does not carry the release to the replacement: a second refusal needs a second extension', async () => {
    const first1 = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop1 = first(first1);
    expect((await fail(first1.rider, stop1.id, { ...REFUSED })).status).toBe(200);
    expect((await extend(senior, stop1.requestId)).status).toBe(200);
    const rescheduled = await ops.client.post(
      `${REQUEST(stop1.requestId)}/cancel`,
      {
        reason_code: CANCEL_REASON,
        create_replacement: true,
        apply_charge: false,
        charge_reason_code: CANCEL_REASON,
      },
      {
        origin: OPS,
        headers: {
          'If-Match': (await ops.client.get(REQUEST(stop1.requestId))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(rescheduled.status).toBe(200);
    const clone = (rescheduled.json() as { replacement_request_id: string | null })
      .replacement_request_id;
    expect(clone).not.toBeNull();
    // The clone names its source's extension, which was raised for the source and releases nothing for the clone.
    expect(
      await routes.rows<{ named: string | null; own: string | null }>(
        `select c.attempt_extension_id as named, e.pickup_request_id as own from pickup_request c left join pickup_attempt_extension e on e.id = c.attempt_extension_id where c.id = $1`,
        [clone],
      ),
    ).toEqual([{ named: expect.any(String) as unknown, own: stop1.requestId }]);
  });

  // Break caught (the review of 5 November 2026): the release of a refused collection read from the extension the request CARRIES and not from one raised FOR it, so that a
  // replacement that carries its source's release is taken for released and its own refusal is rescheduled with no second act; or read from an extension that lifted a ceiling and
  // released nothing. The question is put to the table itself, with the real extensions the routes made.
  it('reads the release from an extension raised for the request that releases, and from nowhere else', async () => {
    const source = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const sourceStop = first(source);
    expect((await fail(source.rider, sourceStop.id, { ...REFUSED })).status).toBe(200);
    expect((await extend(senior, sourceStop.requestId)).status).toBe(200);
    const [released] = await routes.rows<{ id: string }>(
      `select id from pickup_attempt_extension where pickup_request_id = $1 and releases_refused_collection`,
      [sourceStop.requestId],
    );
    // An ordinary failure at the cap, extended: a ceiling lifted and nothing released.
    const capped = await run({ stops: 1, stopStates: ['ARRIVED'], attemptNumber: 3 });
    const cappedStop = first(capped);
    expect((await fail(capped.rider, cappedStop.id, { ...ORDINARY })).status).toBe(200);
    expect((await extend(senior, cappedStop.requestId)).status).toBe(200);
    const [lifted] = await routes.rows<{ id: string; releases_refused_collection: boolean }>(
      `select id, releases_refused_collection from pickup_attempt_extension where pickup_request_id = $1`,
      [cappedStop.requestId],
    );
    expect(lifted?.releases_refused_collection).toBe(false);
    const other = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const otherStop = first(other);
    const asked = (row: { id: string; attempt_extension_id: string | null }) =>
      routes.built.service.transactionWithContext(
        {
          principalType: 'STAFF',
          principalId: randomUUID(),
          sessionId: randomUUID(),
          surface: 'OPS_PORTAL',
          authorizationKey: 'pickup.attempt.extend',
          hubScopeMode: 'ALL',
          authorizedHubIds: [],
          correlationId: 'refusal-released-for',
        },
        (tx) => refusalReleasedFor(tx, row),
      );

    // Its own release: released. The same extension carried by another request, an extension that lifted a ceiling and released nothing, and none at all: not.
    expect(
      await asked({ id: sourceStop.requestId, attempt_extension_id: released?.id ?? '' }),
    ).toBe(true);
    expect(await asked({ id: otherStop.requestId, attempt_extension_id: released?.id ?? '' })).toBe(
      false,
    );
    expect(await asked({ id: cappedStop.requestId, attempt_extension_id: lifted?.id ?? '' })).toBe(
      false,
    );
    expect(await asked({ id: sourceStop.requestId, attempt_extension_id: null })).toBe(false);
  });

  // Break caught (the review of 5 November 2026): an extension that does nothing (no ceiling lifted and no restriction released), or that states one ceiling and not the other,
  // stored by any writer: the table says what an extension is.
  it.each([
    ['lifts nothing and releases nothing', [null, null, false], false],
    ['states a ceiling before and none after', [3, null, true], false],
    ['states a ceiling after and none before', [null, 4, true], false],
    ['lifts a ceiling and releases nothing', [3, 4, false], true],
    ['releases a refused collection and lifts nothing', [null, null, true], true],
    ['lifts a ceiling and releases a refused collection', [3, 4, true], true],
  ] as const)(
    'holds what an extension is, for any writer: one that %s',
    async (_what, [before, after, releases], kept) => {
      const arranged = await run({ stops: 1, stopStates: ['ARRIVED'] });
      const stop = first(arranged);
      const insert = routes.admin.query(
        `insert into pickup_attempt_extension (id, pickup_request_id, ceiling_before, ceiling_after, releases_refused_collection, extended_by, reason)
         values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'Fixture extension')`,
        [stop.requestId, before, after, releases],
      );
      if (kept) {
        await insert;
      } else {
        await expect(insert).rejects.toMatchObject({
          code: '23514',
          constraint: 'pickup_attempt_extension_does_something',
        });
      }
    },
  );

  // Break caught: a refused collection that cannot be escalated (escalation is what it is left to).
  it('can be escalated by Ops at once', async () => {
    const refused = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop = first(refused);
    expect((await fail(refused.rider, stop.id, { ...REFUSED })).status).toBe(200);
    const escalated = await escalate(ops, stop.requestId);
    expect(escalated.status).toBe(200);
    expect((await requestOf(stop.requestId))?.escalated_at).not.toBeNull();
    expect((await requestOf(stop.requestId))?.state).toBe('CONFIRMED');
  });

  // Break caught: the rule applied to every failure (an ordinary failure held back), or an extension granted to a request that can go on.
  it('does not hold back an ordinary failure: it reschedules at once and there is nothing to extend', async () => {
    const ordinary = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop = first(ordinary);
    expect((await fail(ordinary.rider, stop.id, { ...ORDINARY })).status).toBe(200);
    expect(outcome(await extend(senior, stop.requestId))).toEqual([409, 'STATE_CONFLICT']);
    const rescheduled = await reschedule(stop.requestId);
    expect(rescheduled.status).toBe(200);
    expect((await requestOf(stop.requestId))?.state).toBe('CANCELLED');
  });

  // Break caught: the refusal judged from the request's own fields instead of from its failed stop, so that a request cancelled without a replacement is held up.
  it('still lets the office cancel a refused collection without a replacement', async () => {
    const refused = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop = first(refused);
    expect((await fail(refused.rider, stop.id, { ...REFUSED })).status).toBe(200);
    const cancelled = await ops.client.post(
      `${REQUEST(stop.requestId)}/cancel`,
      { reason_code: CANCEL_REASON, apply_charge: false, charge_reason_code: CANCEL_REASON },
      {
        origin: OPS,
        headers: {
          'If-Match': (await ops.client.get(REQUEST(stop.requestId))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(cancelled.status).toBe(200);
    expect((await requestOf(stop.requestId))?.state).toBe('CANCELLED');
  });
});
