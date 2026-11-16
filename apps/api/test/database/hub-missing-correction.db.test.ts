import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { countIntake, handOver } from './support/handed-over.js';
import { storedIntakeEvidence } from './support/intake-evidence.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.35b, what is missing and what a senior officer decides (`listMissingParcels`, `adjudicateDiscrepancy` for a photo intake, `correctIntakeCount`; `hub.read`, `hub.osd.adjudicate`; `AC-SLICE-001-94`, `-99`, `-100`
 * and `-101`; features/hub/hub-intake.md sections 5.4, 5.7 and 5.8; Run D, D-D4 and D-D8), against the real application and a real PostgreSQL. Each claim:
 *
 * - **A missing parcel is searched for first** (`AC-SLICE-001-99`): finished as tapped, what was not tapped is in *Missing - being searched for* with its picture, its vendor, its run and since when; the queue counts
 *   those parcels; a parcel found later is checked in by a tap and leaves the list with the count following (the case stays open for the senior); *Still searching* (`ESCALATED`) leaves it all as it was.
 * - **"Vendor told" is a record and nothing else** (`AC-SLICE-001-100`): only after a write-off, once, with no condition, in any state past the count; it moves no state and **sends nothing** (no message and no outbox row);
 *   the write-off moves the parcel from the list of those being searched for to the list of those whose vendor has yet to be told.
 * - **A senior officer corrects a count or a check-in, with a reason** (`AC-SLICE-001-101`): by the parcels' states for a photo intake and by a number for a blind-count one, never both; the count, the variance and the
 *   routing follow in the same change; the old and new numbers and the parcels changed are recorded in one enhanced event with the reason as its note; a retry is the first answer; Ops Staff cannot.
 * - **The lock is advisory and tells who opened a check-in and when**: \`opened_at\` is the first moment of the holder's lock and survives its refreshes, a takeover starts it again, and the queue says who is checking
 *   a run in.
 * - **No answer names a person by more than a display name**: no phone number is in any answer of any act here.
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const ARRIVAL = (parcel: string) => `${API}/intake-parcels/${parcel}/arrival`;
const FINISH = (id: string) => `${ONE(id)}/check-in`;
const EXTRA = (id: string) => `${ONE(id)}/extra-parcels`;
const CORRECTION = (id: string) => `${ONE(id)}/correction`;
const DISCREPANCY = (id: string) => `${ONE(id)}/discrepancy`;
const LOCK = (id: string) => `${ONE(id)}/lock`;
const MISSING = `${API}/missing-parcels`;
const RUNS = `${API}/receiving-runs`;
const SUMMARY = `${API}/ops/queue-summary`;
/** The telephone number the arranged stops carry in their summary (`runs.ts`). */
const A_PHONE = '233200000001';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let receiver: Actor;
let senior: Actor;
let otherHub: Actor;
/** Every answer the acts of this file were given, so that the last test can scan them. */
const seen: string[] = [];

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 300_000);

// A session is allowed 120 requests a minute: each test is made by officers of its own, as the people of a hub are.
beforeEach(async () => {
  receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
});

afterAll(async () => {
  await routes.stop();
});

interface Parcel {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: string;
  readonly state: string;
  readonly photo_evidence_id: string;
  readonly arrived_by_name: string | null;
  readonly arrived_at: string | null;
  readonly missing_marked_at: string | null;
}
interface Intake {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly state: string;
  readonly count_phase: string;
  readonly parcels_expected?: number;
  readonly rider_declared_count: number;
  readonly arrived_count?: number;
  readonly received_count?: number | null;
  readonly physical_count?: number;
  readonly count_variance: string | null;
  readonly count_difference: number | null;
  readonly missing_count?: number;
  readonly extra_count?: number;
  readonly parcels?: readonly Parcel[];
  readonly lock?: {
    holder_name: string;
    held_by_you: boolean;
    opened_at: string;
    last_seen_at: string;
  } | null;
  readonly condition_findings?: readonly {
    kind: string;
    outcome: string | null;
    note: string | null;
  }[];
}
interface MissingRow {
  readonly parcel_id: string;
  readonly photo_evidence_id: string;
  readonly intake_id: string;
  readonly intake_code: string;
  readonly run_id: string;
  readonly run_code: string;
  readonly vendor_name: string;
  readonly missing_since: string;
  readonly written_off_at: string | null;
}

/** Notes an answer for the scan of the last test, and gives it back. */
const noted = (response: TestResponse): TestResponse => {
  seen.push(response.text);
  return response;
};

const read = async (actor: Actor, id: string): Promise<{ intake: Intake; etag: string }> => {
  const response = noted(await actor.client.get(ONE(id)));
  expect(response.status).toBe(200);
  return { intake: response.json() as Intake, etag: response.header('etag') ?? '' };
};
const tap = async (actor: Actor, parcel: string, arrived: boolean): Promise<TestResponse> =>
  noted(await actor.client.request('PUT', ARRIVAL(parcel), { body: { arrived }, origin: OPS }));
const finish = async (actor: Actor, id: string, body: unknown): Promise<TestResponse> =>
  noted(
    await actor.client.post(FINISH(id), body, {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    }),
  );
const adjudicate = async (
  actor: Actor,
  id: string,
  body: unknown,
  etag?: string | null,
): Promise<TestResponse> => {
  const token = etag === undefined ? (await read(actor, id)).etag : etag;
  return noted(
    await actor.client.post(DISCREPANCY(id), body, {
      origin: OPS,
      headers: token === null ? {} : { 'If-Match': token },
    }),
  );
};
const correct = async (
  actor: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null; key?: string } = {},
): Promise<TestResponse> => {
  const token = over.etag === undefined ? (await read(actor, id)).etag : over.etag;
  return noted(
    await actor.client.post(CORRECTION(id), body, {
      origin: OPS,
      headers: {
        ...(token === null ? {} : { 'If-Match': token }),
        'Idempotency-Key': over.key ?? randomUUID(),
      },
    }),
  );
};
const take = async (actor: Actor, id: string): Promise<TestResponse> =>
  noted(await actor.client.post(LOCK(id), {}, { origin: OPS }));

const outcome = (response: TestResponse): [number, string | undefined, string | undefined] => [
  response.status,
  codeOf(response),
  (response.json() as { details?: { rule?: string } }).details?.rule,
];

/** A photo intake of `count` parcels of which the first `arrived` were tapped, and the vendor finished as tapped: the rest are missing, and the case is open. */
async function finishedWithMissing(
  count: number,
  arrived: number,
): Promise<{
  id: string;
  manifest: string;
  parcels: readonly Parcel[];
  missing: readonly Parcel[];
}> {
  const done = await handOver(routes, vendor, days, { collected: [count], photos: true });
  const id = done.intakes[0]?.id ?? '';
  const { intake } = await read(receiver, id);
  const parcels = intake.parcels ?? [];
  for (const parcel of parcels.slice(0, arrived))
    expect((await tap(receiver, parcel.id, true)).status).toBe(200);
  expect((await finish(receiver, id, { all_arrived: false })).status).toBe(200);
  const after = (await read(receiver, id)).intake;
  expect(after.state).toBe('RECONCILIATION_REQUIRED');
  return {
    id,
    manifest: intake.pickup_manifest_id,
    parcels: after.parcels ?? [],
    missing: (after.parcels ?? []).filter((parcel) => parcel.state === 'MISSING'),
  };
}

async function missingList(
  actor: Actor,
  view: 'searching' | 'vendor_to_tell',
  intake?: string,
): Promise<MissingRow[]> {
  const response = noted(await actor.client.get(`${MISSING}?view=${view}&page_size=100`));
  expect(response.status).toBe(200);
  const items = (response.json() as { items: MissingRow[] }).items;
  return intake === undefined ? items : items.filter((item) => item.intake_id === intake);
}

async function queueCount(actor: Actor, queue: string, hub?: string): Promise<number> {
  const response = await actor.client.get(hub === undefined ? SUMMARY : `${SUMMARY}?hub_id=${hub}`);
  expect(response.status).toBe(200);
  return (
    (response.json() as { queues: { queue: string; count: number }[] }).queues.find(
      (each) => each.queue === queue,
    )?.count ?? -1
  );
}

const eventRow = async (code: string, id: string) =>
  (
    await routes.rows<{
      enhanced: boolean;
      note: string | null;
      previous_state: string | null;
      resulting_state: string | null;
      before_after: Record<string, unknown> | null;
      related_ids: Record<string, unknown> | null;
      detail: Record<string, unknown> | null;
    }>(
      `select enhanced, note, previous_state, resulting_state, before_after, related_ids, detail from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
      [code, id],
    )
  )[0];
const eventCount = async (code: string, id: string): Promise<number> =>
  Number(
    (
      await routes.rows<{ n: string }>(
        `select count(*) as n from audit_event where event_code = $1 and object_id = $2`,
        [code, id],
      )
    )[0]?.n ?? 0,
  );
const messagesSent = async (): Promise<number> =>
  Number(
    (
      await routes.rows<{ n: string }>(
        `select (select count(*) from notification) + (select count(*) from outbox) as n`,
      )
    )[0]?.n ?? 0,
  );

describe('listMissingParcels: a missing parcel is searched for first', () => {
  // Break caught: a vendor finished as tapped whose missing parcels are not on the list (or are on it without their pictures, their vendor, their run or the moment they went missing), a queue that counts them as
  // vendors or does not count them, or a scope that shows another hub's (AC-SLICE-001-94, -99): two of three parcels tapped leaves one missing, in both the list and the queue, and only for the hub that holds it.
  it('lists what was not tapped with its picture, vendor, run and moment, counts it in the queue, and shows it to the hub that holds it alone', async () => {
    const before = await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING');
    const { id, manifest, missing } = await finishedWithMissing(3, 1);
    expect(missing).toHaveLength(2);

    const rows = await missingList(receiver, 'searching', id);
    expect(rows.map((row) => row.parcel_id).toSorted()).toEqual(
      missing.map((parcel) => parcel.id).toSorted(),
    );
    for (const row of rows) {
      const parcel = missing.find((each) => each.id === row.parcel_id);
      expect(row).toMatchObject({
        photo_evidence_id: parcel?.photo_evidence_id,
        intake_id: id,
        run_id: manifest,
        written_off_at: null,
      });
      expect(row.vendor_name).not.toBe('');
      expect(row.run_code).not.toBe('');
      expect(row.missing_since).toBe(parcel?.missing_marked_at);
    }
    expect(await missingList(receiver, 'vendor_to_tell', id)).toEqual([]);
    // Parcels, not vendors: two of this vendor's parcels are two in the queue, and the oldest is the earliest of them.
    expect((await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING')) - before).toBe(2);

    // Another hub's officer is shown none of it, a Platform Admin is shown it and the crossing is audited.
    expect(await missingList(otherHub, 'searching', id)).toEqual([]);
    const admin = await routes.platformAdmin();
    expect((await missingList(admin, 'searching', id)).length).toBe(2);
    const crossings = await routes.rows<{ hub: string }>(
      `select responsible_hub_id as hub from audit_event where event_code = 'auth.hub_boundary.crossed' and related_ids->>'operation_id' = 'listMissingParcels'`,
    );
    expect(crossings.map((row) => row.hub)).toContain(HUB_A);
  });

  // Break caught: a parcel found later that is not checked in by a tap (or leaves the case without the count following, or closes the case on its own): the officer taps the missing parcel, it is ARRIVED with the
  // officer's name, the received count and the variance follow, the case stays open for the senior and the token moves; `hub.parcel.found` says the numbers before and after, and the list and the queue lose it.
  it('is checked in by a tap when it is found: the count follows, the case stays open for a senior, and one event says so', async () => {
    const before = await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING');
    const { id, missing } = await finishedWithMissing(3, 2);
    expect(missing).toHaveLength(1);
    const first = await read(receiver, id);
    expect(first.intake).toMatchObject({
      received_count: 2,
      count_variance: 'SHORT',
      missing_count: 1,
    });

    const found = await tap(receiver, missing[0]?.id ?? '', true);
    expect(found.status).toBe(200);
    expect(found.json()).toMatchObject({
      parcel: { id: missing[0]?.id, state: 'ARRIVED', arrived_by_name: receiver.identity.fullName },
      counts: { arrived_count: 3, received_count: 3, count_variance: 'MATCH', missing_count: 0 },
    });
    expect((found.json() as { intake_etag: string }).intake_etag).not.toBe(first.etag);
    const after = await read(receiver, id);
    expect(after.intake).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      received_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    });
    expect(await eventCount('hub.parcel.found', id)).toBe(1);
    expect((await eventRow('hub.parcel.found', id))?.detail).toMatchObject({
      received_count_before: 2,
      received_count_after: 3,
      count_variance_before: 'SHORT',
      count_variance_after: 'MATCH',
    });
    expect((await eventRow('hub.parcel.found', id))?.related_ids).toMatchObject({
      parcel_id: missing[0]?.id,
    });
    expect(await missingList(receiver, 'searching', id)).toEqual([]);
    expect((await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING')) - before).toBe(0);
    // A parcel that arrived cannot be taken back once the vendor is finished.
    expect(outcome(await tap(receiver, missing[0]?.id ?? '', false))).toEqual([
      409,
      'STATE_CONFLICT',
      'check_in_finished',
    ]);
  });
});

describe('adjudicateDiscrepancy: searching, writing off and "Vendor told"', () => {
  // Break caught: "Still searching" that closes the case or takes the parcel off the list, one that needs no reason, one an Ops Staff officer may make, or a decision that is not recorded: ESCALATED leaves the intake in
  // reconciliation with the parcel still being searched for, records the act with its reason, and is the senior's alone.
  it('is "Still searching" with ESCALATED: the case and the parcel stay as they were, the reason is recorded, and only a senior may', async () => {
    const { id, missing } = await finishedWithMissing(2, 1);
    expect(
      outcome(await adjudicate(receiver, id, { outcome: 'ESCALATED', note: 'Looking' })).slice(
        0,
        2,
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    const blank = await adjudicate(senior, id, { outcome: 'ESCALATED', note: '   ' });
    expect([blank.status, codeOf(blank)]).toEqual([422, 'REASON_REQUIRED']);

    const done = await adjudicate(senior, id, {
      outcome: 'ESCALATED',
      note: 'Still looking in the rider’s bag',
    });
    expect(done.status).toBe(200);
    const intake = done.json() as Intake;
    expect(intake).toMatchObject({
      count_phase: 'CHECK_IN',
      state: 'RECONCILIATION_REQUIRED',
      received_count: 1,
      count_variance: 'SHORT',
      missing_count: 1,
    });
    expect(
      intake.condition_findings?.map((finding) => [finding.kind, finding.outcome, finding.note]),
    ).toEqual([['ADJUDICATION', 'ESCALATED', 'Still looking in the rider’s bag']]);
    expect((await missingList(receiver, 'searching', id)).map((row) => row.parcel_id)).toEqual([
      missing[0]?.id,
    ]);
    expect(await eventRow('hub.osd.resolved', id)).toMatchObject({
      enhanced: true,
      note: 'Still looking in the rider’s bag',
      previous_state: 'RECONCILIATION_REQUIRED',
      resulting_state: 'RECONCILIATION_REQUIRED',
    });
    expect((await eventRow('hub.osd.resolved', id))?.detail).toMatchObject({
      outcome: 'ESCALATED',
      resolved: false,
    });
  });

  // Break caught: a write-off that leaves the parcel on the list of those being searched for, that does not clear the case, or whose parcel is never offered for "Vendor told"; and a "Vendor told" that is a message, that
  // moves the case, that can be made before a write-off or twice, or that carries a condition (AC-SLICE-001-99, -100): the write-off clears the case and moves the parcel to the second list; "Vendor told" is
  // recorded once, moves nothing, sends nothing and takes the parcel off the second list.
  it('is a write-off that closes the search, and "Vendor told" a record that follows it once, moves nothing and sends nothing', async () => {
    const searchingBefore = await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING');
    const { id, missing } = await finishedWithMissing(2, 1);
    expect((await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING')) - searchingBefore).toBe(1);

    // "Vendor told" before a write-off is not offered: the database names the rule, and the case is as it was.
    expect(
      outcome(
        await adjudicate(senior, id, { outcome: 'VENDOR_NOTIFIED', note: 'Phoned the vendor' }),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'not_written_off']);
    expect((await read(senior, id)).intake.state).toBe('RECONCILIATION_REQUIRED');

    const written = await adjudicate(senior, id, {
      outcome: 'WRITTEN_OFF',
      note: 'Not found after a day’s search',
    });
    expect(written.status).toBe(200);
    expect(written.json()).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      received_count: 1,
      missing_count: 1,
    });
    expect((await eventRow('hub.osd.resolved', id))?.detail).toMatchObject({
      outcome: 'WRITTEN_OFF',
      resolved: true,
    });
    // The parcel leaves the list of those being searched for and is offered for "Vendor told", with the moment it was written off.
    expect(await missingList(receiver, 'searching', id)).toEqual([]);
    expect((await queueCount(receiver, 'HUB_MISSING_PARCELS_SEARCHING')) - searchingBefore).toBe(0);
    const toTell = await missingList(receiver, 'vendor_to_tell', id);
    expect(toTell.map((row) => row.parcel_id)).toEqual([missing[0]?.id]);
    expect(toTell[0]?.written_off_at).not.toBeNull();

    // "Vendor told" sets no condition, and is a record: nothing is sent.
    const withCondition = await adjudicate(senior, id, {
      outcome: 'VENDOR_NOTIFIED',
      note: 'Told',
      condition: 'DAMAGED',
    });
    expect([withCondition.status, codeOf(withCondition)]).toEqual([400, 'VALIDATION_FAILED']);
    const messages = await messagesSent();
    const told = await adjudicate(senior, id, {
      outcome: 'VENDOR_NOTIFIED',
      note: 'Phoned Kente Crafts: parcel not found',
    });
    expect(told.status).toBe(200);
    expect(told.json()).toMatchObject({ state: 'READY_FOR_ITEMIZATION' });
    expect((told.json() as Intake).condition_findings?.map((finding) => finding.outcome)).toEqual([
      'WRITTEN_OFF',
      'VENDOR_NOTIFIED',
    ]);
    // The last decision of the case is "Vendor told": it is recorded, enhanced like the others, and resolves nothing (the write-off did).
    const decisions = await routes.rows<{ enhanced: boolean; detail: Record<string, unknown> }>(
      `select enhanced, detail from audit_event where event_code = 'hub.osd.resolved' and object_id = $1 order by recorded_at, id`,
      [id],
    );
    expect(
      decisions.map((decision) => [
        decision.detail.outcome,
        decision.detail.resolved,
        decision.enhanced,
      ]),
    ).toEqual([
      ['WRITTEN_OFF', true, true],
      ['VENDOR_NOTIFIED', false, true],
    ]);
    expect(await messagesSent()).toBe(messages);
    expect(await missingList(receiver, 'vendor_to_tell', id)).toEqual([]);
    expect(
      outcome(await adjudicate(senior, id, { outcome: 'VENDOR_NOTIFIED', note: 'Told again' })),
    ).toEqual([409, 'STATE_CONFLICT', 'vendor_already_told']);
    // A decision on a case that is not in reconciliation is refused (told apart from the record "Vendor told").
    expect(outcome(await adjudicate(senior, id, { outcome: 'ACCEPTED', note: 'Accept' }))).toEqual([
      409,
      'STATE_CONFLICT',
      'not_awaiting_resolution',
    ]);
  });

  // Break caught: "Accept the count" that does not clear a case with a missing parcel, or that is not recorded with its reason: ACCEPTED closes the case at the count as it is (the parcel stays missing, no count moves).
  it('is "Accept the count" with ACCEPTED: the case is cleared at the count as it stands and no count moves', async () => {
    const { id } = await finishedWithMissing(2, 1);
    const done = await adjudicate(senior, id, {
      outcome: 'ACCEPTED',
      note: 'The vendor agrees to one short',
    });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      received_count: 1,
      count_variance: 'SHORT',
      count_difference: -1,
      missing_count: 1,
    });
    expect((await eventRow('hub.osd.resolved', id))?.detail).toMatchObject({
      outcome: 'ACCEPTED',
      resolved: true,
      physical_count: 1,
      rider_declared_count: 2,
      count_variance: 'SHORT',
    });
  });
});

describe('correctIntakeCount: a senior officer’s correction', () => {
  // Break caught: a correction that is not recorded as the contract says (no reason, the old and new numbers or the parcels lost, not enhanced), one that does not recompute the count and route the intake again, a retry
  // that corrects twice, a correction on a token that is not current, or one an Ops Staff officer may make (AC-SLICE-001-101): the senior moves the missing parcel to ARRIVED, the count is 3 of 3 and the intake
  // is cleared for itemization; the event is enhanced with the reason as its note and the parcel's move; the key replays the answer byte for byte.
  it('corrects a photo intake by its parcels, recomputes and routes it again, records the reason and the numbers, and is replayed by its key', async () => {
    const { id, missing } = await finishedWithMissing(3, 2);
    const target = missing[0]?.id ?? '';
    const first = await read(senior, id);
    const key = randomUUID();
    const body = {
      reason: 'The third parcel was under the table',
      parcel_changes: [{ parcel_id: target, state: 'ARRIVED' }],
    };

    expect(outcome(await correct(receiver, id, body)).slice(0, 2)).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    const done = await correct(senior, id, body, { etag: first.etag, key });
    expect(done.status).toBe(200);
    const intake = done.json() as Intake;
    expect(intake).toMatchObject({
      count_phase: 'CHECK_IN',
      state: 'READY_FOR_ITEMIZATION',
      received_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
      missing_count: 0,
    });
    expect(intake.parcels?.find((parcel) => parcel.id === target)).toMatchObject({
      state: 'ARRIVED',
      arrived_by_name: senior.identity.fullName,
    });
    expect(done.header('etag')).not.toBe(first.etag);

    const event = await eventRow('hub.intake.corrected', id);
    expect(event).toMatchObject({
      enhanced: true,
      note: 'The third parcel was under the table',
      previous_state: 'RECONCILIATION_REQUIRED',
      resulting_state: 'READY_FOR_ITEMIZATION',
    });
    expect(event?.before_after).toMatchObject({
      state: { before: 'RECONCILIATION_REQUIRED', after: 'READY_FOR_ITEMIZATION' },
      physical_count: { before: 2, after: 3 },
      count_variance: { before: 'SHORT', after: 'MATCH' },
      parcels: [{ parcel_id: target, from: 'MISSING', to: 'ARRIVED' }],
    });
    expect(await eventCount('hub.intake.corrected', id)).toBe(1);

    const replay = await correct(senior, id, body, { etag: first.etag, key });
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(done.text);
    expect(await eventCount('hub.intake.corrected', id)).toBe(1);
    const changed = await correct(
      senior,
      id,
      { reason: 'Another reason', parcel_changes: [{ parcel_id: target, state: 'MISSING' }] },
      { etag: first.etag, key },
    );
    expect(outcome(changed).slice(0, 2)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    // The token that was read before the correction is stale now.
    expect(
      outcome(
        await correct(
          senior,
          id,
          { reason: 'Again', parcel_changes: [{ parcel_id: target, state: 'MISSING' }] },
          { etag: first.etag },
        ),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'stale']);
  });

  // Break caught: a correction that is judged by the wrong thing: a body that names neither or both members, the member of the other mode, a parcel of another intake, a change that changes no number, a reason that is blank
  // or absent, or an intake that has not been counted: each is refused with the code and the rule the contract names, and nothing changes.
  it('is judged: the reason, the body by the intake’s mode, the parcels, a change that changes the number, and a count that has been made', async () => {
    const { id, parcels, missing } = await finishedWithMissing(3, 2);
    const target = missing[0]?.id ?? '';
    const arrived = parcels.find((parcel) => parcel.state === 'ARRIVED')?.id ?? '';
    const stranger = await finishedWithMissing(2, 1);
    const version = (await read(senior, id)).etag;

    const blank = await correct(senior, id, {
      reason: '  ',
      parcel_changes: [{ parcel_id: target, state: 'ARRIVED' }],
    });
    expect([blank.status, codeOf(blank)]).toEqual([422, 'REASON_REQUIRED']);
    const none = await correct(senior, id, {
      parcel_changes: [{ parcel_id: target, state: 'ARRIVED' }],
    });
    expect([none.status, codeOf(none)]).toEqual([400, 'VALIDATION_FAILED']);
    // A photo intake is corrected by its parcels and by nothing else: a number, both, and neither are `mode_mismatch`.
    for (const body of [
      { reason: 'x', physical_count: 3 },
      { reason: 'x', physical_count: 3, parcel_changes: [{ parcel_id: target, state: 'ARRIVED' }] },
      { reason: 'x' },
    ]) {
      const refused = await correct(senior, id, body);
      expect([refused.status, codeOf(refused)], JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    // A parcel that is not this intake's, one named twice, a state the parcel cannot move to, and a change that moves nothing.
    for (const changes of [
      [{ parcel_id: stranger.missing[0]?.id, state: 'ARRIVED' }],
      [
        { parcel_id: target, state: 'ARRIVED' },
        { parcel_id: target, state: 'MISSING' },
      ],
      [{ parcel_id: target, state: 'VOID' }],
      [{ parcel_id: arrived, state: 'ARRIVED' }],
      [],
    ]) {
      const refused = await correct(senior, id, { reason: 'Because', parcel_changes: changes });
      expect([refused.status, codeOf(refused)], JSON.stringify(changes)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect((await read(senior, id)).etag).toBe(version);

    // A vendor still being checked in has no count to correct.
    const waiting = await handOver(routes, vendor, days, { collected: [2], photos: true });
    const waitingId = waiting.intakes[0]?.id ?? '';
    const waitingParcel = (await read(receiver, waitingId)).intake.parcels?.[0]?.id ?? '';
    expect(
      outcome(
        await correct(senior, waitingId, {
          reason: 'Because',
          parcel_changes: [{ parcel_id: waitingParcel, state: 'ARRIVED' }],
        }),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'intake_not_counted']);
    // Another hub's officer cannot.
    const otherSenior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
    expect(
      outcome(
        await correct(
          otherSenior,
          id,
          { reason: 'Because', parcel_changes: [{ parcel_id: target, state: 'ARRIVED' }] },
          { etag: version },
        ),
      ).slice(0, 2),
    ).toEqual([403, 'HUB_SCOPE_VIOLATION']);
  });

  // Break caught: an extra that cannot be taken out by a senior once the vendor is finished (the mistaken extra counted for ever), or a correction that does not move the count down: the senior puts the extra to VOID
  // and the count, the variance and the routing follow (AC-SLICE-001-101).
  it('takes a mistaken extra out after the vendor is finished: the count falls and the vendor is cleared when nothing else is amiss', async () => {
    const done = await handOver(routes, vendor, days, { collected: [2], photos: true });
    const id = done.intakes[0]?.id ?? '';
    const parcels = (await read(receiver, id)).intake.parcels ?? [];
    const photo = await storedIntakeEvidence(routes, receiver, id, 'OSD');
    const added = noted(
      await receiver.client.post(
        EXTRA(id),
        { photo_evidence_id: photo },
        { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
      ),
    );
    expect(added.status).toBe(200);
    const extraId = (added.json() as { parcel: Parcel }).parcel.id;
    for (const parcel of parcels) expect((await tap(receiver, parcel.id, true)).status).toBe(200);
    expect((await finish(receiver, id, { all_arrived: false })).status).toBe(200);
    expect((await read(receiver, id)).intake).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      received_count: 3,
      count_variance: 'OVER',
      extra_count: 1,
    });

    const fixed = await correct(senior, id, {
      reason: 'The extra was another vendor’s box',
      parcel_changes: [{ parcel_id: extraId, state: 'VOID' }],
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json()).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      received_count: 2,
      count_variance: 'MATCH',
      extra_count: 0,
    });
    expect((await eventRow('hub.intake.corrected', id))?.before_after).toMatchObject({
      physical_count: { before: 3, after: 2 },
      parcels: [{ parcel_id: extraId, from: 'ARRIVED', to: 'VOID' }],
    });
  });

  // Break caught: the blind count that has no way back (D-D8 is for every count): a blind-count intake counted short is corrected by a new number, the answer is its own shape (`HubIntakePostCount`), the count and the routing
  // follow, a parcel change is `mode_mismatch`, and the same number is no correction.
  it('corrects a blind count by a new number, in its own shape, and refuses a parcel change and the same number', async () => {
    const blind = await handOver(routes, vendor, days, { collected: [3] });
    const id = blind.intakes[0]?.id ?? '';
    expect((await countIntake(receiver, id, 2)).status).toBe(200);
    expect((await read(senior, id)).intake).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      physical_count: 2,
      count_variance: 'SHORT',
    });

    for (const body of [
      { reason: 'x', parcel_changes: [{ parcel_id: randomUUID(), state: 'ARRIVED' }] },
      { reason: 'x', physical_count: 2 },
      { reason: 'x', physical_count: -1 },
    ]) {
      const refused = await correct(senior, id, body);
      expect([refused.status, codeOf(refused)], JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    const done = await correct(senior, id, {
      reason: 'Recounted at the sorting table: three',
      physical_count: 3,
    });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({
      count_phase: 'POST_COUNT',
      state: 'READY_FOR_ITEMIZATION',
      physical_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
    });
    expect((await eventRow('hub.intake.corrected', id))?.before_after).toMatchObject({
      physical_count: { before: 2, after: 3 },
      count_variance: { before: 'SHORT', after: 'MATCH' },
    });
  });
});

describe('the lock of a check-in', () => {
  // Break caught: a lock view that says nothing about who opened the check-in and when (the screens would not warn a second officer), an `opened_at` that moves with every refresh of the holder's own lock (it would
  // say "opened a moment ago" for ever), or one that a takeover does not start again; and a queue that does not say who is checking a run in (AC-SLICE-001-43, D-D2): the first officer takes the lock, the second sees
  // it is not theirs, the holder's refresh moves `last_seen_at` and not `opened_at`, and a takeover of an abandoned lock opens a new one.
  it('says who opened it and when, keeps that moment through the holder’s refreshes, starts it again at a takeover, and is named on the run', async () => {
    const done = await handOver(routes, vendor, days, { collected: [2], photos: true });
    const id = done.intakes[0]?.id ?? '';
    const a = receiver;
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);

    expect((await read(a, id)).intake.lock).toBeNull();
    const taken = await take(a, id);
    expect(taken.status).toBe(200);
    const lock = (taken.json() as Intake).lock;
    expect(lock).toMatchObject({ holder_name: a.identity.fullName, held_by_you: true });
    expect(Date.parse(lock?.opened_at ?? '')).toBeLessThanOrEqual(
      Date.parse(lock?.last_seen_at ?? ''),
    );
    expect((await read(b, id)).intake.lock).toMatchObject({
      holder_name: a.identity.fullName,
      held_by_you: false,
      opened_at: lock?.opened_at,
    });

    // The holder's own refresh moves the moment it was last seen and never the moment it opened.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const refreshed = (await take(a, id)).json() as Intake;
    expect(refreshed.lock?.opened_at).toBe(lock?.opened_at);
    expect(Date.parse(refreshed.lock?.last_seen_at ?? '')).toBeGreaterThan(
      Date.parse(lock?.last_seen_at ?? ''),
    );
    // A second officer is not given a lock the first holds, and is told whose it is.
    const refused = (await take(b, id)).json() as Intake;
    expect(refused.lock).toMatchObject({
      holder_name: a.identity.fullName,
      held_by_you: false,
      opened_at: lock?.opened_at,
    });

    // The queue names who is checking the run in, and whether that is the reader.
    const manifest = (await read(a, id)).intake.pickup_manifest_id;
    const rowFor = async (actor: Actor) =>
      (
        (await actor.client.get(`${RUNS}?view=waiting`)).json() as {
          items: { run_id: string; checking_in: { name: string; is_you: boolean }[] }[];
        }
      ).items.find((row) => row.run_id === manifest);
    expect((await rowFor(a))?.checking_in).toEqual([{ name: a.identity.fullName, is_you: true }]);
    expect((await rowFor(b))?.checking_in).toEqual([{ name: a.identity.fullName, is_you: false }]);

    // The holder left: after the hub's idle time another officer takes it over, and the lock is theirs and opened now.
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `update pickup_intake set lock_acquired_at = now() - interval '40 minutes', lock_opened_at = now() - interval '60 minutes' where id = $1`,
        [id],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback');
      throw error;
    }
    const takenOver = (await take(b, id)).json() as Intake;
    expect(takenOver.lock).toMatchObject({ holder_name: b.identity.fullName, held_by_you: true });
    expect(Date.parse(takenOver.lock?.opened_at ?? '')).toBeGreaterThan(
      Date.parse(lock?.opened_at ?? ''),
    );
    // The acts take no lock and refuse none for it (the lock is advisory): the first officer still taps.
    const parcel = (await read(a, id)).intake.parcels?.[0]?.id ?? '';
    expect((await tap(a, parcel, true)).status).toBe(200);
    expect((await read(a, id)).intake.lock).toMatchObject({
      holder_name: b.identity.fullName,
      held_by_you: false,
    });
  });
});

describe('what the acts answer', () => {
  // Break caught: a name that is more than a display name reaching an answer of any act (a phone number, an address, a key): none of the answers this file was given names the telephone number the arranged stops carry,
  // and no property of any is a phone, an email, an address or a secret.
  it('names people and vendors by their display names alone: no phone number, address or key in any answer', () => {
    expect(seen.length).toBeGreaterThan(20);
    for (const text of seen) {
      expect(text).not.toContain(A_PHONE);
      expect(text).not.toMatch(
        /"(phone|phone_number|rider_phone|email|address|credential|secret|password)"/i,
      );
    }
  });
});
