import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { photoOf } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, codeOf } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.28, the photo of a failure (the evidence of S1.11 and its first owner): `reportPickupFailure` takes `evidence_ids`, and the requirement is read from the reason.
 * Against a real PostgreSQL and the real application, with the evidence made by the real operations:
 *
 * - **A reason that asks for a photo** (`ENTRY_REFUSED_BY_SECURITY`, `LOCATION_CLOSED`: read from the catalogue and never hard-coded) is usable with at least one stored record of this
 *   stop and refused without (`REASON_REQUIRED`, rule `photo`); a reason that asks for none takes one or more all the same.
 * - **Only usable evidence is attached, and the refusal is one answer** (`EVIDENCE_NOT_STORED`): a record that is unknown, still `PENDING_UPLOAD`, `EXPIRED`, another rider's, another
 *   stop's, not the proof of a collection or already attached; nothing is attached by a refusal, and the valid record named beside the bad one is not attached either.
 * - **The photo is attached in the act that fails the stop**, once, and a retried report adds no second link.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const FAIL = (id: string) => `${STOP(id)}/fail`;
const NOTE = 'The rider could not get in';
const CLOSED = { category: 'ACCESS_DENIED', reason_code: 'LOCATION_CLOSED', note: NOTE } as const;
const UNPACKED = {
  category: 'PARCEL_NOT_READY',
  reason_code: 'PARCELS_NOT_PACKED',
  note: NOTE,
} as const;

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'ARRIVED'],
    ...over,
  });
const stopAt = (arranged: ArrangedRun, index = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[index];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

async function fail(
  rider: ArrangedRider,
  stopId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<TestResponse> {
  const etag = (await rider.client.get(STOP(stopId))).header('etag') ?? '';
  return rider.client.post(FAIL(stopId), body, {
    headers: { 'If-Match': etag, 'Idempotency-Key': key },
  });
}

const stopOf = (id: string) =>
  routes
    .rows<{ state: string; version: number }>(
      `select state, version from pickup_stop where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);
const linksOf = (stopId: string) =>
  routes.rows<{
    evidence_id: string;
    pickup_stop_id: string;
    responsible_hub_id: string;
    attached_by_rider: string;
    attached_at: Date;
  }>(`select * from pickup_stop_evidence where pickup_stop_id = $1 order by evidence_id`, [stopId]);
const evidenceState = (id: string) =>
  routes
    .rows<{ state: string; version: number }>(`select state, version from evidence where id = $1`, [
      id,
    ])
    .then((rows) => rows[0]);
const failedEvents = (stopId: string) =>
  routes.rows(
    `select 1 from audit_event where event_code = 'pickup.stop.failed' and object_id = $1`,
    [stopId],
  );

/** Changes a stored fact of an evidence record, which the record's guard forbids to every writer: the guard and the version trigger are put aside for the one statement. */
async function arrangeEvidence(id: string, assignments: string): Promise<void> {
  await routes.admin.query('alter table evidence disable trigger evidence_guard');
  await routes.admin.query('alter table evidence disable trigger evidence_version');
  try {
    await routes.admin.query(`update evidence set ${assignments} where id = $1`, [id]);
  } finally {
    await routes.admin.query('alter table evidence enable trigger evidence_version');
    await routes.admin.query('alter table evidence enable trigger evidence_guard');
  }
}

describe('reportPickupFailure: the photo the reason asks for', () => {
  // Break caught: a photo that is not attached to the failure it was named in; a link that is not the stop's, the hub's or the rider's; a moment the writer or the application
  // chose; evidence that the report changes; a second event for the photo; an answer that grows a member the contract does not state.
  it('attaches the stored photo to the failure it reports, in the same act, and changes nothing else about the evidence', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const before = await evidenceState(photo.id);

    const sentAt = Date.now();
    const response = await fail(arranged.rider, stop.id, { ...CLOSED, evidence_ids: [photo.id] });
    expect(response.status, response.text).toBe(200);
    const answeredAt = Date.now();
    expect(Object.keys(response.json() as object).toSorted()).not.toContain('evidence_ids');
    expect(await stopOf(stop.id)).toMatchObject({ state: 'FAILED' });

    const [link, ...more] = await linksOf(stop.id);
    expect(more).toEqual([]);
    expect(link).toMatchObject({
      evidence_id: photo.id,
      pickup_stop_id: stop.id,
      responsible_hub_id: HUB_A,
      attached_by_rider: arranged.rider.id,
    });
    // The moment is the database's own, taken during the call.
    expect(link?.attached_at.getTime()).toBeGreaterThanOrEqual(sentAt - 2000);
    expect(link?.attached_at.getTime()).toBeLessThanOrEqual(answeredAt + 2000);
    expect(await evidenceState(photo.id)).toEqual(before);
    expect(await failedEvents(stop.id)).toHaveLength(1);
  });

  // Break caught: a photo requirement left to the application (a reason that asks for one accepted without), hard-coded for two codes, or satisfied by an empty list.
  it('refuses a reason that asks for a photo without one, and takes a reason that asks for none with or without', async () => {
    const arranged = await run({ stops: 3, stopStates: ['ARRIVED', 'ARRIVED', 'ARRIVED'] });
    const asks = stopAt(arranged, 0);
    const empty = stopAt(arranged, 1);
    const none = stopAt(arranged, 2);
    const missing = await fail(arranged.rider, asks.id, { ...CLOSED });
    expect(outcome(missing)).toEqual([422, 'REASON_REQUIRED']);
    expect(ruleOf(missing)).toBe('photo');
    const emptied = await fail(arranged.rider, empty.id, { ...CLOSED, evidence_ids: [] });
    expect(outcome(emptied)).toEqual([422, 'REASON_REQUIRED']);
    expect(ruleOf(emptied)).toBe('photo');
    expect((await stopOf(asks.id))?.state).toBe('ARRIVED');
    expect(await linksOf(asks.id)).toEqual([]);
    expect((await fail(arranged.rider, none.id, { ...UNPACKED })).status).toBe(200);
    expect(await linksOf(none.id)).toEqual([]);
  });

  // Break caught (AC-SLICE-001-31): a requirement hard-coded for a reason instead of read from the catalogue. The catalogue is changed under the test and put back.
  it('reads the requirement from the reason record: one that now asks for a photo is refused without, and one that asks for none is taken without', async () => {
    const arranged = await run({
      stops: 4,
      stopStates: ['ARRIVED', 'ARRIVED', 'ARRIVED', 'ARRIVED'],
    });
    const asksNow = stopAt(arranged, 0);
    const satisfied = stopAt(arranged, 1);
    const asksNot = stopAt(arranged, 2);
    const control = stopAt(arranged, 3);
    try {
      await routes.admin.query(
        `update reason_code set requires_photo = true where code = 'PARCELS_NOT_PACKED'`,
      );
      await routes.admin.query(
        `update reason_code set requires_photo = false where code = 'LOCATION_CLOSED'`,
      );
      const refused = await fail(arranged.rider, asksNow.id, { ...UNPACKED });
      expect(outcome(refused)).toEqual([422, 'REASON_REQUIRED']);
      expect(ruleOf(refused)).toBe('photo');
      const photo = await photoOf(routes, arranged.rider, satisfied.id);
      expect(
        (await fail(arranged.rider, satisfied.id, { ...UNPACKED, evidence_ids: [photo.id] }))
          .status,
      ).toBe(200);
      expect((await fail(arranged.rider, asksNot.id, { ...CLOSED })).status).toBe(200);
      expect(await linksOf(asksNot.id)).toEqual([]);
      expect((await stopOf(control.id))?.state).toBe('ARRIVED');
    } finally {
      await routes.admin.query(
        `update reason_code set requires_photo = false where code = 'PARCELS_NOT_PACKED'`,
      );
      await routes.admin.query(
        `update reason_code set requires_photo = true where code = 'LOCATION_CLOSED'`,
      );
    }
  });

  // Break caught: a second photo refused, or only the first attached; a photo refused where the reason did not ask for one.
  it('takes more than one photo, and one where the reason does not ask for it, and attaches each', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const one = await photoOf(routes, arranged.rider, stop.id);
    const two = await photoOf(routes, arranged.rider, stop.id);
    const response = await fail(arranged.rider, stop.id, {
      ...UNPACKED,
      evidence_ids: [one.id, two.id],
    });
    expect(response.status, response.text).toBe(200);
    expect((await linksOf(stop.id)).map((link) => link.evidence_id).toSorted()).toEqual(
      [one.id, two.id].toSorted(),
    );
  });
});

describe('reportPickupFailure: evidence that cannot be the photo of this failure', () => {
  // Break caught: a record that is not stored, not the rider's, not this stop's, not the proof of a collection or already attached taken as the photo; a refusal that tells
  // the cases apart (one would learn that a record exists); a refusal that attaches the valid record named beside the bad one, or that changes the stop.
  it.each([
    ['an identifier nobody knows', 'unknown'],
    ['a record still PENDING_UPLOAD', 'pending'],
    ['a record that has EXPIRED', 'expired'],
    ['a record another rider captured', 'foreign'],
    ['a record about another stop', 'otherStop'],
    ['a record that is not the proof of a collection', 'otherPurpose'],
    ['a record already attached to the failure', 'attached'],
  ] as const)(
    'refuses %s as EVIDENCE_NOT_STORED, attaches nothing and fails nothing',
    async (_what, kind) => {
      const arranged = await run();
      const stop = stopAt(arranged);
      const valid = await photoOf(routes, arranged.rider, stop.id);
      let named: string;
      switch (kind) {
        case 'unknown':
          named = randomUUID();
          break;
        case 'pending':
          named = (await photoOf(routes, arranged.rider, stop.id, { complete: false })).id;
          break;
        case 'expired': {
          named = (await photoOf(routes, arranged.rider, stop.id, { complete: false })).id;
          await arrangeEvidence(
            named,
            `state = 'EXPIRED', created_at = now() - interval '2 hours', upload_expires_at = now() - interval '1 hour'`,
          );
          break;
        }
        case 'foreign': {
          const other = await run();
          named = (await photoOf(routes, other.rider, stopAt(other).id)).id;
          break;
        }
        case 'otherStop':
          named = (await photoOf(routes, arranged.rider, stopAt(arranged, 1).id)).id;
          break;
        case 'otherPurpose': {
          named = (await photoOf(routes, arranged.rider, stop.id)).id;
          await arrangeEvidence(named, `purpose = 'CONDITION'`);
          break;
        }
        case 'attached': {
          named = (await photoOf(routes, arranged.rider, stop.id)).id;
          await routes.admin.query(
            `insert into pickup_stop_evidence (evidence_id, pickup_stop_id) values ($1, $2)`,
            [named, stop.id],
          );
          break;
        }
      }
      const linksBefore = await linksOf(stop.id);
      const stopBefore = await stopOf(stop.id);
      const refused = await fail(arranged.rider, stop.id, {
        ...UNPACKED,
        evidence_ids: [valid.id, named],
      });
      expect(outcome(refused)).toEqual([422, 'EVIDENCE_NOT_STORED']);
      expect(await linksOf(stop.id)).toEqual(linksBefore);
      expect(await stopOf(stop.id)).toEqual(stopBefore);
      expect(await failedEvents(stop.id)).toEqual([]);
    },
  );

  // Break caught: the evidence judged late, at the attachment (the database would still refuse it, with the same answer), after the contact attempt, the photo and the door wait: the
  // rider would be told to wait, or to give a contact attempt, before it is told that its photo is not one. The order is the contract's: the pairing, the evidence, the contact
  // attempt, the photo, the wait.
  it('judges the evidence before the contact attempt, the photo and the door wait', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'ARRIVED'] });
    const missingContact = stopAt(arranged, 0);
    const waiting = stopAt(arranged, 1);
    const nobodys = randomUUID();
    const unavailable = {
      category: 'VENDOR_UNAVAILABLE',
      reason_code: 'VENDOR_NOT_AT_LOCATION',
      note: NOTE,
    } as const;
    expect(
      outcome(
        await fail(arranged.rider, missingContact.id, { ...unavailable, evidence_ids: [nobodys] }),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED']);
    await routes.admin.query(
      `update pickup_stop set arrived_at = clock_timestamp() - interval '2 minutes' where id = $1`,
      [waiting.id],
    );
    const attempts = [
      { method: 'PHONE_CALL', attempted_at: '2026-11-04T08:00:00Z', outcome: 'No answer' },
    ];
    expect(
      outcome(
        await fail(arranged.rider, waiting.id, {
          ...unavailable,
          contact_attempts: attempts,
          evidence_ids: [nobodys],
        }),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED']);
    // Without the unusable record the same reports are told what they lack, in the same order.
    expect(outcome(await fail(arranged.rider, missingContact.id, { ...unavailable }))).toEqual([
      422,
      'REASON_REQUIRED',
    ]);
    expect(
      outcome(
        await fail(arranged.rider, waiting.id, { ...unavailable, contact_attempts: attempts }),
      ),
    ).toEqual([422, 'PICKUP_DOOR_WAIT_NOT_ELAPSED']);
  });

  // Break caught: an unbounded list (a list as long as the body limit would make a statement for each), a duplicate counted twice, a value that is no identifier.
  const REPEATED = randomUUID();
  it.each([
    ['eleven records', Array.from({ length: 11 }, () => randomUUID())],
    ['the same record twice', [REPEATED, REPEATED]],
    ['a value that is not an identifier', ['not-an-identifier']],
  ])('refuses %s in the list, before anything is read', async (_what, ids) => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const refused = await fail(arranged.rider, stop.id, { ...UNPACKED, evidence_ids: ids });
    expect(outcome(refused)).toEqual([400, 'VALIDATION_FAILED']);
    expect((await stopOf(stop.id))?.state).toBe('ARRIVED');
  });

  // Break caught: a photo that another rider's report can use; the stop of another rider failed with it.
  it('does not let a rider use the photo of a stop that is not its own, and tells it nothing about the record', async () => {
    const mine = await run();
    const theirs = await run();
    const theirPhoto = await photoOf(routes, theirs.rider, stopAt(theirs).id);
    const refused = await fail(mine.rider, stopAt(mine).id, {
      ...UNPACKED,
      evidence_ids: [theirPhoto.id],
    });
    expect(outcome(refused)).toEqual([422, 'EVIDENCE_NOT_STORED']);
    expect(refused.text).not.toContain(theirPhoto.id);
    // The record is still theirs to use.
    expect(
      (await fail(theirs.rider, stopAt(theirs).id, { ...UNPACKED, evidence_ids: [theirPhoto.id] }))
        .status,
    ).toBe(200);
  });
});

describe('reportPickupFailure: a retried report', () => {
  // Break caught: a retry that attaches the photo again or fails (a second link would be refused by the key of the record), or one that answers differently from the first.
  it('replays the answer with the same key and attaches the photo once', async () => {
    const arranged = await run();
    const stop = stopAt(arranged);
    const photo = await photoOf(routes, arranged.rider, stop.id);
    const key = randomUUID();
    const body = { ...CLOSED, evidence_ids: [photo.id] };
    const first = await fail(arranged.rider, stop.id, body, key);
    expect(first.status, first.text).toBe(200);
    const etag = first.header('etag') ?? '';
    const retried = await arranged.rider.client.post(FAIL(stop.id), body, {
      headers: { 'If-Match': etag, 'Idempotency-Key': key },
    });
    expect(retried.status, retried.text).toBe(200);
    expect(retried.json()).toEqual(first.json());
    expect(await linksOf(stop.id)).toHaveLength(1);
    expect(await failedEvents(stop.id)).toHaveLength(1);
  });
});
