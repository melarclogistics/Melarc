import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { locateContract } from '../../src/platform/contract/locate-contract.js';
import { pickupSummaryOf } from '../../src/pickup/pickup-manifest-dispatch.service.js';
import { PICKUP_MANIFEST_SCHEMA } from '../../src/pickup/pickup-manifest-schemas.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { liftProviderCeiling } from './support/provider-ceiling.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.21, `dispatchManifest` (`AC-SLICE-001-13` and `-19`; the Product Owner's decisions of 29 October and 2 November 2026; D-11;
 * features/pickup/pickup-manifest.md sections 5.1 and 5.2; state-machines.md section 4): Ops sends a draft manifest out to the rider it is
 * given to. Against a real PostgreSQL and the real application, each claim:
 *
 * - **It sends the run out and does not start it.** `DISPATCHED` with its moment, a summary on each stop still to be worked, one event, and
 *   one envelope for the rider's text, all in one transaction; the requests stay confirmed.
 * - **The rider is shown what the pickup needs and nothing else** (OB-S1-21): the reference, the sender as booked, the declared packages, the
 *   place, no note, the primary contact. Not the secondary contact, the goods, the payer, the price or another request.
 * - **A cancelled request is never sent.** A stop resolved before the dispatch gets no summary; a stop still to be worked for a request that
 *   is no longer confirmed refuses the dispatch, naming the stop, and nothing is written or queued.
 * - **Each refusal changes nothing**: no rider, a rider who is no longer eligible, nothing to work, a day that has passed, a manifest that has
 *   gone out or been cancelled, a stale token, a caller without the key.
 * - **Concurrency is a line, not a race**: of two officers who hold the same token one wins; a stop that a cancellation takes while the
 *   dispatch waits for it refuses the dispatch.
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const ASSIGN = (id: string) => `${ONE(id)}/assign-rider`;
const DISPATCH = (id: string) => `${ONE(id)}/dispatch`;
const CANCEL = (id: string) => `${ONE(id)}/cancel`;
const REQUESTS = `${API}/pickup-requests`;
const CANCEL_REQUEST = (id: string) => `${REQUESTS}/${id}/cancel`;
const CUSTOMER_REASON = 'FIXTURE_CANCEL_CUSTOMER_DISPATCH';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let browser: TestClient;
/** One Ops user for each kind of act: the rate limit counts the requests of a principal, and these tests make many. */
let maker: Actor;
let assigner: Actor;
let dispatcher: Actor;
let secondDispatcher: Actor;
let manifestCanceller: Actor;
let requestCanceller: Actor;
/** An officer whose grant reaches every hub: what a grant lets an officer see of a rider is not what makes the rider eligible for a run. */
let wideDispatcher: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  // This file makes dozens of dispatches from a few officers' sessions inside a minute; the ceiling of the operations that cause a text is proven elsewhere.
  await liftProviderCeiling(routes.admin);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  browser = routes.browser(vendor.device.credential.token);
  expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
    200,
  );
  maker = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  assigner = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  dispatcher = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  secondDispatcher = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  manifestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  requestCanceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  wideDispatcher = await routes.actor(
    await newBundle(routes.admin, [
      grant('pickup.manifest.dispatch', 'all', 'any', 'A'),
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

interface Summary {
  readonly reference: string;
  readonly sender_display_name: string;
  readonly declared_package_count: number;
  readonly resolved_pickup_location: Record<string, unknown>;
  readonly location_note: string | null;
  readonly contact_phone: string | null;
}
interface Stop {
  readonly id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: string;
  readonly skipped: { reason_code: string; skipped_at: string; note?: string } | null;
  readonly pickup_summary?: Summary;
}
interface Manifest {
  readonly id: string;
  readonly state: string;
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
/** What an answer says, without the request it was made for. */
const detailsOf = (response: TestResponse): Record<string, unknown> | undefined =>
  (response.json() as { details?: Record<string, unknown> }).details;

/** A value the test has just arranged to be there; a missing one is a failure of the test, said so. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('the value the test expected is missing');
  return value;
}

interface Booked {
  readonly id: string;
  readonly code: string;
}

/** A confirmed request of the vendor for the test's day, with a code the rider is told. */
async function confirmed(over: { packages?: number } = {}): Promise<Booked> {
  const row = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendor.row.organizationId, HUB_A, {
      state: 'CONFIRMED',
      serviceDate: days.day,
      ...over,
    }),
  );
  return { id: row.id, code: row.code };
}

/** A draft manifest of confirmed requests, made through the route. */
async function draftOf(count = 2): Promise<{ manifest: Manifest; etag: string; booked: Booked[] }> {
  const booked: Booked[] = [];
  for (let each = 0; each < count; each += 1) booked.push(await confirmed());
  const made = await maker.client.post(
    LIST,
    { pickup_request_ids: booked.map((request) => request.id), service_date: days.day },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(made.status).toBe(201);
  return { manifest: manifestOf(made), etag: made.header('etag') ?? '', booked };
}

const read = (actor: Actor | TestClient, id: string): Promise<TestResponse> =>
  ('client' in actor ? actor.client : actor).get(ONE(id));

const assignOf = (actor: Actor, id: string, riderId: string, etag: string): Promise<TestResponse> =>
  actor.client.post(
    ASSIGN(id),
    { rider_id: riderId },
    { origin: OPS, headers: { 'If-Match': etag } },
  );

const dispatchOf = (actor: Actor, id: string, etag: string | undefined): Promise<TestResponse> =>
  actor.client.post(DISPATCH(id), undefined, {
    origin: OPS,
    headers: etag === undefined ? {} : { 'If-Match': etag },
  });

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

interface Ready {
  readonly manifest: Manifest;
  readonly etag: string;
  readonly booked: Booked[];
  readonly riderId: string;
  readonly session?: { id: string; client: TestClient };
}

/** A draft given an active rider of its hub, through the route: what dispatch is asked to send out. */
async function readyOf(count = 2, withSession = false): Promise<Ready> {
  const { manifest, etag, booked } = await draftOf(count);
  const session = withSession ? await arrangedRiderSession() : undefined;
  const riderId = session?.id ?? (await rider()).id;
  const assigned = await assignOf(assigner, manifest.id, riderId, etag);
  expect(assigned.status).toBe(200);
  return {
    manifest: manifestOf(assigned),
    etag: assigned.header('etag') ?? '',
    booked,
    riderId,
    ...(session === undefined ? {} : { session }),
  };
}

/** The office cancels a request. Once a rider is assigned, the cancellation says whether to charge: `chargeDecided` gives that decision (not charged). */
const cancelRequest = async (id: string, chargeDecided = false): Promise<TestResponse> => {
  const etag = (await requestCanceller.client.get(`${REQUESTS}/${id}`)).header('etag') ?? '';
  return requestCanceller.client.post(
    CANCEL_REQUEST(id),
    {
      reason_code: CUSTOMER_REASON,
      ...(chargeDecided ? { apply_charge: false, charge_reason_code: CUSTOMER_REASON } : {}),
    },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
};

const manifestRowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      assigned_rider_id: string | null;
      dispatched_at: Date | null;
    }>(
      `select state, version, assigned_rider_id, dispatched_at from pickup_manifest where id = $1`,
      [id],
    )
  )[0];

const stopRowsOf = (manifestId: string) =>
  routes.rows<{
    id: string;
    pickup_request_id: string;
    sequence: number;
    state: string;
    released_at: Date | null;
    pickup_summary: Summary | null;
  }>(
    `select id, pickup_request_id, sequence, state, released_at, pickup_summary
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
    related_ids: Record<string, unknown> | null;
    detail: Record<string, unknown>;
  }>(
    `select actor_id, enhanced, object_type, responsible_hub_id, previous_state, resulting_state, related_ids, detail
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

const envelopesOf = (manifestId: string) =>
  routes.rows<{
    event_type: string;
    aggregate_type: string;
    responsible_hub_id: string;
    vendor_organization_id: string | null;
    rider_id: string | null;
    originating_principal_type: string;
    originating_principal_id: string;
    operation_id: string;
    relay_state: string;
  }>(
    `select event_type, aggregate_type, responsible_hub_id, vendor_organization_id, rider_id, originating_principal_type,
            originating_principal_id, operation_id, relay_state
       from outbox where aggregate_id = $1 order by created_at`,
    [manifestId],
  );

/** Nothing of the act in the database: the manifest as it was, no summary on any stop, no event and no envelope. */
async function expectNothingChanged(id: string, before: { state: string; version: number }) {
  expect(await manifestRowOf(id)).toMatchObject({
    state: before.state,
    version: before.version,
    dispatched_at: null,
  });
  expect((await stopRowsOf(id)).every((stop) => stop.pickup_summary === null)).toBe(true);
  expect(await eventsOf('pickup.manifest.dispatched', id)).toEqual([]);
  expect(await envelopesOf(id)).toEqual([]);
}

describe('dispatchManifest: a draft sent out to its rider', () => {
  // Break caught (AC-13): a dispatch that starts the run, leaves the manifest a draft, writes no moment, no summary, no event or no envelope
  // for the rider's text; that changes a request (the requests move at the start of the run, never at dispatch); or that moves some of it
  // and not the rest.
  it('sends the manifest out without starting it: the moment, a summary on each stop, one event and one envelope', async () => {
    const { manifest, etag, booked, riderId } = await readyOf(3);
    const answer = await dispatchOf(dispatcher, manifest.id, etag);

    expect(answer.status).toBe(200);
    expect(answer.header('etag')).not.toBe(etag);
    const sent = manifestOf(answer);
    expect(sent).toMatchObject({
      state: 'DISPATCHED',
      assigned_rider_id: riderId,
      started_at: null,
      completed_at: null,
    });
    expect(sent.dispatched_at).not.toBeNull();
    expect(sent.stops.map((stop) => stop.pickup_summary?.reference)).toEqual(
      booked.map((request) => request.code),
    );
    // The same representation is what the next read answers, with the token the answer carried.
    const again = await read(dispatcher, manifest.id);
    expect(again.header('etag')).toBe(answer.header('etag'));
    expect(manifestOf(again)).toEqual(sent);

    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'DISPATCHED' });
    expect((await stopRowsOf(manifest.id)).every((stop) => stop.pickup_summary !== null)).toBe(
      true,
    );
    expect(
      await routes.rows(`select state from pickup_request where id = any($1::uuid[])`, [
        booked.map((request) => request.id),
      ]),
    ).toEqual([{ state: 'CONFIRMED' }, { state: 'CONFIRMED' }, { state: 'CONFIRMED' }]);
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toEqual([
      expect.objectContaining({
        actor_id: dispatcher.identity.id,
        enhanced: false,
        object_type: 'PickupManifest',
        responsible_hub_id: HUB_A,
        previous_state: 'DRAFT',
        resulting_state: 'DISPATCHED',
        related_ids: { rider_id: riderId },
        detail: { stops_dispatched: 3 },
      }),
    ]);
    expect(await envelopesOf(manifest.id)).toEqual([
      {
        event_type: 'pickup.manifest.dispatched',
        aggregate_type: 'PICKUP_MANIFEST',
        responsible_hub_id: HUB_A,
        vendor_organization_id: null,
        rider_id: null,
        originating_principal_type: 'STAFF',
        originating_principal_id: dispatcher.identity.id,
        operation_id: 'dispatchManifest',
        relay_state: 'PENDING',
      },
    ]);
  });

  // Break caught (OB-S1-21, approved by the Product Owner on 2 November 2026, `reference` included): a summary that shows the rider more than the
  // pickup needs (the second contact, the goods, the payer, a price, the vendor's account), that makes up a note from the landmark, or that
  // leaves out the reference the cancellation text names. This is the representative payload of the rider's read, and the plan prints it.
  it('shows the assigned rider the reference, the sender, the declared packages, the place and the primary contact, and nothing else', async () => {
    const { manifest, etag, booked, session } = await readyOf(2, true);
    const first = present(booked[0]);
    await routes.admin.query(
      `update pickup_request
          set sender_name = $2, resolved_pickup_location = $3::jsonb, primary_phone = $4, secondary_phone = $5,
              current_item_description = $6, default_payer_intent = 'SENDER_PAYS_FULL'
        where id = $1`,
      [
        first.id,
        'Ama Serwaa Fashions',
        JSON.stringify({
          address: '12 Oxford Street, Osu',
          landmark: 'Opposite the Total filling station',
          map_link: 'https://maps.example/osu-12',
          latitude: 5.5571,
          longitude: -0.1822,
        }),
        '+233201234567',
        '+233241112222',
        'Six boxes of ankara fabric',
      ],
    );
    // The request was read for its summary at dispatch, so the changes above come first. The token is the manifest's, not the request's.
    expect((await dispatchOf(dispatcher, manifest.id, etag)).status).toBe(200);

    const seen = await read(present(session).client, manifest.id);
    expect(seen.status).toBe(200);
    const stops = manifestOf(seen).stops;
    expect(present(stops[0])).toMatchObject({ sequence: 1, state: 'PENDING', skipped: null });
    expect(present(stops[0]).pickup_summary).toEqual({
      reference: first.code,
      sender_display_name: 'Ama Serwaa Fashions',
      declared_package_count: 3,
      resolved_pickup_location: {
        address: '12 Oxford Street, Osu',
        landmark: 'Opposite the Total filling station',
        map_link: 'https://maps.example/osu-12',
        latitude: 5.5571,
        longitude: -0.1822,
      },
      location_note: null,
      contact_phone: '+233201234567',
    });
    // The second stop carries the summary of its own request, and none of the first's.
    expect(present(present(stops[1]).pickup_summary).reference).toBe(present(booked[1]).code);
    expect(present(present(stops[1]).pickup_summary).reference).not.toBe(first.code);

    // Nothing the pickup does not need is anywhere in what the rider is told.
    const text = JSON.stringify(seen.json());
    for (const withheld of [
      '+233241112222',
      'Six boxes of ankara fabric',
      'SENDER_PAYS_FULL',
      'payer',
      'price',
      'recipient',
      'vendor_organization_id',
      vendor.row.organizationId,
      'estimate',
      'declared_value',
    ]) {
      expect(text, withheld).not.toContain(withheld);
    }
    // The rider's list carries the manifest and not its stops, and the staff read of the same manifest shows the same summaries.
    const listed = await present(session).client.get(`${LIST}?page_size=100`);
    expect((listed.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      manifest.id,
    ]);
    expect(
      manifestOf(await read(dispatcher, manifest.id)).stops.map((stop) => stop.pickup_summary),
    ).toEqual(stops.map((stop) => stop.pickup_summary));
  });

  // Break caught (OB-S1-21, approved by the Product Owner on 2 November 2026): the contract, the projection the rider is given and the table that
  // holds it saying three different things about what a rider is shown. The six members of the summary and the five of its place are the same set
  // in the contract (and in the schema the API declares, which `contract:check` compares with it), in what `pickupSummaryOf` makes, and in the
  // check of the stop; the generated client is the contract's (`api-client:check`). A member added in one place and not the others fails here.
  it('is the same six members and five of the place in the contract, the declared schema, the projection and the table', async () => {
    const SIX = [
      'contact_phone',
      'declared_package_count',
      'location_note',
      'reference',
      'resolved_pickup_location',
      'sender_display_name',
    ];
    const FIVE = ['address', 'landmark', 'latitude', 'longitude', 'map_link'];
    interface SchemaFacts {
      readonly properties: Record<string, unknown>;
      readonly required?: string[];
      readonly additionalProperties?: boolean;
    }
    const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as {
      components: { schemas: { PickupStopSummary?: SchemaFacts; Location?: SchemaFacts } };
    };
    const summary = contract.components.schemas.PickupStopSummary;
    expect(Object.keys(summary?.properties ?? {}).toSorted()).toEqual(SIX);
    expect((summary?.required ?? []).toSorted()).toEqual(SIX);
    expect(summary?.additionalProperties).toBe(false);
    expect(Object.keys(contract.components.schemas.Location?.properties ?? {}).toSorted()).toEqual(
      FIVE,
    );

    // The schema the API declares for the answer.
    const declared = (
      PICKUP_MANIFEST_SCHEMA as {
        properties: {
          stops: { items: { properties: { pickup_summary: { properties: object } } } };
        };
      }
    ).properties.stops.items.properties.pickup_summary;
    expect(Object.keys(declared.properties).toSorted()).toEqual(SIX);

    // What the projection makes of a request that has every member of the place.
    const projected = pickupSummaryOf({
      id: randomUUID(),
      code: 'ACC-PR-7K3M9Q',
      state: 'CONFIRMED',
      sender_name: 'Ama Serwaa Fashions',
      declared_package_count: 3,
      resolved_pickup_location: {
        address: '12 Oxford Street, Osu',
        landmark: 'Opposite the Total filling station',
        map_link: 'https://maps.example/osu-12',
        latitude: 5.5571,
        longitude: -0.1822,
        zone: 'ACCRA',
      },
      primary_phone: '+233201234567',
    });
    expect(Object.keys(projected).toSorted()).toEqual(SIX);
    expect(Object.keys(projected.resolved_pickup_location).toSorted()).toEqual(FIVE);
    expect(projected.location_note).toBeNull();

    // The check of the stop names the same members, in the member list and in the list of the place.
    const [check] = await routes.rows<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'pickup_stop_summary_shape' and conrelid = 'pickup_stop'::regclass`,
    );
    const lists = [...(check?.definition ?? '').matchAll(/ARRAY\[([^\]]*)\]/g)].map((match) =>
      [...(match[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((name) => name[1] ?? '').toSorted(),
    );
    // The lists of members are the long ones (the typing of a member, `IN ('string', 'null')`, is a list of two): the six are named where the
    // check demands them and where it forbids the others, and the five where it forbids any other member of the place.
    const members = lists.filter((names) => names.length >= 5).map((names) => names.join());
    expect(members.toSorted()).toEqual([FIVE.join(), SIX.join(), SIX.join()].toSorted());
  });

  // Break caught (OB-S1-21): the manifest's read standing in for the request's. The rider reads the stops of the run assigned and dispatched to
  // them, with the summary each holds; that is not a right to read the request, which the registry denies a rider, so the very requests of
  // the run are refused to the rider's session whatever the manifest shows of them.
  it('gives the rider the summary of a stop and no read of the request behind it', async () => {
    const { manifest, etag, booked, session } = await readyOf(2, true);
    expect((await dispatchOf(dispatcher, manifest.id, etag)).status).toBe(200);
    const asRider = present(session).client;
    const stops = manifestOf(await read(asRider, manifest.id)).stops;
    expect(stops.every((stop) => stop.pickup_summary !== undefined)).toBe(true);
    for (const request of booked) {
      const one = await asRider.get(`${REQUESTS}/${present(request).id}`);
      expect([401, 403, 404], `getPickupRequest as the rider: ${String(one.status)}`).toContain(
        one.status,
      );
      expect(one.text).not.toContain(present(request).code);
    }
    // The list is answered to a rider as an empty page (row-level security shows them no request), never with a request in it.
    const all = await asRider.get(`${REQUESTS}?page_size=100`);
    expect([200, 401, 403]).toContain(all.status);
    if (all.status === 200) expect((all.json() as { items: unknown[] }).items).toEqual([]);
  });

  // Break caught: a manifest that shows summaries before it is dispatched, which would send the rider's facts to a draft.
  it('has no summary on any stop of a draft, assigned or not', async () => {
    const { manifest, etag } = await draftOf(2);
    expect(manifest.stops.every((stop) => stop.pickup_summary === undefined)).toBe(true);
    const assigned = await assignOf(assigner, manifest.id, (await rider()).id, etag);
    expect(assigned.status).toBe(200);
    expect(manifestOf(assigned).stops.every((stop) => stop.pickup_summary === undefined)).toBe(
      true,
    );
  });

  // Break caught (the Product Owner, 2 November 2026: "a cancelled request is never sent"): a cancelled request's pickup details put in the
  // rider's hands because its stop is on the manifest.
  it('gives a stop whose request was cancelled before the dispatch no summary, shows it skipped, and sends the rest', async () => {
    const { manifest, booked } = await draftOf(3);
    const cancelled = present(booked[1]);
    expect((await cancelRequest(cancelled.id)).status).toBe(200);
    const session = await arrangedRiderSession();
    const etag = (await read(assigner, manifest.id)).header('etag') ?? '';
    const assigned = await assignOf(assigner, manifest.id, session.id, etag);
    expect(assigned.status).toBe(200);

    const answer = await dispatchOf(dispatcher, manifest.id, assigned.header('etag') ?? '');
    expect(answer.status).toBe(200);
    const stops = manifestOf(answer).stops;
    expect(stops.map((stop) => stop.state)).toEqual(['PENDING', 'SKIPPED', 'PENDING']);
    expect(present(stops[1]).skipped?.reason_code).toBe('REQUEST_CANCELLED');
    expect(present(stops[1]).pickup_summary).toBeUndefined();
    expect(present(stops[0]).pickup_summary).toBeDefined();
    expect(present(stops[2]).pickup_summary).toBeDefined();
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toEqual([
      expect.objectContaining({ detail: { stops_dispatched: 2 } }),
    ]);

    // The rider reads the same: the cancelled pickup in its place, skipped, with nothing of its address or contact.
    const seen = manifestOf(await read(session.client, manifest.id)).stops;
    expect(present(seen[1])).toMatchObject({ state: 'SKIPPED' });
    expect(present(seen[1]).pickup_summary).toBeUndefined();
    expect(JSON.stringify(seen[1])).not.toContain(cancelled.code);
  });

  // Break caught: a cancellation after the dispatch that the rider's next read does not show, or one that takes the summary away, so that the
  // app has nothing to name the cancelled pickup by.
  it('shows the rider a request cancelled after the dispatch as skipped at once, with its summary kept', async () => {
    const { manifest, etag, booked, session } = await readyOf(2, true);
    const sent = await dispatchOf(dispatcher, manifest.id, etag);
    expect(sent.status).toBe(200);
    const before = await read(present(session).client, manifest.id);
    const cancelled = present(booked[0]);

    expect((await cancelRequest(cancelled.id, true)).status).toBe(200);

    const after = await read(present(session).client, manifest.id);
    expect(after.header('etag')).not.toBe(before.header('etag'));
    const stop = present(manifestOf(after).stops[0]);
    expect(stop).toMatchObject({ state: 'SKIPPED', skipped: { reason_code: 'REQUEST_CANCELLED' } });
    expect(present(stop.pickup_summary).reference).toBe(cancelled.code);
    expect(manifestOf(after)).toMatchObject({ state: 'DISPATCHED' });
  });

  // Break caught: a rider given a run that is not theirs, or a colleague's run existing to them; and a vendor who can read a manifest.
  it('shows the dispatched run to its rider alone', async () => {
    const { manifest, etag } = await readyOf(1, true);
    const other = await arrangedRiderSession();
    expect(outcome(await read(other.client, manifest.id))).toEqual([404, 'NOT_FOUND']);
    await dispatchOf(dispatcher, manifest.id, etag);
    expect(outcome(await read(other.client, manifest.id))).toEqual([404, 'NOT_FOUND']);
    const listed = await other.client.get(`${LIST}?page_size=100`);
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
    expect([403, 404]).toContain((await read(browser, manifest.id)).status);
  });
});

describe('what dispatch refuses, and what it leaves as it was', () => {
  // Break caught: a manifest sent out to nobody. The officer is told that the manifest has no rider, which is not the answer for a rider who is
  // no longer eligible (what they have to do differs: give it a rider, or give it another).
  it('refuses a manifest that has no rider, and says so', async () => {
    const { manifest, etag } = await draftOf(2);
    const answer = await dispatchOf(dispatcher, manifest.id, etag);
    expect(outcome(answer)).toEqual([422, 'RIDER_UNAVAILABLE']);
    expect((answer.json() as { message: string }).message).toContain('has none');
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 1 });
  });

  // Break caught: a run sent to a rider who was suspended, offboarded or moved to another hub since the assignment (the assignment checked
  // them once; the dispatch is the moment the stops reach them).
  it.each([
    ['suspended', `update rider_identity set status = 'SUSPENDED' where id = $1`],
    ['offboarded', `update rider_identity set status = 'OFFBOARDED' where id = $1`],
    [
      'temporarily unavailable',
      `update rider_identity set status = 'TEMPORARILY_UNAVAILABLE' where id = $1`,
    ],
  ])('refuses a manifest whose rider has become %s since the assignment', async (_what, change) => {
    const { manifest, etag, riderId } = await readyOf(2);
    await routes.admin.query(change, [riderId]);
    const answer = await dispatchOf(dispatcher, manifest.id, etag);
    expect(outcome(answer)).toEqual([422, 'RIDER_UNAVAILABLE']);
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 2 });
  });

  it('refuses a manifest whose rider now belongs to another hub', async () => {
    const { manifest, etag, riderId } = await readyOf(2);
    await routes.admin.query(`alter table rider_identity disable trigger user`);
    try {
      await routes.admin.query(`update rider_identity set primary_hub_id = $2 where id = $1`, [
        riderId,
        HUB_B,
      ]);
    } finally {
      await routes.admin.query(`alter table rider_identity enable trigger user`);
    }
    const answer = await dispatchOf(dispatcher, manifest.id, etag);
    expect(outcome(answer)).toEqual([422, 'RIDER_UNAVAILABLE']);
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 2 });
  });

  // Break caught (the Product Owner, 2 November 2026: nothing makes a rider eligible for another hub implicitly): the reach of an officer's
  // grant standing in for the rider's hub. The officer above is confined to the manifest's hub, so the rider of another hub is not even
  // visible to them; an officer whose grant reaches both sees the rider and must still not send the run to them.
  it('refuses a rider of another hub even to an officer whose grant reaches both hubs', async () => {
    const { manifest, etag, riderId } = await readyOf(2);
    await routes.admin.query(`alter table rider_identity disable trigger user`);
    try {
      await routes.admin.query(`update rider_identity set primary_hub_id = $2 where id = $1`, [
        riderId,
        HUB_B,
      ]);
    } finally {
      await routes.admin.query(`alter table rider_identity enable trigger user`);
    }

    const refused = await dispatchOf(wideDispatcher, manifest.id, etag);

    expect(outcome(refused)).toEqual([422, 'RIDER_UNAVAILABLE']);
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 2 });
    expect(await envelopesOf(manifest.id)).toEqual([]);

    // The officer's reach is not the limit: the same officer sends a run to a rider of that run's own hub.
    const own = await readyOf(1);
    expect((await dispatchOf(wideDispatcher, own.manifest.id, own.etag)).status).toBe(200);
  });

  // Break caught: a run with nothing to collect sent to a rider.
  it('refuses a manifest all of whose stops are resolved', async () => {
    const { manifest, booked } = await draftOf(2);
    for (const request of booked) expect((await cancelRequest(request.id)).status).toBe(200);
    const riderId = (await rider()).id;
    const assigned = await assignOf(
      assigner,
      manifest.id,
      riderId,
      (await read(assigner, manifest.id)).header('etag') ?? '',
    );
    expect(assigned.status).toBe(200);
    const answer = await dispatchOf(dispatcher, manifest.id, assigned.header('etag') ?? '');
    expect(outcome(answer)).toEqual([422, 'MANIFEST_EMPTY']);
    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'DRAFT', dispatched_at: null });
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toEqual([]);
    expect(await envelopesOf(manifest.id)).toEqual([]);
  });

  // Break caught (the second safeguard): a stop still to be worked for a request that is no longer confirmed sent to a rider, because the
  // cancellation that should have resolved it did not (it was arranged some other way). The stops are named, and nothing is written.
  it('refuses a stop still to be worked for a request that is not confirmed, naming it, and writes and queues nothing', async () => {
    const riderId = (await rider()).id;
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { assignedRiderId: riderId, serviceDate: days.day }),
    );
    const good = await insertStop(routes.admin, stopRow(manifest, (await confirmed()).id, 1));
    const pending = (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(vendor.row.organizationId, HUB_A, {
          state: 'PENDING',
          serviceDate: days.day,
        }),
      )
    ).id;
    const lapsed = await insertStop(routes.admin, stopRow(manifest, pending, 2));
    const etag = (await read(dispatcher, manifest.id)).header('etag') ?? '';

    const answer = await dispatchOf(dispatcher, manifest.id, etag);

    expect(outcome(answer)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(answer)).toEqual({ rule: 'request_not_confirmed', stops: [lapsed.id] });
    expect(good.id).not.toBe(lapsed.id);
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 1 });
  });

  // Break caught (the Product Owner, 2 November 2026: "do not dispatch a run whose service date has passed. Cancel the unstarted manifest and
  // replan outstanding requests with carry-over reasons"): a run sent out after its day, or a way out that does not work.
  it('refuses a run whose day has passed, and the way out is to cancel it and plan its requests again with a carry-over reason', async () => {
    const riderId = (await rider()).id;
    const old = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.past,
      }),
    );
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { assignedRiderId: riderId, serviceDate: days.past }),
    );
    await insertStop(routes.admin, stopRow(manifest, old.id, 1));
    const etag = (await read(dispatcher, manifest.id)).header('etag') ?? '';

    const refused = await dispatchOf(dispatcher, manifest.id, etag);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(detailsOf(refused)).toEqual({ rule: 'service_date_passed', service_date: days.past });
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 1 });

    // The way out: the unstarted manifest is cancelled (its claim is released), and the request is planned again for a day that has not
    // passed, carried over for a stated reason. The request keeps the day it was promised.
    const cancelled = await manifestCanceller.client.post(
      CANCEL(manifest.id),
      { note: 'The day of the run passed before it could go out' },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
    expect(cancelled.status).toBe(200);
    const replanned = await maker.client.post(
      LIST,
      {
        pickup_request_ids: [old.id],
        service_date: days.day,
        carryover: [{ pickup_request_id: old.id, reason_code: 'CARRYOVER_NO_RIDER_AVAILABLE' }],
      },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(replanned.status).toBe(201);
    expect(
      await routes.rows(
        `select scheduled_service_date::text as day from pickup_request where id = $1`,
        [old.id],
      ),
    ).toEqual([{ day: days.past }]);
  });

  // Break caught (the edge of the rule above): the day of the run is the last day it can go out. A run dated today is sent, a run dated
  // yesterday is refused; a comparison that is one day too strict refuses the run its own officers plan for the morning of its day.
  it('sends out a run whose day is today, the last day it can go out', async () => {
    const riderId = (await rider()).id;
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.today,
      }),
    );
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { assignedRiderId: riderId, serviceDate: days.today }),
    );
    await insertStop(routes.admin, stopRow(manifest, request.id, 1));
    const etag = (await read(dispatcher, manifest.id)).header('etag') ?? '';

    const sent = await dispatchOf(dispatcher, manifest.id, etag);

    expect(sent.status).toBe(200);
    expect(manifestOf(sent).state).toBe('DISPATCHED');
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toHaveLength(1);
  });

  // Break caught: a dispatch of a manifest that has gone out, or been cancelled, or started, answered as a success or as a second dispatch
  // (a second envelope, a second event).
  it('refuses a manifest that is not a draft, whatever its token, and queues no second text', async () => {
    const { manifest, etag } = await readyOf(1);
    const first = await dispatchOf(dispatcher, manifest.id, etag);
    expect(first.status).toBe(200);
    const sentToken = first.header('etag') ?? '';
    expect(outcome(await dispatchOf(dispatcher, manifest.id, sentToken))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(outcome(await dispatchOf(dispatcher, manifest.id, etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toHaveLength(1);
    expect(await envelopesOf(manifest.id)).toHaveLength(1);

    const gone = await readyOf(1);
    const cancelled = await manifestCanceller.client.post(
      CANCEL(gone.manifest.id),
      { note: 'No longer needed' },
      { origin: OPS, headers: { 'If-Match': gone.etag, 'Idempotency-Key': randomUUID() } },
    );
    expect(cancelled.status).toBe(200);
    expect(
      outcome(await dispatchOf(dispatcher, gone.manifest.id, cancelled.header('etag') ?? '')),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(await envelopesOf(gone.manifest.id)).toEqual([]);

    const riderId = (await rider()).id;
    const started = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'IN_PROGRESS', assignedRiderId: riderId, serviceDate: days.day }),
    );
    await insertStop(routes.admin, stopRow(started, (await confirmed()).id, 1));
    const startedToken = (await read(dispatcher, started.id)).header('etag') ?? '';
    expect(outcome(await dispatchOf(dispatcher, started.id, startedToken))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
  });

  // Break caught: a dispatch judged against a token other than the manifest's now: missing, malformed, stale or another manifest's.
  it('is judged against the ETag: missing is a validation failure, and a stale, malformed or foreign token is a conflict', async () => {
    const { manifest, etag } = await readyOf(1);
    const elsewhere = await readyOf(1);
    expect(outcome(await dispatchOf(dispatcher, manifest.id, undefined))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    for (const token of [`"stale"`, 'W/"weak"', '*', elsewhere.etag, `${etag}, ${etag}`]) {
      expect(outcome(await dispatchOf(dispatcher, manifest.id, token)), token).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
    }
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 2 });
    // Reading a manifest that changed since gives a token that is stale at once: a cancellation of a request moved it.
    const { manifest: moving, etag: movingToken, booked } = await readyOf(2);
    expect((await cancelRequest(present(booked[0]).id, true)).status).toBe(200);
    expect(outcome(await dispatchOf(dispatcher, moving.id, movingToken))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
  });

  // Break caught (AC-19): a dispatch open to a rider, a vendor, a holder of another key or a caller with no session; a foreign hub's manifest
  // changed; an absent manifest told from a foreign one.
  it('is refused to a vendor, a rider, a holder of another key and a caller with no session, and tells a foreign hub from nothing', async () => {
    const { manifest, etag } = await readyOf(1);
    const headers = { 'If-Match': etag };
    const asVendor = await browser.post(DISPATCH(manifest.id), undefined, { origin: OPS, headers });
    const asRider = await (
      await arrangedRiderSession()
    ).client.post(DISPATCH(manifest.id), undefined, { headers });
    const none = await routes.kit.client
      .fork()
      .post(DISPATCH(manifest.id), undefined, { origin: OPS, headers });
    for (const answer of [asVendor, asRider, none]) expect([401, 403]).toContain(answer.status);

    for (const key of ['pickup.manifest.create', 'pickup.manifest.assign']) {
      const holder = await routes.actor(
        await newBundle(routes.admin, [
          grant(key, 'all', 'any', 'A'),
          grant('pickup.read', 'all', 'any', 'A'),
        ]),
        HUB_A,
      );
      expect(outcome(await dispatchOf(holder, manifest.id, etag)), key).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    }

    const foreign = await insertManifest(routes.admin, manifestRow(HUB_B));
    expect(outcome(await dispatchOf(dispatcher, foreign.id, '"x"'))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await dispatchOf(dispatcher, randomUUID(), '"x"'))).toEqual([404, 'NOT_FOUND']);
    await expectNothingChanged(manifest.id, { state: 'DRAFT', version: 2 });
  });
});

describe('dispatch and the acts that meet it', () => {
  // Break caught (AC-13, "two Ops dispatching at once, one STATE_CONFLICT"): two dispatches of one manifest that both succeed, a second text
  // for the rider, or a summary written twice.
  it('lets one of two officers who hold the same ETag dispatch, and tells the other to read again', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { manifest, etag } = await readyOf(2);
      const [one, two] = await Promise.all([
        dispatchOf(dispatcher, manifest.id, etag),
        dispatchOf(secondDispatcher, manifest.id, etag),
      ]);
      const outcomes = [one, two].map(outcome);
      expect(
        outcomes.filter(([status]) => status === 200),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
      expect(outcomes).toContainEqual([409, 'STATE_CONFLICT']);
      expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toHaveLength(1);
      expect(await envelopesOf(manifest.id)).toHaveLength(1);
      expect((await stopRowsOf(manifest.id)).every((stop) => stop.pickup_summary !== null)).toBe(
        true,
      );
    }
  });

  // Break caught: a dispatch that sends a stop a cancellation took while the dispatch waited for it (the stop skipped, the request cancelled),
  // or one that sends the other stops and queues the text anyway. The refusal rolls the whole act back, and the next try goes out.
  it('is refused, with nothing written or queued, when a cancellation takes a stop while the dispatch waits for it', async () => {
    const { manifest, etag } = await readyOf(2);
    const [first, second] = await stopRowsOf(manifest.id);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    let dispatching: Promise<TestResponse> | undefined;
    try {
      await holder.query('begin');
      const pid = await backendPidOf(holder);
      // The stop is taken the way the cancellation of its request takes it: skipped, with the system's reason, claim kept.
      await holder.query(
        `update pickup_stop
            set state = 'SKIPPED', resolved_at = clock_timestamp(),
                skip_snapshot = '{"reason_code":"REQUEST_CANCELLED","label":"Request cancelled","skipped_at":"2026-11-03T09:00:00.000Z"}'::jsonb
          where id = $1`,
        [present(first).id],
      );
      dispatching = dispatchOf(dispatcher, manifest.id, etag);
      await waitUntilBlockedBy(routes.admin, pid, 'the dispatch', dispatching);
      await holder.query('commit');
    } catch (error) {
      await holder.query('rollback').catch(() => undefined);
      await dispatching?.catch(() => undefined);
      throw error;
    } finally {
      await holder.end();
    }
    const refused = await dispatching;
    expect(outcome(present(refused))).toEqual([409, 'STATE_CONFLICT']);
    expect(await manifestRowOf(manifest.id)).toMatchObject({ state: 'DRAFT', dispatched_at: null });
    expect(
      (await stopRowsOf(manifest.id)).map((stop) => [stop.id, stop.state, stop.pickup_summary]),
    ).toEqual([
      [present(first).id, 'SKIPPED', null],
      [present(second).id, 'PENDING', null],
    ]);
    expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toEqual([]);
    expect(await envelopesOf(manifest.id)).toEqual([]);

    // Read again, and the manifest goes out with the one stop left.
    const fresh = await read(dispatcher, manifest.id);
    const sent = await dispatchOf(dispatcher, manifest.id, fresh.header('etag') ?? '');
    expect(sent.status).toBe(200);
    expect(manifestOf(sent).stops.map((stop) => stop.pickup_summary !== undefined)).toEqual([
      false,
      true,
    ]);
  });

  // Break caught: the cancellation of a manifest racing a dispatch ending in a dispatched manifest that is also cancelled, or a text for a
  // cancelled run.
  it('lets a dispatch and the cancellation of the same manifest end in one of them', async () => {
    const { manifest, etag } = await readyOf(2);
    const [dispatched, cancelled] = await Promise.all([
      dispatchOf(dispatcher, manifest.id, etag),
      manifestCanceller.client.post(
        CANCEL(manifest.id),
        { note: 'Plans changed' },
        { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
      ),
    ]);
    // Both hold the same token and both take the manifest's lock: the second finds a manifest that has moved on and is told to read again.
    const outcomes = [dispatched, cancelled].map(outcome);
    expect(outcomes.filter(([status]) => status === 200)).toHaveLength(1);
    expect(outcomes).toContainEqual([409, 'STATE_CONFLICT']);
    const row = await manifestRowOf(manifest.id);
    if (dispatched.status === 200) {
      expect(row?.state).toBe('DISPATCHED');
      expect(await envelopesOf(manifest.id)).toHaveLength(1);
    } else {
      expect(row?.state).toBe('CANCELLED');
      expect(await envelopesOf(manifest.id)).toEqual([]);
      expect(await eventsOf('pickup.manifest.dispatched', manifest.id)).toEqual([]);
    }
  });
});
