import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { backendPidOf, waitForBlockedBackend, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  VENDOR,
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.22, `arriveAtPickupStop` (`AC-SLICE-001-13`, `-16` and `-80`; state-machines.md section 5; the Product Owner's decisions of 29 October
 * and 2 November 2026): the assigned rider says it has arrived at a stop of its run. Against a real PostgreSQL and the real application,
 * each claim:
 *
 * - **A stop is arrived at once, in any order, and nothing else changes.** `PENDING` becomes `ARRIVED` with the moment; the rest of the run,
 *   the request and the manifest are as they were; one event is recorded in the rider's name. The order of the stops is advice: the
 *   third may be worked first.
 * - **Only on a run that has started** (`MANIFEST_NOT_STARTED`, asserted for a run dispatched through the office's own routes), only by the
 *   rider it is assigned to (`NOT_ASSIGNED_RIDER`, the same for a colleague's stop and for an id that matches nothing), and only on a stop
 *   still to be worked (`STATE_CONFLICT`: a stop skipped because its request was cancelled is not arrived at from an outdated screen).
 * - **A retry is not a second arrival**: the same `Idempotency-Key` replays the answer and records nothing again, the same key with another
 *   stop is `IDEMPOTENCY_KEY_CONFLICT`, and another key on an arrived stop is `STATE_CONFLICT`.
 * - **Concurrency is a line**: an arrival that meets the cancellation of its request ends in one of the two serial outcomes, with no
 *   deadlock and no answer of 500. A run that crosses midnight goes on.
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const ASSIGN = (id: string) => `${ONE(id)}/assign-rider`;
const DISPATCH = (id: string) => `${ONE(id)}/dispatch`;
const REQUESTS = `${API}/pickup-requests`;
const ARRIVE = (stopId: string) => `${API}/pickup-stops/${stopId}/arrive`;
const REASON = 'FIXTURE_CANCEL_CUSTOMER_ARRIVAL';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let browser: TestClient;
let maker: Actor;
let assigner: Actor;
let dispatcher: Actor;
let requestCanceller: Actor;

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
  browser = routes.browser(vendor.device.credential.token);
  expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
    200,
  );
  maker = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  assigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  dispatcher = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  requestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ($1, 'PICKUP_CANCELLATION', 'Fixture customer cancellation', 'CUSTOMER', false, true)`,
    [REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Stop {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: string;
  readonly arrived_at: string | null;
  readonly failure_category: string | null;
  readonly failure: unknown;
  readonly skipped: { reason_code: string; skipped_at: string } | null;
  readonly pickup_summary?: { reference: string };
}
interface Manifest {
  readonly id: string;
  readonly state: string;
  readonly stops: Stop[];
}
const stopOf = (response: TestResponse): Stop => response.json() as Stop;
const manifestOf = (response: TestResponse): Manifest => response.json() as Manifest;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ETAG_SHAPE = /^"[A-Za-z0-9_-]{43}"$/;

/** An arrival with a key of its own, with the key given, or with none (`null`: a default would turn "no key" into a key). */
const arriveOf = (
  rider: ArrangedRider,
  stopId: string,
  key: string | null = randomUUID(),
): Promise<TestResponse> =>
  rider.client.post(ARRIVE(stopId), undefined, {
    headers: key === null ? {} : { 'Idempotency-Key': key },
  });

const readManifest = (rider: ArrangedRider, id: string): Promise<TestResponse> =>
  rider.client.get(ONE(id));

const running = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}) =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    ...over,
  });

const wholeRows = (
  table: 'pickup_stop' | 'pickup_request' | 'pickup_manifest',
  ids: readonly string[],
) => routes.rows(`select * from ${table} where id = any($1::uuid[]) order by id`, [ids]);

const stopRowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      arrived_at: Date | null;
      resolved_at: Date | null;
      released_at: Date | null;
      skip_snapshot: { reason_code?: string } | null;
    }>(
      `select state, version, arrived_at, resolved_at, released_at, skip_snapshot from pickup_stop where id = $1`,
      [id],
    )
  )[0];

const requestRowOf = async (id: string) =>
  (
    await routes.rows<{ state: string; version: number; rider_assigned: boolean }>(
      `select state, version, rider_assigned from pickup_request where id = $1`,
      [id],
    )
  )[0];

const eventsOf = (code: string, objectId: string) =>
  routes.rows<{
    actor_type: string;
    actor_id: string | null;
    surface_context: string;
    enhanced: boolean;
    outcome: string;
    object_type: string;
    responsible_hub_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    related_ids: Record<string, unknown> | null;
  }>(
    `select actor_type, actor_id, surface_context, enhanced, outcome, object_type, responsible_hub_id, previous_state, resulting_state,
            related_ids
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

const keysOf = (riderId: string) =>
  routes.rows(
    `select id from idempotency_record where principal_type = 'RIDER' and principal_id = $1 and operation_id = 'arriveAtPickupStop'`,
    [riderId],
  );

/** The office cancels a pickup: once a rider is assigned the cancellation says whether to charge, and this one does not. */
async function cancelRequest(id: string): Promise<TestResponse> {
  const etag = (await requestCanceller.client.get(`${REQUESTS}/${id}`)).header('etag') ?? '';
  return requestCanceller.client.post(
    `${REQUESTS}/${id}/cancel`,
    { reason_code: REASON, apply_charge: false, charge_reason_code: REASON },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

describe('arriveAtPickupStop: the rider arrives at a stop of the run it started', () => {
  // Break caught (AC-16): an arrival that is enforced in the order of the stops, that moves another stop, the request or the manifest with
  // it, that records no event or one in another name, or that hands back a representation that is not the stop's.
  it('moves a stop to ARRIVED with its moment in any order, changes that one row, and records one event in the rider’s name', async () => {
    const run = await running({ stops: 3 });
    const [first, second, third] = run.stops;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('stops');
    const requestIds = run.stops.map((stop) => stop.requestId);
    const requestsBefore = await wholeRows('pickup_request', requestIds);
    const manifestBefore = await wholeRows('pickup_manifest', [run.manifest.id]);
    const untouched = await wholeRows('pickup_stop', [first.id, second.id]);
    const thirdBefore = await stopRowOf(third.id);
    const readBefore = await readManifest(run.rider, run.manifest.id);

    // The third is worked first: the order of the stops is advice and is never enforced.
    const sentAt = Date.now();
    const arrived = await arriveOf(run.rider, third.id);
    expect(arrived.status).toBe(200);
    expect(arrived.header('etag')).toMatch(ETAG_SHAPE);
    const body = stopOf(arrived);
    expect(body).toMatchObject({
      id: third.id,
      pickup_manifest_id: run.manifest.id,
      pickup_request_id: third.requestId,
      sequence: 3,
      state: 'ARRIVED',
      failure_category: null,
      failure: null,
      skipped: null,
    });
    expect(body.arrived_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The moment is the database's instant of this arrival, within a minute of the request (the machine's clock and the database's may differ).
    expect(Math.abs(Date.parse(body.arrived_at ?? '') - sentAt)).toBeLessThan(60_000);
    expect(body.pickup_summary?.reference).toBe(third.requestCode);

    const after = await stopRowOf(third.id);
    expect(after).toMatchObject({
      state: 'ARRIVED',
      version: Number(thirdBefore?.version) + 1,
      resolved_at: null,
      released_at: null,
      skip_snapshot: null,
    });
    expect(after?.arrived_at).toBeInstanceOf(Date);
    // Nothing else moved: the other stops, the manifest, and every request (the cancellation window closed at the assignment).
    expect(await wholeRows('pickup_stop', [first.id, second.id])).toEqual(untouched);
    expect(await wholeRows('pickup_manifest', [run.manifest.id])).toEqual(manifestBefore);
    expect(await wholeRows('pickup_request', requestIds)).toEqual(requestsBefore);
    expect((await requestRowOf(third.requestId))?.rider_assigned).toBe(true);

    const events = await eventsOf('pickup.stop.arrived', third.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: run.rider.id,
      surface_context: 'RIDER_ANDROID',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object_type: 'PickupStop',
      responsible_hub_id: HUB_A,
      previous_state: 'PENDING',
      resulting_state: 'ARRIVED',
    });
    expect(events[0]?.related_ids).toEqual({
      pickup_manifest_id: run.manifest.id,
      pickup_request_id: third.requestId,
      rider_id: run.rider.id,
    });

    // The first, then the second: each is accepted whatever was worked before, and the run shows them in their places with their states.
    expect((await arriveOf(run.rider, first.id)).status).toBe(200);
    expect((await arriveOf(run.rider, second.id)).status).toBe(200);
    const reread = await readManifest(run.rider, run.manifest.id);
    expect(manifestOf(reread).stops.map((stop) => [stop.sequence, stop.state])).toEqual([
      [1, 'ARRIVED'],
      [2, 'ARRIVED'],
      [3, 'ARRIVED'],
    ]);
    // An arrival moves the token of the manifest that embeds the stop, so a screen read before is out of date.
    expect(reread.header('etag')).not.toBe(readBefore.header('etag'));
  });

  // Break caught (AC-13): a stop worked before the run started. The run is made, assigned and dispatched through the office's own routes,
  // for a later day so that this holds on every day of the week, and the rider's arrival at one of its stops is refused.
  it('is refused before the run has started: MANIFEST_NOT_STARTED, for a run dispatched through the office’s routes', async () => {
    const rider = await arrangedRider(routes.kit, routes.admin);
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.day,
      }),
    );
    const made = await maker.client.post(
      LIST,
      { pickup_request_ids: [request.id], service_date: days.day },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(made.status).toBe(201);
    const manifest = manifestOf(made);
    const assigned = await assigner.client.post(
      ASSIGN(manifest.id),
      { rider_id: rider.id },
      { origin: OPS, headers: { 'If-Match': made.header('etag') ?? '' } },
    );
    expect(assigned.status).toBe(200);
    const sent = await dispatcher.client.post(DISPATCH(manifest.id), undefined, {
      origin: OPS,
      headers: { 'If-Match': assigned.header('etag') ?? '' },
    });
    expect(sent.status).toBe(200);
    const stop = manifestOf(sent).stops[0];
    if (stop === undefined) throw new Error('the dispatched run has a stop');

    const before = await stopRowOf(stop.id);
    expect(outcome(await arriveOf(rider, stop.id))).toEqual([422, 'MANIFEST_NOT_STARTED']);
    expect(await stopRowOf(stop.id)).toEqual(before);
    expect(await eventsOf('pickup.stop.arrived', stop.id)).toEqual([]);
    expect(await keysOf(rider.id)).toEqual([]);
  });

  // Break caught: a run that is dispatched, today, and not yet started being worked (the arranged form of the same claim).
  it('is refused on a run that is dispatched and not started, however near its day', async () => {
    const run = await running({ state: 'DISPATCHED' });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    expect(outcome(await arriveOf(run.rider, stop.id))).toEqual([422, 'MANIFEST_NOT_STARTED']);
    expect((await stopRowOf(stop.id))?.state).toBe('PENDING');
  });
});

describe('arriveAtPickupStop: a retry is not a second arrival', () => {
  // Break caught: a retry after a lost answer that closes the window a second time or answers differently; the same key used for another
  // stop (a client bug) honoured; another key on a stop already arrived at taken for a new arrival; a key that is not one.
  it('replays the answer for the same key, refuses the key for another stop, and refuses another key on an arrived stop', async () => {
    const run = await running({ stops: 2 });
    const [one, two] = run.stops;
    if (one === undefined || two === undefined) throw new Error('stops');
    const key = randomUUID();

    const first = await arriveOf(run.rider, one.id, key);
    const replay = await arriveOf(run.rider, one.id, key);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.header('etag')).toBe(first.header('etag'));
    expect(await eventsOf('pickup.stop.arrived', one.id)).toHaveLength(1);
    expect((await stopRowOf(one.id))?.version).toBe(2);

    const before = await stopRowOf(two.id);
    expect(outcome(await arriveOf(run.rider, two.id, key))).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
    expect(await stopRowOf(two.id)).toEqual(before);

    expect(outcome(await arriveOf(run.rider, one.id))).toEqual([409, 'STATE_CONFLICT']);
    expect(await eventsOf('pickup.stop.arrived', one.id)).toHaveLength(1);
    expect((await stopRowOf(one.id))?.version).toBe(2);

    for (const bad of [null, '', 'x'.repeat(129)]) {
      expect(outcome(await arriveOf(run.rider, two.id, bad)), String(bad)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(await stopRowOf(two.id)).toEqual(before);
  });
});

describe('arriveAtPickupStop: whose stop it is, and what state it is in', () => {
  // Break caught (AC-80, matrix D2 and D3 at the routes): a rider who acts on a colleague's stop; an answer that tells a colleague's stop
  // from an id that matches nothing; a refusal that leaves a record of the attempt behind.
  it('tells a rider NOT_ASSIGNED_RIDER for a colleague’s stop, for an id that matches nothing and for a stop it was never shown', async () => {
    const mine = await running();
    const theirs = await running();
    const draft = await running({ state: 'DRAFT', rider: mine.rider });
    const target = theirs.stops[0];
    const hidden = draft.stops[0];
    if (target === undefined || hidden === undefined) throw new Error('stops');
    const before = await stopRowOf(target.id);

    const foreign = await arriveOf(mine.rider, target.id);
    const missing = await arriveOf(mine.rider, randomUUID());
    const unseen = await arriveOf(mine.rider, hidden.id);
    expect(outcome(foreign)).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    expect(outcome(missing)).toEqual(outcome(foreign));
    expect(outcome(unseen)).toEqual(outcome(foreign));
    const shape = (response: TestResponse) =>
      Object.fromEntries(
        Object.entries(response.json() as Record<string, unknown>).filter(
          ([member]) => member !== 'request_id',
        ),
      );
    expect(shape(missing)).toEqual(shape(foreign));
    expect(shape(unseen)).toEqual(shape(foreign));

    expect(await stopRowOf(target.id)).toEqual(before);
    expect(await eventsOf('pickup.stop.arrived', target.id)).toEqual([]);
    // The refused attempts left no record: a transaction that is refused is rolled back whole, the key with it.
    expect(await keysOf(mine.rider.id)).toEqual([]);
    expect((await stopRowOf(hidden.id))?.state).toBe('PENDING');
  });

  // Break caught: a stop that is already resolved, or a run that is over, being arrived at: a stop skipped because its request was
  // cancelled, one collected, one failed, a run cancelled after it went out, a run completed.
  it.each([
    ['skipped', 'IN_PROGRESS', 'SKIPPED'],
    ['collected', 'IN_PROGRESS', 'COLLECTED'],
    ['partly collected', 'IN_PROGRESS', 'PARTIALLY_COLLECTED'],
    ['failed', 'IN_PROGRESS', 'FAILED'],
    ['arrived at already', 'IN_PROGRESS', 'ARRIVED'],
    ['on a run cancelled after it went out', 'CANCELLED', 'PENDING'],
    ['on a run that is completed', 'COMPLETED', 'PENDING'],
  ] as const)('refuses an arrival at a stop %s', async (_label, state, stopState) => {
    const run = await running({ state, stopState, stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const before = await stopRowOf(stop.id);
    expect(outcome(await arriveOf(run.rider, stop.id))).toEqual([409, 'STATE_CONFLICT']);
    expect(await stopRowOf(stop.id)).toEqual(before);
    expect(await eventsOf('pickup.stop.arrived', stop.id)).toEqual([]);
  });

  // Break caught: a rider's screen that is out of date being accepted: the office cancelled the pickup after the rider read the run, the
  // cancellation skipped the stop in its own transaction, and the arrival is refused by the stop's own state; the other stops go on.
  it('refuses a stop whose request the office has cancelled since the rider read the run, and the rest of the run goes on', async () => {
    const run = await running({ stops: 2 });
    const [cancelled, other] = run.stops;
    if (cancelled === undefined || other === undefined) throw new Error('stops');
    expect((await cancelRequest(cancelled.requestId)).status).toBe(200);
    const row = await stopRowOf(cancelled.id);
    expect(row?.state).toBe('SKIPPED');
    expect(row?.skip_snapshot?.reason_code).toBe('REQUEST_CANCELLED');

    expect(outcome(await arriveOf(run.rider, cancelled.id))).toEqual([409, 'STATE_CONFLICT']);
    expect(await stopRowOf(cancelled.id)).toEqual(row);
    expect(await eventsOf('pickup.stop.arrived', cancelled.id)).toEqual([]);
    expect((await arriveOf(run.rider, other.id)).status).toBe(200);
  });

  // Break caught: the other serial order: an arrival and then the cancellation of the same pickup. The cancellation resolves the stop it
  // finds, an arrived one included, and keeps the arrival the rider recorded.
  it('lets the office cancel a pickup the rider has already arrived at: the stop is skipped and keeps its arrival', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    expect((await arriveOf(run.rider, stop.id)).status).toBe(200);
    const arrivedAt = (await stopRowOf(stop.id))?.arrived_at;
    expect((await cancelRequest(stop.requestId)).status).toBe(200);
    const after = await stopRowOf(stop.id);
    expect(after).toMatchObject({ state: 'SKIPPED' });
    expect(after?.skip_snapshot?.reason_code).toBe('REQUEST_CANCELLED');
    expect(after?.arrived_at).toEqual(arrivedAt);
    expect(after?.released_at).toBeNull();
  });
});

describe('arriveAtPickupStop: callers who are not the rider, and a run past midnight', () => {
  // Break caught: an arrival by someone who is not a rider: an officer, a vendor, a caller with no session.
  it('refuses an officer, a vendor and a caller with no session', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const before = await stopRowOf(stop.id);
    const headers = { 'Idempotency-Key': randomUUID() };
    expect(
      outcome(await dispatcher.client.post(ARRIVE(stop.id), undefined, { origin: OPS, headers })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(await browser.post(ARRIVE(stop.id), undefined, { origin: VENDOR, headers })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(await routes.kit.client.fork().post(ARRIVE(stop.id), undefined, { headers })),
    ).toEqual([401, 'SESSION_INVALID']);
    expect(await stopRowOf(stop.id)).toEqual(before);
  });

  // Break caught (OB-S1-31): a run that started on its day being refused work, redated or touched by the day ending: the stops of a run
  // that crossed midnight are worked, the arrival is the moment it happened, and the manifest keeps its date and its moments.
  it('lets a run that started on an earlier day go on: the arrival is today’s moment, and the manifest is untouched', async () => {
    const run = await running({ serviceDate: days.past, stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const manifestBefore = await wholeRows('pickup_manifest', [run.manifest.id]);
    const arrived = await arriveOf(run.rider, stop.id);
    expect(arrived.status).toBe(200);
    const moment = Date.parse(stopOf(arrived).arrived_at ?? '');
    expect(Math.abs(Date.now() - moment)).toBeLessThan(60_000);
    expect(await wholeRows('pickup_manifest', [run.manifest.id])).toEqual(manifestBefore);
  });
});

describe('arriveAtPickupStop: concurrency is a line, not a race', () => {
  // Break caught: a stop arrived at twice by two requests that hold different keys (a client that made a new key for a retry): the stop's
  // lock puts them in a line, the second reads a stop that has moved on, one event is recorded, the stop's version moves once, and the
  // loser's key goes with its transaction.
  it('lets one of two arrivals at the same stop win, whatever their keys, and records one event', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const before = await stopRowOf(stop.id);
    const answers = await Promise.all([arriveOf(run.rider, stop.id), arriveOf(run.rider, stop.id)]);
    const outcomes = answers.map(outcome);
    expect(outcomes.filter(([status]) => status === 200)).toHaveLength(1);
    expect(outcomes).toContainEqual([409, 'STATE_CONFLICT']);
    expect(await stopRowOf(stop.id)).toMatchObject({
      state: 'ARRIVED',
      version: Number(before?.version) + 1,
    });
    expect(await eventsOf('pickup.stop.arrived', stop.id)).toHaveLength(1);
    expect(await keysOf(run.rider.id)).toHaveLength(1);
  });

  // Break caught: a double tap, or a retry that does not wait for its answer, that arrives twice or fails. Two requests carry the same key
  // at the same moment: the second waits at the key until the first has committed and is then answered with the first's answer, byte for
  // byte, so both are 200, one arrival is made, one event is recorded and one key is kept. Several rounds, so the order they meet in varies.
  it('answers two arrivals at the same stop with the same key as one arrival, replayed', async () => {
    for (let round = 0; round < 4; round += 1) {
      const run = await running({ stops: 1 });
      const stop = run.stops[0];
      if (stop === undefined) throw new Error('stop');
      const before = await stopRowOf(stop.id);
      const key = randomUUID();
      const answers = await Promise.all([
        arriveOf(run.rider, stop.id, key),
        arriveOf(run.rider, stop.id, key),
      ]);
      expect(answers.map(outcome), `round ${String(round)}`).toEqual([
        [200, undefined],
        [200, undefined],
      ]);
      expect(answers[1].json()).toEqual(answers[0].json());
      expect(answers[1].header('etag')).toBe(answers[0].header('etag'));
      expect(await stopRowOf(stop.id)).toMatchObject({
        state: 'ARRIVED',
        version: Number(before?.version) + 1,
      });
      expect(await eventsOf('pickup.stop.arrived', stop.id)).toHaveLength(1);
      expect(await keysOf(run.rider.id)).toHaveLength(1);
    }
  });

  // Break caught: the moment of the arrival taken when the transaction began (`now()`) and not when the stop's lock was won. The stop is held
  // by another transaction, the arrival is seen waiting for it, and the holder lets go having read the clock; the moment of the arrival is
  // not before that. A pause before the read makes the two moments differ by far more than a clock's grain. Deterministic, not a race.
  it('stamps the arrival after the stop’s lock is won, and not when the transaction began', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from pickup_stop where id = $1 for update', [stop.id]);
      const pid = await backendPidOf(holder);
      const arrival = arriveOf(run.rider, stop.id);
      await waitUntilBlockedBy(routes.admin, pid, 'the arrival', arrival);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const released = (
        await holder.query<{ instant: Date }>('select clock_timestamp() as instant')
      ).rows[0]?.instant;
      await holder.query('commit');
      expect((await arrival).status).toBe(200);
      const moment = (await stopRowOf(stop.id))?.arrived_at;
      expect(moment).toBeInstanceOf(Date);
      expect(released).toBeInstanceOf(Date);
      expect(Number(moment?.getTime())).toBeGreaterThanOrEqual(Number(released?.getTime()));
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  // Break caught: an arrival that reads the stop and does not lock it. The stop is held by another transaction (as the cancellation of its
  // request holds it while it resolves the stop); the arrival is seen waiting for it; the stop is skipped and the holder commits. An arrival
  // that locked the stop finds it skipped and is refused as a conflict. One that only read it saw `PENDING` before the wait, writes after it,
  // finds the row changed under its own update and fails: an answer of 500 for what is an ordinary refusal. Deterministic, not a race.
  it('refuses as a conflict, and not as a failure, an arrival that waited for a stop the office was skipping', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from pickup_stop where id = $1 for update', [stop.id]);
      const pid = await backendPidOf(holder);
      const arrival = arriveOf(run.rider, stop.id);
      await waitUntilBlockedBy(routes.admin, pid, 'the arrival', arrival);
      await holder.query(
        `update pickup_stop
            set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = '{"reason_code":"REQUEST_CANCELLED","skipped_at":"2026-11-03T09:00:00.000Z"}'::jsonb
          where id = $1`,
        [stop.id],
      );
      await holder.query('commit');
      expect(outcome(await arrival)).toEqual([409, 'STATE_CONFLICT']);
      const row = await stopRowOf(stop.id);
      expect(row).toMatchObject({ state: 'SKIPPED', arrived_at: null });
      expect(await eventsOf('pickup.stop.arrived', stop.id)).toEqual([]);
      expect(await keysOf(run.rider.id)).toEqual([]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  // Break caught (the review of 2 November 2026, "arrival commits first"): a cancellation that, having waited for an arrival, loses it: it
  // clears the moment, refuses because a rider has arrived, or leaves the stop to be worked. The rider's arrival is held in flight (the stop
  // locked and arrived at, not yet committed), the real cancellation is seen waiting for the stop, and the arrival commits. The
  // cancellation then skips the stop **as it now is**, keeps the moment of the arrival and says in its event that it skipped an arrived stop.
  // Deterministic, not a race.
  it('lets a cancellation that waited for an arrival skip the stop, keep the arrival and say it skipped an arrived stop', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      const arrived = await holder.query<{ arrived_at: Date }>(
        `update pickup_stop set state = 'ARRIVED', arrived_at = clock_timestamp()
          where id = $1 and state = 'PENDING' returning arrived_at`,
        [stop.id],
      );
      const arrivedAt = arrived.rows[0]?.arrived_at;
      expect(arrivedAt).toBeInstanceOf(Date);
      const pid = await backendPidOf(holder);
      const cancellation = cancelRequest(stop.requestId);
      await waitUntilBlockedBy(routes.admin, pid, 'the cancellation', cancellation);
      await holder.query('commit');
      expect((await cancellation).status).toBe(200);

      const row = await stopRowOf(stop.id);
      expect(row).toMatchObject({ state: 'SKIPPED', released_at: null });
      expect(row?.arrived_at).toEqual(arrivedAt);
      expect(row?.skip_snapshot?.reason_code).toBe('REQUEST_CANCELLED');
      expect((await requestRowOf(stop.requestId))?.state).toBe('CANCELLED');
      const skips = await eventsOf('pickup.stop.skipped', stop.id);
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ previous_state: 'ARRIVED', resulting_state: 'SKIPPED' });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  // Break caught (the review of 2 November 2026, "cancellation commits first"): an arrival that does not wait for a cancellation in flight,
  // or that is accepted after it. The real cancellation is held part-way through, **having skipped the stop and not yet committed** (the
  // audit ledger is held, so that it cannot write its event); the arrival is seen waiting for the stop it holds, the ledger is let go, and
  // the cancellation commits. The arrival then finds the stop skipped and is a conflict: no moment, no event, no key kept. The arrival
  // never needed the request, which the cancellation held all the while. Deterministic, not a race.
  it('makes an arrival that meets a cancellation in flight wait for it, and refuses it once it has committed', async () => {
    const run = await running({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table audit_event in share row exclusive mode');
      const holderPid = await backendPidOf(holder);
      const cancellation = cancelRequest(stop.requestId);
      const cancellingPid = await waitForBlockedBackend(
        routes.admin,
        holderPid,
        'the cancellation',
        cancellation,
      );
      // The cancellation has cancelled the request and skipped the stop, in a transaction that has not ended.
      const arrival = arriveOf(run.rider, stop.id);
      await waitUntilBlockedBy(routes.admin, cancellingPid, 'the arrival', arrival);
      await holder.query('commit');

      expect((await cancellation).status).toBe(200);
      expect(outcome(await arrival)).toEqual([409, 'STATE_CONFLICT']);
      expect(await stopRowOf(stop.id)).toMatchObject({ state: 'SKIPPED', arrived_at: null });
      expect((await requestRowOf(stop.requestId))?.state).toBe('CANCELLED');
      expect(await eventsOf('pickup.stop.arrived', stop.id)).toEqual([]);
      expect(await keysOf(run.rider.id)).toEqual([]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  // Break caught: an arrival and the cancellation of its pickup ending in a state no serial order makes, a deadlock, or an answer of 500.
  // The cancellation locks the request and then the stop and the arrival locks the stop alone, so every wait runs forward. Several rounds,
  // each with a different head start, so that the order they meet in is not always the same.
  it('ends an arrival that meets the cancellation of its pickup in one of the two serial outcomes', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const run = await running({ stops: 1 });
      const stop = run.stops[0];
      if (stop === undefined) throw new Error('stop');
      const lateness = (round % 4) * 6;
      const [arrival, cancellation] = await Promise.all([
        new Promise((resolve) => setTimeout(resolve, round < 4 ? 0 : lateness)).then(() =>
          arriveOf(run.rider, stop.id),
        ),
        new Promise((resolve) => setTimeout(resolve, round < 4 ? lateness : 0)).then(() =>
          cancelRequest(stop.requestId),
        ),
      ]);
      // The cancellation always succeeds: the office's right to cancel is not withdrawn by a rider arriving.
      expect(cancellation.status).toBe(200);
      expect([200, 409]).toContain(arrival.status);
      const row = await stopRowOf(stop.id);
      const request = await requestRowOf(stop.requestId);
      const events = await eventsOf('pickup.stop.arrived', stop.id);
      expect(request?.state).toBe('CANCELLED');
      expect(row?.state).toBe('SKIPPED');
      expect(row?.skip_snapshot?.reason_code).toBe('REQUEST_CANCELLED');
      if (arrival.status === 200) {
        // The arrival came first: the stop was arrived at and then skipped, and keeps the arrival.
        expect(row?.arrived_at).toBeInstanceOf(Date);
        expect(events).toHaveLength(1);
        seen.add('arrived then cancelled');
      } else {
        // The cancellation came first: the stop was skipped and the arrival was refused from an outdated screen.
        expect(outcome(arrival)).toEqual([409, 'STATE_CONFLICT']);
        expect(row?.arrived_at).toBeNull();
        expect(events).toEqual([]);
        seen.add('cancelled then refused');
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
