import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.26, `recordCollection` (`pickup.collection.confirm`; `AC-SLICE-001-20`, `-21`, `-28` and `-29`; pickup-collection.md; the Product Owner's
 * decision of 29 October 2026, "count, then confirm"). Against a real PostgreSQL and the real application, each claim:
 *
 * - **The count makes the record and the stop stays `ARRIVED`**: the actual count (never the declared one), `MATCH` or `SHORT` on every collection,
 *   the handshake's direction fixed by the kind of sender and its outcome empty, the request and the stop's row untouched, and one event in the
 *   rider's name, the count's own (`pickup.collection.recorded`, OB-S1-54), that says the stop is still `ARRIVED` and carries no note; the events of the
 *   close (`pickup.stop.collected`, `pickup.stop.partially_collected`) are the handshake's and are not written.
 * - **Zero is a failed pickup** and makes nothing; **more than was declared is refused**; **a short count needs a catalogue reason** (with the note and
 *   the photo its metadata asks for, and the photo cannot be given yet) and raises the office flag in the same transaction; a count that matches has
 *   no reason. The recording and the flag are the database's instants, and a catalogue that changes between the act's reading of the reason and its
 *   insert is a controlled refusal that leaves the key free (OB-S1-60).
 * - **An individual sender is promoted** by the count, and a registered vendor's request promotes nobody.
 * - **Replay-safe** (`AC-SLICE-001-29`): the same key returns the original answer and one record; another body is `IDEMPOTENCY_KEY_CONFLICT`. A
 *   ledger that refuses an event of the act undoes the record, the promotion and both events, and the same key then makes them all.
 * - **Only the assigned rider, on a started run, on an arrived stop, on the stop's current version**, and a stop with a record is never skipped,
 *   failed or cancelled away, in either order of a race.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let browser: TestClient;
let ops: Actor;

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
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const COLLECT = (id: string) => `${STOP(id)}/collect`;
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const REQUESTS = `${API}/pickup-requests`;

interface Collection {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: string;
  readonly variance_reason_code?: string;
  readonly variance_note?: string;
  readonly captured_at?: string;
  readonly office_notified_at: string | null;
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const violationsOf = (response: TestResponse): { in: string; pointer: string; rule: string }[] =>
  (
    response.json() as {
      details?: { violations?: { in: string; pointer: string; rule: string }[] };
    }
  ).details?.violations ?? [];
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

/** The token the collection takes as `If-Match`: the stop as the rider reads it. */
const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

async function collect(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown> = { collected_count: 3 },
  over: { etag?: string; key?: string } = {},
): Promise<TestResponse> {
  const etag = over.etag ?? (await tokenOf(rider, stopId));
  return rider.client.post(COLLECT(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': over.key ?? randomUUID() },
  });
}

const stopRow1 = (id: string) =>
  routes
    .rows<{ state: string; version: number; resolved_at: Date | null; released_at: Date | null }>(
      `select state, version, resolved_at, released_at from pickup_stop where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const requestRow = (id: string) =>
  routes
    .rows<{ state: string; version: number; rider_assigned: boolean }>(
      `select state, version, rider_assigned from pickup_request where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const recordsOf = (stopId: string) =>
  routes.rows<{
    id: string;
    declared_count: number;
    collected_count: number;
    variance: string;
    variance_reason_snapshot: Record<string, unknown> | null;
    office_notified_at: Date | null;
    handshake_type: string;
    handshake_channel: string | null;
    handshake_override_by: string | null;
    handshake_confirmed_at: Date | null;
    recorded_by: string;
    captured_at: Date | null;
    version: number;
  }>(`select * from collection_record where pickup_stop_id = $1`, [stopId]);
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
/**
 * Every event of a count or of the close of a stop that names the stop, whoever the object is: the count's own event cites the stop in `related_ids`
 * (its object is the record), and the two events of the close (`pickup.stop.collected`, `pickup.stop.partially_collected`) are the handshake's (S1.27).
 */
const countAndCloseEventsOf = (stopId: string) =>
  routes.rows<{ event_code: string }>(
    `select event_code from audit_event
      where event_code in ('pickup.collection.recorded', 'pickup.stop.collected', 'pickup.stop.partially_collected')
        and (object_id::text = $1 or related_ids ->> 'pickup_stop_id' = $1) order by event_code`,
    [stopId],
  );
const clock = async (): Promise<string> =>
  (await routes.rows<{ t: string }>(`select clock_timestamp()::text as t`))[0]?.t ?? '';
const senderState = (id: string) =>
  routes
    .rows<{ state: string }>(`select state from ad_hoc_sender where id = $1`, [id])
    .then((rows) => rows[0]?.state);

/** A run in progress whose only stop is the rider's arrived stop for an individual sender's request. */
async function individualSendersRun(state: 'PROVISIONAL' | 'REUSABLE' = 'PROVISIONAL') {
  const rider = await arrangedRider(routes.kit, routes.admin);
  const sender = await insertAdHocSender(routes.admin, { state });
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      serviceDate: days.today,
      assignedRiderId: rider.id,
    }),
  );
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorA.row.organizationId, HUB_A, {
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      intent: 'ADHOC_SENDER',
      state: 'CONFIRMED',
      serviceDate: days.today,
    }),
  );
  await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
    request.id,
  ]);
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, {
      state: 'ARRIVED',
      pickupSummary: {
        reference: request.code,
        sender_display_name: 'Ama Walk-in',
        declared_package_count: 3,
        resolved_pickup_location: { address: 'Fixture stall' },
        location_note: null,
        contact_phone: null,
      },
    }),
  );
  return { rider, sender, manifest, request, stop };
}

describe('recordCollection: the count makes the record and the stop stays ARRIVED', () => {
  // Break caught: a collection that closes the stop (the handshake's), writes the request, moves the stop's version, records the declared count in
  // place of the actual one, leaves the variance out of a clean count, or answers with more than the contract states.
  it('records a clean count: MATCH, the stop still ARRIVED and untouched, the request untouched, one event in the rider’s name', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const stopBefore = await stopRow1(stop.id);
    const requestBefore = await requestRow(stop.requestId);
    const token = await tokenOf(arranged.rider, stop.id);

    const response = await collect(arranged.rider, stop.id, { collected_count: 3 });
    expect(response.status).toBe(200);
    const body = response.json() as Collection;
    expect(body).toMatchObject({
      pickup_stop_id: stop.id,
      declared_count: 3,
      collected_count: 3,
      variance: 'MATCH',
      office_notified_at: null,
    });
    expect(Object.keys(body).toSorted()).toEqual(
      [
        'collected_count',
        'declared_count',
        'id',
        'office_notified_at',
        'pickup_stop_id',
        'variance',
      ].toSorted(),
    );

    const [record] = await recordsOf(stop.id);
    expect(record).toMatchObject({
      id: body.id,
      declared_count: 3,
      collected_count: 3,
      variance: 'MATCH',
      variance_reason_snapshot: null,
      office_notified_at: null,
      handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      handshake_channel: null,
      handshake_override_by: null,
      handshake_confirmed_at: null,
      recorded_by: arranged.rider.id,
      version: 1,
    });
    // The stop is not closed and not written; the request is not touched; the stop's token is the one it was.
    expect(await stopRow1(stop.id)).toEqual(stopBefore);
    expect(await requestRow(stop.requestId)).toEqual(requestBefore);
    expect(await tokenOf(arranged.rider, stop.id)).toBe(token);

    // One event, the count's own (OB-S1-54): the record is its object, and the stop, its run and request, the rider and the hub are named in it. The
    // stop is still ARRIVED, so nothing says it closed: the two events of the close are the handshake's.
    const written = await events('pickup.collection.recorded', body.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      actor_type: 'RIDER',
      actor_id: arranged.rider.id,
      object_type: 'CollectionRecord',
      responsible_hub_id: HUB_A,
      previous_state: 'ARRIVED',
      resulting_state: 'ARRIVED',
      reason_code: null,
      reason_label: null,
      note: null,
      enhanced: false,
      related_ids: {
        pickup_stop_id: stop.id,
        pickup_manifest_id: arranged.manifest.id,
        pickup_request_id: stop.requestId,
        rider_id: arranged.rider.id,
      },
      detail: {
        declared_count: 3,
        collected_count: 3,
        variance: 'MATCH',
        office_notified: false,
        handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      },
    });
    expect(await countAndCloseEventsOf(stop.id)).toEqual([
      { event_code: 'pickup.collection.recorded' },
    ]);
    expect(await events('pickup.stop.collected', stop.id)).toEqual([]);
    expect(await events('pickup.stop.partially_collected', stop.id)).toEqual([]);
  });

  // Break caught (AC-SLICE-001-21): a short count kept without its reason or without raising the office flag in the same transaction; the stop
  // closed by the count; the note lost; the reason's label not snapshotted.
  it('records a short count with its reason: SHORT, the office flag raised, the stop still ARRIVED', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const stopBefore = await stopRow1(stop.id);

    const from = await clock();
    const response = await collect(arranged.rider, stop.id, {
      collected_count: 2,
      variance_reason_code: 'SOME_PARCELS_NOT_READY',
      captured_at: '2026-11-03T08:15:00.250Z',
    });
    const to = await clock();
    expect(response.status).toBe(200);
    const body = response.json() as Collection;
    expect(body).toMatchObject({
      declared_count: 3,
      collected_count: 2,
      variance: 'SHORT',
      variance_reason_code: 'SOME_PARCELS_NOT_READY',
      captured_at: '2026-11-03T08:15:00.250Z',
    });
    expect(typeof body.office_notified_at).toBe('string');

    const [record] = await recordsOf(stop.id);
    expect(record?.variance).toBe('SHORT');
    expect(record?.office_notified_at).toBeInstanceOf(Date);
    expect(record?.variance_reason_snapshot).toMatchObject({
      reason_code: 'SOME_PARCELS_NOT_READY',
      label: expect.any(String) as unknown,
      attribution: 'CUSTOMER',
    });
    expect(record?.captured_at?.toISOString()).toBe('2026-11-03T08:15:00.250Z');
    expect(await stopRow1(stop.id)).toEqual(stopBefore);

    // The recording and the flag are the database's own instants (OB-S1-60): the act gives neither. The flag is raised at the recording, between the
    // readings taken around the request, and the device's moment is kept apart from them.
    const instants = await routes.rows<{
      inside: boolean;
      flagged_at_recording: boolean;
      apart: boolean;
    }>(
      `select (recorded_at >= $2::timestamptz and recorded_at <= $3::timestamptz) as inside,
              (office_notified_at = recorded_at) as flagged_at_recording,
              (captured_at <> recorded_at) as apart
         from collection_record where pickup_stop_id = $1`,
      [stop.id, from, to],
    );
    expect(instants).toEqual([{ inside: true, flagged_at_recording: true, apart: true }]);

    // The count's own event, the same one a clean count writes, with the reason the record keeps (its code and label as the record snapshotted them).
    const written = await events('pickup.collection.recorded', body.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      actor_type: 'RIDER',
      actor_id: arranged.rider.id,
      object_type: 'CollectionRecord',
      responsible_hub_id: HUB_A,
      previous_state: 'ARRIVED',
      resulting_state: 'ARRIVED',
      reason_code: 'SOME_PARCELS_NOT_READY',
      reason_label: (record?.variance_reason_snapshot as { label: string } | null | undefined)
        ?.label,
      note: null,
      enhanced: false,
      related_ids: {
        pickup_stop_id: stop.id,
        pickup_manifest_id: arranged.manifest.id,
        pickup_request_id: stop.requestId,
        rider_id: arranged.rider.id,
      },
      detail: {
        declared_count: 3,
        collected_count: 2,
        variance: 'SHORT',
        office_notified: true,
        handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      },
    });
    expect(await countAndCloseEventsOf(stop.id)).toEqual([
      { event_code: 'pickup.collection.recorded' },
    ]);
    expect(await events('pickup.stop.partially_collected', stop.id)).toEqual([]);
    expect(await events('pickup.stop.collected', stop.id)).toEqual([]);
  });

  // Break caught: a note kept for a reason that needs one but lost from the record and the ledger, or one that leaks to the representation.
  it('keeps the note of a reason that asks for one, and refuses that reason without it', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const without = await collect(arranged.rider, stop.id, {
      collected_count: 1,
      variance_reason_code: 'VENDOR_HELD_BACK_PARCELS',
    });
    expect(outcome(without)).toEqual([422, 'REASON_REQUIRED']);
    expect(await recordsOf(stop.id)).toEqual([]);

    const kept = await collect(arranged.rider, stop.id, {
      collected_count: 1,
      variance_reason_code: 'VENDOR_HELD_BACK_PARCELS',
      variance_note: 'Two boxes are still in the back room',
    });
    expect(kept.status).toBe(200);
    expect((kept.json() as Collection).variance_note).toBe('Two boxes are still in the back room');
    expect((await recordsOf(stop.id))[0]?.variance_reason_snapshot).toMatchObject({
      note: 'Two boxes are still in the back room',
    });
    // The rider's note is private to the record: it is in the ledger neither as the event's note nor anywhere in its facts (OB-S1-54).
    const written = await events('pickup.collection.recorded', (kept.json() as Collection).id);
    expect(written).toHaveLength(1);
    expect(written[0]?.note).toBeNull();
    expect(JSON.stringify(written[0])).not.toContain('back room');
  });
});

describe('recordCollection: what is refused makes nothing (AC-SLICE-001-20 and -21)', () => {
  const nothingMade = async (arranged: ArrangedRun, requestBefore: unknown): Promise<void> => {
    const stop = first(arranged);
    expect(await recordsOf(stop.id)).toEqual([]);
    expect((await stopRow1(stop.id))?.state).toBe('ARRIVED');
    expect(await requestRow(stop.requestId)).toEqual(requestBefore);
    expect(await countAndCloseEventsOf(stop.id)).toEqual([]);
  };

  // Break caught: a zero count that makes a record or an event, a sender promoted by a visit that collected nothing, or the failure not routed.
  it('refuses a count of zero as a failed pickup, whatever else is true, and promotes no sender', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await requestRow(stop.requestId);
    const zero = await collect(arranged.rider, stop.id, { collected_count: 0 });
    expect(outcome(zero)).toEqual([422, 'ZERO_COLLECTION_IS_FAILURE']);
    await nothingMade(arranged, before);

    const individual = await individualSendersRun();
    expect(
      outcome(await collect(individual.rider, individual.stop.id, { collected_count: 0 })),
    ).toEqual([422, 'ZERO_COLLECTION_IS_FAILURE']);
    expect(await senderState(individual.sender.id)).toBe('PROVISIONAL');
    expect(await recordsOf(individual.stop.id)).toEqual([]);
    expect(await events('pickup.sender.promoted', individual.sender.id)).toEqual([]);
  });

  // Break caught: more than was declared recorded as a variance nobody defined, or taken as a short count, or answered with a server error.
  it('refuses more than was declared, naming the count', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await requestRow(stop.requestId);
    const over = await collect(arranged.rider, stop.id, { collected_count: 4 });
    expect(outcome(over)).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(over)).toEqual([
      { in: 'body', pointer: '/collected_count', rule: 'above_declared' },
    ]);
    const huge = await collect(arranged.rider, stop.id, { collected_count: 2_147_483_648 });
    expect(outcome(huge)).toEqual([400, 'VALIDATION_FAILED']);
    await nothingMade(arranged, before);
  });

  // Break caught: a short count accepted with no reason, with another domain's reason, a retired or an unknown one, with the note or the photo its
  // metadata asks for left out; a reference to evidence that cannot be stored; a reason sent with a count that matches.
  it.each([
    ['no reason', { collected_count: 2 }, 422, 'REASON_REQUIRED'],
    ['an empty reason', { collected_count: 2, variance_reason_code: '' }, 422, 'REASON_REQUIRED'],
    [
      'a code of another domain',
      { collected_count: 2, variance_reason_code: 'RUN_CUT_SHORT' },
      422,
      'REASON_NOT_ACTIVE',
    ],
    [
      'an unknown code',
      { collected_count: 2, variance_reason_code: 'NO_SUCH_REASON' },
      422,
      'REASON_NOT_ACTIVE',
    ],
    [
      'a reason that needs a note, with a blank one',
      { collected_count: 2, variance_reason_code: 'VENDOR_DISPUTES_COUNT', variance_note: '  ' },
      422,
      'REASON_REQUIRED',
    ],
    [
      'a reason that needs a photo, which cannot be given yet',
      { collected_count: 2, variance_reason_code: 'PARCEL_DAMAGED_OR_UNSAFE' },
      422,
      'REASON_REQUIRED',
    ],
    [
      'a reference to evidence, none of which can be stored yet',
      {
        collected_count: 2,
        variance_reason_code: 'SOME_PARCELS_NOT_READY',
        evidence_ids: [randomUUID()],
      },
      422,
      'EVIDENCE_NOT_STORED',
    ],
    [
      'a reason for a count that matches',
      { collected_count: 3, variance_reason_code: 'SOME_PARCELS_NOT_READY' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a note for a count that matches',
      { collected_count: 3, variance_note: 'All there' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a note the ledger cannot keep',
      {
        collected_count: 2,
        variance_reason_code: 'SOME_PARCELS_NOT_READY',
        variance_note: 'two\nlines',
      },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a moment in the year zero',
      { collected_count: 3, captured_at: '0000-01-01T00:00:00Z' },
      400,
      'VALIDATION_FAILED',
    ],
  ] as const)('refuses %s', async (_what, body, status, code) => {
    const arranged = await run();
    const stop = first(arranged);
    const before = await requestRow(stop.requestId);
    expect(outcome(await collect(arranged.rider, stop.id, { ...body }))).toEqual([status, code]);
    await nothingMade(arranged, before);
  });

  // Break caught: a body that is not the contract's reaching the service.
  it('refuses a body that is not the contract’s as a validation failure', async () => {
    const arranged = await run();
    const stop = first(arranged);
    for (const body of [
      {},
      { collected_count: '3' },
      { collected_count: 2.5 },
      { collected_count: -1 },
      { collected_count: 3, declared_count: 3 },
      { collected_count: 3, evidence_ids: ['not-a-uuid'] },
      { collected_count: 3, captured_at: 'yesterday' },
    ]) {
      expect(outcome(await collect(arranged.rider, stop.id, body)), JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(await recordsOf(stop.id)).toEqual([]);
  });
});

describe('recordCollection: whose stop, which run, which state, which version', () => {
  // Break caught: a stop that is not the rider's told apart from one that does not exist; a run not started counted; a stop not arrived at or already
  // worked counted; a stale token accepted; a second record made under another key.
  it('judges the rider’s own work, the run, the stop and the token, and says which', async () => {
    const arranged = await run({ stops: 3, stopStates: ['ARRIVED', 'PENDING', 'SKIPPED'] });
    const [arrived, pending, skipped] = arranged.stops;
    const other = await arrangedRider(routes.kit, routes.admin);

    // Not the rider's, and not there: one answer.
    const theirs = await collect(other, arrived?.id ?? '', { collected_count: 3 }, { etag: '"x"' });
    expect(outcome(theirs)).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    expect(
      outcome(await collect(arranged.rider, randomUUID(), undefined, { etag: '"x"' })),
    ).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    // Not arrived at, and already worked.
    const early = await collect(arranged.rider, pending?.id ?? '');
    expect(outcome(early)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(early)).toBe('stop_not_arrived');
    const done = await collect(arranged.rider, skipped?.id ?? '');
    expect(outcome(done)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(done)).toBe('stop_resolved');
    // A token that is not the stop's current one.
    expect(
      outcome(
        await collect(
          arranged.rider,
          arrived?.id ?? '',
          { collected_count: 3 },
          { etag: '"stale"' },
        ),
      ),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(await recordsOf(arrived?.id ?? '')).toEqual([]);

    // The record, and then a second one under another key.
    expect((await collect(arranged.rider, arrived?.id ?? '')).status).toBe(200);
    const again = await collect(arranged.rider, arrived?.id ?? '');
    expect(outcome(again)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(again)).toBe('collection_recorded');
    expect(await recordsOf(arrived?.id ?? '')).toHaveLength(1);
  });

  // Break caught: a count taken on a run that has only been dispatched, or one that is over.
  it('refuses a run that has not started and a run that is over', async () => {
    const dispatched = await run({ state: 'DISPATCHED', stopStates: ['PENDING', 'PENDING'] });
    const token = await tokenOf(dispatched.rider, first(dispatched).id);
    expect(
      outcome(
        await collect(
          dispatched.rider,
          first(dispatched).id,
          { collected_count: 3 },
          { etag: token },
        ),
      ),
    ).toEqual([422, 'MANIFEST_NOT_STARTED']);
    // A run that is over, with the stop's own current token: it is the run that is refused, and says so (a stale token would answer 409 as well).
    const over = await run({ state: 'COMPLETED', stopStates: ['ARRIVED', 'PENDING'] });
    const done = await collect(over.rider, first(over).id, { collected_count: 3 });
    expect(outcome(done)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(done)).toBe('run_not_in_progress');
  });

  // Break caught: an officer, a vendor or a caller with no session let in, or a refusal that tells what the stop is.
  it('is the assigned rider’s: an officer, a vendor and a caller with no session never reach it', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const headers = {
      'If-Match': await tokenOf(arranged.rider, stop.id),
      'Idempotency-Key': randomUUID(),
    };
    const body = { collected_count: 3 };
    expect(
      outcome(await ops.client.post(COLLECT(stop.id), body, { origin: OPS, headers })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await browser.post(COLLECT(stop.id), body, { headers }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    const anonymous = await routes.kit.client.post(COLLECT(stop.id), body, { headers });
    expect(anonymous.status).toBe(401);
    expect(await recordsOf(stop.id)).toEqual([]);
  });
});

describe('recordCollection: an individual sender is promoted by the count (AC-SLICE-001-28)', () => {
  // Break caught: a promotion that waits for the handshake, is skipped for a short count, is written twice, or is made for a vendor's request.
  it('promotes a provisional individual sender when the count is recorded, and points the handshake at the SMS the sender receives', async () => {
    const individual = await individualSendersRun();
    expect(await senderState(individual.sender.id)).toBe('PROVISIONAL');
    const response = await collect(individual.rider, individual.stop.id, {
      collected_count: 2,
      variance_reason_code: 'BOOKED_COUNT_WRONG',
    });
    expect(response.status).toBe(200);
    expect(await senderState(individual.sender.id)).toBe('REUSABLE');
    expect((await recordsOf(individual.stop.id))[0]?.handshake_type).toBe(
      'SENDER_SMS_RIDER_ENTERED',
    );
    expect((await recordsOf(individual.stop.id))[0]?.handshake_channel).toBeNull();

    const promoted = await events('pickup.sender.promoted', individual.sender.id);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: individual.rider.id,
      previous_state: 'PROVISIONAL',
      resulting_state: 'REUSABLE',
    });
    // The count's event says which flow the handshake will take; the promotion is its own event (the database operation's), once, citing the stop.
    const counted = await events('pickup.collection.recorded', (response.json() as Collection).id);
    expect(counted).toHaveLength(1);
    expect(counted[0]?.detail).toMatchObject({ handshake_type: 'SENDER_SMS_RIDER_ENTERED' });
    expect(promoted[0]?.related_ids).toMatchObject({ pickup_stop_id: individual.stop.id });
  });

  it('leaves a sender that is already reusable as it is, writes no second promotion, and promotes nobody for a vendor’s request', async () => {
    const individual = await individualSendersRun('REUSABLE');
    expect((await collect(individual.rider, individual.stop.id)).status).toBe(200);
    expect(await senderState(individual.sender.id)).toBe('REUSABLE');
    expect(await events('pickup.sender.promoted', individual.sender.id)).toEqual([]);

    const vendors = await run();
    expect((await collect(vendors.rider, first(vendors).id)).status).toBe(200);
    expect((await recordsOf(first(vendors).id))[0]?.handshake_type).toBe(
      'VENDOR_ENTERED_RIDER_DISPLAYED',
    );
  });

  // Break caught (the review of 4 November 2026; OB-S1-54): the record, the promotion and their events made as separate units, so that a failure of one
  // keeps the others (a sender reusable for a count that was not recorded, a record without its event, an event of a count that was undone), or an
  // idempotency record that survives a failed act and turns a genuine retry into a replay of nothing. The ledger refuses one event of the act here (a
  // trigger the test puts on the table), whichever of the two it is: everything of the act is undone, the same key and body then make it all, and a
  // replay after that returns the original answer and makes nothing more.
  it.each([
    ['the count', 'pickup.collection.recorded'],
    ['the promotion', 'pickup.sender.promoted'],
  ] as const)(
    'undoes the record, the promotion and both events together when the ledger refuses the event of %s, makes them all on the retry, and replays the original after',
    async (_which, refusedCode) => {
      const individual = await individualSendersRun();
      const key = randomUUID();
      const etag = await tokenOf(individual.rider, individual.stop.id);
      const body = { collected_count: 3 };
      await routes.admin.query(`
        create function fixture_refuse_event() returns trigger language plpgsql as $$
        begin
          if new.event_code = '${refusedCode}' then raise exception 'fixture: the ledger refuses this event'; end if;
          return new;
        end $$`);
      await routes.admin.query(`
        create trigger fixture_refuse_event before insert on audit_event
          for each row execute function fixture_refuse_event()`);
      try {
        const refused = await collect(individual.rider, individual.stop.id, body, { etag, key });
        expect(refused.status).toBe(500);
        expect(await recordsOf(individual.stop.id)).toEqual([]);
        expect(await senderState(individual.sender.id)).toBe('PROVISIONAL');
        expect(await countAndCloseEventsOf(individual.stop.id)).toEqual([]);
        expect(await events('pickup.sender.promoted', individual.sender.id)).toEqual([]);
      } finally {
        await routes.admin.query(`drop trigger fixture_refuse_event on audit_event`);
        await routes.admin.query(`drop function fixture_refuse_event()`);
      }
      // The same key and body once the ledger takes it: nothing was kept of the failed attempt, so this is a first attempt.
      const retried = await collect(individual.rider, individual.stop.id, body, { etag, key });
      expect(retried.status).toBe(200);
      const made = async (): Promise<void> => {
        expect(await recordsOf(individual.stop.id)).toHaveLength(1);
        expect(await senderState(individual.sender.id)).toBe('REUSABLE');
        expect(await countAndCloseEventsOf(individual.stop.id)).toEqual([
          { event_code: 'pickup.collection.recorded' },
        ]);
        expect(await events('pickup.sender.promoted', individual.sender.id)).toHaveLength(1);
      };
      await made();
      // The replay: the original answer, and no second record, event or promotion.
      const replayed = await collect(individual.rider, individual.stop.id, body, { etag, key });
      expect(replayed.status).toBe(200);
      expect(replayed.json()).toEqual(retried.json());
      await made();
    },
  );
});

describe('recordCollection: replay (AC-SLICE-001-29)', () => {
  // Break caught: a replay that makes a second record or a second event, answers differently, or accepts another body under the same key.
  it('returns the original answer for the same key and body, makes one record, and refuses another body under the key', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const key = randomUUID();
    const etag = await tokenOf(arranged.rider, stop.id);
    const body = { collected_count: 2, variance_reason_code: 'SOME_PARCELS_NOT_READY' };

    const original = await collect(arranged.rider, stop.id, body, { key, etag });
    expect(original.status).toBe(200);
    const replay = await collect(arranged.rider, stop.id, body, { key, etag });
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(original.json());
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await countAndCloseEventsOf(stop.id)).toEqual([
      { event_code: 'pickup.collection.recorded' },
    ]);

    const other = await collect(arranged.rider, stop.id, { collected_count: 3 }, { key, etag });
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });

  // Break caught: two submissions at the same moment under different keys both recorded, or one answered with a server error.
  it('makes exactly one record of two counts sent at the same moment', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const etag = await tokenOf(arranged.rider, stop.id);
    const answers = await Promise.all(
      [3, 3].map((count) => collect(arranged.rider, stop.id, { collected_count: count }, { etag })),
    );
    expect(answers.map((each) => each.status).toSorted()).toEqual([200, 409]);
    expect(await recordsOf(stop.id)).toHaveLength(1);
  });
});

describe('recordCollection: the catalogue changes between the act’s reading of the reason and its insert (OB-S1-60)', () => {
  beforeAll(async () => {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active)
       values ('FIXTURE_ROUTE_DRIFT', 'PICKUP_SHORT_COUNT', 'Fixture drift before', 'CUSTOMER', false, true)`,
    );
  });

  // Break caught: the reason read at one moment and written at another with nothing to compare them. The act reads the reason, then asks the database
  // for the direction of the handshake (a read of the request), then inserts; a lock on the request's table holds it between the reading and the insert
  // while the catalogue's label is edited and committed. The insert meets a snapshot that no longer agrees with the catalogue: a controlled refusal
  // (the contract's `REASON_NOT_ACTIVE`, not a server error), nothing kept, the key still free, and the retry records the reason as it now stands.
  it('refuses the stale snapshot with REASON_NOT_ACTIVE, keeps nothing and frees the key, and the retry records the new label', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const key = randomUUID();
    const etag = await tokenOf(arranged.rider, stop.id);
    const body = { collected_count: 2, variance_reason_code: 'FIXTURE_ROUTE_DRIFT' };
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table pickup_request in access exclusive mode');
      const pid = await backendPidOf(holder);
      const counting = collect(arranged.rider, stop.id, body, { etag, key });
      await waitUntilBlockedBy(routes.admin, pid, 'the count', counting);
      await holder.query(
        `update reason_code set label = 'Fixture drift after' where code = 'FIXTURE_ROUTE_DRIFT'`,
      );
      await holder.query('commit');
      expect(outcome(await counting)).toEqual([422, 'REASON_NOT_ACTIVE']);
    } finally {
      await holder.end();
    }
    expect(await recordsOf(stop.id)).toEqual([]);
    expect(await countAndCloseEventsOf(stop.id)).toEqual([]);

    const retried = await collect(arranged.rider, stop.id, body, { etag, key });
    expect(retried.status).toBe(200);
    expect((await recordsOf(stop.id))[0]?.variance_reason_snapshot).toMatchObject({
      reason_code: 'FIXTURE_ROUTE_DRIFT',
      label: 'Fixture drift after',
    });
    const written = await events('pickup.collection.recorded', (retried.json() as Collection).id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      reason_code: 'FIXTURE_ROUTE_DRIFT',
      reason_label: 'Fixture drift after',
    });
  });
});

describe('a stop with a record is never skipped, failed or cancelled away', () => {
  const skipAsOps = async (stopId: string): Promise<TestResponse> => {
    const etag = (await ops.client.get(STOP(stopId))).header('etag') ?? '';
    return ops.client.post(
      `${STOP(stopId)}/skip`,
      { reason_code: 'RUN_CUT_SHORT' },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
  };
  const cancelAsOps = async (requestId: string): Promise<TestResponse> => {
    const etag = (await ops.client.get(`${REQUESTS}/${requestId}`)).header('etag') ?? '';
    return ops.client.post(
      `${REQUESTS}/${requestId}/cancel`,
      {
        reason_code: 'FIXTURE_CANCEL_COLLECTION',
        apply_charge: false,
        charge_reason_code: 'FIXTURE_CANCEL_COLLECTION',
      },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
  };
  beforeAll(async () => {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active)
       values ('FIXTURE_CANCEL_COLLECTION', 'PICKUP_CANCELLATION', 'Fixture cancellation', 'CUSTOMER', false, true)`,
    );
  });

  // Break caught: Ops's skip, or the cancellation of the request, taking away a stop whose parcels were counted at the door.
  it('refuses Ops’s skip and the cancellation of the request, leaving the stop, the record and the request as they were', async () => {
    const arranged = await run();
    const stop = first(arranged);
    expect((await collect(arranged.rider, stop.id)).status).toBe(200);
    const requestBefore = await requestRow(stop.requestId);

    const skip = await skipAsOps(stop.id);
    expect(outcome(skip)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(skip)).toBe('collection_recorded');
    const cancel = await cancelAsOps(stop.requestId);
    expect(outcome(cancel)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(cancel)).toBe('collection_recorded');

    expect((await stopRow1(stop.id))?.state).toBe('ARRIVED');
    expect(await recordsOf(stop.id)).toHaveLength(1);
    expect(await requestRow(stop.requestId)).toEqual(requestBefore);
    expect(await events('pickup.stop.skipped', stop.id)).toEqual([]);
  });

  // Break caught (the order in which the cancellation committed first): a count recorded on a stop the cancellation skipped. The cancellation holds
  // the stop's lock while the rider's collection waits; when it commits, the stop is skipped and the collection finds that.
  it('refuses a count that waited for a cancellation that took the stop first, and makes no record', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const etag = await tokenOf(arranged.rider, stop.id);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from pickup_stop where id = $1 for update`, [stop.id]);
      const pid = await backendPidOf(holder);
      const counting = collect(arranged.rider, stop.id, { collected_count: 3 }, { etag });
      await waitUntilBlockedBy(routes.admin, pid, 'the count', counting);
      await holder.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = jsonb_build_object('reason_code', 'REQUEST_CANCELLED', 'label', 'x', 'skipped_at', now())
          where id = $1`,
        [stop.id],
      );
      await holder.query('commit');
      const answer = await counting;
      // The stop changed under the rider's token and is no longer arrived at: either way nothing is recorded.
      expect([409]).toContain(answer.status);
      expect(await recordsOf(stop.id)).toEqual([]);
    } finally {
      await holder.end();
    }
  });

  // Break caught (the order in which the count committed first): a cancellation that skips a stop whose count commits while it waits. The count
  // holds the stop's lock and has made its record; the cancellation, which locks the request and then the stop, waits and then finds the record.
  it('refuses a cancellation that waited for a count that took the stop first, and leaves the request confirmed', async () => {
    const arranged = await run();
    const stop = first(arranged);
    const requestBefore = await requestRow(stop.requestId);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from pickup_stop where id = $1 for update`, [stop.id]);
      const pid = await backendPidOf(holder);
      const cancelling = cancelAsOps(stop.requestId);
      await waitUntilBlockedBy(routes.admin, pid, 'the cancellation', cancelling);
      await holder.query(
        `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, handshake_type, recorded_by)
         values ($1, $2, $3, 3, 3, 'MATCH', 'VENDOR_ENTERED_RIDER_DISPLAYED', $4)`,
        [randomUUID(), stop.id, HUB_A, arranged.rider.id],
      );
      await holder.query('commit');
      const answer = await cancelling;
      expect(outcome(answer)).toEqual([409, 'STATE_CONFLICT']);
      expect(ruleOf(answer)).toBe('collection_recorded');
      expect((await stopRow1(stop.id))?.state).toBe('ARRIVED');
      expect(await requestRow(stop.requestId)).toEqual(requestBefore);
    } finally {
      await holder.end();
    }
  });

  // Break caught: the rule held by the services alone, so that any other writer (a recovery script, a future operation) could skip a counted stop.
  it('is held by the database for every writer: a statement that skips or fails a counted stop is refused', async () => {
    const arranged = await run();
    const stop = first(arranged);
    expect((await collect(arranged.rider, stop.id)).status).toBe(200);
    for (const state of ['SKIPPED', 'FAILED']) {
      await expect(
        routes.admin.query(`update pickup_stop set state = $2 where id = $1`, [stop.id, state]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect((await stopRow1(stop.id))?.state).toBe('ARRIVED');
    // The outsider: a stop with no record can still be skipped by the same statement, so the refusal is the record's and not a closed door.
    const free = await run();
    await routes.admin.query(
      `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
              skip_snapshot = jsonb_build_object('reason_code', 'RUN_CUT_SHORT', 'label', 'x', 'skipped_at', now())
        where id = $1`,
      [first(free).id],
    );
    expect((await stopRow1(first(free).id))?.state).toBe('SKIPPED');
  });
});

describe('the run is not completed over a counted stop', () => {
  // Break caught: the completion by the system closing a run whose only open stop has been counted (the handshake has not closed it).
  it('keeps a run in progress while a counted stop is still to be closed by the handshake', async () => {
    const arranged = await run({ stops: 1, stopStates: ['ARRIVED'] });
    expect((await collect(arranged.rider, first(arranged).id)).status).toBe(200);
    expect(
      ((await ops.client.get(MANIFEST(arranged.manifest.id))).json() as { state: string }).state,
    ).toBe('IN_PROGRESS');
  });
});
