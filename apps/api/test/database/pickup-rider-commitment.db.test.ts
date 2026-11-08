import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.21, the current rider commitment of a pickup request (OB-S1-35; the Product Owner's decision of 2 November 2026): the cancellation
 * policy follows the request's **current unreleased claim** and **that claim's manifest assignment**, and a rider who was once assigned
 * establishes nothing. `pickup_request.rider_assigned` is that commitment, not a history: `assignRider` raises it, the cancellation of a
 * manifest lowers it in the transaction that releases the claims, and a request cancelled meanwhile keeps what its cancellation was decided
 * on (a cancelled request is frozen, with its charge decision).
 *
 * - **The relation is the oracle.** After every act the mark of a `CONFIRMED` request equals whether a stop with no `released_at` holds it
 *   on a manifest that has a rider, read as the administrator (a read through row-level security could hide the very claim in question).
 * - **Serial order, not a race.** The three acts that meet on a request (the assignment of a rider, the cancellation of the manifest, the
 *   cancellation of the request) take the locks in one order (the manifest, then the requests it holds in the order of their ids, then the
 *   stops: the order in which the cancellation of a request takes the request and then its stop), so any interleaving ends in a state one
 *   serial order could have made, and none deadlocks.
 * - **A refusal or a failure leaves nothing.** No mark, claim, stop, event or charge is half-written.
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const ASSIGN = (id: string) => `${ONE(id)}/assign-rider`;
const DISPATCH = (id: string) => `${ONE(id)}/dispatch`;
const CANCEL = (id: string) => `${ONE(id)}/cancel`;
const REQUESTS = `${API}/pickup-requests`;
const CANCEL_REQUEST = (id: string) => `${REQUESTS}/${id}/cancel`;
const CUSTOMER = 'FIXTURE_COMMIT_CUSTOMER';
const MELARC = 'FIXTURE_COMMIT_MELARC';
const CONCURRENT_ROUNDS = 12;
/** The seed of the first round of the race: a round that fails is repeated by its seed (S1.51 records them). */
const RACE_SEED = 20261102;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
/** One Ops user for each kind of act: the rate limit counts the requests of a principal, and these tests make many. */
let maker: Actor;
let assigner: Actor;
let manifestCanceller: Actor;
let requestCanceller: Actor;
let dispatcher: Actor;
let racingAssigner: Actor;
let racingManifestCanceller: Actor;
let racingRequestCanceller: Actor;
let modelAssigner: Actor;
let modelManifestCanceller: Actor;
let modelRequestCanceller: Actor;
/** Senior Ops may elect a charge. */
let senior: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  maker = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  assigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  manifestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  requestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  dispatcher = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  racingAssigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  racingManifestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  racingRequestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  modelAssigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  modelManifestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  modelRequestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  for (const [code, attribution] of [
    [CUSTOMER, 'CUSTOMER'],
    [MELARC, 'MELARC'],
  ] as const) {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active)
       values ($1, 'PICKUP_CANCELLATION', $2, $3, false, true)`,
      [code, `Fixture ${attribution.toLowerCase()} cancellation`, attribution],
    );
  }
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Stop {
  readonly id: string;
  readonly pickup_request_id: string;
  readonly state: string;
}
interface Manifest {
  readonly id: string;
  readonly state: string;
  readonly assigned_rider_id: string | null;
  readonly stops: Stop[];
}
interface RequestBody {
  readonly state: string;
  readonly rider_assigned: boolean;
  readonly cancellation_charge_outcome?: string | null;
}
const manifestOf = (response: TestResponse): Manifest => response.json() as Manifest;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const confirmed = async (): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.day,
      }),
    )
  ).id;

const rider = async () => insertRider(routes.admin, riderRow({ hubId: HUB_A }));

/** A draft manifest of confirmed requests, made through the route. */
async function draftOf(
  count = 3,
): Promise<{ manifest: Manifest; etag: string; requests: string[] }> {
  const requests: string[] = [];
  for (let each = 0; each < count; each += 1) requests.push(await confirmed());
  const made = await maker.client.post(
    LIST,
    { pickup_request_ids: requests, service_date: days.day },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(made.status).toBe(201);
  return { manifest: manifestOf(made), etag: made.header('etag') ?? '', requests };
}

const readManifest = (actor: Actor, id: string): Promise<TestResponse> => actor.client.get(ONE(id));

const assignOf = (
  actor: Actor,
  id: string,
  riderId: string,
  etag: string | undefined,
): Promise<TestResponse> =>
  actor.client.post(
    ASSIGN(id),
    { rider_id: riderId },
    { origin: OPS, headers: etag === undefined ? {} : { 'If-Match': etag } },
  );

const dispatchOf = (actor: Actor, id: string, etag: string): Promise<TestResponse> =>
  actor.client.post(DISPATCH(id), undefined, { origin: OPS, headers: { 'If-Match': etag } });

const cancelManifestOf = (
  actor: Actor,
  id: string,
  etag: string | undefined,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  actor.client.post(
    CANCEL(id),
    { note: 'Replanned' },
    {
      origin: OPS,
      headers: { ...(etag === undefined ? {} : { 'If-Match': etag }), 'Idempotency-Key': key },
    },
  );

/** The request as the office reads it: its mark and its ETag, which moves with the mark. */
async function readRequest(actor: Actor, id: string): Promise<{ body: RequestBody; etag: string }> {
  const answer = await actor.client.get(`${REQUESTS}/${id}`);
  expect(answer.status).toBe(200);
  return { body: answer.json() as RequestBody, etag: answer.header('etag') ?? '' };
}

const cancelRequestOf = (
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
  etag: string,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  actor.client.post(
    CANCEL_REQUEST(id),
    { reason_code: CUSTOMER, ...body },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': key } },
  );

/** What a cancellation of a request carries once the read said a rider holds it: the decision not to charge, and why. */
const DECIDED = { apply_charge: false, charge_reason_code: CUSTOMER } as const;

/** A small seeded generator, so that a round of the race that fails is repeated from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface RequestRow {
  readonly id: string;
  readonly state: string;
  readonly rider_assigned: boolean;
  readonly version: number;
  readonly cancellation_charge_outcome: string | null;
  readonly cancellation_charge_snapshot: unknown;
  readonly cancellation_reason_code: string | null;
  readonly cancelled_by_actor_type: string | null;
}
const requestRowOf = async (id: string): Promise<RequestRow> => {
  const [row] = await routes.rows<RequestRow>(
    `select id, state, rider_assigned, version, cancellation_charge_outcome, cancellation_charge_snapshot,
            cancellation_reason_code, cancelled_by_actor_type
       from pickup_request where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('the request is missing');
  return row;
};

/** The whole row of a request, every column: what must not change when an act that has nothing to do with it runs. */
const wholeRequest = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('the request is missing');
  return row;
};

const stopRowsOf = (manifestId: string) =>
  routes.rows<{
    id: string;
    pickup_request_id: string;
    state: string;
    released_at: Date | null;
    skip_reason: string | null;
  }>(
    `select id, pickup_request_id, state, released_at, skip_snapshot ->> 'reason_code' as skip_reason
       from pickup_stop where pickup_manifest_id = $1 order by sequence, id`,
    [manifestId],
  );

const manifestRowOf = async (id: string) =>
  (
    await routes.rows<{ state: string; version: number; assigned_rider_id: string | null }>(
      `select state, version, assigned_rider_id from pickup_manifest where id = $1`,
      [id],
    )
  )[0];

const eventsOf = (code: string, objectId: string) =>
  routes.rows<{ detail: Record<string, unknown>; related_ids: Record<string, unknown> | null }>(
    `select detail, related_ids from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

/**
 * The oracle: for each request that is still `CONFIRMED`, the mark equals whether a stop with no `released_at` holds it on a manifest that has a
 * rider, read as the administrator. A request that is `CANCELLED` is frozen and says what its cancellation was decided on, so it is not judged.
 */
async function expectMarkToBeTheClaim(ids: readonly string[]): Promise<void> {
  const rows = await routes.rows<{ id: string; rider_assigned: boolean; committed: boolean }>(
    `select r.id, r.rider_assigned,
            exists (select 1 from pickup_stop s join pickup_manifest m on m.id = s.pickup_manifest_id
                     where s.pickup_request_id = r.id and s.released_at is null and m.assigned_rider_id is not null) as committed
       from pickup_request r where r.id = any($1::uuid[]) and r.state = 'CONFIRMED' order by r.id`,
    [ids],
  );
  for (const row of rows) {
    expect(row.rider_assigned, `request ${row.id}: the mark and the claim`).toBe(row.committed);
  }
  // The assumption the guard of the mark stands on (migration 0064; OB-S1-33): it reads the stops through row-level security, which is complete
  // while a request and every stop that holds or held it are in one hub. It holds in every state these tests reach, whichever way they got there.
  const strays = await routes.rows<{ stop: string }>(
    `select s.id as stop from pickup_stop s join pickup_request r on r.id = s.pickup_request_id
      where r.id = any($1::uuid[]) and s.responsible_hub_id <> r.responsible_hub_id`,
    [ids],
  );
  expect(strays, 'a stop in another hub than its request').toEqual([]);
}

describe('the commitment follows the claim: assignment, then the cancellation of the request', () => {
  // Break caught: an assignment that does not make the office decide the charge, or a decision that is not recorded as one (AC-12).
  it('sees the rider: the read says so, the cancellation must decide, and the decision is recorded', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const [held] = requests as [string, string];
    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);

    const seen = await readRequest(requestCanceller, held);
    expect(seen.body.rider_assigned).toBe(true);
    await expectMarkToBeTheClaim(requests);

    const undecided = await cancelRequestOf(requestCanceller, held, {}, seen.etag);
    expect(outcome(undecided)).toEqual([422, 'REASON_REQUIRED']);
    expect(await requestRowOf(held)).toMatchObject({
      state: 'CONFIRMED',
      rider_assigned: true,
      cancellation_charge_outcome: null,
    });

    const decided = await cancelRequestOf(requestCanceller, held, DECIDED, seen.etag);
    expect(decided.status).toBe(200);
    expect(await requestRowOf(held)).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'NOT_APPLIED',
      cancelled_by_actor_type: 'OPS',
    });
    expect(await eventsOf('pickup.request.cancelled_chargeable', held)).toHaveLength(1);
    expect(await eventsOf('pickup.request.cancelled', held)).toHaveLength(0);
  });
});

describe('the commitment follows the claim: the cancellation of the manifest, then the cancellation of the request', () => {
  // Break caught: a request returned to the pool that stays marked, so that its cancellation is still a chargeable decision "solely because a
  // rider was once assigned" (the Product Owner's decision of 2 November 2026).
  it('sees no rider: the read says so, the pool holds it, and its cancellation records no charge decision', async () => {
    const { manifest, etag, requests } = await draftOf(3);
    const [released, other] = requests as [string, string, string];
    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);
    const before = await readRequest(requestCanceller, released);
    expect(before.body.rider_assigned).toBe(true);
    const rowBefore = await requestRowOf(released);

    const seen = await readManifest(manifestCanceller, manifest.id);
    const cancelled = await cancelManifestOf(
      manifestCanceller,
      manifest.id,
      seen.header('etag') ?? '',
    );
    expect(cancelled.status).toBe(200);

    const after = await readRequest(requestCanceller, released);
    expect(after.body).toMatchObject({ state: 'CONFIRMED', rider_assigned: false });
    expect(after.etag).not.toBe(before.etag);
    expect((await requestRowOf(released)).version).toBe(rowBefore.version + 1);
    expect(await requestRowOf(other)).toMatchObject({ rider_assigned: false });
    await expectMarkToBeTheClaim(requests);

    // A decision offered for a request no rider holds is a validation failure, and nothing is written.
    const offered = await cancelRequestOf(requestCanceller, released, DECIDED, after.etag);
    expect(outcome(offered)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await requestRowOf(released)).toMatchObject({
      state: 'CONFIRMED',
      rider_assigned: false,
    });

    const freed = await cancelRequestOf(requestCanceller, released, {}, after.etag);
    expect(freed.status).toBe(200);
    expect(await requestRowOf(released)).toMatchObject({
      state: 'CANCELLED',
      rider_assigned: false,
      cancellation_charge_outcome: null,
    });
    expect(await eventsOf('pickup.request.cancelled', released)).toHaveLength(1);
    expect(await eventsOf('pickup.request.cancelled_chargeable', released)).toHaveLength(0);
  });

  // Break caught: a request read as committed that is cancelled on that read after the manifest was cancelled (a charge decided on a view that
  // is no longer true), or a mark that changes without moving the request's ETag.
  it('refuses a cancellation made on the read that came before the manifest was cancelled', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const [held] = requests as [string, string];
    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);
    const stale = await readRequest(requestCanceller, held);
    expect(stale.body.rider_assigned).toBe(true);

    const seen = await readManifest(manifestCanceller, manifest.id);
    expect(
      (await cancelManifestOf(manifestCanceller, manifest.id, seen.header('etag') ?? '')).status,
    ).toBe(200);

    const refused = await cancelRequestOf(requestCanceller, held, DECIDED, stale.etag);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(await requestRowOf(held)).toMatchObject({ state: 'CONFIRMED', rider_assigned: false });
    expect(await eventsOf('pickup.request.cancelled_chargeable', held)).toHaveLength(0);
  });

  // Break caught: the cancellation of a dispatched manifest leaving its requests committed to a run that no longer exists.
  it('ends the commitment of a dispatched manifest too, and the rider still reads it, cancelled', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    const sent = await dispatchOf(dispatcher, manifest.id, assigned.header('etag') ?? '');
    expect(sent.status).toBe(200);
    await expectMarkToBeTheClaim(requests);

    const cancelled = await cancelManifestOf(
      manifestCanceller,
      manifest.id,
      sent.header('etag') ?? '',
    );
    expect(cancelled.status).toBe(200);
    expect(manifestOf(cancelled).state).toBe('CANCELLED');
    for (const id of requests) {
      expect(await requestRowOf(id)).toMatchObject({ state: 'CONFIRMED', rider_assigned: false });
    }
    await expectMarkToBeTheClaim(requests);
  });
});

describe('the commitment survives what does not end the claim', () => {
  // Break caught: a reassignment of a draft that unmarks the requests (the claim is the same and the manifest still has a rider), or one that
  // marks them a second time (a second count in the event).
  it('keeps the commitment when a draft is given another rider, and counts no second marking', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const one = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(one.status).toBe(200);
    const two = await assignOf(assigner, manifest.id, (await rider()).id, one.header('etag') ?? '');
    expect(two.status).toBe(200);

    await expectMarkToBeTheClaim(requests);
    for (const id of requests) expect((await requestRowOf(id)).rider_assigned).toBe(true);
    expect(
      (await eventsOf('pickup.manifest.rider_assigned', manifest.id)).map((e) => e.detail),
    ).toEqual([{ requests_marked: 2 }, { requests_marked: 0 }]);
    const seen = await readRequest(requestCanceller, requests[0] ?? '');
    expect(
      outcome(await cancelRequestOf(requestCanceller, requests[0] ?? '', {}, seen.etag)),
    ).toEqual([422, 'REASON_REQUIRED']);
  });

  // Break caught: a skip, a failure or a cancellation of the request releasing the claim's commitment (only an explicit release ends it).
  it('keeps the commitment of a request cancelled meanwhile, with its decision, when the manifest is cancelled', async () => {
    const { manifest, etag, requests } = await draftOf(3);
    const [held, melarc, kept] = requests as [string, string, string];
    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);

    const charged = await cancelRequestOf(
      senior,
      held,
      { apply_charge: true, charge_reason_code: CUSTOMER },
      (await readRequest(senior, held)).etag,
    );
    expect(charged.status).toBe(200);
    expect(await requestRowOf(held)).toMatchObject({ cancellation_charge_outcome: 'APPLIED' });
    const exempted = await cancelRequestOf(
      requestCanceller,
      melarc,
      { reason_code: MELARC, apply_charge: false, charge_reason_code: CUSTOMER },
      (await readRequest(requestCanceller, melarc)).etag,
    );
    expect(exempted.status).toBe(200);
    expect(await requestRowOf(melarc)).toMatchObject({ cancellation_charge_outcome: 'EXEMPT' });

    const rowsBefore = [await wholeRequest(held), await wholeRequest(melarc)];
    const seen = await readManifest(manifestCanceller, manifest.id);
    const cancelled = await cancelManifestOf(
      manifestCanceller,
      manifest.id,
      seen.header('etag') ?? '',
    );
    expect(cancelled.status).toBe(200);

    // Both decisions, their snapshots and the rows themselves are exactly as they were; only the request still confirmed lost its rider.
    expect([await wholeRequest(held), await wholeRequest(melarc)]).toEqual(rowsBefore);
    expect(await requestRowOf(held)).toMatchObject({
      state: 'CANCELLED',
      rider_assigned: true,
      cancellation_charge_outcome: 'APPLIED',
    });
    expect(await requestRowOf(kept)).toMatchObject({ state: 'CONFIRMED', rider_assigned: false });
    expect((await eventsOf('pickup.manifest.cancelled', manifest.id)).map((e) => e.detail)).toEqual(
      [{ stops_skipped: 1, claims_released: 3, commitments_ended: 1 }],
    );
  });
});

describe('a request claimed by a later manifest', () => {
  // Break caught: an act on a manifest that has been cancelled reaching the request its claim used to hold, now held by another manifest with
  // its own rider (the mark follows the CURRENT claim, and the earlier manifest is not it).
  it('keeps its commitment when its earlier manifest is cancelled again, assigned or replayed', async () => {
    const { manifest: first, etag, requests } = await draftOf(2);
    const [moved, stayed] = requests as [string, string];
    expect((await assignOf(assigner, first.id, (await rider()).id, etag)).status).toBe(200);
    const key = randomUUID();
    const seenFirst = await readManifest(manifestCanceller, first.id);
    const firstEtag = seenFirst.header('etag') ?? '';
    const cancelled = await cancelManifestOf(manifestCanceller, first.id, firstEtag, key);
    expect(cancelled.status).toBe(200);
    await expectMarkToBeTheClaim(requests);

    // A second manifest takes one of the two requests and is given a rider of its own.
    const made = await maker.client.post(
      LIST,
      { pickup_request_ids: [moved], service_date: days.day },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(made.status).toBe(201);
    const secondRider = await rider();
    expect(
      (await assignOf(assigner, manifestOf(made).id, secondRider.id, made.header('etag') ?? ''))
        .status,
    ).toBe(200);
    expect(await requestRowOf(moved)).toMatchObject({ rider_assigned: true });
    const marked = await requestRowOf(moved);

    // Whatever is done to the earlier manifest now finds it cancelled and changes nothing of the request.
    const again = await cancelManifestOf(
      manifestCanceller,
      first.id,
      (await readManifest(manifestCanceller, first.id)).header('etag') ?? '',
    );
    expect(outcome(again)).toEqual([409, 'STATE_CONFLICT']);
    const replayed = await cancelManifestOf(manifestCanceller, first.id, firstEtag, key);
    expect(replayed.status).toBe(200);
    const reassigned = await assignOf(
      assigner,
      first.id,
      (await rider()).id,
      (await readManifest(assigner, first.id)).header('etag') ?? '',
    );
    expect(outcome(reassigned)).toEqual([409, 'STATE_CONFLICT']);

    expect(await requestRowOf(moved)).toEqual(marked);
    expect(await requestRowOf(stayed)).toMatchObject({ rider_assigned: false });
    expect(await eventsOf('pickup.manifest.cancelled', first.id)).toHaveLength(1);
    await expectMarkToBeTheClaim(requests);
  });
});

describe('a refusal or a failure leaves nothing half done', () => {
  /** Everything the three acts write, so that "nothing changed" is a comparison and not a list of hopes. */
  async function snapshotOf(manifestId: string, requests: readonly string[]) {
    return {
      manifest: await manifestRowOf(manifestId),
      stops: await stopRowsOf(manifestId),
      requests: await Promise.all(requests.map(wholeRequest)),
      assigned: await eventsOf('pickup.manifest.rider_assigned', manifestId),
      cancelled: await eventsOf('pickup.manifest.cancelled', manifestId),
    };
  }

  // Break caught: an assignment that marks requests and is then refused, or a cancellation that clears marks and releases claims and is then
  // refused (a stale token, a blank note, a rider who is not available, a run that has started).
  it('writes nothing when the assignment or the cancellation of a manifest is refused', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    const current = assigned.header('etag') ?? '';
    const before = await snapshotOf(manifest.id, requests);

    const refusals = [
      await assignOf(assigner, manifest.id, (await rider()).id, etag),
      await assignOf(assigner, manifest.id, randomUUID(), current),
      await cancelManifestOf(manifestCanceller, manifest.id, etag),
      await cancelManifestOf(manifestCanceller, manifest.id, undefined),
      await manifestCanceller.client.post(
        CANCEL(manifest.id),
        { note: '   ' },
        { origin: OPS, headers: { 'If-Match': current, 'Idempotency-Key': randomUUID() } },
      ),
    ];
    for (const refusal of refusals) expect(refusal.status).toBeGreaterThanOrEqual(400);
    expect(await snapshotOf(manifest.id, requests)).toEqual(before);
    await expectMarkToBeTheClaim(requests);

    // The same hold for a run that has started: it is not cancelled, and nothing about its requests moves.
    await routes.admin.query(
      `update pickup_manifest set state = 'DISPATCHED', dispatched_at = now() where id = $1`,
      [manifest.id],
    );
    await routes.admin.query(
      `update pickup_manifest set state = 'IN_PROGRESS', started_at = now() where id = $1`,
      [manifest.id],
    );
    const started = await snapshotOf(manifest.id, requests);
    const tooLate = await cancelManifestOf(
      manifestCanceller,
      manifest.id,
      (await readManifest(manifestCanceller, manifest.id)).header('etag') ?? '',
    );
    expect(outcome(tooLate)).toEqual([422, 'RUN_ALREADY_STARTED']);
    expect(await snapshotOf(manifest.id, requests)).toEqual(started);
  });

  // Break caught: the marks cleared, the claims released and the stops skipped by a cancellation whose event could not be written (a record
  // of nothing, or a request returned to the pool with no trace of why), and the retry under the same key that is then refused.
  it('makes neither the cancellation of a manifest nor its changes to the requests when its event cannot be written', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    const current = assigned.header('etag') ?? '';
    const before = await snapshotOf(manifest.id, requests);
    const key = randomUUID();

    const broken = await routes.kit.admin.breakWrites('audit_event');
    const failed = await cancelManifestOf(manifestCanceller, manifest.id, current, key).finally(
      () => broken.mend(),
    );
    expect(failed.status).toBe(500);
    expect(await snapshotOf(manifest.id, requests)).toEqual(before);
    await expectMarkToBeTheClaim(requests);

    const retried = await cancelManifestOf(manifestCanceller, manifest.id, current, key);
    expect(retried.status).toBe(200);
    for (const id of requests)
      expect(await requestRowOf(id)).toMatchObject({ rider_assigned: false });
    expect(await eventsOf('pickup.manifest.cancelled', manifest.id)).toHaveLength(1);
  });

  // Break caught: a rider assigned and the requests marked although the event of the assignment could not be written.
  it('makes neither the assignment of a rider nor the marks when its event cannot be written', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const riderId = (await rider()).id;
    const before = await snapshotOf(manifest.id, requests);

    const broken = await routes.kit.admin.breakWrites('audit_event');
    const failed = await assignOf(assigner, manifest.id, riderId, etag).finally(() =>
      broken.mend(),
    );
    expect(failed.status).toBe(500);
    expect(await snapshotOf(manifest.id, requests)).toEqual(before);
    for (const id of requests)
      expect(await requestRowOf(id)).toMatchObject({ rider_assigned: false });

    expect((await assignOf(assigner, manifest.id, riderId, etag)).status).toBe(200);
    await expectMarkToBeTheClaim(requests);
  });

  // Break caught: a cancellation of a request that records its charge decision and is then undone only in part (the stop skipped, the
  // decision kept, or the other way round).
  it('makes no part of the cancellation of a committed request when its event cannot be written', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const [held] = requests as [string, string];
    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);
    const seen = await readRequest(requestCanceller, held);
    const before = await snapshotOf(manifest.id, requests);

    const broken = await routes.kit.admin.breakWrites('audit_event');
    const failed = await cancelRequestOf(requestCanceller, held, DECIDED, seen.etag).finally(() =>
      broken.mend(),
    );
    expect(failed.status).toBe(500);
    expect(await snapshotOf(manifest.id, requests)).toEqual(before);
    expect(await requestRowOf(held)).toMatchObject({
      state: 'CONFIRMED',
      rider_assigned: true,
      cancellation_charge_outcome: null,
    });
  });
});

describe('the three acts that meet on a request take their locks in one order', () => {
  // Break caught: the cancellation of a manifest that updates a request's stop before it locks the request. The cancellation of a request locks
  // the request and then its stop; a manifest cancellation that takes the stop and then waits for the request is the other half of a deadlock.
  // Here a request is locked the way its cancellation locks it, the cancellation of the manifest is seen waiting for it, and the stop of the
  // request is then taken the way the cancellation takes it: it must be free, because the manifest's cancellation has touched no stop yet.
  it('locks the requests it holds before it touches their stops, as the cancellation of a request does', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const [target] = requests as [string, string];
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    let cancelling: Promise<TestResponse> | undefined;
    try {
      await holder.query('begin');
      const pid = await backendPidOf(holder);
      await holder.query(`select id from pickup_request where id = $1 for update`, [target]);
      cancelling = cancelManifestOf(manifestCanceller, manifest.id, assigned.header('etag') ?? '');
      await waitUntilBlockedBy(routes.admin, pid, 'the cancellation of the manifest', cancelling);

      // The next lock of a cancelled request: its stop. It must not wait for the manifest's cancellation, which holds none.
      await holder.query(`set local lock_timeout = '3s'`);
      const taken = await holder.query(
        `select id from pickup_stop where pickup_request_id = $1 and released_at is null for update`,
        [target],
      );
      expect(taken.rows).toHaveLength(1);
      await holder.query('commit');
    } catch (error) {
      await holder.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await holder.end();
    }
    const done = await cancelling;
    expect(done.status).toBe(200);
    await expectMarkToBeTheClaim(requests);
    expect((await requestRowOf(target)).rider_assigned).toBe(false);
  });
});

/** The shape of an end: (an assignment was made, the request's cancellation was decided on a rider, requests marked, commitments ended). */
const VALID_SHAPES = [
  'false,false,undefined,0',
  'true,true,3,2',
  'true,false,2,2',
  'true,false,3,3',
];

describe('every serial order of an assignment, the cancellation of the manifest and the cancellation of a request', () => {
  type Act = 'assign' | 'cancel the manifest' | 'cancel the request';

  /**
   * The three acts in this order, one after the other, each on what it reads when it begins (the token and, for the request, whether a rider
   * holds it). Three requests; the third act of the list that is a cancellation of the request is of the first of them.
   */
  async function inOrder(order: readonly Act[]) {
    const { manifest, requests } = await draftOf(3);
    const [target] = requests as [string, string, string];
    const riderId = (await rider()).id;
    const answers: Partial<Record<Act, TestResponse>> = {};
    for (const act of order) {
      if (act === 'assign') {
        const read = await readManifest(modelAssigner, manifest.id);
        answers[act] = await assignOf(
          modelAssigner,
          manifest.id,
          riderId,
          read.header('etag') ?? '',
        );
      } else if (act === 'cancel the manifest') {
        const read = await readManifest(modelManifestCanceller, manifest.id);
        answers[act] = await cancelManifestOf(
          modelManifestCanceller,
          manifest.id,
          read.header('etag') ?? '',
        );
      } else {
        const read = await readRequest(modelRequestCanceller, target);
        answers[act] = await cancelRequestOf(
          modelRequestCanceller,
          target,
          read.body.rider_assigned ? DECIDED : {},
          read.etag,
        );
      }
    }
    return { manifest, requests, target, answers };
  }

  // Break caught: a mark, a charge decision or a count in the events that depends on anything but the order the acts were made in. A request
  // cancelled before the assignment is not marked by it; one cancelled between the assignment and the manifest's cancellation is decided on
  // a rider and keeps its mark; one cancelled after the manifest's cancellation is free; and an assignment that follows the manifest's
  // cancellation is refused (a cancelled manifest is not a draft) and marks nothing.
  it.each([
    [['assign', 'cancel the manifest', 'cancel the request'], 'true,false,3,3'],
    [['assign', 'cancel the request', 'cancel the manifest'], 'true,true,3,2'],
    [['cancel the request', 'assign', 'cancel the manifest'], 'true,false,2,2'],
    [['cancel the request', 'cancel the manifest', 'assign'], 'false,false,undefined,0'],
    [['cancel the manifest', 'assign', 'cancel the request'], 'false,false,undefined,0'],
    [['cancel the manifest', 'cancel the request', 'assign'], 'false,false,undefined,0'],
  ] as [Act[], string][])(
    'ends as the model says when the order is %j',
    async (order, expected) => {
      const { manifest, requests, target, answers } = await inOrder(order);
      expect(answers['cancel the manifest']?.status).toBe(200);
      expect(answers['cancel the request']?.status).toBe(200);
      const assigned = await eventsOf('pickup.manifest.rider_assigned', manifest.id);
      const ended = await eventsOf('pickup.manifest.cancelled', manifest.id);
      const row = await requestRowOf(target);
      const shape = [
        assigned.length === 1,
        row.cancellation_charge_outcome !== null,
        assigned[0]?.detail.requests_marked,
        ended[0]?.detail.commitments_ended,
      ]
        .map(String)
        .join(',');
      expect(shape).toBe(expected);
      // An assignment that follows the manifest's cancellation is refused: a cancelled manifest is not a draft.
      if (expected === 'false,false,undefined,0') {
        const refused = answers.assign;
        expect(refused === undefined ? undefined : outcome(refused)).toEqual([
          409,
          'STATE_CONFLICT',
        ]);
      }
      expect(VALID_SHAPES).toContain(shape);
      expect(row).toMatchObject({
        state: 'CANCELLED',
        rider_assigned: row.cancellation_charge_outcome !== null,
      });
      await expectMarkToBeTheClaim(requests);
    },
  );
});

describe('an assignment, the cancellation of the manifest and the cancellation of a request at once', () => {
  /**
   * An act as a client makes it: the first try goes with what was read before the race, and an answer of `STATE_CONFLICT` sends the client to
   * read again and try on what it reads, a few times. An act that is no longer offered by what it reads ends there (nothing is sent).
   */
  async function untilSettled(
    send: (attempt: number) => Promise<TestResponse | undefined>,
  ): Promise<TestResponse | undefined> {
    let answer: TestResponse | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      answer = await send(attempt);
      if (answer?.status !== 409) return answer;
    }
    return answer;
  }

  // Break caught: a mark and a claim that disagree after any interleaving, a charge decision made on a view that was not true when it was
  // decided, a deadlock (a 500), or counts in the events that no serial order could produce. Three requests; the target is the one cancelled.
  // The valid ends, by (assignment made, cancellation of the request decided on a rider, requests marked, commitments ended):
  //   no assignment (the cancellation of the manifest came first)            -> (no, no, -, 0)
  //   the request cancelled between the assignment and the manifest's        -> (yes, yes, 3, 2)
  //   the request cancelled before the assignment                            -> (yes, no, 2, 2)
  //   the request cancelled after the manifest's cancellation                -> (yes, no, 3, 3)
  it('ends in a state one serial order could have made, with no deadlock', async () => {
    for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
      const where = `round ${String(round)}`;
      const { manifest, etag, requests } = await draftOf(3);
      const [target] = requests as [string, string, string];
      const riderId = (await rider()).id;
      const readBefore = await readRequest(racingRequestCanceller, target);
      const random = seeded(RACE_SEED + round);
      const [startAssign, startCancel, startRequest] = [
        random() * 10,
        random() * 10,
        random() * 10,
      ];

      const [assignment, cancellation, requestCancellation] = await Promise.all([
        untilSettled(async (attempt) => {
          if (attempt === 0) await pause(startAssign);
          if (attempt === 0) return assignOf(racingAssigner, manifest.id, riderId, etag);
          const read = await readManifest(racingAssigner, manifest.id);
          if (manifestOf(read).state !== 'DRAFT') return undefined;
          return assignOf(racingAssigner, manifest.id, riderId, read.header('etag') ?? '');
        }),
        untilSettled(async (attempt) => {
          if (attempt === 0) await pause(startCancel);
          if (attempt === 0) return cancelManifestOf(racingManifestCanceller, manifest.id, etag);
          const read = await readManifest(racingManifestCanceller, manifest.id);
          return cancelManifestOf(racingManifestCanceller, manifest.id, read.header('etag') ?? '');
        }),
        untilSettled(async (attempt) => {
          if (attempt === 0) await pause(startRequest);
          const read =
            attempt === 0 ? readBefore : await readRequest(racingRequestCanceller, target);
          return cancelRequestOf(
            racingRequestCanceller,
            target,
            read.body.rider_assigned ? DECIDED : {},
            read.etag,
          );
        }),
      ]);
      for (const answer of [assignment, cancellation, requestCancellation]) {
        expect(answer?.status ?? 0, `${where}: ${answer?.text ?? 'not sent'}`).toBeLessThan(500);
      }

      // The two cancellations always end by succeeding, whatever they met; the assignment succeeds only if it came first.
      expect(cancellation?.status, `${where}: ${cancellation?.text ?? ''}`).toBe(200);
      expect(requestCancellation?.status, `${where}: ${requestCancellation?.text ?? ''}`).toBe(200);
      const assigned = await eventsOf('pickup.manifest.rider_assigned', manifest.id);
      const ended = await eventsOf('pickup.manifest.cancelled', manifest.id);
      expect(assigned.length).toBeLessThanOrEqual(1);
      expect(assignment?.status === 200, where).toBe(assigned.length === 1);
      expect(ended).toHaveLength(1);
      const row = await requestRowOf(target);
      const decidedOnARider = row.cancellation_charge_outcome !== null;
      const marked = assigned[0]?.detail.requests_marked;
      const commitmentsEnded = ended[0]?.detail.commitments_ended;
      const shape = [assigned.length === 1, decidedOnARider, marked, commitmentsEnded]
        .map(String)
        .join(',');
      expect(
        VALID_SHAPES,
        `${where} (seed ${String(RACE_SEED + round)}): (assignment made, decided on a rider, marked, ended) = ${shape}`,
      ).toContain(shape);

      // Whatever the order, the end is one state: the manifest cancelled, every claim released, the others back in the pool and unmarked, and
      // the target cancelled with the mark it was decided on.
      expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'CANCELLED' });
      expect((await stopRowsOf(manifest.id)).every((stop) => stop.released_at !== null)).toBe(true);
      expect(row.state).toBe('CANCELLED');
      expect(row.rider_assigned).toBe(decidedOnARider);
      for (const id of requests.filter((each) => each !== target)) {
        expect(await requestRowOf(id)).toMatchObject({ state: 'CONFIRMED', rider_assigned: false });
      }
      await expectMarkToBeTheClaim(requests);
    }
  });
});
