import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { PICKUP_FAILURE_CATEGORIES } from '../../src/pickup/pickup-vocabulary.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * D-A4 (`OB-S1-73`, the Product Owner, 11 November 2026): **a failure reason belongs to one failure category, which the catalogue holds, and the server refuses a reason reported
 * under another category** (`VALIDATION_FAILED` at `/reason_code`, rule `category`). Against a real PostgreSQL and the real application:
 *
 * - **Every one of the eight reasons** is accepted under its own category and refused under each of the other three, with nothing written by a refusal; and the pairing is judged
 *   before the evidence, the photo, the contact attempt and the door wait (a refused pairing never asks the rider for a photo it would not need).
 * - **The two rules that attach to a category cannot be stepped around by pairing**: the door wait of `VENDOR_UNAVAILABLE` (a vendor-unavailable reason cannot be reported under a
 *   category that carries no wait, nor another reason under it) and the escalation-only rule of `REFUSED_COLLECTION` (a refused-collection reason cannot be reported as an ordinary
 *   failure so that Ops could reschedule it).
 * - **The pairing is the catalogue's data, not the code's**: the binding is moved in the catalogue under the test, and the server follows it.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;

const CANCEL_REASON = 'FIXTURE_CATEGORY_RESCHEDULE';

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
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
const REQUEST = (id: string) => `${API}/pickup-requests/${id}`;
const NOTE = 'The rider could not collect the parcels';

/** The eight failure reasons and the category each belongs to, with what each asks of the rider: written out, so that the seed and this test cannot drift together. */
const REASONS = [
  { code: 'VENDOR_NOT_AT_LOCATION', category: 'VENDOR_UNAVAILABLE', contact: true, photo: false },
  {
    code: 'VENDOR_UNREACHABLE_BY_PHONE',
    category: 'VENDOR_UNAVAILABLE',
    contact: true,
    photo: false,
  },
  { code: 'ENTRY_REFUSED_BY_SECURITY', category: 'ACCESS_DENIED', contact: false, photo: true },
  { code: 'LOCATION_CLOSED', category: 'ACCESS_DENIED', contact: false, photo: true },
  { code: 'PARCELS_NOT_PACKED', category: 'PARCEL_NOT_READY', contact: false, photo: false },
  {
    code: 'VENDOR_ASKED_TO_COME_BACK_LATER',
    category: 'PARCEL_NOT_READY',
    contact: false,
    photo: false,
  },
  { code: 'VENDOR_REFUSED_HANDOVER', category: 'REFUSED_COLLECTION', contact: false, photo: false },
  { code: 'PARCEL_NOT_ACCEPTABLE', category: 'REFUSED_COLLECTION', contact: false, photo: false },
] as const;

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const violationsOf = (response: TestResponse): unknown =>
  (response.json() as { details?: { violations?: unknown } }).details?.violations;

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
    ...over,
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

async function fail(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return rider.client.post(FAIL(stopId), body, {
    headers: { 'If-Match': await tokenOf(rider, stopId), 'Idempotency-Key': randomUUID() },
  });
}

const stopOf = (id: string) =>
  routes
    .rows<{ state: string; version: number; failure_category: string | null }>(
      `select state, version, failure_category from pickup_stop where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const requestOf = (id: string) =>
  routes
    .rows<{ state: string; version: number }>(
      `select state, version from pickup_request where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const failedEvents = (stopId: string) =>
  routes.rows(
    `select 1 from audit_event where event_code = 'pickup.stop.failed' and object_id = $1`,
    [stopId],
  );
const arrivedAgo = (stopId: string, interval: string) =>
  routes.admin.query(
    `update pickup_stop set arrived_at = clock_timestamp() - $2::interval where id = $1`,
    [stopId, interval],
  );

/** The body that satisfies everything the reason asks of the rider besides the pairing: the note, a contact attempt and a stored photo. */
async function honest(
  arranged: ArrangedRun,
  stopId: string,
  reason: (typeof REASONS)[number],
): Promise<Record<string, unknown>> {
  return {
    category: reason.category,
    reason_code: reason.code,
    note: NOTE,
    ...(reason.contact
      ? {
          contact_attempts: [
            { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00Z', outcome: 'No answer' },
          ],
        }
      : {}),
    ...(reason.photo ? { evidence_ids: [(await photoOf(routes, arranged.rider, stopId)).id] } : {}),
  };
}

describe('reportPickupFailure: a reason belongs to one category', () => {
  // Break caught: a reason accepted under a category that is not its own (a pairing nobody checks), or refused under its own; a refusal that writes the stop, the event or the
  // request; a pairing judged after the photo or the contact attempt (the rider would be asked for what a refused pairing never needed); a binding read from the wrong reason.
  it.each(REASONS)(
    'accepts $code under $category and refuses it under each of the other three, writing nothing',
    async (reason) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const before = await stopOf(stop.id);
      const requestBefore = await requestOf(stop.requestId);
      const others = PICKUP_FAILURE_CATEGORIES.filter((category) => category !== reason.category);
      expect(others).toHaveLength(3);
      for (const category of others) {
        // Only a note is sent: the pairing is judged before the contact attempt and the photo the reason may ask for, so it is the first thing the rider is told.
        const refused = await fail(arranged.rider, stop.id, {
          category,
          reason_code: reason.code,
          note: NOTE,
        });
        expect(outcome(refused), `${reason.code} under ${category}`).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
        expect(violationsOf(refused), `${reason.code} under ${category}`).toEqual([
          { in: 'body', pointer: '/reason_code', rule: 'category' },
        ]);
      }
      expect(await stopOf(stop.id)).toEqual(before);
      expect(await requestOf(stop.requestId)).toEqual(requestBefore);
      expect(await failedEvents(stop.id)).toEqual([]);

      const accepted = await fail(arranged.rider, stop.id, await honest(arranged, stop.id, reason));
      expect(accepted.status, accepted.text).toBe(200);
      expect(await stopOf(stop.id)).toMatchObject({
        state: 'FAILED',
        failure_category: reason.category,
      });
    },
  );

  // Break caught: the pairing hard-coded in the service (a table of eight in code) instead of read from the catalogue, so that a catalogue the Product Owner changes is not followed.
  it('reads the pairing from the catalogue: a reason moved to another category is accepted there and refused where it was', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const [one, two] = [stopAt(arranged, 0), stopAt(arranged, 1)];
    try {
      await routes.admin.query(
        `update reason_code set failure_category = 'ACCESS_DENIED' where code = 'PARCELS_NOT_PACKED'`,
      );
      const body = { reason_code: 'PARCELS_NOT_PACKED', note: NOTE };
      const formerly = await fail(arranged.rider, one.id, {
        ...body,
        category: 'PARCEL_NOT_READY',
      });
      expect(outcome(formerly)).toEqual([400, 'VALIDATION_FAILED']);
      expect((await stopOf(one.id))?.state).toBe('ARRIVED');
      const now = await fail(arranged.rider, two.id, { ...body, category: 'ACCESS_DENIED' });
      expect(now.status, now.text).toBe(200);
      expect((await stopOf(two.id))?.failure_category).toBe('ACCESS_DENIED');
    } finally {
      await routes.admin.query(
        `update reason_code set failure_category = 'PARCEL_NOT_READY' where code = 'PARCELS_NOT_PACKED'`,
      );
    }
  });

  // Break caught: a reason that has no category in the catalogue (a future row, or a catalogue edited by hand) accepted under any category: the check of the table refuses the row,
  // so the pairing can never be "none", and the service refuses what it cannot prove.
  it('cannot be left without a category by the catalogue: the table refuses a failure reason with none, or a category on any other reason', async () => {
    await expect(
      routes.admin.query(
        `update reason_code set failure_category = null where code = 'PARCELS_NOT_PACKED'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(
        `update reason_code set failure_category = 'ACCESS_DENIED' where code = 'RUN_CUT_SHORT'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(
        `update reason_code set failure_category = 'CLOSED' where code = 'PARCELS_NOT_PACKED'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the rules attached to a category cannot be stepped around by pairing', () => {
  // Break caught: the door wait of VENDOR_UNAVAILABLE avoided by reporting a vendor-unavailable reason under a category that carries no wait; or held against the wrong reason
  // (a reason of another category paired with VENDOR_UNAVAILABLE would be told to wait, or accepted once the wait had passed, as though it were a vendor-unavailable failure).
  it('door wait: a vendor-unavailable reason is refused under a category with no wait, another reason is refused under VENDOR_UNAVAILABLE, and the honest report waits', async () => {
    const arranged = await run({ stops: 1, stopStates: ['ARRIVED'] });
    const stop = stopAt(arranged);
    await arrivedAgo(stop.id, '2 minutes');
    const waiting = REASONS[0];
    const contact = [
      { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00Z', outcome: 'No answer' },
    ];
    for (const category of ['ACCESS_DENIED', 'PARCEL_NOT_READY', 'REFUSED_COLLECTION']) {
      const stepped = await fail(arranged.rider, stop.id, {
        category,
        reason_code: waiting.code,
        note: NOTE,
        contact_attempts: contact,
      });
      expect(outcome(stepped), category).toEqual([400, 'VALIDATION_FAILED']);
    }
    // And the other way: a reason of a category with no wait, reported under VENDOR_UNAVAILABLE, is no vendor-unavailable failure at all.
    for (const other of REASONS.filter((each) => each.category !== 'VENDOR_UNAVAILABLE')) {
      const stepped = await fail(arranged.rider, stop.id, {
        category: 'VENDOR_UNAVAILABLE',
        reason_code: other.code,
        note: NOTE,
      });
      expect(outcome(stepped), other.code).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await stopOf(stop.id))?.state).toBe('ARRIVED');
    // The honest report is held by the wait, and accepted once it has passed.
    const body = {
      category: 'VENDOR_UNAVAILABLE',
      reason_code: waiting.code,
      note: NOTE,
      contact_attempts: contact,
    };
    expect(outcome(await fail(arranged.rider, stop.id, body))).toEqual([
      422,
      'PICKUP_DOOR_WAIT_NOT_ELAPSED',
    ]);
    expect((await stopOf(stop.id))?.state).toBe('ARRIVED');
    await arrivedAgo(stop.id, '2 hours');
    expect((await fail(arranged.rider, stop.id, body)).status).toBe(200);
    expect((await stopOf(stop.id))?.failure_category).toBe('VENDOR_UNAVAILABLE');
  });

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

  // Break caught: the escalation-only rule of a refused collection avoided by reporting a refused-collection reason as an ordinary failure, so that Ops could reschedule it; or an
  // honest refused collection that Ops can reschedule by ordinary action (AC-SLICE-001-33).
  it('escalation-only: a refused-collection reason is not reported as an ordinary failure, and the honest report is not rescheduled by ordinary action', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const [refusedStop, ordinaryStop] = [stopAt(arranged, 0), stopAt(arranged, 1)];
    for (const category of ['VENDOR_UNAVAILABLE', 'ACCESS_DENIED', 'PARCEL_NOT_READY']) {
      const stepped = await fail(arranged.rider, refusedStop.id, {
        category,
        reason_code: 'VENDOR_REFUSED_HANDOVER',
        note: NOTE,
      });
      expect(outcome(stepped), category).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await stopOf(refusedStop.id))?.state).toBe('ARRIVED');
    expect((await requestOf(refusedStop.requestId))?.state).toBe('CONFIRMED');

    // The honest report is a refused collection, and Ops cannot reschedule it by ordinary action.
    const refused = await fail(arranged.rider, refusedStop.id, {
      category: 'REFUSED_COLLECTION',
      reason_code: 'VENDOR_REFUSED_HANDOVER',
      note: NOTE,
    });
    expect(refused.status).toBe(200);
    expect(outcome(await reschedule(refusedStop.requestId))).toEqual([
      422,
      'PICKUP_ATTEMPT_LIMIT_REACHED',
    ]);
    expect((await requestOf(refusedStop.requestId))?.state).toBe('CONFIRMED');

    // An ordinary failure, with a reason of its own category, is rescheduled at once: the rule follows the reason, and only a refused collection carries it.
    const ordinary = await fail(arranged.rider, ordinaryStop.id, {
      category: 'PARCEL_NOT_READY',
      reason_code: 'PARCELS_NOT_PACKED',
      note: NOTE,
    });
    expect(ordinary.status).toBe(200);
    expect((await reschedule(ordinaryStop.requestId)).status).toBe(200);
  });
});
