import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileContractSource } from '../../src/platform/contract/contract-source.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * The four Ops work lists of the collection and the failure (D-A3, OB-S1-70; plan S1.30), against a real PostgreSQL and the real application:
 * `listCollectionDisputes`, `listHandshakesForOps`, `listCollectionShortfalls` and `listPickupFailures`. One world is built through the real operations (the
 * rider counts and fails, Ops overrides, escalates and cancels, the vendor disputes) in two hubs, and the claims are made on what the lists answer:
 *
 * - **What each list holds, oldest first**, and what each item says, with every member the contract names and no other.
 * - **`open`** is each list's own rule and its complement, and `hub_id` narrows and never widens (a hub outside the grant and a hub that is none are an empty
 *   page, with no statement and no audit event).
 * - **A page is a position**: paging by one reaches the same items as one page, none twice.
 * - **Whose**: the staff of the hubs of the grant under the one existing key each list names, and nobody else; a crossing into another hub is audited.
 * - **What never reaches the wire**: a handshake code, a phone number, the Ops note of an override.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let vendorC: ArrangedVendor;
let browserA: TestClient;
let browserB: TestClient;
let browserC: TestClient;
let opsA: Actor;
let seniorA: Actor;
let opsB: Actor;
let platformAdmin: Actor;

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const REQUEST = (id: string) => `${API}/pickup-requests/${id}`;
const PATHS = {
  disputes: `${API}/collection-disputes`,
  handshakes: `${API}/handshakes-for-ops`,
  shortfalls: `${API}/collection-shortfalls`,
  failures: `${API}/pickup-failures`,
} as const;
type Which = keyof typeof PATHS;
const WHICH = Object.keys(PATHS) as Which[];
const OPERATIONS: Record<Which, string> = {
  disputes: 'listCollectionDisputes',
  handshakes: 'listHandshakesForOps',
  shortfalls: 'listCollectionShortfalls',
  failures: 'listPickupFailures',
};
const SCHEMAS: Record<Which, string> = {
  disputes: 'CollectionDisputeListItem',
  handshakes: 'OpsHandshake',
  shortfalls: 'CollectionShortfall',
  failures: 'PickupFailureQueueItem',
};
/** The one existing key each list names (and no other opens it). */
const KEYS: Record<Which, string> = {
  disputes: 'pickup.read',
  handshakes: 'pickup.handshake.override',
  shortfalls: 'pickup.handshake.override',
  failures: 'pickup.failure.resolve',
};

const RESOLVE_NOTE = 'The vendor confirmed by phone';
const OVERRIDE_NOTE = 'Phoned the vendor on the number we hold';
const DISPUTE_NOTE = 'Two of the three parcels were not ours';
const CANCEL_REASON = 'FIXTURE_WORKLIST_RESCHEDULE';
const FAILURE_NOTE = 'The parcels were not packed when the rider came';
const ORDINARY = {
  category: 'PARCEL_NOT_READY',
  reason_code: 'PARCELS_NOT_PACKED',
  note: FAILURE_NOTE,
} as const;
const PHONE = '+233200000001';

interface Item {
  readonly [member: string]: unknown;
  readonly pickup_stop_id: string;
}
interface Page {
  readonly items: Item[];
  readonly next_page_token: string | null;
}
type Query = Record<string, string | number | boolean | undefined>;

const queryOf = (query: Query): string => {
  const given = Object.entries(query).filter(([, value]) => value !== undefined);
  return given.length === 0
    ? ''
    : `?${given.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')}`;
};
const pageOf = (client: TestClient, which: Which, query: Query = {}): Promise<TestResponse> =>
  client.get(`${PATHS[which]}${queryOf(query)}`);
const bodyOf = (response: TestResponse): Page => response.json() as Page;
/** Every item of a list, by following the position of each page. */
async function everything(client: TestClient, which: Which, query: Query = {}): Promise<Item[]> {
  const items: Item[] = [];
  let token: string | null = null;
  do {
    const response = await pageOf(client, which, {
      ...query,
      page_size: 100,
      ...(token === null ? {} : { page_token: token }),
    });
    expect(response.status, `${which}: ${response.text}`).toBe(200);
    const page = bodyOf(response);
    items.push(...page.items);
    token = page.next_page_token;
  } while (token !== null);
  return items;
}
const stopsOf = (items: readonly Item[]): string[] => items.map((item) => item.pickup_stop_id);
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const violationsOf = (response: TestResponse): { pointer: string; rule: string }[] =>
  (response.json() as { details?: { violations?: { pointer: string; rule: string }[] } }).details
    ?.violations ?? [];

/** The world, by the stop each claim is about. */
interface World {
  readonly runA: ArrangedRun;
  readonly runB: ArrangedRun;
  readonly runC: ArrangedRun;
  /** A dispute that is open (a clean count). */
  readonly disputeOpen: string;
  /** A dispute that is resolved (a short count). */
  readonly disputeResolved: string;
  /** A dispute of the other hub. */
  readonly disputeOtherHub: string;
  readonly handshakeLive: string;
  readonly handshakeClockExpired: string;
  readonly handshakeExpired: string;
  readonly handshakeExhausted: string;
  readonly handshakeFallbackUsed: string;
  readonly handshakeOverridden: string;
  readonly handshakeResolved: string;
  readonly handshakeOtherHub: string;
  readonly shortfallOpen: string;
  readonly shortfallClosed: string;
  readonly shortfallOtherHub: string;
  readonly failurePending: string;
  readonly failureEscalated: string;
  readonly failureRescheduled: string;
  readonly failureCancelled: string;
  readonly failureOtherHub: string;
}
let world: World;

const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

const stopAt = (run: ArrangedRun, at: number): string => {
  const stop = run.stops[at];
  if (stop === undefined) throw new Error(`stop ${String(at)}`);
  return stop.id;
};

/** The rider's count of a stop (S1.26): three declared, so fewer than three is a shortfall with its reason. */
async function count(rider: ArrangedRider, stopId: string, collected = 3): Promise<void> {
  const response = await rider.client.post(
    `${STOP(stopId)}/collect`,
    collected < 3
      ? { collected_count: collected, variance_reason_code: 'SOME_PARCELS_NOT_READY' }
      : { collected_count: collected },
    { headers: { 'If-Match': await tokenOf(rider, stopId), 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, `count: ${response.text}`).toBe(200);
}
async function initiate(rider: ArrangedRider, stopId: string): Promise<void> {
  const response = await rider.client.post(`${STOP(stopId)}/handshake`, undefined, {
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(response.status, `initiate: ${response.text}`).toBeLessThan(300);
}
async function override(who: Actor, stopId: string): Promise<void> {
  const response = await who.client.post(
    `${STOP(stopId)}/handshake/ops-override`,
    { verification_note: OVERRIDE_NOTE },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, `override: ${response.text}`).toBe(200);
}
async function resolveByHand(who: Actor, stopId: string): Promise<void> {
  const response = await who.client.post(
    `${STOP(stopId)}/handshake/resolve`,
    { note: RESOLVE_NOTE },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, `resolve: ${response.text}`).toBe(200);
}
async function dispute(client: TestClient, stopId: string): Promise<void> {
  const response = await client.post(
    `${STOP(stopId)}/dispute`,
    { note: DISPUTE_NOTE },
    { headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, `dispute: ${response.text}`).toBe(201);
}
/** The code of the first generation of a stop's handshake, as the application makes it. */
const codeOfStop = (stopId: string): string =>
  routes.handshakeCodes.codeFor(stopId, 1, routes.handshakeCodes.activeVersion, 4);
const age = (stopId: string) =>
  routes.admin.query(
    `update collection_handshake set expires_at = clock_timestamp() - interval '1 second' where pickup_stop_id = $1`,
    [stopId],
  );
async function failStop(rider: ArrangedRider, stopId: string, over: object = {}): Promise<void> {
  const response = await rider.client.post(
    `${STOP(stopId)}/fail`,
    { ...ORDINARY, ...over },
    { headers: { 'If-Match': await tokenOf(rider, stopId), 'Idempotency-Key': randomUUID() } },
  );
  expect(response.status, `fail: ${response.text}`).toBe(200);
}
const requestHeaders = async (who: Actor, requestId: string) => ({
  origin: OPS,
  headers: {
    'If-Match': (await who.client.get(REQUEST(requestId))).header('etag') ?? '',
    'Idempotency-Key': randomUUID(),
  },
});
async function escalate(who: Actor, requestId: string): Promise<void> {
  const response = await who.client.post(
    `${REQUEST(requestId)}/escalate`,
    { note: 'The vendor asked for a Senior Ops decision' },
    await requestHeaders(who, requestId),
  );
  expect(response.status, `escalate: ${response.text}`).toBeLessThan(300);
}
async function cancel(who: Actor, requestId: string, replacement: boolean): Promise<void> {
  const response = await who.client.post(
    `${REQUEST(requestId)}/cancel`,
    {
      reason_code: CANCEL_REASON,
      create_replacement: replacement,
      apply_charge: false,
      charge_reason_code: CANCEL_REASON,
    },
    await requestHeaders(who, requestId),
  );
  expect(response.status, `cancel: ${response.text}`).toBeLessThan(300);
}

async function build(): Promise<World> {
  const open = (vendor: ArrangedVendor, hubId: string, stops: number) =>
    arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendor.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops,
      stopState: 'ARRIVED',
      hubId,
    });

  // Hub A, vendor A: twelve stops the rider has arrived at, each worked a different way.
  const runA = await open(vendorA, HUB_A, 13);
  const riderA = runA.rider;
  const at = (n: number): string => stopAt(runA, n);
  // 0. A clean count closed by Ops's override and disputed by the vendor: an open dispute, and a handshake Ops settled.
  await count(riderA, at(0));
  await override(opsA, at(0));
  await dispute(browserA, at(0));
  // 1. A handshake with a live code, which nothing routes to Ops.
  await count(riderA, at(1));
  await initiate(riderA, at(1));
  // 2. A code whose life has passed on the database's clock, which nobody has tried: expired all the same.
  await count(riderA, at(2));
  await initiate(riderA, at(2));
  await age(at(2));
  // 3. A code that expired when the vendor entered it: the state moved, and the handshake routes to Ops.
  await count(riderA, at(3));
  await initiate(riderA, at(3));
  await age(at(3));
  expect(
    outcome(await browserA.post(`${STOP(at(3))}/handshake/verify`, { code: codeOfStop(at(3)) })),
  ).toEqual([422, 'CODE_EXPIRED']);
  // 4. Five wrong codes: the attempts are used up.
  await count(riderA, at(4));
  await initiate(riderA, at(4));
  const wrong = codeOfStop(at(4)) === '0000' ? '0001' : '0000';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await browserA.post(`${STOP(at(4))}/handshake/verify`, { code: wrong });
  }
  // 5. A live code whose SMS fallback has sent all it may: the rider has nothing left to ask.
  await count(riderA, at(5));
  await initiate(riderA, at(5));
  // (The guard of the handshake lets the counter grow by one at a time, as the fallback does: the cap, one step at a time.)
  const cap = Number(
    (
      await routes.rows<{ cap: string }>(
        `select value #>> '{}' as cap from setting where key = 'sms_fallback_max_per_pickup'`,
      )
    )[0]?.cap,
  );
  expect(cap).toBeGreaterThan(0);
  for (let sent = 0; sent < cap; sent += 1) {
    await routes.admin.query(
      `update collection_handshake set fallback_sends = fallback_sends + 1 where pickup_stop_id = $1`,
      [at(5)],
    );
  }
  // 6. A handshake Ops closed by its override without a dispute.
  await count(riderA, at(6));
  await override(opsA, at(6));
  // 7. A short count: the office is flagged while the run is in progress.
  await count(riderA, at(7), 2);
  // 8 to 11. Four failures, and what the office did with each.
  await failStop(riderA, at(8), {
    contact_attempts: [
      {
        method: 'PHONE_CALL',
        attempted_at: new Date(Date.now() - 60_000).toISOString(),
        outcome: 'No answer',
        note: 'Rang four times',
      },
    ],
  });
  await failStop(riderA, at(9));
  await escalate(opsA, runA.stops[9]?.requestId ?? '');
  await failStop(riderA, at(10));
  await cancel(opsA, runA.stops[10]?.requestId ?? '', true);
  await failStop(riderA, at(11));
  await cancel(opsA, runA.stops[11]?.requestId ?? '', false);
  // 12. A code that ran out and that Senior Ops resolved by hand: settled, and recorded as Ops's own.
  await count(riderA, at(12));
  await initiate(riderA, at(12));
  await age(at(12));
  expect(
    outcome(await browserA.post(`${STOP(at(12))}/handshake/verify`, { code: codeOfStop(at(12)) })),
  ).toEqual([422, 'CODE_EXPIRED']);
  await resolveByHand(seniorA, at(12));

  // Hub A, vendor B: a short count, closed by Ops, disputed, the run completed and the dispute resolved.
  const runB = await open(vendorB, HUB_A, 1);
  await count(runB.rider, stopAt(runB, 0), 2);
  await override(opsA, stopAt(runB, 0));
  await dispute(browserB, stopAt(runB, 0));
  await routes.admin.query(
    `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = $1`,
    [runB.manifest.id],
  );
  await routes.admin.query(
    `update collection_dispute set state = 'RESOLVED', resolved_at = now() where pickup_stop_id = $1`,
    [stopAt(runB, 0)],
  );

  // Hub B, vendor C: one of each kind, so that a list that did not scope by hub would show it to hub A.
  const runC = await open(vendorC, HUB_B, 4);
  await count(runC.rider, stopAt(runC, 0));
  await override(opsB, stopAt(runC, 0));
  await dispute(browserC, stopAt(runC, 0));
  await count(runC.rider, stopAt(runC, 1));
  await initiate(runC.rider, stopAt(runC, 1));
  await age(stopAt(runC, 1));
  await count(runC.rider, stopAt(runC, 2), 2);
  await failStop(runC.rider, stopAt(runC, 3));

  return {
    runA,
    runB,
    runC,
    disputeOpen: at(0),
    disputeResolved: stopAt(runB, 0),
    disputeOtherHub: stopAt(runC, 0),
    handshakeLive: at(1),
    handshakeClockExpired: at(2),
    handshakeExpired: at(3),
    handshakeExhausted: at(4),
    handshakeFallbackUsed: at(5),
    handshakeOverridden: at(6),
    handshakeResolved: at(12),
    handshakeOtherHub: stopAt(runC, 1),
    shortfallOpen: at(7),
    shortfallClosed: stopAt(runB, 0),
    shortfallOtherHub: stopAt(runC, 2),
    failurePending: at(8),
    failureEscalated: at(9),
    failureRescheduled: at(10),
    failureCancelled: at(11),
    failureOtherHub: stopAt(runC, 3),
  };
}

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor();
  vendorC = await routes.vendor({ hubId: HUB_B });
  const signedIn = async (vendor: ArrangedVendor): Promise<TestClient> => {
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    return browser;
  };
  browserA = await signedIn(vendorA);
  browserB = await signedIn(vendorB);
  browserC = await signedIn(vendorC);
  opsA = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  seniorA = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  platformAdmin = await routes.platformAdmin();
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution) values ($1, 'PICKUP_CANCELLATION', 'Fixture reason', 'CUSTOMER')`,
    [CANCEL_REASON],
  );
  world = await build();
}, 900_000);

afterAll(async () => {
  await routes.stop();
});

const contract = fileContractSource.load() as {
  components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};
const MEMBERS = (which: Which): string[] =>
  Object.keys(contract.components.schemas[SCHEMAS[which]]?.properties ?? {}).toSorted();

describe('every item holds the contract’s members and no other', () => {
  // Break caught: a member of a row on the wire that the contract does not name (a code, a digest, a phone number), or one it names left out.
  it.each(WHICH)('%s', async (which) => {
    const items = await everything(platformAdmin.client, which);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(Object.keys(item).toSorted()).toEqual(MEMBERS(which));
  });
});

describe('listCollectionDisputes', () => {
  // Break caught (AC-SLICE-001-27): the order (newest first, or by the stop), the pickup and the count missing from an item, a resolved item shown as open.
  it('lists the disputes of the hub, oldest first, with the pickup and what was counted', async () => {
    const items = await everything(opsA.client, 'disputes');

    expect(stopsOf(items)).toEqual([world.disputeOpen, world.disputeResolved]);
    expect(items[0]).toMatchObject({
      pickup_stop_id: world.disputeOpen,
      pickup_request_id: world.runA.stops[0]?.requestId,
      pickup_manifest_id: world.runA.manifest.id,
      responsible_hub_id: HUB_A,
      request_code: world.runA.stops[0]?.requestCode,
      sender_name: 'Fixture Sender',
      vendor_organization_id: vendorA.row.organizationId,
      state: 'OPEN',
      note: DISPUTE_NOTE,
      resolved_at: null,
      stop_state: 'COLLECTED',
      declared_count: 3,
      collected_count: 3,
      variance: 'MATCH',
    });
    expect(items[1]).toMatchObject({
      vendor_organization_id: vendorB.row.organizationId,
      state: 'RESOLVED',
      stop_state: 'PARTIALLY_COLLECTED',
      declared_count: 3,
      collected_count: 2,
      variance: 'SHORT',
    });
    expect(typeof items[1]?.resolved_at).toBe('string');
    expect(Date.parse(String(items[0]?.created_at))).toBeLessThan(
      Date.parse(String(items[1]?.created_at)),
    );
  });

  // Break caught: `open` read as the other way round, or ignored.
  it('open is the items still OPEN, and its complement the resolved ones', async () => {
    expect(stopsOf(await everything(opsA.client, 'disputes', { open: true }))).toEqual([
      world.disputeOpen,
    ]);
    expect(stopsOf(await everything(opsA.client, 'disputes', { open: false }))).toEqual([
      world.disputeResolved,
    ]);
  });
});

describe('listHandshakesForOps', () => {
  const limits = async () => {
    const rows = await routes.rows<{ key: string; value: number }>(
      `select key, value from setting where key in ('handshake_max_wrong_attempts', 'sms_fallback_max_per_pickup')`,
    );
    const valueOf = (key: string): number | undefined => rows.find((row) => row.key === key)?.value;
    return {
      attempts: valueOf('handshake_max_wrong_attempts'),
      fallback: valueOf('sms_fallback_max_per_pickup'),
    };
  };

  // Break caught (AC-SLICE-001-26): a handshake that was never tried left out because its state never moved; a live handshake listed; the order; the limit
  // missing from an item; a handshake Ops settled listed as waiting.
  it('lists what routes to Ops and what Ops settled, oldest first, and says why each routes', async () => {
    const items = await everything(opsA.client, 'handshakes');
    const { attempts, fallback } = await limits();

    expect(stopsOf(items)).toEqual([
      world.disputeOpen,
      world.handshakeClockExpired,
      world.handshakeExpired,
      world.handshakeExhausted,
      world.handshakeFallbackUsed,
      world.handshakeOverridden,
      world.handshakeResolved,
      world.disputeResolved,
    ]);
    expect(stopsOf(items)).not.toContain(world.handshakeLive);
    const by = (stopId: string): Item => {
      const found = items.find((item) => item.pickup_stop_id === stopId);
      if (found === undefined) throw new Error(`no item for ${stopId}`);
      return found;
    };
    // Its state never moved (nobody asked), and the database says it ran out all the same.
    expect(String(by(world.handshakeClockExpired).state)).toMatch(/^CODE_(GENERATED|DELIVERED)$/);
    expect(by(world.handshakeClockExpired)).toMatchObject({
      routed_because: 'CODE_EXPIRED',
      stop_state: 'ARRIVED',
      channel: null,
      confirmed_at: null,
      authorised_by: null,
    });
    expect(by(world.handshakeExpired)).toMatchObject({
      state: 'EXPIRED',
      routed_because: 'CODE_EXPIRED',
    });
    expect(by(world.handshakeExhausted)).toMatchObject({
      state: 'EXHAUSTED',
      routed_because: 'ATTEMPTS_EXHAUSTED',
      attempts: attempts,
      attempt_limit: attempts,
    });
    expect(by(world.handshakeFallbackUsed)).toMatchObject({
      routed_because: 'FALLBACK_LIMIT_REACHED',
      fallback_sends: fallback,
      fallback_limit: fallback,
    });
    // What Ops settled: its channel and the officer, and no reason to route.
    for (const stopId of [world.handshakeOverridden, world.disputeOpen]) {
      expect(by(stopId)).toMatchObject({
        routed_because: null,
        channel: 'OPS_OVERRIDE',
        authorised_by: opsA.identity.id,
      });
      expect(typeof by(stopId).confirmed_at).toBe('string');
    }
    expect(by(world.handshakeResolved)).toMatchObject({
      state: 'MANUALLY_RESOLVED',
      routed_because: null,
      channel: 'OPS_OVERRIDE',
      authorised_by: seniorA.identity.id,
      stop_state: 'COLLECTED',
    });
    expect(by(world.handshakeOverridden)).toMatchObject({
      state: 'VERIFIED',
      stop_state: 'COLLECTED',
      direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
    });
    expect(by(world.disputeOpen)).toMatchObject({ state: 'DISPUTED' });
  });

  // Break caught: `open` taken from the state alone (so that the code that ran out on the clock is missed), or its complement taken as "everything else".
  it('open is what needs Ops now, and its complement what Ops settled', async () => {
    expect(stopsOf(await everything(opsA.client, 'handshakes', { open: true }))).toEqual([
      world.handshakeClockExpired,
      world.handshakeExpired,
      world.handshakeExhausted,
      world.handshakeFallbackUsed,
    ]);
    expect(stopsOf(await everything(opsA.client, 'handshakes', { open: false }))).toEqual([
      world.disputeOpen,
      world.handshakeOverridden,
      world.handshakeResolved,
      world.disputeResolved,
    ]);
    const reasons = (await everything(opsA.client, 'handshakes', { open: true })).map(
      (item) => item.routed_because,
    );
    expect(reasons).toEqual([
      'CODE_EXPIRED',
      'CODE_EXPIRED',
      'ATTEMPTS_EXHAUSTED',
      'FALLBACK_LIMIT_REACHED',
    ]);
  });

  // Break caught: a default invented for an unusable cap (the platform's own value is the only one), or a cap that fails the whole list.
  it('judges nothing by a cap the platform holds no usable value for, and says so as null', async () => {
    const original = (
      await routes.rows<{ value: unknown }>(
        `select value from setting where key = 'sms_fallback_max_per_pickup'`,
      )
    )[0]?.value;
    await routes.admin.query(
      `update setting set value = '"not a number"'::jsonb where key = 'sms_fallback_max_per_pickup'`,
    );
    try {
      const items = await everything(opsA.client, 'handshakes', { open: true });

      expect(stopsOf(items)).toEqual([
        world.handshakeClockExpired,
        world.handshakeExpired,
        world.handshakeExhausted,
      ]);
      for (const item of items) expect(item.fallback_limit).toBeNull();
    } finally {
      await routes.admin.query(
        `update setting set value = $1::jsonb where key = 'sms_fallback_max_per_pickup'`,
        [JSON.stringify(original)],
      );
    }
  });
});

describe('listCollectionShortfalls', () => {
  // Break caught (AC-SLICE-001-21, OB-S1-51): a clean count listed, the shortfall computed the wrong way, the reason or the rider missing.
  it('lists the short counts of the hub, oldest first, with what was declared, counted and why', async () => {
    const items = await everything(opsA.client, 'shortfalls');

    expect(stopsOf(items)).toEqual([world.shortfallOpen, world.shortfallClosed]);
    expect(items[0]).toMatchObject({
      pickup_request_id: world.runA.stops[7]?.requestId,
      pickup_manifest_id: world.runA.manifest.id,
      responsible_hub_id: HUB_A,
      request_code: world.runA.stops[7]?.requestCode,
      declared_count: 3,
      collected_count: 2,
      shortfall_count: 1,
      reason: { code: 'SOME_PARCELS_NOT_READY', attribution: 'CUSTOMER' },
      note: null,
      recorded_by: world.runA.rider.id,
      stop_state: 'ARRIVED',
      run_state: 'IN_PROGRESS',
    });
    expect((items[0]?.reason as { label: string }).label.length).toBeGreaterThan(0);
    expect(Date.parse(String(items[0]?.office_notified_at))).not.toBeNaN();
    expect(items[1]).toMatchObject({
      stop_state: 'PARTIALLY_COLLECTED',
      run_state: 'COMPLETED',
      recorded_by: world.runB.rider.id,
    });
  });

  // Break caught: `open` read from the stop and not the run, or its complement left out.
  it('open is the shortfalls of runs still in progress, and its complement those of runs that ended', async () => {
    expect(stopsOf(await everything(opsA.client, 'shortfalls', { open: true }))).toEqual([
      world.shortfallOpen,
    ]);
    expect(stopsOf(await everything(opsA.client, 'shortfalls', { open: false }))).toEqual([
      world.shortfallClosed,
    ]);
  });
});

describe('listPickupFailures', () => {
  const byStop = async (stopId: string): Promise<Item> => {
    const found = (await everything(opsA.client, 'failures')).find(
      (item) => item.pickup_stop_id === stopId,
    );
    if (found === undefined) throw new Error(`no failure for ${stopId}`);
    return found;
  };

  // Break caught (AC-SLICE-001-30, -31): the facts of the failure missing from the queue (the category, the reason, the note, the attempts), the order.
  it('lists the failed stops of the hub, oldest first, with what the rider reported', async () => {
    const items = await everything(opsA.client, 'failures');

    expect(stopsOf(items)).toEqual([
      world.failurePending,
      world.failureEscalated,
      world.failureRescheduled,
      world.failureCancelled,
    ]);
    expect(items[0]).toMatchObject({
      pickup_stop_id: world.failurePending,
      pickup_request_id: world.runA.stops[8]?.requestId,
      pickup_manifest_id: world.runA.manifest.id,
      responsible_hub_id: HUB_A,
      request_code: world.runA.stops[8]?.requestCode,
      sender_name: 'Fixture Sender',
      category: 'PARCEL_NOT_READY',
      reason: { code: 'PARCELS_NOT_PACKED', attribution: 'CUSTOMER' },
      note: FAILURE_NOTE,
      request_state: 'CONFIRMED',
      decision: 'PENDING',
      attempt_number: 1,
      attempt_extended: false,
      escalated_at: null,
      decided_at: null,
      replacement_request_id: null,
      rider_id: world.runA.rider.id,
    });
    expect((items[0]?.reason as { label: string }).label.length).toBeGreaterThan(0);
    const attempts = items[0]?.contact_attempts as { attempted_at: string }[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({
      method: 'PHONE_CALL',
      attempted_at: attempts[0]?.attempted_at,
      outcome: 'No answer',
      note: 'Rang four times',
    });
    expect(Date.parse(attempts[0]?.attempted_at ?? '')).not.toBeNaN();
    expect(items[1]?.contact_attempts).toEqual([]);
  });

  // Break caught (AC-SLICE-001-33): a failure whose request the office escalated shown as decided or as pending; a reschedule shown as a cancellation.
  it('says what became of each request', async () => {
    expect(await byStop(world.failurePending)).toMatchObject({ decision: 'PENDING' });
    expect(await byStop(world.failureEscalated)).toMatchObject({
      request_state: 'CONFIRMED',
      decision: 'ESCALATED',
      decided_at: null,
    });
    expect(typeof (await byStop(world.failureEscalated)).escalated_at).toBe('string');
    const rescheduled = await byStop(world.failureRescheduled);
    expect(rescheduled).toMatchObject({ request_state: 'CANCELLED', decision: 'RESCHEDULED' });
    expect(typeof rescheduled.replacement_request_id).toBe('string');
    expect(typeof rescheduled.decided_at).toBe('string');
    expect(await byStop(world.failureCancelled)).toMatchObject({
      request_state: 'CANCELLED',
      decision: 'CANCELLED',
      replacement_request_id: null,
    });
  });

  // Break caught (AC-SLICE-001-34): `open` taken from the escalation (so that an escalated failure leaves the queue), or its complement left out.
  it('open is the failures whose request is still CONFIRMED, escalated or not, and its complement the decided ones', async () => {
    expect(stopsOf(await everything(opsA.client, 'failures', { open: true }))).toEqual([
      world.failurePending,
      world.failureEscalated,
    ]);
    expect(stopsOf(await everything(opsA.client, 'failures', { open: false }))).toEqual([
      world.failureRescheduled,
      world.failureCancelled,
    ]);
  });

  // Break caught: the waiting time read from the client's clock or fixed when the failure was made; one that goes on running after the office decided.
  it('counts the waiting time on the database’s clock: until the read while it waits, until the decision once decided', async () => {
    const pending = await byStop(world.failurePending);
    const [now] = await routes.rows<{ waited: number }>(
      `select floor(extract(epoch from (clock_timestamp() - resolved_at)))::int as waited from pickup_stop where id = $1`,
      [world.failurePending],
    );
    const waited = pending.waiting_seconds as number;
    expect(waited).toBeLessThanOrEqual(now?.waited ?? -1);
    expect((now?.waited ?? 0) - waited).toBeLessThan(30);

    const [decided] = await routes.rows<{ waited: number }>(
      `select floor(extract(epoch from (r.cancelled_at - s.resolved_at)))::int as waited
         from pickup_stop s join pickup_request r on r.id = s.pickup_request_id where s.id = $1`,
      [world.failureRescheduled],
    );
    expect((await byStop(world.failureRescheduled)).waiting_seconds).toBe(decided?.waited);
  });
});

describe('the hub, and the position of a page', () => {
  // Break caught (AC-HUBF-01): the hub of the query ignored, or widening what the session may read.
  it.each(WHICH)(
    '%s: hub_id narrows to the hub, and a hub outside the grant widens nothing',
    async (which) => {
      const whole = stopsOf(await everything(opsA.client, which));
      expect(whole.length).toBeGreaterThan(0);
      expect(stopsOf(await everything(opsA.client, which, { hub_id: HUB_A }))).toEqual(whole);

      for (const hub of [HUB_B, '00000000-0000-4000-8000-000000000000']) {
        const answer = await pageOf(opsA.client, which, { hub_id: hub });
        expect([answer.status, answer.json()]).toEqual([200, { items: [], next_page_token: null }]);
      }
      // The platform administrator reads every hub, and the hub filter narrows it to either.
      const every = stopsOf(await everything(platformAdmin.client, which));
      const inB = stopsOf(await everything(platformAdmin.client, which, { hub_id: HUB_B }));
      expect(inB.length).toBeGreaterThan(0);
      expect(stopsOf(await everything(platformAdmin.client, which, { hub_id: HUB_A }))).toEqual(
        whole,
      );
      expect(every.toSorted()).toEqual([...whole, ...inB].toSorted());
      expect(whole.some((stop) => inB.includes(stop))).toBe(false);
    },
  );

  // Break caught (AC-HUBF-07): a value that is not a hub, an open that is not a boolean, a page size or a position taken on trust.
  it.each(WHICH)(
    '%s: refuses a hub, an open, a page size and a position that are not valid, naming the parameter',
    async (which) => {
      for (const [query, pointer] of [
        [{ hub_id: 'not-a-hub' }, '/hub_id'],
        [{ open: 'maybe' }, '/open'],
        [{ open: 'TRUE' }, '/open'],
        [{ page_size: 0 }, '/page_size'],
        [{ page_size: 101 }, '/page_size'],
        [{ page_token: 'not-a-position' }, '/page_token'],
      ] as const) {
        const refused = await pageOf(opsA.client, which, query);
        expect(outcome(refused), JSON.stringify(query)).toEqual([400, 'VALIDATION_FAILED']);
        // The contract's validation names the parameter ("hub_id"), the service as a pointer ("/hub_id"): the refusal is the same, whichever layer makes it.
        expect(
          violationsOf(refused).map((violation) => violation.pointer.replace(/^\//, '')),
          JSON.stringify(query),
        ).toContain(pointer.replace(/^\//, ''));
      }
    },
  );

  // Break caught: a position that skips or repeats a row (the moment alone, or the id alone), or a last page that points to another.
  it.each(WHICH)(
    '%s: paging by one reaches the same items as one page, none twice',
    async (which) => {
      const whole = stopsOf(await everything(platformAdmin.client, which));
      const paged: string[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const response = await pageOf(platformAdmin.client, which, {
          page_size: 1,
          ...(token === null ? {} : { page_token: token }),
        });
        expect(response.status).toBe(200);
        const page = bodyOf(response);
        expect(page.items.length).toBeLessThanOrEqual(1);
        paged.push(...stopsOf(page.items));
        token = page.next_page_token;
        pages += 1;
      } while (token !== null && pages < 50);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(paged.length);
    },
  );
});

describe('whose, and what is audited', () => {
  const crossings = (operation: string) =>
    routes.rows<{ responsible_hub_id: string; object_id: string }>(
      `select responsible_hub_id, object_id from audit_event
        where event_code = 'auth.hub_boundary.crossed' and related_ids ->> 'operation_id' = $1
        order by recorded_at, id`,
      [operation],
    );

  // Break caught (audit.md sections 5.4 and 6): a read of another hub that is not audited, one audit event for each row and not for each hub, an event for the
  // actor's own hub, or one for a page that returned nothing.
  it.each(WHICH)(
    '%s: a read across hubs is audited once for each foreign hub, and a read of the own hub is not',
    async (which) => {
      const operation = OPERATIONS[which];
      const before = (await crossings(operation)).length;

      await everything(opsA.client, which);
      expect((await crossings(operation)).length, 'a read of the own hub').toBe(before);
      expect([
        (await pageOf(opsA.client, which, { hub_id: HUB_B })).status,
        (await crossings(operation)).length,
      ]).toEqual([200, before]);

      await everything(platformAdmin.client, which);
      const written = (await crossings(operation)).slice(before);
      expect(written.map((event) => event.responsible_hub_id).toSorted()).toEqual(
        [HUB_A, HUB_B].toSorted(),
      );
      expect(written.every((event) => event.object_id === event.responsible_hub_id)).toBe(true);
    },
  );

  // Break caught (GBT-D, the existence rule): a hub-A officer shown a hub-B item, or a list that is not scoped by the grant.
  it.each(WHICH)('%s: an officer of one hub never sees the items of another', async (which) => {
    const ofA = stopsOf(await everything(opsA.client, which));
    const ofB = stopsOf(await everything(opsB.client, which));

    expect(ofB.length).toBeGreaterThan(0);
    expect(ofA.filter((stop) => ofB.includes(stop))).toEqual([]);
  });

  // Break caught: a list opened by a key it does not name, or by none; the key of one list opening another's.
  it.each(WHICH)('%s: is read with the one key it names and with no other', async (which) => {
    const reads = async (keys: string[]): Promise<number> => {
      const bundle = await newBundle(
        routes.admin,
        keys.map((key) => grant(key, 'own')),
      );
      const actor = await routes.actor(bundle, HUB_A);
      return (await pageOf(actor.client, which)).status;
    };

    expect(await reads([KEYS[which]])).toBe(200);
    const others = [...new Set(Object.values(KEYS))].filter((key) => key !== KEYS[which]);
    for (const key of [...others, 'dispatch.read', 'notification.read']) {
      expect(await reads([key]), key).toBe(403);
    }
    expect(await reads([])).toBe(403);
  });

  // Break caught: a list served to a vendor (its own dispute is not Ops's list), to a rider, or to no session.
  it.each(WHICH)('%s: refuses a vendor, a rider and a caller with no session', async (which) => {
    expect(outcome(await pageOf(browserA, which))).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await pageOf(world.runA.rider.client, which))).toEqual([401, 'SESSION_INVALID']);
    expect(outcome(await pageOf(routes.kit.client.fork(), which))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
  });
});

describe('what never reaches the wire', () => {
  // Break caught: a handshake code or digest, a phone number, the Ops note of an override, or a member of a row that the contract does not name.
  it('carries no code, no digest, no phone number and no note of Ops’s in any list', async () => {
    const texts: string[] = [];
    for (const which of WHICH) {
      texts.push(JSON.stringify(await everything(platformAdmin.client, which)));
    }
    const everyText = texts.join('\n');
    const stops = [
      world.handshakeLive,
      world.handshakeClockExpired,
      world.handshakeExpired,
      world.handshakeExhausted,
      world.handshakeFallbackUsed,
    ];

    for (const stop of stops) expect(everyText).not.toContain(`"${codeOfStop(stop)}"`);
    for (const sentinel of [
      PHONE,
      OVERRIDE_NOTE,
      RESOLVE_NOTE,
      'code_digest',
      'primary_phone',
      'contact_phone',
    ]) {
      expect(everyText, sentinel).not.toContain(sentinel);
    }
  });
});
