import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { handOver } from './support/handed-over.js';
import { declareIntakeEvidence, intakeEvidenceBody, storedIntakeEvidence } from './support/intake-evidence.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.35b, the check-in of a vendor's parcels (`recordParcelArrival`, `finishCheckIn`, `addExtraParcel` and the condition of a parcel: `recordIntakeCondition`; `hub.intake.count`; `AC-SLICE-001-93` to `-97`;
 * features/hub/hub-intake.md sections 5.1 and 5.4 to 5.6; contracts/state-machines.md section 7; Run D, D-D2, D-D5 to D-D7), against the real application and a real PostgreSQL. Each claim:
 *
 * - **A tap is the officer's word for one parcel and moves nothing else**: it names the officer and the moment, is idempotent, can be taken back until the vendor is finished, writes no event, and **never moves
 *   the intake's `ETag`**, so the finish the officer is about to make is never stale for it (`AC-SLICE-001-93`).
 * - **"All N here" is confirmed, and N is the number the photos expect** (`count_changed` otherwise, and nothing changes); finishing as tapped marks what was not tapped missing and shows its picture; the count of
 *   an intake is the parcels that arrived and no number is typed; the System routes the intake by one rule (`AC-SLICE-001-93`, `-94`, `-97`).
 * - **A finish is made once, and a retry is not a second one**: the `Idempotency-Key` replays the stored answer byte for byte, the `ETag` is judged (missing, weak, another intake's and out of date are one
 *   `stale`), two officers finishing at once get one success and one `STATE_CONFLICT`, and one event says what was counted.
 * - **A parcel with no door photo is an extra** (`AC-SLICE-001-95`): added with a stored photo of the intake, counted with the arrived ones, taken back until the vendor is finished, and a pile with an extra is
 *   never "all here".
 * - **Damage is a finding of one parcel, once** (`AC-SLICE-001-96`): a parcel that has arrived, with stored evidence, the intake's condition the first one found, a blind-count intake having none to name.
 * - **Scope and keys**: another hub's parcel or intake is `HUB_SCOPE_VIOLATION`, one that does not exist `NOT_FOUND`, a session without `hub.intake.count` `PERMISSION_DENIED`; a Platform Admin's act in a hub it is
 *   not at is one audited crossing.
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const ARRIVAL = (parcel: string) => `${API}/intake-parcels/${parcel}/arrival`;
const FINISH = (id: string) => `${ONE(id)}/check-in`;
const EXTRA = (id: string) => `${ONE(id)}/extra-parcels`;
const CONDITION = (id: string) => `${ONE(id)}/condition`;
const RUNS = `${API}/receiving-runs`;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let receiver: Actor;
let otherHub: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 300_000);

// A session is allowed 120 requests a minute (and a refusal by the limiter is 429): each test is made by officers of its own, as the people of a hub are.
beforeEach(async () => {
  receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
});

afterAll(async () => {
  await routes.stop();
});

interface Condition {
  readonly condition: string;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by_name: string;
  readonly recorded_at: string;
}
interface Parcel {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: string;
  readonly state: string;
  readonly photo_evidence_id: string | null;
  readonly arrived_by_name: string | null;
  readonly arrived_at: string | null;
  readonly missing_marked_at: string | null;
  readonly condition: Condition | null;
}
interface CheckIn {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly count_phase: string;
  readonly receiving_mode: string;
  readonly parcels_expected: number;
  readonly rider_declared_count: number;
  readonly arrived_count: number;
  readonly received_count: number | null;
  readonly count_variance: string | null;
  readonly count_difference: number | null;
  readonly counted_at: string | null;
  readonly counted_by_name: string | null;
  readonly parcels: readonly Parcel[];
  readonly missing_count: number;
  readonly extra_count: number;
  readonly damaged_count: number;
  readonly condition: string;
  readonly condition_findings: readonly { readonly kind: string; readonly condition: string | null }[];
}
interface ParcelAnswer {
  readonly parcel: Parcel;
  readonly intake_etag: string;
  readonly counts: {
    readonly parcels_expected: number | null;
    readonly arrived_count: number | null;
    readonly received_count: number | null;
    readonly count_variance: string | null;
    readonly missing_count: number;
    readonly extra_count: number;
    readonly damaged_count: number;
  };
}

/** A photo intake of `count` parcels, handed over to the first hub through the real routes, read as the officer reads it. */
async function arrange(count = 2): Promise<{ id: string; code: string; parcels: readonly Parcel[]; etag: string }> {
  const done = await handOver(routes, vendor, days, { collected: [count], photos: true });
  const id = done.intakes[0]?.id ?? '';
  const read = await receiver.client.get(ONE(id));
  expect(read.status).toBe(200);
  const intake = read.json() as CheckIn;
  expect(intake.count_phase).toBe('CHECK_IN');
  return { id, code: intake.code, parcels: intake.parcels, etag: read.header('etag') ?? '' };
}

const read = async (actor: Actor, id: string): Promise<{ intake: CheckIn; etag: string }> => {
  const response = await actor.client.get(ONE(id));
  expect(response.status).toBe(200);
  return { intake: response.json() as CheckIn, etag: response.header('etag') ?? '' };
};

const tap = (actor: Actor, parcel: string, arrived: unknown): Promise<TestResponse> =>
  actor.client.request('PUT', ARRIVAL(parcel), { body: { arrived }, origin: OPS });

/** The officer finishes the vendor, on the `ETag` of the read unless the test says otherwise. */
async function finish(
  actor: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null; key?: string | null } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? (await read(actor, id)).etag : over.etag;
  return actor.client.post(FINISH(id), body, {
    origin: OPS,
    headers: {
      ...(etag === null ? {} : { 'If-Match': etag }),
      ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
    },
  });
}

const extra = (actor: Actor, id: string, body: unknown, key: string | null = randomUUID()): Promise<TestResponse> =>
  actor.client.post(EXTRA(id), body, {
    origin: OPS,
    headers: key === null ? {} : { 'Idempotency-Key': key },
  });

async function record(
  actor: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null; key?: string } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? (await read(actor, id)).etag : over.etag;
  return actor.client.post(CONDITION(id), body, {
    origin: OPS,
    headers: {
      ...(etag === null ? {} : { 'If-Match': etag }),
      'Idempotency-Key': over.key ?? randomUUID(),
    },
  });
}

const outcome = (response: TestResponse): [number, string | undefined, string | undefined] => [
  response.status,
  codeOf(response),
  (response.json() as { details?: { rule?: string } }).details?.rule,
];

/** The events the hub's acts wrote about an intake, by code, in the order they were written. */
const eventsOf = async (id: string): Promise<string[]> =>
  (
    await routes.rows<{ event_code: string }>(
      `select event_code from audit_event where object_id = $1 and event_code like 'hub.%' order by recorded_at, id`,
      [id],
    )
  ).map((row) => row.event_code);

const eventRow = async (code: string, id: string) =>
  (
    await routes.rows<{
      enhanced: boolean;
      note: string | null;
      previous_state: string | null;
      resulting_state: string | null;
      related_ids: Record<string, unknown> | null;
      detail: Record<string, unknown> | null;
    }>(
      `select enhanced, note, previous_state, resulting_state, related_ids, detail from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
      [code, id],
    )
  )[0];

const versionOf = async (id: string): Promise<number> =>
  (await routes.rows<{ version: number }>(`select version from pickup_intake where id = $1`, [id]))[0]?.version ?? -1;

describe('recordParcelArrival: a tap', () => {
  // Break caught: a tap that moves the intake's token (so the finish the officer read before it is stale), that is not idempotent, that cannot be taken back, that names nobody, or that leaves an event: the
  // officer taps a photo, taps it again, takes it back; each answer is the parcel as it now is, with the officer and the moment, and the counts are derived (AC-SLICE-001-93).
  it('is the officer’s word for one parcel: named, idempotent, taken back until the vendor is finished, and it never moves the intake’s ETag or writes an event', async () => {
    const { id, parcels, etag } = await arrange(3);
    const [first] = parcels;
    const target = first?.id ?? '';

    const tapped = await tap(receiver, target, true);
    expect(tapped.status).toBe(200);
    const answer = tapped.json() as ParcelAnswer;
    expect(answer.parcel).toMatchObject({
      id: target,
      state: 'ARRIVED',
      arrived_by_name: receiver.identity.fullName,
    });
    expect(answer.parcel.arrived_at).not.toBeNull();
    expect(answer.counts).toMatchObject({
      parcels_expected: 3,
      arrived_count: 1,
      received_count: null,
      count_variance: null,
      missing_count: 0,
      extra_count: 0,
      damaged_count: 0,
    });
    // The token of the vendor the officer holds is the one it still is.
    expect(answer.intake_etag).toBe(etag);

    const again = await tap(receiver, target, true);
    expect(again.status).toBe(200);
    expect((again.json() as ParcelAnswer).parcel.arrived_at).toBe(answer.parcel.arrived_at);

    const back = await tap(receiver, target, false);
    expect(back.status).toBe(200);
    const taken = back.json() as ParcelAnswer;
    expect(taken.parcel).toMatchObject({ id: target, state: 'EXPECTED', arrived_by_name: null, arrived_at: null });
    expect(taken.counts.arrived_count).toBe(0);

    expect((await read(receiver, id)).etag).toBe(etag);
    expect(await eventsOf(id)).toEqual([]);
  });

  // Break caught: a tap whose body is not judged, a parcel that is not looked up under the officer's hubs and key, or a refusal that tells a hub's parcels from absent ones: another hub's parcel is
  // HUB_SCOPE_VIOLATION, one that does not exist NOT_FOUND, an id that is not one and a body that is not `{ arrived: boolean }` VALIDATION_FAILED, and a session without the key PERMISSION_DENIED.
  it('is judged: its body, its parcel, its hub and its key', async () => {
    const { parcels } = await arrange(2);
    const target = parcels[0]?.id ?? '';

    for (const body of [{}, { arrived: 'yes' }, { arrived: 1 }, { arrived: true, extra: 1 }]) {
      const refused = await receiver.client.request('PUT', ARRIVAL(target), { body, origin: OPS });
      expect([refused.status, codeOf(refused)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(outcome(await tap(receiver, 'not-a-parcel', true)).slice(0, 2)).toEqual([400, 'VALIDATION_FAILED']);
    expect(outcome(await tap(receiver, randomUUID(), true)).slice(0, 2)).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await tap(otherHub, target, true)).slice(0, 2)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const readOnly = await routes.actor(await newBundle(routes.admin, [grant('hub.read', 'own')]), HUB_A);
    expect(outcome(await tap(readOnly, target, true)).slice(0, 2)).toEqual([403, 'PERMISSION_DENIED']);
    // Nothing of the above moved the parcel.
    const { intake } = await read(receiver, await intakeOfParcel(target));
    expect(intake.parcels.find((parcel) => parcel.id === target)?.state).toBe('EXPECTED');
  });

  // Break caught: a Platform Admin's act in a hub it is not at that leaves no trace (audit.md section 5.4): one audited crossing naming the hub for each act, a tap and a finish alike.
  it('is one audited crossing for each act a Platform Admin makes in a hub that is not its own', async () => {
    const { id, parcels, etag } = await arrange(2);
    const admin = await routes.platformAdmin();
    expect(await crossingsOf(id)).toEqual([]);

    expect((await tap(admin, parcels[0]?.id ?? '', true)).status).toBe(200);
    expect(await crossingsOf(id)).toEqual([HUB_A]);
    expect((await finish(admin, id, { all_arrived: false }, { etag })).status).toBe(200);
    expect(await crossingsOf(id)).toEqual([HUB_A, HUB_A]);
  });
});

describe('finishCheckIn: "All N here" and as tapped', () => {
  // Break caught: "All N here" that does not settle the vendor in one change (the parcels not all arrived, the count not the number of parcels, the variance or the routing wrong), that mis-names who counted, that
  // leaves no event, or a retry that is a second finish: the officer confirms 3 of 3 and the vendor is counted, matched and cleared for itemization (AC-SLICE-001-93); the same key replays the answer byte for byte.
  it('settles the vendor in one change, routes it by the rule of the System, writes one event and replays a retry', async () => {
    const { id, parcels, etag } = await arrange(3);
    const key = randomUUID();

    const done = await finish(receiver, id, { all_arrived: true, confirmed_count: 3 }, { etag, key });
    expect(done.status).toBe(200);
    const intake = done.json() as CheckIn;
    expect(intake).toMatchObject({
      id,
      count_phase: 'CHECK_IN',
      receiving_mode: 'PHOTO_CHECK_IN',
      state: 'READY_FOR_ITEMIZATION',
      parcels_expected: 3,
      rider_declared_count: 3,
      arrived_count: 3,
      received_count: 3,
      count_variance: 'MATCH',
      count_difference: 0,
      counted_by_name: receiver.identity.fullName,
      missing_count: 0,
      extra_count: 0,
      damaged_count: 0,
      condition: 'OK',
    });
    expect(intake.counted_at).not.toBeNull();
    expect(intake.parcels.map((parcel) => [parcel.id, parcel.state, parcel.arrived_by_name])).toEqual(
      parcels.map((parcel) => [parcel.id, 'ARRIVED', receiver.identity.fullName]),
    );
    // The token moved with the version, and is the one a read gives now.
    expect(done.header('etag')).not.toBe(etag);
    expect(done.header('etag')).toBe((await read(receiver, id)).etag);
    expect(await eventsOf(id)).toEqual(['hub.intake.counted']);
    expect((await eventRow('hub.intake.counted', id))?.detail).toMatchObject({
      receiving_mode: 'PHOTO_CHECK_IN',
      all_arrived: true,
      expected_count: 3,
      received_count: 3,
      missing_count: 0,
      extra_count: 0,
      rider_declared_count: 3,
      count_variance: 'MATCH',
    });

    const replay = await finish(receiver, id, { all_arrived: true, confirmed_count: 3 }, { etag, key });
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(done.text);
    expect(await eventsOf(id)).toEqual(['hub.intake.counted']);
    const changed = await finish(receiver, id, { all_arrived: false }, { etag, key });
    expect(outcome(changed).slice(0, 2)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: a "confirmation" that does not have to be the number of the photos (the officer's count of the table, typed, accepted whatever it is), or a refusal that changes something first: a wrong N is
  // STATE_CONFLICT (`count_changed`) and nothing is changed; the body is judged (the number is given for "all here" and for no other).
  it('is refused when N is not the number the photos expect, and nothing changes; the body is judged', async () => {
    const { id, parcels } = await arrange(3);
    const version = await versionOf(id);

    expect(outcome(await finish(receiver, id, { all_arrived: true, confirmed_count: 2 }))).toEqual([
      409,
      'STATE_CONFLICT',
      'count_changed',
    ]);
    expect(outcome(await finish(receiver, id, { all_arrived: true, confirmed_count: 4 }))).toEqual([
      409,
      'STATE_CONFLICT',
      'count_changed',
    ]);
    for (const body of [
      { all_arrived: true },
      { all_arrived: true, confirmed_count: 0 },
      { all_arrived: true, confirmed_count: 1.5 },
      { all_arrived: false, confirmed_count: 3 },
      { confirmed_count: 3 },
      { all_arrived: 'yes' },
      {},
    ]) {
      const refused = await finish(receiver, id, body);
      expect([refused.status, codeOf(refused)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    const { intake } = await read(receiver, id);
    expect([intake.state, intake.arrived_count, intake.received_count]).toEqual(['AWAITING_COUNT', 0, null]);
    expect(intake.parcels.map((parcel) => parcel.state)).toEqual(parcels.map(() => 'EXPECTED'));
    expect(await versionOf(id)).toBe(version);
    expect(await eventsOf(id)).toEqual([]);
  });

  // Break caught: a finish that is stale after a tap (the token moved by a tap), one that accepts a token that is missing, weak, another intake's or old, or a vendor finished as tapped that does not mark what was not
  // tapped missing with its picture and the count short (AC-SLICE-001-94): the token the officer read before two taps still finishes the vendor, and the three bad tokens are one `stale`.
  it('takes the token the officer read before the taps, refuses a token that is not the intake’s current one, and marks what was not tapped missing', async () => {
    const { id, parcels, etag } = await arrange(3);
    const other = await arrange(2);
    const [first, second, third] = parcels;
    expect((await tap(receiver, first?.id ?? '', true)).status).toBe(200);
    expect((await tap(receiver, second?.id ?? '', true)).status).toBe(200);

    // A token that is missing is a request that is not well formed; one that is weak, another intake's or not a token at all is a token the intake is not at.
    const none = await finish(receiver, id, { all_arrived: false }, { etag: null });
    expect([none.status, codeOf(none)]).toEqual([400, 'VALIDATION_FAILED']);
    for (const bad of [`W/${etag}`, other.etag, '"not-a-token"']) {
      expect(outcome(await finish(receiver, id, { all_arrived: false }, { etag: bad })), String(bad)).toEqual([
        409,
        'STATE_CONFLICT',
        'stale',
      ]);
    }
    const done = await finish(receiver, id, { all_arrived: false }, { etag });
    expect(done.status).toBe(200);
    const intake = done.json() as CheckIn;
    expect(intake).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      parcels_expected: 3,
      arrived_count: 2,
      received_count: 2,
      count_variance: 'SHORT',
      count_difference: -1,
      missing_count: 1,
      extra_count: 0,
    });
    const missing = intake.parcels.find((parcel) => parcel.id === third?.id);
    expect(missing).toMatchObject({ state: 'MISSING', photo_evidence_id: third?.photo_evidence_id });
    expect(missing?.missing_marked_at).not.toBeNull();
    expect(await eventsOf(id)).toEqual(['hub.intake.counted', 'hub.osd.opened']);
    expect((await eventRow('hub.osd.opened', id))?.resulting_state).toBe('RECONCILIATION_REQUIRED');
  });

  // Break caught: a vendor finished twice (a second finish moves a settled count), a blind-count intake "checked in", or a finish that an officer without the key, of another hub, or for a vendor that does not
  // exist makes: each refused with the code and the rule the contract names.
  it('is made once, is for a photo intake alone, and is judged by hub and key', async () => {
    const { id } = await arrange(2);
    expect((await finish(receiver, id, { all_arrived: true, confirmed_count: 2 })).status).toBe(200);
    expect(outcome(await finish(receiver, id, { all_arrived: true, confirmed_count: 2 }))).toEqual([
      409,
      'STATE_CONFLICT',
      'check_in_finished',
    ]);

    const blind = await handOver(routes, vendor, days, { collected: [3] });
    const blindId = blind.intakes[0]?.id ?? '';
    expect(outcome(await finish(receiver, blindId, { all_arrived: false }))).toEqual([
      409,
      'STATE_CONFLICT',
      'blind_count_intake',
    ]);

    const fresh = await arrange(2);
    expect(outcome(await finish(otherHub, fresh.id, { all_arrived: false }, { etag: fresh.etag })).slice(0, 2)).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await finish(receiver, randomUUID(), { all_arrived: false }, { etag: fresh.etag })).slice(0, 2)).toEqual([
      404,
      'NOT_FOUND',
    ]);
    const readOnly = await routes.actor(await newBundle(routes.admin, [grant('hub.read', 'own')]), HUB_A);
    expect(outcome(await finish(readOnly, fresh.id, { all_arrived: false }, { etag: fresh.etag })).slice(0, 2)).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
  });

  // Break caught: two officers finishing the same vendor at once both succeeding (a count made twice, two events), or neither: with the token both read, one is answered 200 and the other STATE_CONFLICT, whoever
  // is first, and one event is written.
  it('is one success and one STATE_CONFLICT when two officers finish at once', async () => {
    const { id, etag } = await arrange(2);
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);

    const answers = await Promise.all([
      finish(receiver, id, { all_arrived: true, confirmed_count: 2 }, { etag }),
      finish(second, id, { all_arrived: true, confirmed_count: 2 }, { etag }),
    ]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 409]);
    expect((await eventsOf(id)).filter((code) => code === 'hub.intake.counted')).toHaveLength(1);
  });

  // Break caught: the summary of a finished run that cannot be read from the reads (what is left to act on after "finish": arrived, missing with its pictures, extras, damaged): the run's page and the queue say
  // the same as the finished vendors, and a run with no vendor waiting leaves the queue of the waiting (AC-SLICE-001-97).
  it('leaves the run’s page and the queue saying what was counted: arrived, missing and what is left to decide', async () => {
    const { id } = await arrange(2);
    const [first] = (await read(receiver, id)).intake.parcels;
    expect((await tap(receiver, first?.id ?? '', true)).status).toBe(200);
    expect((await finish(receiver, id, { all_arrived: false })).status).toBe(200);

    const manifest = (await routes.rows<{ pickup_manifest_id: string }>(`select pickup_manifest_id from pickup_intake where id = $1`, [id]))[0]
      ?.pickup_manifest_id;
    const page = (await receiver.client.get(`${RUNS}/${manifest}`)).json() as {
      vendors: { intake_id: string; state: string; arrived_count: number; missing_count: number; extra_count: number; damaged_count: number; received_count: number }[];
    };
    expect(page.vendors.map((vendorSection) => [vendorSection.intake_id, vendorSection.state, vendorSection.arrived_count, vendorSection.missing_count])).toEqual([
      [id, 'RECONCILIATION_REQUIRED', 1, 1],
    ]);
    const rows = (await receiver.client.get(`${RUNS}?view=needs_decision`)).json() as {
      items: { run_id: string; vendors_waiting: number; vendors_needing_decision: number; missing_searching: number }[];
    };
    expect(rows.items.find((row) => row.run_id === manifest)).toMatchObject({
      vendors_waiting: 0,
      vendors_needing_decision: 1,
      missing_searching: 1,
    });
    const waiting = (await receiver.client.get(`${RUNS}?view=waiting`)).json() as { items: { run_id: string }[] };
    expect(waiting.items.some((row) => row.run_id === manifest)).toBe(false);
  });
});

describe('addExtraParcel: a parcel with no door photo', () => {
  // Break caught: an extra that is not a parcel of the intake (no place after the door parcels, no photo of its own, not counted with the arrived ones), one that moves the intake's token before the finish, a retry
  // that adds a second parcel, or a pile with an extra taken as "all here" (AC-SLICE-001-95): the extra is added with a stored photo, shown last, counted in the live numbers, the retry is the first answer, and the
  // vendor is then finished as tapped: the count is over the photos and the System sends it to Senior Ops.
  it('is added with a stored photo, counted with the arrived, replayed by its key, and makes "all here" impossible', async () => {
    const { id, parcels, etag } = await arrange(2);
    const photo = await storedIntakeEvidence(routes, receiver, id, 'OSD');
    const key = randomUUID();

    const added = await extra(receiver, id, { photo_evidence_id: photo, note: 'A box with no photo at the door' }, key);
    expect(added.status).toBe(200);
    const answer = added.json() as ParcelAnswer;
    expect(answer.parcel).toMatchObject({
      origin: 'HUB_EXTRA',
      state: 'ARRIVED',
      photo_evidence_id: photo,
      arrived_by_name: receiver.identity.fullName,
    });
    expect(answer.parcel.ordinal).toBe(3);
    expect(answer.counts).toMatchObject({ parcels_expected: 2, arrived_count: 1, extra_count: 1 });
    expect(answer.intake_etag).toBe(etag);

    const replay = await extra(receiver, id, { photo_evidence_id: photo, note: 'A box with no photo at the door' }, key);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(added.text);
    expect((await read(receiver, id)).intake.parcels).toHaveLength(3);
    expect((await eventsOf(id)).filter((code) => code === 'hub.parcel.extra_added')).toHaveLength(1);
    expect((await eventRow('hub.parcel.extra_added', id))?.note).toBe('A box with no photo at the door');

    expect(outcome(await finish(receiver, id, { all_arrived: true, confirmed_count: 2 }))).toEqual([
      409,
      'STATE_CONFLICT',
      'has_extra_parcels',
    ]);
    for (const parcel of parcels) expect((await tap(receiver, parcel.id, true)).status).toBe(200);
    const done = await finish(receiver, id, { all_arrived: false });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      parcels_expected: 2,
      received_count: 3,
      count_variance: 'OVER',
      count_difference: 1,
      extra_count: 1,
      missing_count: 0,
    });
  });

  // Break caught: an extra's photo that is not the intake's own or is not stored (a record the officer only declared, or another intake's), the same photo used for two parcels, or a body that is not judged: each
  // refused as the contract says; and an extra taken back before the finish (an untap) is VOID and leaves the count.
  it('refuses a photo that is not stored, is another intake’s or is used twice, is judged, and is taken back by an untap', async () => {
    const { id } = await arrange(2);
    const other = await arrange(2);
    const own = await storedIntakeEvidence(routes, receiver, id, 'OSD');
    const foreign = await storedIntakeEvidence(routes, receiver, other.id, 'OSD');

    for (const photo of [randomUUID(), foreign]) {
      expect(outcome(await extra(receiver, id, { photo_evidence_id: photo })).slice(0, 2), photo).toEqual([
        422,
        'EVIDENCE_NOT_STORED',
      ]);
    }
    for (const body of [{}, { photo_evidence_id: 'nope' }, { photo_evidence_id: own, note: 7 }, { photo_evidence_id: own, parcel_id: randomUUID() }]) {
      const refused = await extra(receiver, id, body);
      expect([refused.status, codeOf(refused)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    const added = await extra(receiver, id, { photo_evidence_id: own });
    expect(added.status).toBe(200);
    // The one photo is one parcel's.
    expect(outcome(await extra(receiver, id, { photo_evidence_id: own })).slice(0, 2)).toEqual([422, 'EVIDENCE_NOT_STORED']);

    const parcel = (added.json() as ParcelAnswer).parcel;
    const taken = await tap(receiver, parcel.id, false);
    expect(taken.status).toBe(200);
    expect(taken.json()).toMatchObject({ parcel: { id: parcel.id, state: 'VOID' }, counts: { extra_count: 0 } });
    expect(outcome(await extra(otherHub, id, { photo_evidence_id: own })).slice(0, 2)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
  });

  // Break caught: an extra added to a vendor whose case is resolved (a settled count moved by an extra), or added to a blind-count intake, or one added after the vendor was finished that is not counted at once: while
  // the case is open the extra is counted and the case stays open with a new token; on a clean finished vendor and on a blind-count intake it is refused with the rule.
  it('is counted at once while the case is open, and is refused on a settled vendor and on a blind-count intake', async () => {
    const { id } = await arrange(2);
    const [first] = (await read(receiver, id)).intake.parcels;
    expect((await tap(receiver, first?.id ?? '', true)).status).toBe(200);
    expect((await finish(receiver, id, { all_arrived: false })).status).toBe(200);
    const before = await read(receiver, id);
    expect(before.intake).toMatchObject({ state: 'RECONCILIATION_REQUIRED', received_count: 1, count_variance: 'SHORT' });

    const photo = await storedIntakeEvidence(routes, receiver, id, 'OSD');
    const added = await extra(receiver, id, { photo_evidence_id: photo });
    expect(added.status).toBe(200);
    expect((added.json() as ParcelAnswer).intake_etag).not.toBe(before.etag);
    const after = await read(receiver, id);
    expect(after.intake).toMatchObject({ state: 'RECONCILIATION_REQUIRED', received_count: 2, count_variance: 'MATCH', extra_count: 1, missing_count: 1 });
    expect((await eventRow('hub.parcel.extra_added', id))?.detail).toMatchObject({ extra_counted: true, received_count: 2, extra_count: 1 });

    // A vendor settled clean: the photo declared while it was open takes no parcel (check_in_finished), and no photo is declared for it any more.
    const clean = await arrange(2);
    const late = await storedIntakeEvidence(routes, receiver, clean.id, 'OSD');
    expect((await finish(receiver, clean.id, { all_arrived: true, confirmed_count: 2 })).status).toBe(200);
    expect(outcome(await extra(receiver, clean.id, { photo_evidence_id: late }))).toEqual([409, 'STATE_CONFLICT', 'check_in_finished']);
    expect(outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody(clean.id, 'OSD')))).toEqual([409, 'STATE_CONFLICT', 'check_in_finished']);

    // A blind-count intake has no parcels: the receiver has no act to declare the photo of one, and an extra for it is refused before any photo is judged.
    const blind = await handOver(routes, vendor, days, { collected: [3] });
    const blindId = blind.intakes[0]?.id ?? '';
    expect(outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody(blindId, 'OSD'))).slice(0, 2)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await extra(receiver, blindId, { photo_evidence_id: randomUUID() }))).toEqual([409, 'STATE_CONFLICT', 'blind_count_intake']);
  });
});

describe('recordIntakeCondition: damage is a finding of one parcel', () => {
  // Break caught: a condition of a photo intake that is the intake's and not a parcel's, one recorded on a parcel that has not arrived, a second one on the same parcel, a damage without its evidence, or a parcel that is
  // not the intake's: the officer records DAMAGED on a parcel that has arrived with its stored photo (once for each parcel), the answer is the intake with the finding on its parcel and the intake's condition the
  // first one found; the refusals each name their rule (AC-SLICE-001-96).
  it('is recorded once for a parcel that has arrived, with evidence, and each refusal names its rule', async () => {
    const { id, parcels } = await arrange(2);
    const [first, second] = parcels;
    const evidence = await storedIntakeEvidence(routes, receiver, id, 'CONDITION');

    // The condition of the whole intake is damage's own parcel's: refused, naming the field.
    const whole = await record(receiver, id, { condition: 'DAMAGED', evidence_ids: [evidence] });
    expect([whole.status, codeOf(whole)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(JSON.stringify((whole.json() as { details?: unknown }).details)).toContain('parcel_required');
    // A parcel that has not arrived has no condition to find.
    expect(outcome(await record(receiver, id, { condition: 'DAMAGED', evidence_ids: [evidence], parcel_id: first?.id }))).toEqual([
      409,
      'STATE_CONFLICT',
      'parcel_not_arrived',
    ]);
    expect((await tap(receiver, first?.id ?? '', true)).status).toBe(200);
    expect((await tap(receiver, second?.id ?? '', true)).status).toBe(200);
    // Damage without evidence is a reason's absence; a parcel of another intake is not this intake's parcel.
    expect(outcome(await record(receiver, id, { condition: 'DAMAGED', parcel_id: first?.id })).slice(0, 2)).toEqual([422, 'REASON_REQUIRED']);
    const stranger = await arrange(2);
    expect(
      outcome(await record(receiver, id, { condition: 'DAMAGED', evidence_ids: [evidence], parcel_id: stranger.parcels[0]?.id })).slice(0, 2),
    ).toEqual([400, 'VALIDATION_FAILED']);

    const version = await versionOf(id);
    const done = await record(receiver, id, { condition: 'DAMAGED', evidence_ids: [evidence], note: 'Crushed corner', parcel_id: first?.id });
    expect(done.status).toBe(200);
    const intake = done.json() as CheckIn;
    expect(intake).toMatchObject({ count_phase: 'CHECK_IN', state: 'AWAITING_COUNT', condition: 'DAMAGED', damaged_count: 1 });
    expect(intake.parcels.find((parcel) => parcel.id === first?.id)?.condition).toMatchObject({
      condition: 'DAMAGED',
      note: 'Crushed corner',
      evidence_ids: [evidence],
      recorded_by_name: receiver.identity.fullName,
    });
    expect(intake.parcels.find((parcel) => parcel.id === second?.id)?.condition).toBeNull();
    expect(await versionOf(id)).toBeGreaterThan(version);
    expect((await eventRow('hub.intake.condition_recorded', id))?.related_ids).toMatchObject({ parcel_id: first?.id });

    // Once for each parcel: the same parcel again, whatever it says, is the receiver's no second turn.
    expect(outcome(await record(receiver, id, { condition: 'OK', parcel_id: first?.id }))).toEqual([409, 'STATE_CONFLICT', 'condition_already_recorded']);
    // The second parcel's finding does not overwrite the intake's condition (the first one found stands) and is counted.
    const evidenceTwo = await storedIntakeEvidence(routes, receiver, id, 'CONDITION');
    const twice = await record(receiver, id, { condition: 'TAMPERED', evidence_ids: [evidenceTwo], parcel_id: second?.id });
    expect(twice.status).toBe(200);
    expect(twice.json()).toMatchObject({ condition: 'DAMAGED', damaged_count: 2 });
  });

  // Break caught: a damage that does not follow the System's rule (an intake with a condition cleared for itemization by "all here"), or a condition recorded for a blind-count intake with a parcel (it has none): the
  // vendor finished with all arrived and matching but one parcel damaged goes to Senior Ops, and a blind-count intake refuses a parcel to name.
  it('sends a vendor with a damaged parcel to Senior Ops even when all arrived, and is not for a parcel of a blind-count intake', async () => {
    const { id, parcels } = await arrange(2);
    const evidence = await storedIntakeEvidence(routes, receiver, id, 'CONDITION');
    for (const parcel of parcels) expect((await tap(receiver, parcel.id, true)).status).toBe(200);
    expect((await record(receiver, id, { condition: 'DAMAGED', evidence_ids: [evidence], parcel_id: parcels[0]?.id })).status).toBe(200);

    const done = await finish(receiver, id, { all_arrived: true, confirmed_count: 2 });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({ state: 'RECONCILIATION_REQUIRED', count_variance: 'MATCH', missing_count: 0, damaged_count: 1, condition: 'DAMAGED' });
    expect(await eventsOf(id)).toEqual(['hub.intake.condition_recorded', 'hub.intake.counted', 'hub.osd.opened']);

    const blind = await handOver(routes, vendor, days, { collected: [3] });
    const blindId = blind.intakes[0]?.id ?? '';
    const refused = await record(receiver, blindId, { condition: 'OK', parcel_id: parcels[0]?.id });
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

/** The identifier of the intake a parcel belongs to. */
async function intakeOfParcel(parcel: string): Promise<string> {
  return (await routes.rows<{ pickup_intake_id: string }>(`select pickup_intake_id from intake_parcel where id = $1`, [parcel]))[0]?.pickup_intake_id ?? '';
}

/** The hubs of the audited crossings written about an intake, in the order they were written: one `auth.hub_boundary.crossed` for each act or read of a hub other than the actor's own. */
async function crossingsOf(intake: string): Promise<string[]> {
  const rows = await routes.rows<{ hub: string }>(
    `select responsible_hub_id as hub from audit_event where event_code = 'auth.hub_boundary.crossed' and object_id = $1 order by recorded_at, id`,
    [intake],
  );
  return rows.map((row) => row.hub);
}
