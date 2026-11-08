import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.21, the planning of a manifest before it goes out: `setManifestStopOrder`, `assignRider` and `cancelPickupManifest` (`AC-SLICE-001-12`
 * and `-19`; the Product Owner's decisions of 29 October and 1 and 2 November 2026; features/pickup/pickup-manifest.md sections 5.1 and 5.2;
 * state-machines.md sections 4 and 5).
 *
 * - **Ordering** sets the complete sequence of a draft, once however many times it is sent, and is judged against the manifest's `ETag`
 *   (which digests the stops, so a read that came before a request on the manifest was cancelled is stale).
 * - **Assigning** gives a draft manifest an active rider whom the caller's grant reaches, marks every confirmed request on it as having a
 *   rider (the moment a cancellation by the office becomes a chargeable decision) and leaves the manifest a draft, unseen by the rider.
 * - **Cancelling** takes a draft or a dispatched manifest to `CANCELLED`, skips the stops still to be worked with the system's reason and
 *   releases every claim, so the requests that are still confirmed return to the pool.
 * - Each is a staff act under its own key; a rider, a vendor and a caller without the key are refused (`AC-SLICE-001-19`: a rider cannot
 *   alter the membership or the order of a run).
 *
 * The dispatch of a manifest to its rider is not here: no stop reaches a rider until the stop summary is resolved (OB-S1-21).
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const STOPS = (id: string) => `${ONE(id)}/stops`;
const ASSIGN = (id: string) => `${ONE(id)}/assign-rider`;
const CANCEL = (id: string) => `${ONE(id)}/cancel`;
const REQUESTS = `${API}/pickup-requests`;
const CANCEL_REQUEST = (id: string) => `${REQUESTS}/${id}/cancel`;
const CUSTOMER_REASON = 'FIXTURE_CANCEL_CUSTOMER_PLANNING';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let browser: TestClient;
/** One Ops user for each kind of act: the rate limit counts the requests of a principal, and these tests make many. */
let maker: Actor;
let orderer: Actor;
let assigner: Actor;
let cancellerOfManifests: Actor;
let cancellerOfRequests: Actor;
let secondOrderer: Actor;
/** An officer whose grant reaches every hub: what a grant lets an officer see of a rider is not what makes the rider eligible for a manifest. */
let wideAssigner: Actor;

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
  orderer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  secondOrderer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  assigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  cancellerOfManifests = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  cancellerOfRequests = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  wideAssigner = await routes.actor(
    await newBundle(routes.admin, [
      grant('pickup.manifest.assign', 'all', 'any', 'A'),
      grant('pickup.read', 'all', 'any', 'A'),
    ]),
    HUB_A,
  );
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ($1, 'PICKUP_CANCELLATION', 'Fixture customer cancellation', 'CUSTOMER', false, true)`,
    [CUSTOMER_REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Stop {
  readonly id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: string;
  readonly skipped: { reason_code: string; skipped_at: string; note?: string } | null;
}
interface Manifest {
  readonly id: string;
  readonly state: string;
  readonly assigned_rider_id: string | null;
  readonly assigned_at: string | null;
  readonly dispatched_at: string | null;
  readonly stops: Stop[];
}
const manifestOf = (response: TestResponse): Manifest => response.json() as Manifest;
const violationsOf = (response: TestResponse): { in: string; pointer: string; rule: string }[] =>
  (response.json() as { details?: { violations?: never[] } }).details?.violations ?? [];
/** What an answer says, without the request it was made for: two refusals that must be told apart by nobody have the same shape. */
const shapeOf = (answer: TestResponse) => ({
  status: answer.status,
  body: { ...(answer.json() as Record<string, unknown>), request_id: undefined },
});
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const confirmed = async (assigned = false): Promise<string> => {
  const id = (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.day,
      }),
    )
  ).id;
  if (assigned) {
    await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [id]);
  }
  return id;
};

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

const read = (actor: Actor | TestClient, id: string): Promise<TestResponse> =>
  ('client' in actor ? actor.client : actor).get(ONE(id));

const orderOf = (
  actor: Actor,
  id: string,
  ids: readonly string[],
  etag: string | undefined,
  key: string | null = randomUUID(),
): Promise<TestResponse> =>
  actor.client.put(
    STOPS(id),
    { ordered_stop_ids: ids },
    {
      origin: OPS,
      headers: {
        ...(etag === undefined ? {} : { 'If-Match': etag }),
        ...(key === null ? {} : { 'Idempotency-Key': key }),
      },
    },
  );

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

const cancelOf = (
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
  etag: string | undefined,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  actor.client.post(CANCEL(id), body, {
    origin: OPS,
    headers: {
      ...(etag === undefined ? {} : { 'If-Match': etag }),
      'Idempotency-Key': key,
    },
  });

const cancelRequest = async (
  id: string,
  body: Record<string, unknown> = {},
): Promise<TestResponse> => {
  const etag = (await cancellerOfRequests.client.get(`${REQUESTS}/${id}`)).header('etag') ?? '';
  return cancellerOfRequests.client.post(
    CANCEL_REQUEST(id),
    { reason_code: CUSTOMER_REASON, ...body },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
};

const rider = async (overrides: Parameters<typeof riderRow>[0] = {}) =>
  insertRider(routes.admin, riderRow({ hubId: HUB_A, ...overrides }));

async function arrangedRiderSession(): Promise<{ id: string; client: TestClient }> {
  const row = await rider();
  const device = await insertRiderDevice(routes.admin, row.id);
  const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
    principalId: row.id,
    registeredDeviceId: device.id,
  });
  return { id: row.id, client: routes.kit.client.fork().bearer(session.token) };
}

const manifestRowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      assigned_rider_id: string | null;
      assigned_at: Date | null;
    }>(`select state, version, assigned_rider_id, assigned_at from pickup_manifest where id = $1`, [
      id,
    ])
  )[0];

const stopRowsOf = (manifestId: string) =>
  routes.rows<{
    id: string;
    pickup_request_id: string;
    sequence: number;
    state: string;
    released_at: Date | null;
    skip_snapshot: { reason_code: string; label: string; skipped_at: string } | null;
    version: number;
  }>(
    `select id, pickup_request_id, sequence, state, released_at, skip_snapshot, version
       from pickup_stop where pickup_manifest_id = $1 order by sequence, id`,
    [manifestId],
  );

const eventsOf = (code: string, objectId: string) =>
  routes.rows<{
    actor_id: string | null;
    enhanced: boolean;
    object_type: string;
    responsible_hub_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    reason_code: string | null;
    note: string | null;
    related_ids: Record<string, unknown> | null;
    detail: Record<string, unknown>;
  }>(
    `select actor_id, enhanced, object_type, responsible_hub_id, previous_state, resulting_state, reason_code, note, related_ids, detail
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

describe('setManifestStopOrder: the complete sequence of a draft', () => {
  // Break caught: a sequence not applied (the stops keep their numbers), numbered from the wrong place, or answered with the old order; a
  // read that does not agree with the answer; an ETag that does not move with the order; a version that moves though the manifest's row did
  // not change; and an event that does not carry the order.
  it('numbers the stops by place, answers and reads the new order, moves the ETag and not the version, and records the order', async () => {
    const { manifest, etag } = await draftOf(3);
    const [first, second, third] = manifest.stops.map((stop) => stop.id) as [
      string,
      string,
      string,
    ];
    const answer = await orderOf(orderer, manifest.id, [third, first, second], etag);
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).not.toBe(etag);
    expect(manifestOf(answer).stops.map((stop) => [stop.id, stop.sequence])).toEqual([
      [third, 1],
      [first, 2],
      [second, 3],
    ]);
    const reread = await read(orderer, manifest.id);
    expect(reread.header('etag')).toBe(answer.header('etag'));
    expect(reread.json()).toEqual(answer.json());
    expect((await stopRowsOf(manifest.id)).map((row) => [row.id, row.sequence])).toEqual([
      [third, 1],
      [first, 2],
      [second, 3],
    ]);
    expect((await manifestRowOf(manifest.id))?.version).toBe(1);
    expect(await eventsOf('pickup.manifest.stops_ordered', manifest.id)).toEqual([
      expect.objectContaining({
        actor_id: orderer.identity.id,
        enhanced: false,
        object_type: 'PickupManifest',
        responsible_hub_id: HUB_A,
        related_ids: { ordered_stop_ids: [third, first, second] },
        detail: { stop_count: 3 },
      }),
    ]);
  });

  // Break caught: the order the manifest already has refused as a change, or an ETag that moves though nothing did.
  it('accepts the order the manifest already has, and leaves its ETag as it was', async () => {
    const { manifest, etag } = await draftOf(2);
    const answer = await orderOf(
      orderer,
      manifest.id,
      manifest.stops.map((stop) => stop.id),
      etag,
    );
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).toBe(etag);
  });

  // Break caught: a delta accepted as a sequence, a stop named twice, or a stranger's id taken into this manifest's order; and faults
  // reported one at a time.
  it('refuses a list that leaves a stop out, repeats one or names a stranger, together, and changes nothing', async () => {
    const { manifest, etag } = await draftOf(3);
    const [a, b] = manifest.stops.map((stop) => stop.id) as [string, string, string];
    const stranger = randomUUID();
    const answer = await orderOf(orderer, manifest.id, [b, stranger, b, a], etag);
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([
      { in: 'body', pointer: '/ordered_stop_ids/1', rule: 'not_on_manifest' },
      { in: 'body', pointer: '/ordered_stop_ids/2', rule: 'duplicate' },
      { in: 'body', pointer: '/ordered_stop_ids', rule: 'incomplete' },
    ]);
    expect(answer.text).not.toContain(stranger);
    expect((await read(orderer, manifest.id)).header('etag')).toBe(etag);
    expect(await eventsOf('pickup.manifest.stops_ordered', manifest.id)).toEqual([]);
  });

  // Break caught: the order of a manifest that has gone out, or been cancelled, changed (a rider would be working a sequence nobody gave it).
  it('is refused for a manifest that is not a draft, whatever its ETag', async () => {
    const rid = (await rider()).id;
    for (const state of ['DISPATCHED', 'CANCELLED', 'IN_PROGRESS'] as const) {
      const arranged = await insertManifest(
        routes.admin,
        manifestRow(HUB_A, { state, assignedRiderId: rid, serviceDate: days.day }),
      );
      await insertStop(routes.admin, stopRow(arranged, await confirmed(), 1));
      const seen = await read(orderer, arranged.id);
      const ids = manifestOf(seen).stops.map((stop) => stop.id);
      const answer = await orderOf(orderer, arranged.id, ids, seen.header('etag') ?? undefined);
      expect(outcome(answer), state).toEqual([409, 'STATE_CONFLICT']);
    }
  });

  // Break caught: ordering closed by the assignment of a rider (the contract says it stays open until dispatch).
  it('stays open across the assignment of a rider', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    expect(requests).toHaveLength(2);
    const [a, b] = manifestOf(assigned).stops.map((stop) => stop.id) as [string, string];
    const answer = await orderOf(
      orderer,
      manifest.id,
      [b, a],
      assigned.header('etag') ?? undefined,
    );
    expect(answer.status).toBe(200);
    expect(manifestOf(answer).stops.map((stop) => stop.id)).toEqual([b, a]);
  });

  // Break caught: an If-Match that is not the manifest's current token accepted (a lost update), one that is missing (the header is
  // required) or not a token, and a read that came before a request on the manifest was cancelled still good (the ETag must digest the stops).
  it('refuses a missing, malformed or stale If-Match, and the read that came before a request on the manifest was cancelled', async () => {
    const { manifest, etag, requests } = await draftOf(3);
    const ids = manifest.stops.map((stop) => stop.id);
    expect(outcome(await orderOf(orderer, manifest.id, ids, undefined))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    // A token that is malformed, and one that is well formed and is another manifest's, are stale.
    const elsewhere = await draftOf(1);
    for (const token of ['"not-the-current-token"', elsewhere.etag]) {
      expect(outcome(await orderOf(orderer, manifest.id, ids, token)), token).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
    }

    expect((await cancelRequest(requests[1] ?? '')).status).toBe(200);
    expect(outcome(await orderOf(orderer, manifest.id, [...ids].reverse(), etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    const fresh = await read(orderer, manifest.id);
    expect(fresh.header('etag')).not.toBe(etag);
    const [first, skipped, last] = ids as [string, string, string];
    // The stop skipped because its request was cancelled keeps its place (the second); the others are ordered around it.
    const moved = await orderOf(
      orderer,
      manifest.id,
      [skipped, first, last],
      fresh.header('etag') ?? undefined,
    );
    expect([moved.status, codeOf(moved)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(moved)).toEqual([
      { in: 'body', pointer: '/ordered_stop_ids/0', rule: 'resolved_stop_moved' },
    ]);
    const around = await orderOf(
      orderer,
      manifest.id,
      [last, skipped, first],
      fresh.header('etag') ?? undefined,
    );
    expect(around.status).toBe(200);
    expect(manifestOf(around).stops.map((stop) => [stop.id, stop.sequence, stop.state])).toEqual([
      [last, 1, 'PENDING'],
      [skipped, 2, 'SKIPPED'],
      [first, 3, 'PENDING'],
    ]);
    expect(manifestOf(around).stops[1]?.skipped?.reason_code).toBe('REQUEST_CANCELLED');
  });

  // Break caught: a command sent again that is applied again (a second event), or answered differently; or another order under the key
  // answered as a replay.
  it('answers the same command again as it was answered, writes one event, and refuses another body under the key', async () => {
    const { manifest, etag } = await draftOf(3);
    const [a, b, c] = manifest.stops.map((stop) => stop.id) as [string, string, string];
    const key = randomUUID();
    const first = await orderOf(orderer, manifest.id, [c, b, a], etag, key);
    const second = await orderOf(orderer, manifest.id, [c, b, a], etag, key);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.text).toBe(first.text);
    expect(second.header('etag')).toBe(first.header('etag'));
    expect(await eventsOf('pickup.manifest.stops_ordered', manifest.id)).toHaveLength(1);
    const other = await orderOf(orderer, manifest.id, [a, b, c], etag, key);
    expect(outcome(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(outcome(await orderOf(orderer, manifest.id, [a, b, c], etag, null))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  // Break caught: two officers who read the same manifest both succeeding (the second overwriting the first without having seen it).
  it('lets one of two officers who hold the same ETag win, and tells the other to read again', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { manifest, etag } = await draftOf(3);
      const ids = manifest.stops.map((stop) => stop.id);
      const [one, two] = await Promise.all([
        orderOf(orderer, manifest.id, [...ids].reverse(), etag),
        orderOf(secondOrderer, manifest.id, [ids[1] ?? '', ids[0] ?? '', ids[2] ?? ''], etag),
      ]);
      const outcomes = [one, two].map(outcome);
      expect(
        outcomes.filter(([status]) => status === 200),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
      expect(outcomes).toContainEqual([409, 'STATE_CONFLICT']);
      const winner = one.status === 200 ? one : two;
      expect(manifestOf(winner).stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
      const rows = await stopRowsOf(manifest.id);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(await eventsOf('pickup.manifest.stops_ordered', manifest.id)).toHaveLength(1);
    }
  });

  // Break caught: the order of a run changed by someone who does not plan it (AC-19), or by a caller with the assignment key alone.
  it('is refused to a vendor, a rider, a holder of another key and a caller with no session', async () => {
    const { manifest, etag } = await draftOf(2);
    const ids = manifest.stops.map((stop) => stop.id);
    const body = { ordered_stop_ids: [...ids].reverse() };
    const headers = { 'If-Match': etag, 'Idempotency-Key': randomUUID() };

    const asVendor = await browser.put(STOPS(manifest.id), body, { origin: OPS, headers });
    const asRider = await (
      await arrangedRiderSession()
    ).client.put(STOPS(manifest.id), body, {
      headers,
    });
    const none = await routes.kit.client
      .fork()
      .put(STOPS(manifest.id), body, { origin: OPS, headers });
    for (const answer of [asVendor, asRider, none]) expect([401, 403]).toContain(answer.status);

    const onlyAssign = await routes.actor(
      await newBundle(routes.admin, [
        grant('pickup.manifest.assign', 'all', 'any', 'A'),
        grant('pickup.read', 'all', 'any', 'A'),
      ]),
      HUB_A,
    );
    expect(outcome(await orderOf(onlyAssign, manifest.id, ids, etag))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect((await read(orderer, manifest.id)).header('etag')).toBe(etag);
  });

  // Break caught: a manifest of another hub told apart from one that does not exist wrongly (the guard's answers: HUB_SCOPE_VIOLATION for
  // an Ops user on a foreign manifest, NOT_FOUND for an id that matches nothing), or changed.
  it('tells a manifest of another hub from one that does not exist, and changes neither', async () => {
    const foreign = await insertManifest(routes.admin, manifestRow(HUB_B));
    const seeded = await insertStop(routes.admin, stopRow(foreign, await confirmed(), 1));
    expect(outcome(await orderOf(orderer, foreign.id, [seeded.id], '"x"'))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await orderOf(orderer, randomUUID(), [randomUUID()], '"x"'))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect((await stopRowsOf(foreign.id)).map((row) => row.sequence)).toEqual([1]);
  });

  // Break caught: a body the contract's schema refuses reaching the service.
  it.each([
    ['no list', {}],
    ['an empty list', { ordered_stop_ids: [] }],
    ['a list that is not a list', { ordered_stop_ids: randomUUID() }],
    ['an id that is not a UUID', { ordered_stop_ids: ['nope'] }],
    ['a member of its own', { ordered_stop_ids: [randomUUID()], sequence: 1 }],
  ])('refuses %s as a validation failure', async (_label, body) => {
    const { manifest, etag } = await draftOf(1);
    const answer = await orderer.client.put(STOPS(manifest.id), body, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    });
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('assignRider: a rider for a draft', () => {
  // Break caught: an assignment that does not record the rider and the moment, that dispatches or starts the manifest, that marks no request
  // (the vendor window and the charge read it), that marks a request that is no longer confirmed, or that writes no event.
  it('records the rider and the moment, marks the confirmed requests, leaves the manifest a draft and writes the event', async () => {
    const { manifest, etag, requests } = await draftOf(3);
    // One request is cancelled before the assignment: its stop is skipped and the request is frozen, so it is not marked and does not stop it.
    expect((await cancelRequest(requests[2] ?? '')).status).toBe(200);
    const seen = await read(assigner, manifest.id);
    const riderRow = await rider();

    const answer = await assignOf(
      assigner,
      manifest.id,
      riderRow.id,
      seen.header('etag') ?? undefined,
    );
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).not.toBe(etag);
    expect(manifestOf(answer)).toMatchObject({
      state: 'DRAFT',
      assigned_rider_id: riderRow.id,
      dispatched_at: null,
    });
    expect(manifestOf(answer).assigned_at).not.toBeNull();
    expect(await manifestRowOf(manifest.id)).toMatchObject({
      state: 'DRAFT',
      assigned_rider_id: riderRow.id,
      version: 2,
    });
    expect(
      await routes.rows(
        `select id, rider_assigned from pickup_request where id = any($1::uuid[]) order by id`,
        [requests],
      ),
    ).toEqual(requests.toSorted().map((id) => ({ id, rider_assigned: id !== requests[2] })));
    expect(await eventsOf('pickup.manifest.rider_assigned', manifest.id)).toEqual([
      expect.objectContaining({
        actor_id: assigner.identity.id,
        enhanced: false,
        object_type: 'PickupManifest',
        responsible_hub_id: HUB_A,
        previous_state: 'DRAFT',
        resulting_state: 'DRAFT',
        related_ids: { rider_id: riderRow.id },
        detail: { requests_marked: 2 },
      }),
    ]);
  });

  // Break caught (AC-12): a vendor who can cancel a confirmed request after assignment, an office cancellation that is refused, or one that
  // needs no decision on the charge now that a rider is assigned.
  it('closes the vendor’s window and makes a cancellation by the office a chargeable decision', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const [held, other] = requests as [string, string];
    const etagOfRequest = async (client: TestClient, id: string): Promise<string> =>
      (await client.get(`${REQUESTS}/${id}`)).header('etag') ?? '';
    const vendorCancel = async (id: string) =>
      browser.post(
        CANCEL_REQUEST(id),
        { reason_code: CUSTOMER_REASON },
        {
          headers: {
            'If-Match': await etagOfRequest(browser, id),
            'Idempotency-Key': randomUUID(),
          },
        },
      );
    expect(outcome(await vendorCancel(held))).toEqual([403, 'PERMISSION_DENIED']);

    expect((await assignOf(assigner, manifest.id, (await rider()).id, etag)).status).toBe(200);
    expect(outcome(await vendorCancel(held))).toEqual([403, 'PERMISSION_DENIED']);

    // The office still cancels, and must now say whether to charge.
    const undecided = await cancelRequest(held);
    expect(outcome(undecided)).toEqual([422, 'REASON_REQUIRED']);
    const decided = await cancelRequest(held, {
      apply_charge: false,
      charge_reason_code: CUSTOMER_REASON,
    });
    expect(decided.status).toBe(200);
    expect(decided.json()).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'NOT_APPLIED',
    });
    expect(other).toBeDefined();
  });

  // Break caught: a rider who is not active, who does not exist or is out of the caller's grant accepted, or told apart from the others.
  it('refuses a rider who is not active, does not exist or is outside the grant, alike, and changes nothing', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const candidates = [
      (await rider({ status: 'SUSPENDED' })).id,
      (await rider({ status: 'OFFBOARDED' })).id,
      (await rider({ status: 'INACTIVE' })).id,
      (await rider({ status: 'TEMPORARILY_UNAVAILABLE' })).id,
      (await rider({ hubId: HUB_B })).id,
      randomUUID(),
    ];
    const answers: TestResponse[] = [];
    for (const id of candidates) answers.push(await assignOf(assigner, manifest.id, id, etag));
    for (const answer of answers) expect(outcome(answer)).toEqual([422, 'RIDER_UNAVAILABLE']);
    const shape = (answer: TestResponse) => ({
      status: answer.status,
      body: { ...(answer.json() as Record<string, unknown>), request_id: undefined },
    });
    const [reference] = answers;
    if (reference === undefined) throw new Error('no answer was given');
    for (const answer of answers) expect(shape(answer)).toEqual(shape(reference));

    expect(await manifestRowOf(manifest.id)).toMatchObject({ assigned_rider_id: null, version: 1 });
    expect(
      await routes.rows(`select rider_assigned from pickup_request where id = any($1::uuid[])`, [
        requests,
      ]),
    ).toEqual([{ rider_assigned: false }, { rider_assigned: false }]);
    expect(await eventsOf('pickup.manifest.rider_assigned', manifest.id)).toEqual([]);
  });

  // Break caught (the Product Owner's decision of 2 November 2026, on the reviewer's recommendation): the reach of an officer's grant standing in for a rider's hub, so that a rider of
  // another hub is given a manifest because the officer can see both. A rider works for the hub they belong to (`primary_hub_id`); the
  // temporary assignment that could say otherwise (`HubAssignment`, section 30.5) is not built, so nothing makes a rider eligible elsewhere.
  it('refuses a rider of another hub even to an officer whose grant reaches both, in the answer it gives for a rider that does not exist', async () => {
    const { manifest, etag } = await draftOf(2);
    const elsewhere = await rider({ hubId: HUB_B });
    const refused = await assignOf(wideAssigner, manifest.id, elsewhere.id, etag);
    expect(outcome(refused)).toEqual([422, 'RIDER_UNAVAILABLE']);
    const nobody = await assignOf(wideAssigner, manifest.id, randomUUID(), etag);
    expect(shapeOf(refused)).toEqual(shapeOf(nobody));
    expect(await manifestRowOf(manifest.id)).toMatchObject({ assigned_rider_id: null, version: 1 });
    expect(await eventsOf('pickup.manifest.rider_assigned', manifest.id)).toEqual([]);

    // The officer's reach is not the limit: a rider of the manifest's own hub is given it, by the same officer.
    const own = await rider();
    const given = await assignOf(wideAssigner, manifest.id, own.id, etag);
    expect(given.status).toBe(200);
    expect(manifestOf(given).assigned_rider_id).toBe(own.id);
  });

  // Break caught: the rider the manifest already has treated as a change (a second event, a new moment), or a replacement that reopens the
  // vendor's window by unmarking the requests.
  it('changes nothing when the rider is the one it has, and replaces the rider of a draft with a new moment', async () => {
    const { manifest, etag, requests } = await draftOf(2);
    const first = await rider();
    const second = await rider();
    const one = await assignOf(assigner, manifest.id, first.id, etag);
    expect(one.status).toBe(200);
    const again = await assignOf(assigner, manifest.id, first.id, one.header('etag') ?? undefined);
    expect(again.status).toBe(200);
    expect(again.header('etag')).toBe(one.header('etag'));
    expect(await eventsOf('pickup.manifest.rider_assigned', manifest.id)).toHaveLength(1);

    const replaced = await assignOf(
      assigner,
      manifest.id,
      second.id,
      one.header('etag') ?? undefined,
    );
    expect(replaced.status).toBe(200);
    expect(manifestOf(replaced).assigned_rider_id).toBe(second.id);
    const events = await eventsOf('pickup.manifest.rider_assigned', manifest.id);
    expect(events.map((event) => event.related_ids)).toEqual([
      { rider_id: first.id },
      { rider_id: second.id, previous_rider_id: first.id },
    ]);
    expect(
      await routes.rows(`select rider_assigned from pickup_request where id = any($1::uuid[])`, [
        requests,
      ]),
    ).toEqual([{ rider_assigned: true }, { rider_assigned: true }]);
  });

  // Break caught: a rider shown a draft because it was assigned (the stops reach a rider from dispatch, never from assignment).
  it('does not show the rider the manifest: a draft is unseen by the rider it is assigned to', async () => {
    const { manifest, etag } = await draftOf(1);
    const session = await arrangedRiderSession();
    expect((await assignOf(assigner, manifest.id, session.id, etag)).status).toBe(200);
    expect(outcome(await read(session.client, manifest.id))).toEqual([404, 'NOT_FOUND']);
    const listed = await session.client.get(`${LIST}?page_size=100`);
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  });

  // Break caught: a manifest that has gone out given another rider by this act (the dispatch task owns that: its stops reach the rider),
  // or a stale token accepted.
  it('is of a draft only, and judged against the ETag', async () => {
    const riderId = (await rider()).id;
    const dispatched = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: riderId, serviceDate: days.day }),
    );
    await insertStop(routes.admin, stopRow(dispatched, await confirmed(), 1));
    const seen = await read(assigner, dispatched.id);
    expect(
      outcome(
        await assignOf(
          assigner,
          dispatched.id,
          (await rider()).id,
          seen.header('etag') ?? undefined,
        ),
      ),
    ).toEqual([409, 'STATE_CONFLICT']);

    const { manifest } = await draftOf(1);
    const elsewhere = await draftOf(1);
    expect(outcome(await assignOf(assigner, manifest.id, riderId, elsewhere.etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(outcome(await assignOf(assigner, manifest.id, riderId, '"stale"'))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(outcome(await assignOf(assigner, manifest.id, riderId, undefined))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  // Break caught: the assignment open to a holder of the creating key alone, to a vendor or a rider, or a foreign hub's manifest changed.
  it('needs its own key, and is refused to a vendor, a rider and a caller with no session', async () => {
    const { manifest, etag } = await draftOf(1);
    const riderId = (await rider()).id;
    const body = { rider_id: riderId };
    const headers = { 'If-Match': etag };
    const asVendor = await browser.post(ASSIGN(manifest.id), body, { origin: OPS, headers });
    const asRider = await (
      await arrangedRiderSession()
    ).client.post(ASSIGN(manifest.id), body, {
      headers,
    });
    const none = await routes.kit.client
      .fork()
      .post(ASSIGN(manifest.id), body, { origin: OPS, headers });
    for (const answer of [asVendor, asRider, none]) expect([401, 403]).toContain(answer.status);

    const onlyCreate = await routes.actor(
      await newBundle(routes.admin, [
        grant('pickup.manifest.create', 'all', 'any', 'A'),
        grant('pickup.read', 'all', 'any', 'A'),
      ]),
      HUB_A,
    );
    expect(outcome(await assignOf(onlyCreate, manifest.id, riderId, etag))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);

    const foreign = await insertManifest(routes.admin, manifestRow(HUB_B));
    expect(outcome(await assignOf(assigner, foreign.id, riderId, '"x"'))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await assignOf(assigner, randomUUID(), riderId, '"x"'))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await manifestRowOf(manifest.id)).toMatchObject({ assigned_rider_id: null });
  });

  it.each([
    ['no rider', {}],
    ['a rider that is not a UUID', { rider_id: 'nope' }],
    ['a member of its own', { rider_id: randomUUID(), state: 'DISPATCHED' }],
  ])('refuses %s as a validation failure', async (_label, body) => {
    const { manifest, etag } = await draftOf(1);
    const answer = await assigner.client.post(ASSIGN(manifest.id), body, {
      origin: OPS,
      headers: { 'If-Match': etag },
    });
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('cancelPickupManifest: a manifest that has not started', () => {
  // Break caught: a cancellation that leaves a stop to be worked, a claim held, the manifest not cancelled, or no record of the act and of
  // each stop it skipped; a note that is not recorded; an ETag that does not move.
  it('cancels a draft: the stops are skipped, the claims released, the act and each skipped stop recorded', async () => {
    const { manifest, etag } = await draftOf(3);
    const answer = await cancelOf(
      cancellerOfManifests,
      manifest.id,
      { note: 'The vendor closed for the day' },
      etag,
    );
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).not.toBe(etag);
    expect(manifestOf(answer).state).toBe('CANCELLED');
    expect(manifestOf(answer).stops.map((stop) => [stop.state, stop.skipped?.reason_code])).toEqual(
      [
        ['SKIPPED', 'MANIFEST_CANCELLED'],
        ['SKIPPED', 'MANIFEST_CANCELLED'],
        ['SKIPPED', 'MANIFEST_CANCELLED'],
      ],
    );
    expect(JSON.stringify(manifestOf(answer))).not.toContain('closed for the day');
    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'CANCELLED' });
    const rows = await stopRowsOf(manifest.id);
    expect(rows.map((row) => row.state)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
    expect(rows.every((row) => row.released_at !== null)).toBe(true);
    expect(rows[0]?.skip_snapshot).toMatchObject({
      reason_code: 'MANIFEST_CANCELLED',
      label: 'Manifest cancelled',
    });

    expect(await eventsOf('pickup.manifest.cancelled', manifest.id)).toEqual([
      expect.objectContaining({
        actor_id: cancellerOfManifests.identity.id,
        enhanced: false,
        responsible_hub_id: HUB_A,
        previous_state: 'DRAFT',
        resulting_state: 'CANCELLED',
        note: 'The vendor closed for the day',
        detail: { stops_skipped: 3, claims_released: 3, commitments_ended: 0 },
      }),
    ]);
    for (const row of rows) {
      expect(await eventsOf('pickup.stop.skipped', row.id)).toEqual([
        expect.objectContaining({
          previous_state: 'PENDING',
          resulting_state: 'SKIPPED',
          reason_code: 'MANIFEST_CANCELLED',
          detail: { cause: 'MANIFEST_CANCELLATION' },
        }),
      ]);
    }
  });

  // Break caught: a released claim that does not return the request to the pool (it could not be built into a run again), or a cancelled
  // request that returns to it; and a stop already skipped by a cancellation overwritten with the manifest's reason.
  it('returns the requests that are still confirmed to the pool and builds them into a new manifest, and keeps the reason of a stop already skipped', async () => {
    const { manifest, etag, requests } = await draftOf(3);
    const [cancelled, free1, free2] = requests as [string, string, string];
    expect((await cancelRequest(cancelled)).status).toBe(200);
    const seen = await read(cancellerOfManifests, manifest.id);
    const answer = await cancelOf(
      cancellerOfManifests,
      manifest.id,
      { note: 'Replanned' },
      seen.header('etag') ?? undefined,
    );
    expect(answer.status).toBe(200);
    expect(etag).toBeDefined();
    const stops = manifestOf(answer).stops;
    expect(stops.find((stop) => stop.pickup_request_id === cancelled)?.skipped?.reason_code).toBe(
      'REQUEST_CANCELLED',
    );
    expect(
      stops
        .filter((stop) => stop.pickup_request_id !== cancelled)
        .map((stop) => stop.skipped?.reason_code),
    ).toEqual(['MANIFEST_CANCELLED', 'MANIFEST_CANCELLED']);
    const rows = await stopRowsOf(manifest.id);
    expect(rows.every((row) => row.released_at !== null)).toBe(true);
    const events = await eventsOf('pickup.manifest.cancelled', manifest.id);
    expect(events[0]?.detail).toEqual({
      stops_skipped: 2,
      claims_released: 3,
      commitments_ended: 0,
    });
    // The stop already skipped has no second skip event.
    const already = rows.find((row) => row.pickup_request_id === cancelled);
    expect(await eventsOf('pickup.stop.skipped', already?.id ?? '')).toHaveLength(1);

    const pool = async (): Promise<string[]> => {
      const found: string[] = [];
      let token: string | null = null;
      do {
        const page: TestResponse = await maker.client.get(
          `${REQUESTS}?state=CONFIRMED&manifested=false&page_size=100${token === null ? '' : `&page_token=${token}`}`,
        );
        const body = page.json() as { items: { id: string }[]; next_page_token: string | null };
        found.push(...body.items.map((item) => item.id));
        token = body.next_page_token;
      } while (token !== null);
      return found;
    };
    const inPool = await pool();
    expect(inPool).toEqual(expect.arrayContaining([free1, free2]));
    expect(inPool).not.toContain(cancelled);

    const rebuilt = await maker.client.post(
      LIST,
      { pickup_request_ids: [free1, free2], service_date: days.day },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(rebuilt.status).toBe(201);
  });

  // Break caught: a dispatched manifest that cannot be cancelled, or a rider who is no longer shown it (the handset must learn it is off).
  it('cancels a dispatched manifest, which its rider still reads, cancelled', async () => {
    const session = await arrangedRiderSession();
    const dispatched = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, {
        state: 'DISPATCHED',
        assignedRiderId: session.id,
        serviceDate: days.day,
      }),
    );
    await insertStop(routes.admin, stopRow(dispatched, await confirmed(true), 1));
    const seen = await read(cancellerOfManifests, dispatched.id);
    const answer = await cancelOf(
      cancellerOfManifests,
      dispatched.id,
      { note: 'Rider unavailable' },
      seen.header('etag') ?? undefined,
    );
    expect(answer.status).toBe(200);
    expect(manifestOf(answer).state).toBe('CANCELLED');

    const asRider = await read(session.client, dispatched.id);
    expect(asRider.status).toBe(200);
    expect(manifestOf(asRider)).toMatchObject({ state: 'CANCELLED' });
    expect(manifestOf(asRider).stops[0]).toMatchObject({
      state: 'SKIPPED',
      skipped: { reason_code: 'MANIFEST_CANCELLED' },
    });
    expect(asRider.header('etag')).toBe(answer.header('etag'));
  });

  // Break caught: a run that has started cancelled (the way out is a skip or a custody handover), or a manifest cancelled twice.
  it('refuses a run that has started, and a manifest that is completed or already cancelled', async () => {
    const riderId = (await rider()).id;
    const states: [string, number, string][] = [
      ['IN_PROGRESS', 422, 'RUN_ALREADY_STARTED'],
      ['COMPLETED', 409, 'STATE_CONFLICT'],
      ['CANCELLED', 409, 'STATE_CONFLICT'],
    ];
    for (const [state, status, code] of states) {
      const arranged = await insertManifest(
        routes.admin,
        manifestRow(HUB_A, {
          state: state as 'IN_PROGRESS',
          assignedRiderId: riderId,
          serviceDate: days.day,
        }),
      );
      await insertStop(routes.admin, stopRow(arranged, await confirmed(), 1));
      const seen = await read(cancellerOfManifests, arranged.id);
      const answer = await cancelOf(
        cancellerOfManifests,
        arranged.id,
        { note: 'Too late' },
        seen.header('etag') ?? undefined,
      );
      expect(outcome(answer), state).toEqual([status, code]);
      expect((await manifestRowOf(arranged.id))?.state).toBe(state);
    }
  });

  // Break caught: a cancellation with no reason in the operator's words (a blank note is REASON_REQUIRED, a missing one is a malformed
  // body), or one with a note the ledger would not keep, which would fail after the act began.
  it('needs a note: blank is REASON_REQUIRED, missing is a validation failure, and one the ledger would not keep is refused', async () => {
    const { manifest, etag } = await draftOf(1);
    expect(
      outcome(await cancelOf(cancellerOfManifests, manifest.id, { note: '   ' }, etag)),
    ).toEqual([422, 'REASON_REQUIRED']);
    for (const body of [{}, { note: '' }, { note: 7 }, { note: 'x', extra: true }]) {
      expect(
        outcome(await cancelOf(cancellerOfManifests, manifest.id, body, etag)),
        JSON.stringify(body),
      ).toEqual([400, 'VALIDATION_FAILED']);
    }
    const unkeepable = await cancelOf(
      cancellerOfManifests,
      manifest.id,
      { note: 'Write to me@example.com' },
      etag,
    );
    expect([unkeepable.status, codeOf(unkeepable)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(unkeepable)).toEqual([{ in: 'body', pointer: '/note', rule: 'format' }]);
    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'DRAFT' });
  });

  // Break caught: a command sent again that cancels again or answers differently; a stale token accepted; another body under the key.
  it('answers the same command again as it was answered, and judges a stale or missing If-Match', async () => {
    const { manifest, etag } = await draftOf(2);
    const key = randomUUID();
    const first = await cancelOf(cancellerOfManifests, manifest.id, { note: 'Replan' }, etag, key);
    const second = await cancelOf(cancellerOfManifests, manifest.id, { note: 'Replan' }, etag, key);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.text).toBe(first.text);
    expect(await eventsOf('pickup.manifest.cancelled', manifest.id)).toHaveLength(1);
    expect(
      outcome(await cancelOf(cancellerOfManifests, manifest.id, { note: 'Other' }, etag, key)),
    ).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);

    const another = await draftOf(1);
    const elsewhere = await draftOf(1);
    expect(
      outcome(
        await cancelOf(cancellerOfManifests, another.manifest.id, { note: 'x' }, elsewhere.etag),
      ),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(
      outcome(await cancelOf(cancellerOfManifests, another.manifest.id, { note: 'x' }, '"stale"')),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(
      outcome(await cancelOf(cancellerOfManifests, another.manifest.id, { note: 'x' }, undefined)),
    ).toEqual([400, 'VALIDATION_FAILED']);
    expect(await manifestRowOf(another.manifest.id)).toMatchObject({ state: 'DRAFT' });
  });

  // Break caught: the cancellation of a manifest and of one of its requests at once leaving a stop to be worked, a claim held, or an error;
  // whichever commits first, the end state is the same.
  it('meets the cancellation of one of its requests at once: every stop skipped, every claim released, the request cancelled', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { manifest, etag, requests } = await draftOf(2);
      const [cancelled] = requests as [string, string];
      const [onManifest, onRequest] = await Promise.all([
        cancelOf(cancellerOfManifests, manifest.id, { note: 'Replan' }, etag),
        cancelRequest(cancelled),
      ]);
      expect(onRequest.status, `round ${String(round)}: ${onRequest.text}`).toBe(200);
      expect(onManifest.status, `round ${String(round)}: ${onManifest.text}`).toBe(200);
      const rows = await stopRowsOf(manifest.id);
      expect(rows.map((row) => row.state)).toEqual(['SKIPPED', 'SKIPPED']);
      expect(rows.every((row) => row.released_at !== null)).toBe(true);
      expect(
        rows.find((row) => row.pickup_request_id === cancelled)?.skip_snapshot?.reason_code,
      ).toMatch(/^(REQUEST_CANCELLED|MANIFEST_CANCELLED)$/);
      expect(
        await routes.rows(`select state from pickup_request where id = $1`, [cancelled]),
      ).toEqual([{ state: 'CANCELLED' }]);
    }
  });

  // Break caught: the cancellation of a manifest open to the assignment key alone, a rider, a vendor or no session; a foreign hub's manifest
  // changed, or told apart wrongly from one that does not exist.
  it('is refused to a vendor, a rider, a holder of the assignment key alone and a caller with no session, and tells a foreign hub from nothing', async () => {
    const { manifest, etag } = await draftOf(1);
    const headers = { 'If-Match': etag, 'Idempotency-Key': randomUUID() };
    const asVendor = await browser.post(
      CANCEL(manifest.id),
      { note: 'x' },
      { origin: OPS, headers },
    );
    const asRider = await (
      await arrangedRiderSession()
    ).client.post(CANCEL(manifest.id), { note: 'x' }, { headers });
    const none = await routes.kit.client
      .fork()
      .post(CANCEL(manifest.id), { note: 'x' }, { origin: OPS, headers });
    for (const answer of [asVendor, asRider, none]) expect([401, 403]).toContain(answer.status);

    const onlyAssign = await routes.actor(
      await newBundle(routes.admin, [
        grant('pickup.manifest.assign', 'all', 'any', 'A'),
        grant('pickup.read', 'all', 'any', 'A'),
      ]),
      HUB_A,
    );
    expect(outcome(await cancelOf(onlyAssign, manifest.id, { note: 'x' }, etag))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    const foreign = await insertManifest(routes.admin, manifestRow(HUB_B));
    expect(outcome(await cancelOf(cancellerOfManifests, foreign.id, { note: 'x' }, '"x"'))).toEqual(
      [403, 'HUB_SCOPE_VIOLATION'],
    );
    expect(
      outcome(await cancelOf(cancellerOfManifests, randomUUID(), { note: 'x' }, '"x"')),
    ).toEqual([404, 'NOT_FOUND']);
    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'DRAFT' });
  });
});
