import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.22, `getPickupStop` (`pickup.read`; the plan's traceability table places "the stop's `ETag` read" here; contracts/openapi.yaml): the read
 * that hands out the version a stop operation takes as `If-Match`. Against a real PostgreSQL and the real application, each claim:
 *
 * - **It is the stop the manifest read shows, and nothing more**: the same closed projection, member for member, for staff and for the rider
 *   alike, so a rider's stop detail has the privacy boundary of a rider's manifest read. Its `ETag` is the token the arrival hands back for
 *   the same stop, and it moves when the stop does.
 * - **Access follows the manifest's**: staff by the hubs of the grant (`HUB_SCOPE_VIOLATION` outside them, `NOT_FOUND` for an id that matches
 *   nothing, and an audited crossing for an authorised read of another hub), a rider by assignment and from dispatch only, and every other
 *   stop is answered to a rider exactly as one that does not exist. A vendor is refused (the vendor's read of its own stop is a deferred
 *   capability, OB-S1-23).
 */
const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const ARRIVE = (id: string) => `${STOP(id)}/arrive`;
const REQUESTS = `${API}/pickup-requests`;
const REASON = 'FIXTURE_CANCEL_CUSTOMER_STOP_READ';
const ETAG_SHAPE = /^"[A-Za-z0-9_-]{43}"$/;

let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let opsB: Actor;
let wide: Actor;
let canceller: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor({ hubId: HUB_B });
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  canceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  // Reaches both hubs for the reading key (an all-hub grant) with a primary hub of its own: its read of the other hub is a crossing.
  wide = await routes.actor(
    await newBundle(routes.admin, [grant('pickup.read', 'all', 'any', 'A')]),
    HUB_A,
  );
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
  readonly skipped: Record<string, unknown> | null;
  readonly pickup_summary?: Record<string, unknown>;
}
interface Manifest {
  readonly stops: Stop[];
}
const stopOf = (response: TestResponse): Stop => response.json() as Stop;
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** What two answers must share to be indistinguishable: everything but the request's own identifier. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
  cookies: response.setCookies,
});

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    ...over,
  });

const onlyStop = (arranged: ArrangedRun): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

async function cancelRequest(id: string): Promise<TestResponse> {
  const etag = (await canceller.client.get(`${REQUESTS}/${id}`)).header('etag') ?? '';
  return canceller.client.post(
    `${REQUESTS}/${id}/cancel`,
    { reason_code: REASON, apply_charge: false, charge_reason_code: REASON },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

describe('getPickupStop: what it shows', () => {
  // Break caught: a read that shows more or less than the stop the manifest read shows (a member added from the row, the request or the
  // vendor; the summary left out; a different projection for the rider), which would give a rider's stop detail another privacy boundary
  // than its manifest read has.
  it('is the stop of the manifest read, member for member, for staff and for the rider', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const staff = await ops.client.get(STOP(stop.id));
    const rider = await arranged.rider.client.get(STOP(stop.id));
    expect(staff.status).toBe(200);
    expect(rider.status).toBe(200);

    const inManifest = (
      (await ops.client.get(MANIFEST(arranged.manifest.id))).json() as Manifest
    ).stops.find((each) => each.id === stop.id);
    expect(stopOf(staff)).toEqual(inManifest);
    expect(stopOf(rider)).toEqual(inManifest);
    // The closed projection of the contract, and no other member: the request, the vendor, the payer and the price are not here.
    expect(Object.keys(stopOf(staff)).toSorted()).toEqual(
      [
        'arrived_at',
        'failure',
        'failure_category',
        'id',
        'pickup_manifest_id',
        'pickup_request_id',
        'pickup_summary',
        'sequence',
        'skipped',
        'state',
      ].toSorted(),
    );
    expect(Object.keys(stopOf(staff).pickup_summary ?? {}).toSorted()).toEqual(
      [
        'contact_phone',
        'declared_package_count',
        'location_note',
        'reference',
        'resolved_pickup_location',
        'sender_display_name',
      ].toSorted(),
    );
    // The rider's read is the staff's: one version of one stop.
    expect(rider.header('etag')).toBe(staff.header('etag'));
    expect(staff.header('etag')).toMatch(ETAG_SHAPE);
  });

  // Break caught: a token that is not the one the stop's operations hand out and take, or one that does not move with the stop. The arrival
  // returns the stop and its token; the read afterwards returns the same two, and the read before it a different token.
  it('hands out the token the arrival hands back for the same stop, and moves it with the stop', async () => {
    const arranged = await run({ state: 'IN_PROGRESS', stops: 1 });
    const stop = onlyStop(arranged);
    const before = await arranged.rider.client.get(STOP(stop.id));
    expect(before.status).toBe(200);
    const arrived = await arranged.rider.client.post(ARRIVE(stop.id), undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(arrived.status).toBe(200);
    const after = await arranged.rider.client.get(STOP(stop.id));
    expect(after.header('etag')).toBe(arrived.header('etag'));
    expect(after.json()).toEqual(arrived.json());
    expect(after.header('etag')).not.toBe(before.header('etag'));
    // Reading again changes nothing: a read is not a change.
    expect((await arranged.rider.client.get(STOP(stop.id))).header('etag')).toBe(
      after.header('etag'),
    );
  });

  // Break caught: the skip a cancellation makes shown with more than the system's own reason (the cancellation's note is Ops's, and a rider is
  // not shown it), or a skipped stop shown as one still to be worked.
  it('shows the stop a cancellation skipped as skipped, with the system’s reason and no note', async () => {
    const arranged = await run({ stops: 1 });
    const stop = onlyStop(arranged);
    const before = await arranged.rider.client.get(STOP(stop.id));
    expect((await cancelRequest(stop.requestId)).status).toBe(200);
    const after = await arranged.rider.client.get(STOP(stop.id));
    expect(after.status).toBe(200);
    expect(stopOf(after)).toMatchObject({
      state: 'SKIPPED',
      skipped: { reason_code: 'REQUEST_CANCELLED' },
    });
    expect(Object.keys(stopOf(after).skipped ?? {}).toSorted()).toEqual([
      'reason_code',
      'skipped_at',
    ]);
    expect(after.header('etag')).not.toBe(before.header('etag'));
  });
});

describe('getPickupStop: who may read which stop', () => {
  // Break caught: a stop of another hub shown to staff outside the grant, or told from one that does not exist when it should not be, or
  // the reverse (the contract says where it is for a staff reader, as for a manifest).
  it('tells a staff reader a stop outside its hubs from one that does not exist, and reaches every hub of an all-hub grant', async () => {
    const own = await run({ stops: 1 });
    const other = await run({
      stops: 1,
      hubId: HUB_B,
      vendorOrganizationId: vendorB.row.organizationId,
    });
    const ownStop = onlyStop(own);
    const otherStop = onlyStop(other);
    expect((await ops.client.get(STOP(ownStop.id))).status).toBe(200);
    expect((await opsB.client.get(STOP(otherStop.id))).status).toBe(200);

    const outside = await ops.client.get(STOP(otherStop.id));
    expect(outcome(outside)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcome(await ops.client.get(STOP(randomUUID())))).toEqual([404, 'NOT_FOUND']);
    expect(outside.text).not.toContain(otherStop.requestCode);
    expect(outside.text).not.toContain(otherStop.requestId);

    expect((await wide.client.get(STOP(otherStop.id))).status).toBe(200);
    expect((await wide.client.get(STOP(ownStop.id))).status).toBe(200);
  });

  // Break caught: an authorised read of another hub that leaves no record, an own-hub read recorded as a crossing, a rider's read recorded
  // as one, or a record that carries the stop's contents.
  it('writes one hub-boundary event for the stop of another hub, none for its own hub, and none for a rider', async () => {
    const own = onlyStop(await run({ stops: 1 }));
    const other = onlyStop(
      await run({ stops: 1, hubId: HUB_B, vendorOrganizationId: vendorB.row.organizationId }),
    );
    // An actor of its own, so that the crossings other tests of this file made as `wide` are not in the count.
    const reader = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'all', 'any', 'A')]),
      HUB_A,
    );
    const events = () =>
      routes.rows<{ object_type: string; object_id: string; responsible_hub_id: string }>(
        `select object_type, object_id, responsible_hub_id from audit_event
          where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
        [reader.identity.id],
      );
    expect((await reader.client.get(STOP(own.id))).status).toBe(200);
    expect(await events()).toEqual([]);
    expect((await reader.client.get(STOP(other.id))).status).toBe(200);
    expect(await events()).toEqual([
      { object_type: 'PickupStop', object_id: other.id, responsible_hub_id: HUB_B },
    ]);
    expect(JSON.stringify(await events())).not.toContain(other.requestCode);

    const arranged = await run({ stops: 1 });
    expect((await arranged.rider.client.get(STOP(onlyStop(arranged).id))).status).toBe(200);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
        [arranged.rider.id],
      ),
    ).toEqual([]);
  });

  // Break caught: a rider shown a colleague's stop, or a stop of a draft or of a run cancelled before it went out, or told any of them apart
  // from an id that matches nothing. A run cancelled after its dispatch, and a completed one, stay readable to the rider they were assigned to.
  it('shows a rider the stops of its own dispatched runs, and answers every other stop as one that does not exist', async () => {
    const mine = await run({ stops: 1 });
    const colleague = await run({ stops: 1 });
    const draft = await run({ stops: 1, state: 'DRAFT', rider: mine.rider });
    const unsent = await run({
      stops: 1,
      state: 'CANCELLED',
      dispatchedBeforeCancel: false,
      rider: mine.rider,
    });
    const cancelledAfter = await run({
      stops: 1,
      state: 'CANCELLED',
      dispatchedBeforeCancel: true,
      stopState: 'SKIPPED',
      rider: mine.rider,
    });
    const completed = await run({
      stops: 1,
      state: 'COMPLETED',
      stopState: 'COLLECTED',
      rider: mine.rider,
    });

    for (const visible of [mine, cancelledAfter, completed]) {
      const answer = await mine.rider.client.get(STOP(onlyStop(visible).id));
      expect(answer.status, visible.manifest.state).toBe(200);
    }
    const nothing = shapeOf(await mine.rider.client.get(STOP(randomUUID())));
    expect(nothing.status).toBe(404);
    for (const hidden of [colleague, draft, unsent]) {
      const stop = onlyStop(hidden);
      const answer = await mine.rider.client.get(STOP(stop.id));
      expect(shapeOf(answer), hidden.manifest.state).toEqual(nothing);
      expect(answer.text).not.toContain(stop.id);
      expect(answer.text).not.toContain(stop.requestCode);
    }
  });

  // Break caught: access that stays with the rider a run was taken from, or does not reach the one it was given.
  it('follows a reassignment of the run at once', async () => {
    const arranged = await run({ stops: 1 });
    const stop = onlyStop(arranged);
    const second = await arrangedRider(routes.kit, routes.admin);
    expect((await arranged.rider.client.get(STOP(stop.id))).status).toBe(200);
    expect((await second.client.get(STOP(stop.id))).status).toBe(404);
    await routes.admin.query(`update pickup_manifest set assigned_rider_id = $2 where id = $1`, [
      arranged.manifest.id,
      second.id,
    ]);
    expect((await arranged.rider.client.get(STOP(stop.id))).status).toBe(404);
    expect((await second.client.get(STOP(stop.id))).status).toBe(200);
  });

  // Break caught: a vendor shown a stop, its own request's included, or told whether one exists (the vendor's read of its own stop is a
  // deferred capability, OB-S1-23), and a caller with no session reaching the service.
  it('refuses a vendor, whatever it asks for, in the same words, and a caller with no session', async () => {
    const arranged = await run({ stops: 1 });
    const stop = onlyStop(arranged);
    const real = await browser.get(STOP(stop.id));
    const missing = await browser.get(STOP(randomUUID()));
    expect(outcome(real)).toEqual([403, 'PERMISSION_DENIED']);
    expect(shapeOf(real)).toEqual(shapeOf(missing));
    expect(real.text).not.toContain(stop.requestCode);

    const anonymous = await routes.kit.client.fork().get(STOP(stop.id));
    expect(outcome(anonymous)).toEqual([401, 'SESSION_INVALID']);
  });

  it('refuses an id that is not a UUID as a validation failure', async () => {
    expect(outcome(await ops.client.get(STOP('not-a-uuid')))).toEqual([400, 'VALIDATION_FAILED']);
  });
});
