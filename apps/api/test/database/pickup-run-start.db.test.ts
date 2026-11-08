import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRider } from './support/runs.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  VENDOR,
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { seedHubConfiguration } from './support/seeded.js';

/**
 * S1.22, `startRun` (`AC-SLICE-001-14` and `-80`; the Product Owner's decisions of 2 November 2026, OB-S1-31; state-machines.md sections 4
 * and 5; features/pickup/pickup-manifest.md): the assigned rider starts a dispatched run, on its day. Against a real PostgreSQL and the
 * real application, each claim:
 *
 * - **Only the assigned rider starts it, and it starts once.** `DISPATCHED` becomes `IN_PROGRESS` with the moment; that one row is the whole
 *   change ("all member pickup work moves to the active context in one change": the stops are worked because their manifest is in progress,
 *   and none is written), one event is recorded in the rider's name, and nothing is sent. Another rider, a vendor, an officer and a caller
 *   with no session cannot, and a rider who is not the assigned one is told `NOT_ASSIGNED_RIDER`, a run that does not exist is answered the
 *   same, and the run is left as it was.
 * - **A run is started on its day, on the hub's clock** (OB-S1-31): not before it (`service_date_not_reached`) and not after it has passed
 *   (`service_date_passed`), each a `STATE_CONFLICT`. A run that has started goes on past midnight and is not touched by the day ending.
 * - **A screen that is out of date is refused**: a stale token, and one that a cancelled request moved, are `STATE_CONFLICT`.
 * - **A run with nothing left to work is not started** (OB-S1-39; the Product Owner's review of 2 November 2026): every pickup cancelled or
 *   resolved is `MANIFEST_EMPTY`, judged after the day, and the run stays dispatched for Ops to cancel, with no event and nothing sent.
 * - **Concurrency is a line, not a race**: of two starts that hold the same token one wins, and a start meeting the cancellation of its
 *   manifest leaves one of the two outcomes a serial order could.
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const START = (id: string) => `${ONE(id)}/start`;
const ASSIGN = (id: string) => `${ONE(id)}/assign-rider`;
const DISPATCH = (id: string) => `${ONE(id)}/dispatch`;
const CANCEL = (id: string) => `${ONE(id)}/cancel`;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let browser: TestClient;
let maker: Actor;
let assigner: Actor;
let dispatcher: Actor;
let manifestCanceller: Actor;
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
  manifestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  requestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ('FIXTURE_CANCEL_CUSTOMER_START', 'PICKUP_CANCELLATION', 'Fixture customer cancellation', 'CUSTOMER', false, true)`,
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Stop {
  readonly id: string;
  readonly sequence: number;
  readonly state: string;
  readonly arrived_at: string | null;
  readonly skipped: { reason_code: string } | null;
}
interface Manifest {
  readonly id: string;
  readonly state: string;
  readonly service_date: string;
  readonly assigned_rider_id: string | null;
  readonly dispatched_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly stops: Stop[];
}
const manifestOf = (response: TestResponse): Manifest => response.json() as Manifest;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const detailsOf = (response: TestResponse): Record<string, unknown> | undefined =>
  (response.json() as { details?: Record<string, unknown> }).details;

const asRider = (
  rider: ArrangedRider,
  id: string,
  etag: string | undefined,
): Promise<TestResponse> =>
  rider.client.post(START(id), undefined, {
    headers: etag === undefined ? {} : { 'If-Match': etag },
  });

const readAs = (rider: ArrangedRider, id: string): Promise<TestResponse> =>
  rider.client.get(ONE(id));

const arranged = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}) =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    ...over,
  });

const manifestRowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      service_date: string;
      assigned_rider_id: string | null;
      dispatched_at: Date | null;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `select state, version, service_date::text as service_date, assigned_rider_id, dispatched_at, started_at, completed_at
         from pickup_manifest where id = $1`,
      [id],
    )
  )[0];

/** The whole rows of a table for these identifiers, in a fixed order: what a test compares before and after an act. */
const wholeRows = (
  table: 'pickup_stop' | 'pickup_request' | 'pickup_manifest',
  ids: readonly string[],
) => routes.rows(`select * from ${table} where id = any($1::uuid[]) order by id`, [ids]);

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
    detail: Record<string, unknown>;
  }>(
    `select actor_type, actor_id, surface_context, enhanced, outcome, object_type, responsible_hub_id, previous_state, resulting_state,
            related_ids, detail
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

const envelopesOf = (manifestId: string) =>
  routes.rows(`select id from outbox where aggregate_id = $1`, [manifestId]);

/**
 * Nothing of the act in the database: the manifest as it was, no event, and no envelope beyond the ones it had (a run dispatched through the
 * office's routes holds the envelope of the rider's text, which the dispatch queued and the start does not add to).
 */
async function expectNothingStarted(
  id: string,
  before: { state: string; version: number },
  envelopes: readonly unknown[] = [],
) {
  expect(await manifestRowOf(id)).toMatchObject({
    state: before.state,
    version: before.version,
    started_at: null,
  });
  expect(await eventsOf('pickup.manifest.started', id)).toEqual([]);
  expect(await envelopesOf(id)).toEqual(envelopes);
}

describe('startRun: the assigned rider starts a dispatched run on its day', () => {
  // Break caught (AC-14): a start that does not move the manifest, that moves a stop or a request with it, that lets the rider's token go
  // stale in no way, that records no event or one in another name, that sends a text, or that starts a run but not on the rider's say-so.
  it('makes the run IN_PROGRESS with its moment, changes that one row and records one event in the rider’s name', async () => {
    // Three stops, one of which the office has already cancelled the pickup of: the event counts the two still to be worked.
    const run = await arranged({ stops: 3, stopStates: ['PENDING', 'PENDING', 'SKIPPED'] });
    const stopIds = run.stops.map((stop) => stop.id);
    const requestIds = run.stops.map((stop) => stop.requestId);
    const stopsBefore = await wholeRows('pickup_stop', stopIds);
    const requestsBefore = await wholeRows('pickup_request', requestIds);
    const before = await manifestRowOf(run.manifest.id);

    const read = await readAs(run.rider, run.manifest.id);
    expect(read.status).toBe(200);
    const etag = read.header('etag') ?? '';
    const sentAt = Date.now();
    const started = await asRider(run.rider, run.manifest.id, etag);
    expect(started.status).toBe(200);

    const body = manifestOf(started);
    expect(body).toMatchObject({
      id: run.manifest.id,
      state: 'IN_PROGRESS',
      assigned_rider_id: run.rider.id,
      completed_at: null,
    });
    expect(body.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The moment is the database's instant of this start, within a minute of the request (the machine's clock and the database's may differ).
    expect(Math.abs(Date.parse(body.started_at ?? '') - sentAt)).toBeLessThan(60_000);
    expect(body.dispatched_at).toBe(before?.dispatched_at?.toISOString());
    // The stops are in their places and untouched: working them is allowed by the manifest's state alone.
    expect(body.stops.map((stop) => [stop.sequence, stop.state])).toEqual([
      [1, 'PENDING'],
      [2, 'PENDING'],
      [3, 'SKIPPED'],
    ]);
    expect(body.stops.every((stop) => stop.arrived_at === null)).toBe(true);
    // The token it hands back is the one a fresh read hands out, and it is not the one the rider sent.
    const fresh = await readAs(run.rider, run.manifest.id);
    expect(started.header('etag')).toBe(fresh.header('etag'));
    expect(started.header('etag')).not.toBe(etag);

    // The database: the one row moved, and the version with it.
    const after = await manifestRowOf(run.manifest.id);
    expect(after).toMatchObject({
      state: 'IN_PROGRESS',
      version: Number(before?.version) + 1,
      assigned_rider_id: run.rider.id,
      completed_at: null,
    });
    expect(after?.started_at).toBeInstanceOf(Date);
    expect(after?.dispatched_at).toEqual(before?.dispatched_at);
    expect(after?.service_date).toBe(days.today);
    expect(await wholeRows('pickup_stop', stopIds)).toEqual(stopsBefore);
    expect(await wholeRows('pickup_request', requestIds)).toEqual(requestsBefore);

    // One event, in the rider's name, from the rider's surface; and nothing is sent: the start notifies no one.
    const events = await eventsOf('pickup.manifest.started', run.manifest.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: run.rider.id,
      surface_context: 'RIDER_ANDROID',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object_type: 'PickupManifest',
      responsible_hub_id: HUB_A,
      previous_state: 'DISPATCHED',
      resulting_state: 'IN_PROGRESS',
    });
    expect(events[0]?.related_ids).toEqual({ rider_id: run.rider.id });
    expect(events[0]?.detail).toEqual({ stops_to_work: 2 });
    expect(await envelopesOf(run.manifest.id)).toEqual([]);
  });

  // Break caught (AC-14, AC-80): a start by a rider who is not the assigned one, which would start a colleague's run; an answer that tells a
  // colleague's run from one that does not exist (the existence rule: both are the same refusal); a refusal that changes the run.
  it('tells another rider NOT_ASSIGNED_RIDER, the same as for a run that does not exist, and leaves the run as it was', async () => {
    const run = await arranged();
    const other = await arrangedRider(routes.kit, routes.admin);
    const ownRun = await arranged({ rider: other });
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const before = await manifestRowOf(run.manifest.id);

    const foreign = await asRider(other, run.manifest.id, etag);
    const missing = await asRider(other, randomUUID(), etag);
    expect(outcome(foreign)).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    expect(outcome(missing)).toEqual(outcome(foreign));
    // The same body in every member but the request's own identifier: a colleague's run is not told from an id that matches nothing.
    const shape = (response: TestResponse) =>
      Object.fromEntries(
        Object.entries(response.json() as Record<string, unknown>).filter(
          ([member]) => member !== 'request_id',
        ),
      );
    expect(shape(missing)).toEqual(shape(foreign));
    await expectNothingStarted(run.manifest.id, {
      state: 'DISPATCHED',
      version: before?.version ?? 0,
    });
    expect((await manifestRowOf(ownRun.manifest.id))?.state).toBe('DISPATCHED');

    // The assigned rider can still start it, and the other rider's run was never touched by the attempt.
    expect((await asRider(run.rider, run.manifest.id, etag)).status).toBe(200);
    expect((await manifestRowOf(ownRun.manifest.id))?.state).toBe('DISPATCHED');
  });

  // Break caught (AC-80, matrix D1 to D3 at the routes): a rider who reads a colleague's run, or whose list carries it.
  it('shows a rider its own run alone: a colleague’s is 404 NOT_FOUND, as one that does not exist, and the list holds one run', async () => {
    const mine = await arranged();
    const theirs = await arranged();
    expect(outcome(await readAs(mine.rider, theirs.manifest.id))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await readAs(mine.rider, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    const list = await mine.rider.client.get(LIST);
    expect(list.status).toBe(200);
    expect((list.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      mine.manifest.id,
    ]);
  });

  // Break caught: a start by someone who is not a rider: a vendor, an officer (who holds the keys to plan and send a run, not to work it)
  // and a caller with no session.
  it('refuses a vendor, an officer and a caller with no session, and the run is left as it was', async () => {
    const run = await arranged();
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const before = await manifestRowOf(run.manifest.id);

    expect(
      outcome(
        await dispatcher.client.post(START(run.manifest.id), undefined, {
          origin: OPS,
          headers: { 'If-Match': etag },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await browser.post(START(run.manifest.id), undefined, {
          origin: VENDOR,
          headers: { 'If-Match': etag },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await routes.kit.client
          .fork()
          .post(START(run.manifest.id), undefined, { headers: { 'If-Match': etag } }),
      ),
    ).toEqual([401, 'SESSION_INVALID']);
    await expectNothingStarted(run.manifest.id, {
      state: 'DISPATCHED',
      version: before?.version ?? 0,
    });
  });
});

describe('startRun: the day of the run (OB-S1-31)', () => {
  // Break caught: a run started before its day (dispatch in advance is publication, and the start is the day), made through the routes
  // as the office makes it, so that the dispatch is shown to change nothing about it.
  it('refuses the start of a run dispatched in advance until its day, as STATE_CONFLICT with the rule, and changes nothing', async () => {
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

    const read = await readAs(rider, manifest.id);
    expect(manifestOf(read).state).toBe('DISPATCHED');
    const before = await manifestRowOf(manifest.id);
    const queued = await envelopesOf(manifest.id);
    expect(queued).toHaveLength(1);
    const refused = await asRider(rider, manifest.id, read.header('etag') ?? '');
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(refused)).toMatchObject({
      rule: 'service_date_not_reached',
      service_date: days.day,
    });
    // The dispatch's text is still the only thing queued for the run: the refused start added nothing and took nothing away.
    await expectNothingStarted(
      manifest.id,
      { state: 'DISPATCHED', version: before?.version ?? 0 },
      queued,
    );
  });

  // Break caught: a run started after its day has passed (the unstarted manifest is cancelled and its requests planned again).
  it('refuses the start of a run whose day has passed, as STATE_CONFLICT with the rule, and changes nothing', async () => {
    const run = await arranged({ serviceDate: days.past });
    const read = await readAs(run.rider, run.manifest.id);
    const before = await manifestRowOf(run.manifest.id);
    const refused = await asRider(run.rider, run.manifest.id, read.header('etag') ?? '');
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(refused)).toMatchObject({
      rule: 'service_date_passed',
      service_date: days.past,
    });
    await expectNothingStarted(run.manifest.id, {
      state: 'DISPATCHED',
      version: before?.version ?? 0,
    });
  });

  // Break caught: a run that is already started being redated, completed or cancelled because its day ended, or refused its second start by
  // the day and not by its state; and the stops of a run that crossed midnight no longer working.
  it('leaves a run that started on its day alone when the day ends: it keeps its date and its moments, and starting it again is a plain conflict', async () => {
    const run = await arranged({ serviceDate: days.past, state: 'IN_PROGRESS' });
    const before = await manifestRowOf(run.manifest.id);
    const read = await readAs(run.rider, run.manifest.id);
    expect(read.status).toBe(200);
    const body = manifestOf(read);
    expect(body).toMatchObject({ state: 'IN_PROGRESS', service_date: days.past });
    expect(body.started_at).not.toBeNull();

    const again = await asRider(run.rider, run.manifest.id, read.header('etag') ?? '');
    expect(outcome(again)).toEqual([409, 'STATE_CONFLICT']);
    // A run that has started is refused by its state, not by the day it was meant for.
    expect(detailsOf(again)?.rule).toBeUndefined();
    const after = await manifestRowOf(run.manifest.id);
    expect(after).toEqual(before);
    expect(await eventsOf('pickup.manifest.started', run.manifest.id)).toEqual([]);
  });
});

describe('startRun: what the run is and what the screen showed', () => {
  // Break caught: a start from a screen that is out of date: the token is compared with the manifest as it is now, with its stops, so a
  // cancellation of one of its requests moves it and the rider must read the run again before it goes out.
  it('is judged against the token: missing is a validation failure, stale or another run’s is a conflict, and a cancelled pickup makes the rider read again', async () => {
    const run = await arranged();
    const elsewhere = await arranged();
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const elsewhereEtag =
      (await readAs(elsewhere.rider, elsewhere.manifest.id)).header('etag') ?? '';
    const before = await manifestRowOf(run.manifest.id);

    expect(outcome(await asRider(run.rider, run.manifest.id, undefined))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    for (const token of ['"stale"', 'W/"weak"', '*', elsewhereEtag, `${etag}, ${etag}`]) {
      expect(outcome(await asRider(run.rider, run.manifest.id, token)), token).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
    }
    await expectNothingStarted(run.manifest.id, {
      state: 'DISPATCHED',
      version: before?.version ?? 0,
    });

    // The office cancels a pickup of the run after the rider read it: the stop is skipped at once, the rider's token is stale, and a start
    // from that screen is refused; read again, it starts.
    const request = run.stops[0]?.requestId ?? '';
    const requestEtag =
      (await requestCanceller.client.get(`${API}/pickup-requests/${request}`)).header('etag') ?? '';
    const cancelled = await requestCanceller.client.post(
      `${API}/pickup-requests/${request}/cancel`,
      {
        reason_code: 'FIXTURE_CANCEL_CUSTOMER_START',
        apply_charge: false,
        charge_reason_code: 'FIXTURE_CANCEL_CUSTOMER_START',
      },
      { origin: OPS, headers: { 'If-Match': requestEtag, 'Idempotency-Key': randomUUID() } },
    );
    expect(cancelled.status).toBe(200);
    expect(outcome(await asRider(run.rider, run.manifest.id, etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    const reread = await readAs(run.rider, run.manifest.id);
    expect(manifestOf(reread).stops.map((stop) => stop.state)).toEqual(['SKIPPED', 'PENDING']);
    expect((await asRider(run.rider, run.manifest.id, reread.header('etag') ?? '')).status).toBe(
      200,
    );
  });

  // Break caught: a start of a run that is not a dispatched one: a run already started, one that was cancelled after it went out (the rider
  // reads it, cancelled), one that is completed, and a draft (which its rider has never been shown, so it is not the rider's to start).
  it.each([
    ['already started', 'IN_PROGRESS', [409, 'STATE_CONFLICT']],
    ['cancelled after it went out', 'CANCELLED', [409, 'STATE_CONFLICT']],
    ['completed', 'COMPLETED', [409, 'STATE_CONFLICT']],
  ] as const)('refuses the start of a run %s', async (_label, state, expected) => {
    const run = await arranged({
      state,
      stopState: state === 'COMPLETED' ? 'COLLECTED' : 'PENDING',
    });
    const before = await manifestRowOf(run.manifest.id);
    const read = await readAs(run.rider, run.manifest.id);
    expect(read.status).toBe(200);
    expect(outcome(await asRider(run.rider, run.manifest.id, read.header('etag') ?? ''))).toEqual(
      expected,
    );
    expect(await manifestRowOf(run.manifest.id)).toEqual(before);
    expect(await eventsOf('pickup.manifest.started', run.manifest.id)).toEqual([]);
  });

  it('does not tell a rider about a draft, or a run cancelled before it went out: both are answered as a run that is not theirs', async () => {
    for (const over of [
      { state: 'DRAFT' as const },
      { state: 'CANCELLED' as const, dispatchedBeforeCancel: false },
    ]) {
      const run = await arranged(over);
      const before = await manifestRowOf(run.manifest.id);
      expect(outcome(await asRider(run.rider, run.manifest.id, '"x"'))).toEqual([
        422,
        'NOT_ASSIGNED_RIDER',
      ]);
      expect(await manifestRowOf(run.manifest.id)).toEqual(before);
    }
  });
});

/** The office cancels a pickup: once a rider is assigned the cancellation says whether to charge, and this one does not. */
async function cancelRequest(id: string): Promise<TestResponse> {
  const etag =
    (await requestCanceller.client.get(`${API}/pickup-requests/${id}`)).header('etag') ?? '';
  return requestCanceller.client.post(
    `${API}/pickup-requests/${id}/cancel`,
    {
      reason_code: 'FIXTURE_CANCEL_CUSTOMER_START',
      apply_charge: false,
      charge_reason_code: 'FIXTURE_CANCEL_CUSTOMER_START',
    },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

describe('startRun: a run with nothing left to work is not started (OB-S1-39)', () => {
  // Break caught (the review of 2 November 2026): a start that goes ahead when every stop of the run has been skipped, which would leave a
  // run in progress that nothing completes. Judged under the manifest's lock with a token that is current, so that the refusal is the rule's
  // and not the stale screen's; the run stays dispatched (Ops cancels it unstarted), no event is written and nothing is sent.
  it.each([
    ['every stop skipped', { stops: 2, stopState: 'SKIPPED' as const }],
    [
      'every stop already collected or failed',
      { stops: 2, stopStates: ['COLLECTED', 'FAILED'] as const },
    ],
    ['no stop at all', { stops: 0 }],
  ])(
    'refuses the start of a run with %s, as MANIFEST_EMPTY, and leaves it dispatched',
    async (_label, over) => {
      const run = await arranged(over);
      const read = await readAs(run.rider, run.manifest.id);
      expect(read.status).toBe(200);
      const before = await manifestRowOf(run.manifest.id);
      const refused = await asRider(run.rider, run.manifest.id, read.header('etag') ?? '');
      // The declared error of a manifest with nothing left to work, which the dispatch answers with for the same condition.
      expect(outcome(refused)).toEqual([422, 'MANIFEST_EMPTY']);
      await expectNothingStarted(run.manifest.id, {
        state: 'DISPATCHED',
        version: before?.version ?? 0,
      });
      // It is still the rider's dispatched run, which Ops can cancel unstarted.
      expect(manifestOf(await readAs(run.rider, run.manifest.id)).state).toBe('DISPATCHED');
    },
  );

  // Break caught: the pickups of the run all cancelled by the office after the rider read it (the real route, the real skip): the rider's
  // screen is stale first, and read again the refusal is the rule's. The cancelled pickups are skipped by the system, with the arrival of
  // none of them, and that is what the start finds.
  it('refuses a run whose every pickup the office has cancelled, first as a stale screen and then, read again, by its rule', async () => {
    const run = await arranged({ stops: 2 });
    const stale = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    for (const stop of run.stops) expect((await cancelRequest(stop.requestId)).status).toBe(200);

    const behind = await asRider(run.rider, run.manifest.id, stale);
    expect(outcome(behind)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(behind)?.rule).toBeUndefined();

    const reread = await readAs(run.rider, run.manifest.id);
    expect(manifestOf(reread).stops.map((stop) => stop.state)).toEqual(['SKIPPED', 'SKIPPED']);
    const refused = await asRider(run.rider, run.manifest.id, reread.header('etag') ?? '');
    expect(outcome(refused)).toEqual([422, 'MANIFEST_EMPTY']);
    const row = await manifestRowOf(run.manifest.id);
    expect(row).toMatchObject({ state: 'DISPATCHED', started_at: null });
    expect(await eventsOf('pickup.manifest.started', run.manifest.id)).toEqual([]);
  });

  // Break caught: a rule that counts only the stops not yet arrived at (an arrived stop is still to be worked), or that counts the resolved
  // stop beside a pending one: one stop to work among resolved ones is enough, and one arrived stop alone is enough.
  it.each([
    [
      'one pending stop among resolved ones',
      { stops: 3, stopStates: ['COLLECTED', 'SKIPPED', 'PENDING'] as const },
    ],
    ['a stop already arrived at', { stops: 1, stopState: 'ARRIVED' as const }],
  ])('starts a run with %s', async (_label, over) => {
    const run = await arranged(over);
    const read = await readAs(run.rider, run.manifest.id);
    expect((await asRider(run.rider, run.manifest.id, read.header('etag') ?? '')).status).toBe(200);
  });

  // Break caught: the order the start is judged in, which the contract states: the rider's, the token, the state, the day and then this rule.
  // A run of a day that has passed and has nothing to work is told its day, and a screen out of date is told that first.
  it('judges the day before it, and the screen before the day', async () => {
    const past = await arranged({ serviceDate: days.past, stops: 1, stopState: 'SKIPPED' });
    const pastRead = await readAs(past.rider, past.manifest.id);
    const dayFirst = await asRider(past.rider, past.manifest.id, pastRead.header('etag') ?? '');
    expect(detailsOf(dayFirst)).toMatchObject({ rule: 'service_date_passed' });

    const today = await arranged({ stops: 1, stopState: 'SKIPPED' });
    const stale = await asRider(today.rider, today.manifest.id, '"stale"');
    expect(outcome(stale)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(stale)?.rule).toBeUndefined();
  });
});

describe('startRun: concurrency is a line, not a race', () => {
  // Break caught (the review of 2 November 2026): a start and the cancellation of the last pickup of the run ending in a state no serial
  // order makes: a start refused that moved the run anyway, a refused start with an event, a run started with no start event, or a
  // cancellation that was refused because a rider was starting. The cancellation does not lock the manifest, so the two meet at the stop.
  // Several rounds, each with a different head start, so that the order they meet in is not always the same.
  it('ends a start that meets the cancellation of the last pickup of the run in one of the two serial outcomes', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      const run = await arranged({ stops: 1 });
      const stop = run.stops[0];
      if (stop === undefined) throw new Error('stop');
      const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
      const lateness = (round % 4) * 6;
      const [started, cancelled] = await Promise.all([
        new Promise((resolve) => setTimeout(resolve, round < 4 ? 0 : lateness)).then(() =>
          asRider(run.rider, run.manifest.id, etag),
        ),
        new Promise((resolve) => setTimeout(resolve, round < 4 ? lateness : 0)).then(() =>
          cancelRequest(stop.requestId),
        ),
      ]);
      // The office's cancellation always succeeds: a rider starting does not withdraw it.
      expect(cancelled.status, `round ${String(round)}`).toBe(200);
      const row = await manifestRowOf(run.manifest.id);
      const events = await eventsOf('pickup.manifest.started', run.manifest.id);
      const stops = await routes.rows<{ state: string }>(
        `select state from pickup_stop where pickup_manifest_id = $1`,
        [run.manifest.id],
      );
      // Whatever came first, the pickup is cancelled and its stop skipped.
      expect(stops.map((each) => each.state)).toEqual(['SKIPPED']);
      if (started.status === 200) {
        // The start came first: the run went out with the pickup it had, which the cancellation then skipped. That left a run in progress with
        // nothing to work, and the system completes it in the transaction of the cancellation (S1.23): it is never stranded.
        expect(row).toMatchObject({ state: 'COMPLETED' });
        expect(row?.started_at).toBeInstanceOf(Date);
        expect(row?.completed_at).toBeInstanceOf(Date);
        expect(events).toHaveLength(1);
        expect(events[0]?.detail).toEqual({ stops_to_work: 1 });
        expect(await eventsOf('pickup.manifest.completed', run.manifest.id)).toHaveLength(1);
        seen.add('started then cancelled');
      } else {
        // The cancellation came first: the start was refused (the screen was out of date, or the run had nothing left), and the run stays
        // dispatched with no event.
        expect(outcome(started)).toEqual([409, 'STATE_CONFLICT']);
        expect(row).toMatchObject({ state: 'DISPATCHED', started_at: null });
        expect(events).toEqual([]);
        seen.add('cancelled then refused');
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  // Break caught: a start that was waiting for the manifest's lock and then went ahead on what it had read before it waited. The run is held
  // by another transaction, the start is seen waiting for it, the office cancels the last pickup (which does not need the manifest) and the
  // holder lets go. The start reads the run as it now is: refused, the run dispatched, no event. Read again with the token it now has, it is
  // refused by the rule. Deterministic, not a race.
  it('refuses a start that waited for the manifest while the last pickup of the run was cancelled, and writes nothing', async () => {
    const run = await arranged({ stops: 1 });
    const stop = run.stops[0];
    if (stop === undefined) throw new Error('stop');
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const before = await manifestRowOf(run.manifest.id);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from pickup_manifest where id = $1 for update', [
        run.manifest.id,
      ]);
      const pid = await backendPidOf(holder);
      const start = asRider(run.rider, run.manifest.id, etag);
      await waitUntilBlockedBy(routes.admin, pid, 'the start', start);
      expect((await cancelRequest(stop.requestId)).status).toBe(200);
      await holder.query('commit');
      const refused = await start;
      expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
      await expectNothingStarted(run.manifest.id, {
        state: 'DISPATCHED',
        version: before?.version ?? 0,
      });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
    const fresh = await readAs(run.rider, run.manifest.id);
    const byRule = await asRider(run.rider, run.manifest.id, fresh.header('etag') ?? '');
    expect(outcome(byRule)).toEqual([422, 'MANIFEST_EMPTY']);
    expect((await manifestRowOf(run.manifest.id))?.state).toBe('DISPATCHED');
  });

  // Break caught: a run started twice by a double tap (two requests that hold one token): the manifest's lock puts them in a line, the second
  // reads a run that has moved on, and one event is recorded.
  it('lets one of two starts that hold the same token win, and records one event', async () => {
    const run = await arranged();
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const before = await manifestRowOf(run.manifest.id);
    const answers = await Promise.all([
      asRider(run.rider, run.manifest.id, etag),
      asRider(run.rider, run.manifest.id, etag),
    ]);
    const outcomes = answers.map(outcome);
    expect(outcomes.filter(([status]) => status === 200)).toHaveLength(1);
    expect(outcomes).toContainEqual([409, 'STATE_CONFLICT']);
    expect(await manifestRowOf(run.manifest.id)).toMatchObject({
      state: 'IN_PROGRESS',
      version: Number(before?.version) + 1,
    });
    expect(await eventsOf('pickup.manifest.started', run.manifest.id)).toHaveLength(1);
  });

  // Break caught: the moment of the start taken when the transaction began (`now()`) and not when the manifest's lock was won. The manifest
  // is held by another transaction, the start is seen waiting for it, and the holder lets go having read the clock; the moment of the start
  // is not before that. A pause before the read makes the two moments differ by far more than a clock's grain. Deterministic, not a race.
  it('stamps the start after the manifest’s lock is won, and not when the transaction began', async () => {
    const run = await arranged();
    const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from pickup_manifest where id = $1 for update', [
        run.manifest.id,
      ]);
      const pid = await backendPidOf(holder);
      const start = asRider(run.rider, run.manifest.id, etag);
      await waitUntilBlockedBy(routes.admin, pid, 'the start', start);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const released = (
        await holder.query<{ instant: Date }>('select clock_timestamp() as instant')
      ).rows[0]?.instant;
      await holder.query('commit');
      expect((await start).status).toBe(200);
      const moment = (await manifestRowOf(run.manifest.id))?.started_at;
      expect(moment).toBeInstanceOf(Date);
      expect(released).toBeInstanceOf(Date);
      expect(Number(moment?.getTime())).toBeGreaterThanOrEqual(Number(released?.getTime()));
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });

  // Break caught: a start and the cancellation of the same manifest ending in a state no serial order makes: a run both started and
  // cancelled, a started event for a cancelled run, or stops skipped under a run that is going out. Several rounds, so that the order they
  // meet in is not always the same.
  it('ends a start that meets the cancellation of its manifest in one of the two serial outcomes', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const run = await arranged();
      const etag = (await readAs(run.rider, run.manifest.id)).header('etag') ?? '';
      const lateness = round * 7;
      const [started, cancelled] = await Promise.all([
        asRider(run.rider, run.manifest.id, etag),
        new Promise((resolve) => setTimeout(resolve, lateness)).then(() =>
          manifestCanceller.client.post(
            CANCEL(run.manifest.id),
            { note: 'Plans changed' },
            { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
          ),
        ),
      ]);
      const row = await manifestRowOf(run.manifest.id);
      const events = await eventsOf('pickup.manifest.started', run.manifest.id);
      const stops = await routes.rows<{ state: string }>(
        `select state from pickup_stop where pickup_manifest_id = $1`,
        [run.manifest.id],
      );
      if (started.status === 200) {
        // The start won: the run is going out, its stops are untouched and the cancellation was refused.
        expect(row?.state).toBe('IN_PROGRESS');
        expect(events).toHaveLength(1);
        expect(stops.every((stop) => stop.state === 'PENDING')).toBe(true);
        expect([409, 422]).toContain(cancelled.status);
        seen.add('started');
      } else {
        // The cancellation won: the run is cancelled, its stops are skipped and nothing was started.
        expect(outcome(started)).toEqual([409, 'STATE_CONFLICT']);
        expect(cancelled.status).toBe(200);
        expect(row?.state).toBe('CANCELLED');
        expect(events).toEqual([]);
        expect(stops.every((stop) => stop.state === 'SKIPPED')).toBe(true);
        seen.add('cancelled');
      }
      expect(row?.started_at === null).toBe(started.status !== 200);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
