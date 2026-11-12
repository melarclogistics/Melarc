import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nextOperatingDay } from '../../src/pickup/booking-rules.js';
import { MAX_MANIFEST_STOPS } from '../../src/pickup/pickup-manifest-schemas.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type StopState,
} from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangedRider } from './support/runs.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.20, `createPickupManifest`, `listPickupManifests` and `getPickupManifest` against the real application and a real PostgreSQL
 * (`AC-SLICE-001-11`; pickup-manifest.md sections 4 and 5; the Product Owner's decisions of 29 October and 1 November 2026, plan section
 * 11): Ops builds a `DRAFT` manifest from confirmed requests that are on no manifest, each becoming a stop; what a reader sees of
 * manifests follows the hubs of the grant for staff and assignment, from dispatch, for a rider; a vendor sees none (`GBT-C9`); the read of
 * one tells a manifest outside the staff reader's hubs from one that does not exist and tells a rider nothing; and the unmanifested pool
 * is the `manifested` filter of the request list.
 *
 * The claim of two Ops users on one request, and the cancellation that meets a creation, are `pickup-manifest-races.db.test.ts`; the
 * claim rule as the database holds it for every writer is `pickup-manifest-claim.db.test.ts`.
 */
const LIST = `${API}/pickup-manifests`;
const ONE = (id: string) => `${LIST}/${id}`;
const REQUESTS = `${API}/pickup-requests`;
/** A day for the bodies the schema refuses before any rule reads the day, so that it may be any valid date. */
const SCHEMA_DAY = '2026-11-04';
/** The fixture reasons of the carry-over (see `beforeAll`). */
const CARRYOVER = {
  road: 'FIXTURE_CARRYOVER_ROAD',
  closed: 'FIXTURE_CARRYOVER_CLOSED',
  needsNote: 'FIXTURE_CARRYOVER_NEEDS_NOTE',
  retired: 'FIXTURE_CARRYOVER_RETIRED',
  otherDomain: 'FIXTURE_CARRYOVER_OTHER_DOMAIN',
} as const;
/** The days of the tests, relative to the database's clock on the hub (support/manifest-days.ts), set before any test runs. */
let days: ManifestDays;

let routes: VendorRoutes;
let ops: Actor;
let opsB: Actor;
let senior: Actor;
/** Reaches both hubs for the pickup keys (an all-hub grant), with a primary hub of its own. */
let wide: Actor;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;

beforeAll(async () => {
  routes = await startVendorRoutes();
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor({ hubId: HUB_B });
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  const bundle = await newBundle(routes.admin, [
    grant('pickup.manifest.create', 'all', 'any', 'A'),
    grant('pickup.read', 'all', 'any', 'A'),
  ]);
  wide = await routes.actor(bundle, HUB_A);
  // The codes of the PICKUP_CARRYOVER domain are the Product Owner's and none is seeded, so the tests that need one make their own
  // (named FIXTURE_, as the other fixtures are): an active one, one that wants a note, a retired one, and one of another domain.
  const reasonCode = (
    code: string,
    domain: string,
    over: { requiresNote?: boolean; active?: boolean } = {},
  ): Promise<unknown> =>
    routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active) values ($1, $2, $3, 'EXTERNAL', $4, $5)`,
      [code, domain, `Fixture ${code}`, over.requiresNote ?? false, over.active ?? true],
    );
  await reasonCode(CARRYOVER.road, 'PICKUP_CARRYOVER');
  await reasonCode(CARRYOVER.closed, 'PICKUP_CARRYOVER');
  await reasonCode(CARRYOVER.needsNote, 'PICKUP_CARRYOVER', { requiresNote: true });
  await reasonCode(CARRYOVER.retired, 'PICKUP_CARRYOVER', { active: false });
  await reasonCode(CARRYOVER.otherDomain, 'PICKUP_CANCELLATION');
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
  readonly skipped: unknown;
}
interface Manifest {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly service_date: string;
  readonly responsible_hub_id: string;
  readonly assigned_rider_id: string | null;
  readonly assigned_at: string | null;
  readonly dispatched_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly stops?: Stop[];
}
interface Page {
  readonly items: Manifest[];
  readonly next_page_token: string | null;
}
interface Violation {
  readonly in: string;
  readonly pointer: string;
  readonly rule: string;
}
const manifestOf = (response: TestResponse): Manifest => response.json() as Manifest;
const pageOf = (response: TestResponse): Page => response.json() as Page;
const idsOf = (response: TestResponse): string[] => pageOf(response).items.map((item) => item.id);
const violationsOf = (response: TestResponse): Violation[] =>
  (response.json() as { details?: { violations?: Violation[] } }).details?.violations ?? [];
const at = (position: number, rule: string): Violation => ({
  in: 'body',
  pointer: `/pickup_request_ids/${String(position)}`,
  rule,
});

/** What two answers must share to be indistinguishable: everything but the request's own identifier and the moment. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: (() => {
    const body = response.json() as Record<string, unknown>;
    return { ...body, request_id: undefined };
  })(),
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
  cookies: response.setCookies,
});

/** Every manifest a reader is shown, whatever the number of pages. */
async function everything(reader: Pick<Actor, 'client'> | { client: TestClient }): Promise<Page> {
  const items: Manifest[] = [];
  let token: string | null = null;
  do {
    const answer: TestResponse = await reader.client.get(
      `${LIST}?page_size=100${token === null ? '' : `&page_token=${token}`}`,
    );
    expect(answer.status).toBe(200);
    items.push(...pageOf(answer).items);
    token = pageOf(answer).next_page_token;
  } while (token !== null);
  return { items, next_page_token: null };
}

/** A confirmed request of the hub for a day, as the administrator arranges it (the booking and its confirmation are other tasks' tests). */
async function confirmed(
  hub: string = HUB_A,
  overrides: Parameters<typeof pickupRequestRow>[2] = {},
): Promise<string> {
  const organisation = hub === HUB_B ? vendorB.row.organizationId : vendorA.row.organizationId;
  return (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, hub, {
        state: 'CONFIRMED',
        serviceDate: days.day,
        ...overrides,
      }),
    )
  ).id;
}

const confirmedMany = async (count: number, hub: string = HUB_A): Promise<string[]> => {
  const made: string[] = [];
  for (let each = 0; each < count; each += 1) made.push(await confirmed(hub));
  return made;
};

function create(
  actor: Actor,
  ids: readonly string[],
  serviceDate: string = days.day,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> {
  return actor.client.post(
    LIST,
    { pickup_request_ids: ids, service_date: serviceDate },
    { origin: OPS, headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

/** An entry of `carryover`: why this overdue request goes on a later day's manifest. */
const carried = (requestId: string, reason: string, note?: string) => ({
  pickup_request_id: requestId,
  reason_code: reason,
  ...(note === undefined ? {} : { note }),
});

/** `createPickupManifest` with the reasons of the requests it carries over (none sent where `carryover` is undefined). */
function createCarrying(
  actor: Actor,
  ids: readonly string[],
  carryover: readonly unknown[] | undefined,
  serviceDate: string = days.day,
  idempotencyKey: string = randomUUID(),
): Promise<TestResponse> {
  return actor.client.post(
    LIST,
    {
      pickup_request_ids: ids,
      service_date: serviceDate,
      ...(carryover === undefined ? {} : { carryover }),
    },
    { origin: OPS, headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

/** What each stop of a manifest keeps of the reason its request was carried over for, by request. */
async function carryoversOf(manifestId: string): Promise<Record<string, unknown>> {
  const rows = await routes.rows<{ pickup_request_id: string; carryover_snapshot: unknown }>(
    `select pickup_request_id, carryover_snapshot from pickup_stop where pickup_manifest_id = $1`,
    [manifestId],
  );
  return Object.fromEntries(rows.map((row) => [row.pickup_request_id, row.carryover_snapshot]));
}

interface Counts {
  readonly manifests: number;
  readonly stops: number;
  readonly created: number;
}
/** What the application has written, read from a second connection: a refusal must leave all three exactly as they were. */
async function counts(): Promise<Counts> {
  const [row] = await routes.rows<{ manifests: number; stops: number; created: number }>(
    `select (select count(*) from pickup_manifest)::int as manifests,
            (select count(*) from pickup_stop)::int as stops,
            (select count(*) from audit_event where event_code = 'pickup.manifest.created')::int as created`,
  );
  if (row === undefined) throw new Error('no counts');
  return row;
}

const stopsOf = (manifestId: string) =>
  routes.rows<{
    pickup_request_id: string;
    sequence: number;
    state: string;
    responsible_hub_id: string;
    released_at: Date | null;
  }>(
    `select pickup_request_id, sequence, state, responsible_hub_id, released_at
       from pickup_stop where pickup_manifest_id = $1 order by sequence`,
    [manifestId],
  );

/** Asserts a refusal changed nothing, and returns it. */
async function refusedWithoutTrace(attempt: () => Promise<TestResponse>): Promise<TestResponse> {
  const before = await counts();
  const answer = await attempt();
  expect(await counts()).toEqual(before);
  return answer;
}

describe('createPickupManifest: a manifest from confirmed requests (AC-SLICE-001-11)', () => {
  // Break caught: a manifest that is not a DRAFT, that is assigned or dispatched at birth, that names a hub other than its requests', that
  // loses the order of the stops, or that answers with something other than the manifest and the version it can be changed with.
  it('creates a DRAFT manifest of the requests’ hub, one PENDING stop for each request, in the order named', async () => {
    // Named from the highest request id to the lowest, so that the order named is neither the order made nor the order of the ids.
    const ids = (await confirmedMany(3)).toSorted().toReversed();
    const answer = await create(ops, ids);
    expect(answer.status).toBe(201);
    expect(answer.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const manifest = manifestOf(answer);
    expect(manifest).toMatchObject({
      state: 'DRAFT',
      service_date: days.day,
      responsible_hub_id: HUB_A,
      assigned_rider_id: null,
      assigned_at: null,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
    });
    expect(manifest.code).toMatch(/^[A-Z]{3}-MF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // The moment the run was made is the table's own column, stated as an instant (contract 5.100.0).
    const [made] = await routes.rows<{ created_at: Date }>(
      `select created_at from pickup_manifest where id = $1`,
      [manifest.id],
    );
    expect(made?.created_at).toBeInstanceOf(Date);
    expect(manifest.created_at).toBe(made?.created_at.toISOString());
    expect(
      manifest.stops?.map((stop) => [stop.sequence, stop.pickup_request_id, stop.state]),
    ).toEqual(ids.map((id, position) => [position + 1, id, 'PENDING']));
    for (const stop of manifest.stops ?? []) {
      expect(stop).toMatchObject({
        pickup_manifest_id: manifest.id,
        arrived_at: null,
        failure_category: null,
        failure: null,
        skipped: null,
      });
      expect(stop).not.toHaveProperty('pickup_summary');
    }

    // What the database holds: the manifest made by the actor, the hub copied to every stop, every claim unreleased.
    const [row] = await routes.rows<{
      created_by: string;
      version: number;
      responsible_hub_id: string;
    }>(`select created_by, version, responsible_hub_id from pickup_manifest where id = $1`, [
      manifest.id,
    ]);
    expect(row).toEqual({ created_by: ops.identity.id, version: 1, responsible_hub_id: HUB_A });
    expect(await stopsOf(manifest.id)).toEqual(
      ids.map((id, position) => ({
        pickup_request_id: id,
        sequence: position + 1,
        state: 'PENDING',
        responsible_hub_id: HUB_A,
        released_at: null,
      })),
    );
  });

  // Break caught: a read that does not agree with the creation, so that the version a client was given cannot be the version it reads.
  it('answers what a read of the manifest answers, with the same version', async () => {
    const ids = await confirmedMany(2);
    const made = await create(ops, ids);
    expect(made.status).toBe(201);
    const read = await ops.client.get(ONE(manifestOf(made).id));
    expect(read.status).toBe(200);
    expect(read.json()).toEqual(made.json());
    expect(read.header('etag')).toBe(made.header('etag'));
  });

  // Break caught: a manifest that cannot be made of one request, or an event that does not record the membership and the order.
  it('writes pickup.manifest.created in the same transaction: the actor, the hub, the state, the membership and its order', async () => {
    const ids = (await confirmedMany(2)).toSorted().toReversed();
    const before = await counts();
    const made = await create(ops, ids);
    expect(made.status).toBe(201);
    expect((await counts()).created).toBe(before.created + 1);
    const events = await routes.rows<{
      actor_id: string;
      enhanced: boolean;
      resulting_state: string;
      responsible_hub_id: string;
      object_type: string;
      related_ids: { pickup_request_ids: string[] };
      detail: { stop_count: number; carried_over_count: number };
    }>(
      `select actor_id, enhanced, resulting_state, responsible_hub_id, object_type, related_ids, detail
         from audit_event where event_code = 'pickup.manifest.created' and object_id = $1`,
      [manifestOf(made).id],
    );
    expect(events).toEqual([
      {
        actor_id: ops.identity.id,
        enhanced: false,
        resulting_state: 'DRAFT',
        responsible_hub_id: HUB_A,
        object_type: 'PickupManifest',
        related_ids: { pickup_request_ids: ids },
        detail: { stop_count: 2, carried_over_count: 0 },
      },
    ]);
    // A creation crosses no hub boundary, as a booking does not.
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
        [ops.identity.id],
      ),
    ).toEqual([]);
  });

  // Break caught: a limit that is not the contract's (the audit's, or none), so that the largest manifest, or its audit event, is refused.
  it('builds a manifest of one request, and of the most the contract allows, whose audit event the writer holds', async () => {
    expect(MAX_MANIFEST_STOPS).toBe(64);
    const [one] = await confirmedMany(1);
    expect((await create(ops, [one ?? ''])).status).toBe(201);
    const many = await confirmedMany(MAX_MANIFEST_STOPS);
    const answer = await create(ops, many);
    expect(answer.status).toBe(201);
    expect(manifestOf(answer).stops).toHaveLength(MAX_MANIFEST_STOPS);
    const [event] = await routes.rows<{ related_ids: { pickup_request_ids: string[] } }>(
      `select related_ids from audit_event where event_code = 'pickup.manifest.created' and object_id = $1`,
      [manifestOf(answer).id],
    );
    expect(event?.related_ids.pickup_request_ids).toEqual(many);
  });

  // Break caught: no upper bound on the list, or one the schema does not state, so that a long list reaches the service and the writer.
  it('refuses a list one longer than the limit by the schema, as a validation failure, and writes nothing', async () => {
    const tooMany = Array.from({ length: MAX_MANIFEST_STOPS + 1 }, () => randomUUID());
    const answer = await refusedWithoutTrace(() => create(ops, tooMany));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([
      { in: 'body', pointer: '/pickup_request_ids', rule: 'maxItems' },
    ]);
  });
});

describe('createPickupManifest: once however many times it is sent', () => {
  // Break caught: a retry that makes a second manifest or claims a request twice.
  it('replays the original answer for the same key and body, and makes one manifest', async () => {
    const ids = await confirmedMany(2);
    const key = randomUUID();
    const before = await counts();
    const first = await create(ops, ids, days.day, key);
    const second = await create(ops, ids, days.day, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.text).toBe(first.text);
    expect(second.header('etag')).toBe(first.header('etag'));
    const after = await counts();
    expect([after.manifests, after.stops, after.created]).toEqual([
      before.manifests + 1,
      before.stops + 2,
      before.created + 1,
    ]);
  });

  // Break caught: a key reused for another request answered as a replay, which would tell the client its different request had succeeded.
  it('refuses another body under the same key', async () => {
    const [one, two] = await confirmedMany(2);
    const key = randomUUID();
    expect((await create(ops, [one ?? ''], days.day, key)).status).toBe(201);
    const conflict = await create(ops, [two ?? ''], days.day, key);
    expect([conflict.status, codeOf(conflict)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: a key that a refusal used up, so that the same command could not be sent again once the cause was mended.
  it('keeps no record of a refused command: the key can be used again once the cause is mended', async () => {
    const [good] = await confirmedMany(1);
    const pending = await confirmed(HUB_A, { state: 'PENDING' });
    const key = randomUUID();
    const refused = await create(ops, [good ?? '', pending], days.day, key);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    // The same key, now with the one request that is eligible, is a new command and not a conflict.
    const mended = await create(ops, [good ?? ''], days.day, key);
    expect(mended.status).toBe(201);
  });

  it('refuses a request with no Idempotency-Key, and one with a key that is not a key, and writes nothing', async () => {
    const [one] = await confirmedMany(1);
    const body = { pickup_request_ids: [one], service_date: days.day };
    const none = await refusedWithoutTrace(() => ops.client.post(LIST, body, { origin: OPS }));
    expect([none.status, codeOf(none)]).toEqual([400, 'VALIDATION_FAILED']);
    const long = await refusedWithoutTrace(() =>
      ops.client.post(LIST, body, {
        origin: OPS,
        headers: { 'Idempotency-Key': 'k'.repeat(129) },
      }),
    );
    expect([long.status, codeOf(long)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('createPickupManifest: what the body may say', () => {
  // Break caught: a body the contract's schema refuses reaching the service, or a member the client has no business setting (a rider, a
  // sequence, a hub, a state) accepted and ignored.
  it.each([
    ['no members', {}],
    ['no requests', { pickup_request_ids: [], service_date: SCHEMA_DAY }],
    ['no day', { pickup_request_ids: [randomUUID()] }],
    [
      'requests that are not a list',
      { pickup_request_ids: randomUUID(), service_date: SCHEMA_DAY },
    ],
    ['a request that is not a UUID', { pickup_request_ids: ['nope'], service_date: SCHEMA_DAY }],
    [
      'a day that does not exist',
      { pickup_request_ids: [randomUUID()], service_date: '2026-02-30' },
    ],
    ['a day that is not a date', { pickup_request_ids: [randomUUID()], service_date: 'tomorrow' }],
    [
      'a rider',
      {
        pickup_request_ids: [randomUUID()],
        service_date: SCHEMA_DAY,
        assigned_rider_id: randomUUID(),
      },
    ],
    ['a sequence', { pickup_request_ids: [randomUUID()], service_date: SCHEMA_DAY, sequence: 1 }],
    [
      'a hub',
      { pickup_request_ids: [randomUUID()], service_date: SCHEMA_DAY, responsible_hub_id: HUB_A },
    ],
    [
      'a state',
      { pickup_request_ids: [randomUUID()], service_date: SCHEMA_DAY, state: 'DISPATCHED' },
    ],
  ])('refuses %s as a validation failure, and writes nothing', async (_label, body) => {
    const answer = await refusedWithoutTrace(() =>
      ops.client.post(LIST, body, { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } }),
    );
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('createPickupManifest: which requests may be built into a manifest', () => {
  // Break caught: a manifest for a day Ops does not work (Monday to Saturday only, MSC-DEC-149).
  it('refuses a Sunday', async () => {
    const [one] = await confirmedMany(1);
    const answer = await refusedWithoutTrace(() => create(ops, [one ?? ''], days.sunday));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'operating_day' },
    ]);
  });

  // Break caught: a manifest planned for a day that has gone, including the case that looks harmless: a request promised yesterday on a
  // manifest dated yesterday (the Product Owner, 1 November 2026, on the reviewer's recommendation: a manifest's day is the day the run is worked, and it cannot be behind us).
  it('refuses a manifest dated in the past, even for requests promised for that day, and writes nothing', async () => {
    const promisedThen = await confirmed(HUB_A, { serviceDate: days.past });
    const answer = await refusedWithoutTrace(() => create(ops, [promisedThen], days.past));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'past_day' },
    ]);
  });

  // Break caught: a boundary read the wrong way, today refused (or tomorrow, on a working day).
  it('accepts a manifest for the first day that has not passed: today, or the Monday after a Sunday', async () => {
    const request = await confirmed(HUB_A, { serviceDate: days.first });
    const answer = await create(ops, [request], days.first);
    expect(answer.status).toBe(201);
    expect(manifestOf(answer).service_date).toBe(days.first);
  });

  // Break caught: a request that is not confirmed built into a run (AC-11: only the confirmed are eligible).
  it('refuses a request that is not confirmed, at its place, and the others with it', async () => {
    const good = await confirmed();
    const pending = await confirmed(HUB_A, { state: 'PENDING' });
    const cancelled = await confirmed(HUB_A, { state: 'CANCELLED' });
    const answer = await refusedWithoutTrace(() => create(ops, [good, pending, cancelled]));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([at(1, 'not_confirmed'), at(2, 'not_confirmed')]);
  });

  // Break caught: a late booking claimed before Ops decides it, or shut out of the queues the pool's rule is not meant to hide it from.
  it('refuses a request awaiting the review of its cutoff, which the request list still shows', async () => {
    const waiting = await confirmed(HUB_A, { cutoffState: 'PENDING_OPS_REVIEW' });
    const answer = await refusedWithoutTrace(() => create(ops, [waiting]));
    expect(violationsOf(answer)).toEqual([at(0, 'awaiting_cutoff_review')]);

    const shown = await ops.client.get(
      `${REQUESTS}?service_date=${days.day}&state=CONFIRMED&page_size=100`,
    );
    expect(shown.status).toBe(200);
    const page = shown.json() as { items: { id: string }[]; next_page_token: string | null };
    // The request awaiting its review is among the confirmed ones, however many pages they fill: look it up by paging.
    let found = page.items.some((item) => item.id === waiting);
    let token = page.next_page_token;
    while (!found && token !== null) {
      const next = (
        await ops.client.get(
          `${REQUESTS}?service_date=${days.day}&state=CONFIRMED&page_size=100&page_token=${token}`,
        )
      ).json() as { items: { id: string }[]; next_page_token: string | null };
      found = next.items.some((item) => item.id === waiting);
      token = next.next_page_token;
    }
    expect(found).toBe(true);
    // Decided, it is claimable: the rule is about the pending review and nothing else.
    await routes.admin.query(
      `update pickup_request set cutoff_exception_state = 'SAME_DAY_APPROVED' where id = $1`,
      [waiting],
    );
    expect((await create(ops, [waiting])).status).toBe(201);
  });

  // Break caught: a request collected ahead of the day it was promised (the vendor was told a later day).
  it('refuses a request promised for a later day than the manifest’s, and a manifest for that later day takes it', async () => {
    const onDay = await confirmed();
    const later = await confirmed(HUB_A, { serviceDate: days.nextDay });
    const answer = await refusedWithoutTrace(() => create(ops, [onDay, later]));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([at(1, 'before_scheduled_day')]);
    expect((await create(ops, [later], days.nextDay)).status).toBe(201);
  });

  // Break caught: Melarc's own delay forcing a cancellation and a rebooking (a new promise), or a carried-over request losing the day it
  // was promised, which is what lateness is measured from (the Product Owner, 1 November 2026), or a carry-over that the audit event of the act
  // does not count.
  it('carries over a request promised for an earlier day, for its reason: the promise stays, and the audit event counts it', async () => {
    const late = await confirmed(HUB_A, { serviceDate: days.past });
    const onDay = await confirmed();
    const made = await createCarrying(ops, [late, onDay], [carried(late, CARRYOVER.road)]);
    expect(made.status).toBe(201);
    expect(manifestOf(made).service_date).toBe(days.day);
    const [promised] = await routes.rows<{ scheduled_service_date: string; state: string }>(
      `select scheduled_service_date::text as scheduled_service_date, state from pickup_request where id = $1`,
      [late],
    );
    expect(promised).toEqual({ scheduled_service_date: days.past, state: 'CONFIRMED' });
    const [event] = await routes.rows<{
      detail: { stop_count: number; carried_over_count: number };
    }>(
      `select detail from audit_event where event_code = 'pickup.manifest.created' and object_id = $1`,
      [manifestOf(made).id],
    );
    expect(event?.detail).toEqual({ stop_count: 2, carried_over_count: 1 });
  });

  // Break caught: a request named twice making two stops, or an error from the database's index answered as a server failure.
  it('refuses a request named twice at its second place, in either spelling of the id', async () => {
    const [one, two] = await confirmedMany(2);
    const answer = await refusedWithoutTrace(() =>
      create(ops, [one ?? '', two ?? '', (one ?? '').toUpperCase()]),
    );
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([at(2, 'duplicate')]);
  });

  // Break caught: a manifest that spans two hubs because the caller's grant reaches both.
  it('refuses a request of another hub than the first one’s, for a caller whose grant reaches both', async () => {
    const inA = await confirmed(HUB_A);
    const inB = await confirmed(HUB_B);
    const mixed = await refusedWithoutTrace(() => create(wide, [inA, inB]));
    expect([mixed.status, codeOf(mixed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(mixed)).toEqual([at(1, 'hub_mismatch')]);
    // Each hub's requests make a manifest of their own, by the same caller.
    const forB = await create(wide, [inB]);
    expect(forB.status).toBe(201);
    expect(manifestOf(forB).responsible_hub_id).toBe(HUB_B);
    expect((await create(wide, [inA])).status).toBe(201);
  });

  // Break caught: a refusal that stops at the first fault, so that Ops mends a list one fault at a time.
  it('reports every fault together: the day, then the places in the order they were named', async () => {
    const good = await confirmed();
    const pending = await confirmed(HUB_A, { state: 'PENDING' });
    const afterTheSunday = await confirmed(HUB_A, { serviceDate: nextOperatingDay(days.sunday) });
    const unknown = randomUUID();
    const answer = await refusedWithoutTrace(() =>
      create(ops, [good, pending, afterTheSunday, unknown], days.sunday),
    );
    expect(violationsOf(answer)).toEqual([
      { in: 'body', pointer: '/service_date', rule: 'operating_day' },
      at(1, 'not_confirmed'),
      at(2, 'before_scheduled_day'),
      at(3, 'not_available'),
    ]);
  });
});

describe('createPickupManifest: the reason for each request carried over (S1.20 closeout)', () => {
  // An Ops user of its own: the rate limit counts the requests of a principal, and these tests make many.
  let ops: Actor;
  beforeAll(async () => {
    ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  });

  const overdue = (): Promise<string> => confirmed(HUB_A, { serviceDate: days.past });
  const reasonViolation = (position: number): Violation => ({
    in: 'body',
    pointer: `/carryover/${String(position)}`,
    rule: 'reason',
  });
  const entryViolation = (position: number, member: string, rule: string): Violation => ({
    in: 'body',
    pointer: `/carryover/${String(position)}/${member}`,
    rule,
  });

  // Break caught: a carry-over the contract's schema refuses reaching the service (a member that is not a list, an entry that names no
  // request or no reason, a member of its own, a note that is not text, more entries than a manifest has stops).
  const entry = { pickup_request_id: randomUUID(), reason_code: CARRYOVER.road };
  it.each([
    ['a carry-over that is not a list', 'late'],
    ['a carry-over entry with no reason', [{ pickup_request_id: randomUUID() }]],
    ['a carry-over entry with no request', [{ reason_code: CARRYOVER.road }]],
    [
      'a carry-over entry for a request that is not a UUID',
      [{ ...entry, pickup_request_id: 'no' }],
    ],
    ['a carry-over entry with a member of its own', [{ ...entry, released: true }]],
    ['a carry-over entry whose note is not text', [{ ...entry, note: 7 }]],
    [
      'more carry-over entries than the limit of a manifest',
      Array.from({ length: MAX_MANIFEST_STOPS + 1 }, () => ({ ...entry })),
    ],
  ])('refuses %s as a validation failure, and writes nothing', async (_label, carryover) => {
    const answer = await refusedWithoutTrace(() =>
      ops.client.post(
        LIST,
        { pickup_request_ids: [randomUUID()], service_date: SCHEMA_DAY, carryover },
        { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
      ),
    );
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: overdue work carried over with no reason given for it (the silent carry-over), whether the member is missing, empty, or
  // names only some of the requests; and a refusal that names the wrong places.
  it('refuses a carried-over request that has no reason: REASON_REQUIRED at its place, and nothing is written', async () => {
    const first = await overdue();
    const second = await overdue();
    const onDay = await confirmed();
    for (const [entries, places] of [
      [undefined, [0, 2]],
      [[], [0, 2]],
      [[carried(second, CARRYOVER.road)], [0]],
      [[carried(first, CARRYOVER.road)], [2]],
    ] as const) {
      const answer = await refusedWithoutTrace(() =>
        createCarrying(ops, [first, onDay, second], entries),
      );
      expect([answer.status, codeOf(answer)], JSON.stringify(entries)).toEqual([
        422,
        'REASON_REQUIRED',
      ]);
      expect(violationsOf(answer)).toEqual(
        places.map((place) => at(place, 'carryover_reason_required')),
      );
    }
  });

  // Break caught: a reason the catalogue does not hold for this domain accepted (the domain has no code seeded, so every real code is
  // refused until the Product Owner supplies them; a retired code and a code of another domain are refused the same way), or a refusal
  // that does not say which entry it is about.
  it.each([
    ['a code the catalogue does not know', 'FIXTURE_CARRYOVER_UNKNOWN'],
    ['a retired code', CARRYOVER.retired],
    ['a code of another domain', CARRYOVER.otherDomain],
    ['a code that is not in the form of a code', 'not a code'],
  ])(
    'refuses %s: REASON_NOT_ACTIVE at the place of the entry, and nothing is written',
    async (_why, code) => {
      const late = await overdue();
      const onDay = await confirmed();
      const answer = await refusedWithoutTrace(() =>
        createCarrying(ops, [onDay, late], [carried(late, code)]),
      );
      expect([answer.status, codeOf(answer)]).toEqual([422, 'REASON_NOT_ACTIVE']);
      expect(violationsOf(answer)).toEqual([reasonViolation(0)]);
      // The text of a refused code is client text and is not repeated.
      expect(answer.text).not.toContain(code);
    },
  );

  // Break caught: a reason that wants a note accepted without one, with an empty one, or with a blank one; or a note given and lost.
  it('asks for the note a reason requires, and keeps the note it is given', async () => {
    const late = await overdue();
    for (const note of [undefined, '', '  \t ']) {
      const answer = await refusedWithoutTrace(() =>
        createCarrying(ops, [late], [carried(late, CARRYOVER.needsNote, note)]),
      );
      expect([answer.status, codeOf(answer)], JSON.stringify(note)).toEqual([
        422,
        'REASON_REQUIRED',
      ]);
      expect(violationsOf(answer)).toEqual([reasonViolation(0)]);
    }
    const made = await createCarrying(
      ops,
      [late],
      [carried(late, CARRYOVER.needsNote, 'The road to the market was shut')],
    );
    expect(made.status).toBe(201);
    expect(await carryoversOf(manifestOf(made).id)).toEqual({
      [late]: {
        reason_code: CARRYOVER.needsNote,
        label: `Fixture ${CARRYOVER.needsNote}`,
        note: 'The road to the market was shut',
      },
    });
  });

  // Break caught: a reason judged once for a whole batch (the verdict on one entry reused for the next), so that a reason that wants a note
  // is satisfied for every entry by the one that has it.
  it('judges each entry on its own: the same code given with a note and then without is refused at the second', async () => {
    const first = await overdue();
    const second = await overdue();
    const answer = await refusedWithoutTrace(() =>
      createCarrying(
        ops,
        [first, second],
        [
          carried(first, CARRYOVER.needsNote, 'The road was shut'),
          carried(second, CARRYOVER.needsNote),
        ],
      ),
    );
    expect([answer.status, codeOf(answer)]).toEqual([422, 'REASON_REQUIRED']);
    expect(violationsOf(answer)).toEqual([reasonViolation(1)]);
  });

  // Break caught: an entry accepted for a request that was not carried over (a false record of a carry-over that never was), for one the
  // manifest does not hold, or a second for the same request (which of the two reasons is true?); a note the ledger would not keep; and the
  // faults reported one at a time.
  it('refuses an entry for a request on its own day, for one not on the manifest, a second for the same request and a note it cannot keep, together', async () => {
    const late = await overdue();
    const other = await overdue();
    const onDay = await confirmed();
    const answer = await refusedWithoutTrace(() =>
      createCarrying(
        ops,
        [late, onDay, other],
        [
          carried(late, CARRYOVER.road),
          carried(onDay, CARRYOVER.road),
          carried(randomUUID(), CARRYOVER.road),
          carried(late, CARRYOVER.closed),
          carried(other, CARRYOVER.road, 'Write to me@example.com'),
        ],
      ),
    );
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([
      entryViolation(1, 'pickup_request_id', 'not_carried_over'),
      entryViolation(2, 'pickup_request_id', 'not_listed'),
      entryViolation(3, 'pickup_request_id', 'duplicate'),
      entryViolation(4, 'note', 'format'),
    ]);
  });

  // Break caught: the rules of the manifest judged after the reasons (so that a request that cannot be manifested is told it needs a
  // reason), or a reason asked for work that is refused anyway.
  it('judges the requests before the reasons: a request that cannot be manifested is refused as such, whatever reasons came with it', async () => {
    const late = await overdue();
    const pending = await confirmed(HUB_A, { state: 'PENDING', serviceDate: days.past });
    const answer = await refusedWithoutTrace(() => createCarrying(ops, [late, pending], []));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(answer)).toEqual([at(1, 'not_confirmed')]);
  });

  // Break caught: one reason forced on a whole batch, or the reasons of a batch mixed up between its requests; a reason that is not
  // repeated where it is given for several; a snapshot on a request that is on its own day; or a representation that carries the reasons.
  it('keeps for each overdue request the reason given for it, lets one reason be given for several, and shows none of it', async () => {
    const [a, b, c] = [await overdue(), await overdue(), await overdue()] as [
      string,
      string,
      string,
    ];
    const onDay = await confirmed();
    const made = await createCarrying(
      ops,
      [a, onDay, b, c],
      [
        carried(c, CARRYOVER.closed),
        carried(a, CARRYOVER.road, 'Gate was shut'),
        carried(b, CARRYOVER.road),
      ],
    );
    expect(made.status).toBe(201);
    const label = (code: string) => `Fixture ${code}`;
    expect(await carryoversOf(manifestOf(made).id)).toEqual({
      [a]: { reason_code: CARRYOVER.road, label: label(CARRYOVER.road), note: 'Gate was shut' },
      [b]: { reason_code: CARRYOVER.road, label: label(CARRYOVER.road), note: null },
      [c]: { reason_code: CARRYOVER.closed, label: label(CARRYOVER.closed), note: null },
      [onDay]: null,
    });
    const [event] = await routes.rows<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where event_code = 'pickup.manifest.created' and object_id = $1`,
      [manifestOf(made).id],
    );
    expect(event?.detail).toEqual({ stop_count: 4, carried_over_count: 3 });
    // The reasons are on the stops and are not part of what a reader is shown (the contract's `PickupStop` has no such member).
    const read = await ops.client.get(ONE(manifestOf(made).id));
    expect(read.status).toBe(200);
    expect(read.text).not.toMatch(/carryover|FIXTURE_CARRYOVER/i);
    expect(made.text).not.toMatch(/carryover|FIXTURE_CARRYOVER/i);
  });

  // Break caught: a manifest of requests on their own day asked for reasons, or refused for the empty list; or accepted for the stops that
  // are not carried over.
  it('needs no reason where nothing is carried over, and takes an empty list', async () => {
    const [one, two] = await confirmedMany(2);
    for (const entries of [undefined, []] as const) {
      const ids = [await confirmed(), await confirmed()];
      const made = await createCarrying(ops, ids, entries);
      expect(made.status).toBe(201);
      expect(Object.values(await carryoversOf(manifestOf(made).id))).toEqual([null, null]);
    }
    expect([one, two]).toHaveLength(2);
  });

  // Break caught: a command with reasons sent again that is judged again (or written twice), or answered differently from the first time.
  it('answers the same command with its reasons again as it was answered, and writes the stops once', async () => {
    const late = await overdue();
    const key = randomUUID();
    const before = await counts();
    const first = await createCarrying(ops, [late], [carried(late, CARRYOVER.road)], days.day, key);
    const second = await createCarrying(
      ops,
      [late],
      [carried(late, CARRYOVER.road)],
      days.day,
      key,
    );
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.text).toBe(first.text);
    const after = await counts();
    expect([after.manifests, after.stops, after.created]).toEqual([
      before.manifests + 1,
      before.stops + 1,
      before.created + 1,
    ]);
    // Another reason under the same key is another command.
    const conflict = await createCarrying(
      ops,
      [late],
      [carried(late, CARRYOVER.closed)],
      days.day,
      key,
    );
    expect([conflict.status, codeOf(conflict)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: the carry-over of a request judged by its age (a request promised weeks ago refused, or asked for something more).
  it('does not look at how old the work is', async () => {
    const old = await confirmed(HUB_A, { serviceDate: days.longPast });
    const made = await createCarrying(ops, [old], [carried(old, CARRYOVER.road)]);
    expect(made.status).toBe(201);
    expect(await carryoversOf(manifestOf(made).id)).toMatchObject({
      [old]: { reason_code: CARRYOVER.road },
    });
  });
});

describe('createPickupManifest: what the caller is shown (the existence rule)', () => {
  // Break caught: a request of another hub, one that does not exist and one that is claimed told apart for a caller who may see none of
  // them (the owner's decision of 1 November 2026, call 3): the answer would tell Ops of one hub that another hub's request exists, or is
  // claimed.
  it('answers a request of another hub, one that is claimed there and one that does not exist alike', async () => {
    const foreign = await confirmed(HUB_B);
    const claimedForeign = await confirmed(HUB_B);
    const elsewhere = await insertManifest(routes.admin, manifestRow(HUB_B));
    await insertStop(routes.admin, stopRow(elsewhere, claimedForeign, 1));

    const unclaimed = await refusedWithoutTrace(() => create(ops, [foreign]));
    const claimed = await refusedWithoutTrace(() => create(ops, [claimedForeign]));
    const unknown = await refusedWithoutTrace(() => create(ops, [randomUUID()]));
    for (const answer of [unclaimed, claimed, unknown]) {
      expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
      expect(violationsOf(answer)).toEqual([at(0, 'not_available')]);
    }
    expect(shapeOf(claimed)).toEqual(shapeOf(unclaimed));
    expect(shapeOf(unknown)).toEqual(shapeOf(unclaimed));
  });

  // Break caught: input that mixes what the caller may see and what it may not made into a manifest of the part it may see, or refused
  // in a way that shows which part was the problem by what was done about the rest.
  it('refuses a list that mixes requests the caller may see with ones it may not, whole', async () => {
    const mine = await confirmed(HUB_A);
    const theirs = await confirmed(HUB_B);
    const answer = await refusedWithoutTrace(() => create(ops, [mine, theirs]));
    expect(violationsOf(answer)).toEqual([at(1, 'not_available')]);
    // The request it could see is still unclaimed.
    expect(
      await routes.rows(`select 1 from pickup_stop where pickup_request_id = $1`, [mine]),
    ).toEqual([]);
  });

  // Break caught: the claim told to a caller who was not shown the request, or not told to one who was.
  it('tells ALREADY_MANIFESTED only about requests the caller was shown, at their places, and creates nothing', async () => {
    const [claimed, free] = await confirmedMany(2);
    const holder = await insertManifest(routes.admin, manifestRow(HUB_A));
    await insertStop(routes.admin, stopRow(holder, claimed ?? '', 1));
    const answer = await refusedWithoutTrace(() => create(ops, [free ?? '', claimed ?? '']));
    expect([answer.status, codeOf(answer)]).toEqual([422, 'ALREADY_MANIFESTED']);
    expect(violationsOf(answer)).toEqual([at(1, 'already_manifested')]);
    // The free request stayed free.
    expect(
      await routes.rows(`select 1 from pickup_stop where pickup_request_id = $1`, [free]),
    ).toEqual([]);
  });

  // Break caught: a claim released by something that is not a release: a stop that was skipped, failed or collected still holds its
  // request (the owner's decision of 1 November 2026, call 4), and one whose claim was released frees it.
  it.each<StopState>([
    'PENDING',
    'ARRIVED',
    'COLLECTED',
    'PARTIALLY_COLLECTED',
    'FAILED',
    'SKIPPED',
  ])(
    'keeps a request claimed by a %s stop, and takes it again once the claim is released',
    async (state) => {
      const [request] = await confirmedMany(1);
      const holder = await insertManifest(routes.admin, manifestRow(HUB_A));
      const stop = await insertStop(routes.admin, stopRow(holder, request ?? '', 1, { state }));
      const refused = await refusedWithoutTrace(() => create(ops, [request ?? '']));
      expect([refused.status, codeOf(refused)]).toEqual([422, 'ALREADY_MANIFESTED']);

      await routes.admin.query(`update pickup_stop set released_at = now() where id = $1`, [
        stop.id,
      ]);
      const again = await create(ops, [request ?? '']);
      expect(again.status).toBe(201);
    },
  );
});

describe('who may build a manifest', () => {
  const body = (id: string) => ({ pickup_request_ids: [id], service_date: days.day });

  // Break caught: a holder of another bundle's keys, a vendor, a rider or an unauthenticated caller building a manifest.
  it('refuses Finance, a Vendor, a Rider and a caller with no session, with nothing written', async () => {
    const [request] = await confirmedMany(1);
    const before = await counts();
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const asFinance = await create(finance, [request ?? '']);
    expect([asFinance.status, codeOf(asFinance)]).toEqual([403, 'PERMISSION_DENIED']);

    const asVendor = await browser.post(LIST, body(request ?? ''), {
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);

    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const asRider = await routes.kit.client
      .fork()
      .bearer(rider.token)
      .post(LIST, body(request ?? ''), {
        origin: null,
        headers: { 'Idempotency-Key': randomUUID() },
      });
    expect([401, 403]).toContain(asRider.status);

    const anonymous = await routes
      .browser()
      .post(LIST, body(request ?? ''), { headers: { 'Idempotency-Key': randomUUID() } });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    expect(await counts()).toEqual(before);
  });

  // Break caught: a browser command with no synchronizer token, or from an origin that is not the Ops Portal's.
  it('refuses a command without its synchronizer token, and one from another origin', async () => {
    const [request] = await confirmedMany(1);
    const before = await counts();
    const noToken = await presenting(routes.kit, ops.token).post(LIST, body(request ?? ''), {
      origin: OPS,
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect([noToken.status, codeOf(noToken)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    const elsewhere = await ops.client.post(LIST, body(request ?? ''), {
      origin: 'http://127.0.0.1:5174',
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect([elsewhere.status, codeOf(elsewhere)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(await counts()).toEqual(before);
  });

  it('serves Senior Ops as it serves Ops Staff', async () => {
    const [request] = await confirmedMany(1);
    expect((await create(senior, [request ?? ''])).status).toBe(201);
  });

  // Break caught: a staff member building in a hub outside its grant, which the existence rule above makes unreachable: the request is
  // not shown to it. Ops of the other hub is told exactly what Ops of this one is told of a request that is not its own.
  it('gives Ops of another hub no way to claim this hub’s request', async () => {
    const [request] = await confirmedMany(1);
    const answer = await refusedWithoutTrace(() => create(opsB, [request ?? '']));
    expect(violationsOf(answer)).toEqual([at(0, 'not_available')]);
  });
});

describe('listPickupManifests and getPickupManifest: what a staff reader sees', () => {
  const made: Record<string, Manifest> = {};

  beforeAll(async () => {
    for (const [name, actor] of [
      ['a1', ops],
      ['a2', ops],
      ['a3', ops],
      ['b1', opsB],
      ['b2', opsB],
    ] as const) {
      const hub = actor === opsB ? HUB_B : HUB_A;
      const answer = await create(actor, await confirmedMany(2, hub));
      expect(answer.status).toBe(201);
      made[name] = manifestOf(answer);
    }
  });
  const named = (name: string): Manifest => {
    const found = made[name];
    if (found === undefined) throw new Error(`no manifest was made as ${name}`);
    return found;
  };

  // Break caught: a list that crosses hubs, or one in no stable order.
  it('lists the manifests of the hubs of the grant, in the order they were made, without stops', async () => {
    // The first page, which is the default size: it carries no stops, no version and nothing of another hub.
    const first = await ops.client.get(LIST);
    expect(first.status).toBe(200);
    expect(pageOf(first).items.length).toBeLessThanOrEqual(25);
    for (const item of pageOf(first).items) {
      expect(item).not.toHaveProperty('stops');
      expect(item.responsible_hub_id).toBe(HUB_A);
      // Every item states the moment the run was made, as an instant (contract 5.100.0).
      expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(first.header('etag')).toBeNull();

    // Other tests of this file add manifests of the first hub; the ones made here are in it in order, and none of the other hub's is.
    const listed = await everything(ops);
    expect(
      listed.items
        .filter((item) => [named('a1').id, named('a2').id, named('a3').id].includes(item.id))
        .map((item) => item.id),
    ).toEqual([named('a1').id, named('a2').id, named('a3').id]);
    // The list states the moment each run was made as the read of it does, and the order of the list is the order of those moments.
    const moments = ['a1', 'a2', 'a3'].map((name) => {
      const item = listed.items.find((candidate) => candidate.id === named(name).id);
      expect(item?.created_at).toBe(named(name).created_at);
      return Date.parse(named(name).created_at);
    });
    expect(moments).toEqual(moments.toSorted((a, b) => a - b));
    expect(listed.items.map((item) => item.id)).not.toContain(named('b1').id);
    expect(listed.items.every((item) => item.responsible_hub_id === HUB_A)).toBe(true);

    const mineB = (await everything(opsB)).items.map((item) => item.id);
    expect(mineB.filter((id) => id === named('b1').id || id === named('b2').id)).toEqual([
      named('b1').id,
      named('b2').id,
    ]);
    expect(mineB).not.toContain(named('a1').id);
  });

  // Break caught: a page that skips or repeats a row at its edge, or a token that is not a position.
  it('pages by an opaque position, without a row skipped or repeated', async () => {
    const pagedBy = async (size: number): Promise<{ ids: string[]; pages: number }> => {
      const ids: string[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const query = `?page_size=${String(size)}${token === null ? '' : `&page_token=${token}`}`;
        const answer: TestResponse = await ops.client.get(`${LIST}${query}`);
        expect(answer.status).toBe(200);
        expect(idsOf(answer).length).toBeLessThanOrEqual(size);
        ids.push(...idsOf(answer));
        token = pageOf(answer).next_page_token;
        pages += 1;
      } while (token !== null && pages < 500);
      expect(token).toBeNull();
      return { ids, pages };
    };
    const whole = await pagedBy(100);
    const small = await pagedBy(2);
    expect(small.ids).toEqual(whole.ids);
    expect(new Set(small.ids).size).toBe(small.ids.length);
    expect(small.pages).toBeGreaterThan(whole.pages);
  });

  // Break caught: a page parameter read as a statement or taken on trust, and an answer that is not the contract's 400.
  it.each([
    ['a page size of zero', 'page_size=0'],
    ['a page size over the maximum', 'page_size=101'],
    ['a page size that is not a number', 'page_size=many'],
    ['a position that is not one', 'page_token=not-a-position'],
  ])('refuses %s as a validation failure', async (_label, query) => {
    const answer = await ops.client.get(`${LIST}?${query}`);
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('shows a manifest with its stops in order, and the version it can be changed with', async () => {
    const answer = await ops.client.get(ONE(named('a1').id));
    expect(answer.status).toBe(200);
    expect(answer.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(manifestOf(answer)).toEqual(named('a1'));
  });

  // Break caught: a staff reader told a manifest of another hub does not exist (the contract says where it is not), or told it of one that
  // does not exist.
  it('tells a staff reader a manifest outside its hubs from one that does not exist', async () => {
    const outside = await ops.client.get(ONE(named('b1').id));
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const missing = await ops.client.get(ONE(randomUUID()));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'NOT_FOUND']);
    expect(outside.text).not.toContain(named('b1').code);
  });

  it('reaches every hub of an all-hub grant', async () => {
    const listed = (await everything(wide)).items.map((item) => item.id);
    expect(listed).toEqual(expect.arrayContaining([named('a1').id, named('b1').id]));
    expect((await wide.client.get(ONE(named('b2').id))).status).toBe(200);
  });

  // Break caught: an id that is not a UUID looked up as one, or answered as anything but a validation failure.
  it('refuses an id that is not a UUID as a validation failure', async () => {
    const answer = await ops.client.get(ONE('not-a-uuid'));
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a token that does not move with the order of the stops (the version S1.21 compares under the manifest's lock), or with the
  // manifest itself.
  it('moves the ETag when the order of the stops changes, and when the manifest does', async () => {
    const answer = await create(ops, await confirmedMany(3));
    const manifest = manifestOf(answer);
    const before = answer.header('etag');
    const [first, second] = manifest.stops ?? [];
    expect((await ops.client.get(ONE(manifest.id))).header('etag')).toBe(before);

    // Two stops exchange their places in one statement (the constraint on the sequence is deferred to the end of it).
    await routes.admin.query(
      `update pickup_stop set sequence = case when id = $1 then 2 else 1 end where id in ($1, $2)`,
      [first?.id, second?.id],
    );
    const reordered = await ops.client.get(ONE(manifest.id));
    expect(manifestOf(reordered).stops?.map((stop) => stop.id)).toEqual([
      second?.id,
      first?.id,
      manifest.stops?.[2]?.id,
    ]);
    expect(reordered.header('etag')).not.toBe(before);

    await routes.admin.query(`update pickup_manifest set state = 'CANCELLED' where id = $1`, [
      manifest.id,
    ]);
    const cancelled = await ops.client.get(ONE(manifest.id));
    expect(cancelled.header('etag')).not.toBe(reordered.header('etag'));
    expect(manifestOf(cancelled).state).toBe('CANCELLED');
  });
});

describe('listPickupManifests: the filters (OB-S1-25: operational filtering is owed before the manifest screens)', () => {
  // Days far from the others of this file, so that what is listed under them is what is arranged here.
  const MONDAY = '2031-06-02';
  const TUESDAY = '2031-06-03';
  const arranged: Record<string, string> = {};
  // Ops users of its own: the rate limit counts the requests of a principal, and these tests make many (the describes after this one use the
  // file's own, and a limit passed on a shared session answers them 500).
  let ops: Actor;
  let opsB: Actor;

  beforeAll(async () => {
    ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const rider = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    const make = async (
      name: string,
      hub: string,
      state: 'DRAFT' | 'CANCELLED' | 'DISPATCHED',
      serviceDate: string,
    ): Promise<void> => {
      const row = await insertManifest(
        routes.admin,
        manifestRow(hub, {
          state,
          serviceDate,
          ...(state === 'DISPATCHED' ? { assignedRiderId: rider } : {}),
        }),
      );
      arranged[name] = row.id;
    };
    await make('draftMonday', HUB_A, 'DRAFT', MONDAY);
    await make('cancelledMonday', HUB_A, 'CANCELLED', MONDAY);
    await make('dispatchedMonday', HUB_A, 'DISPATCHED', MONDAY);
    await make('draftTuesday', HUB_A, 'DRAFT', TUESDAY);
    await make('otherHubMonday', HUB_B, 'DRAFT', MONDAY);
  });
  const id = (name: string): string => arranged[name] ?? '';
  const ours = (response: TestResponse): string[] =>
    idsOf(response).filter((each) => Object.values(arranged).includes(each));
  const names = (response: TestResponse): string[] =>
    ours(response).map(
      (each) => Object.entries(arranged).find(([, value]) => value === each)?.[0] ?? '?',
    );

  // Break caught: a filter that is ignored (the whole list comes back), applied to the wrong column, or applied as "or" rather than "and".
  it('narrows by the state, by the day, and by both', async () => {
    expect(names(await ops.client.get(`${LIST}?service_date=${MONDAY}&page_size=100`))).toEqual([
      'draftMonday',
      'cancelledMonday',
      'dispatchedMonday',
    ]);
    expect(names(await ops.client.get(`${LIST}?state=DRAFT&service_date=${MONDAY}`))).toEqual([
      'draftMonday',
    ]);
    expect(names(await ops.client.get(`${LIST}?state=CANCELLED&service_date=${MONDAY}`))).toEqual([
      'cancelledMonday',
    ]);
    expect(names(await ops.client.get(`${LIST}?state=DRAFT&service_date=${TUESDAY}`))).toEqual([
      'draftTuesday',
    ]);
    // By state alone: every draft of the hub, the two arranged here among them.
    const drafts = await ops.client.get(`${LIST}?state=DRAFT&page_size=100`);
    expect(names(drafts)).toEqual(['draftMonday', 'draftTuesday']);
    expect(pageOf(drafts).items.every((item) => item.state === 'DRAFT')).toBe(true);
    // A day with nothing on it, and a state with nothing of that day, are empty and not errors.
    expect(idsOf(await ops.client.get(`${LIST}?service_date=2031-06-04`))).toEqual([]);
    expect(idsOf(await ops.client.get(`${LIST}?state=COMPLETED&service_date=${MONDAY}`))).toEqual(
      [],
    );
  });

  // Break caught: a filter that widens what a reader may see: the other hub's manifest listed to the first hub's officer.
  it('narrows only what the reader is already shown', async () => {
    const all = await ops.client.get(`${LIST}?service_date=${MONDAY}&page_size=100`);
    expect(idsOf(all)).not.toContain(id('otherHubMonday'));
    expect(idsOf(await opsB.client.get(`${LIST}?service_date=${MONDAY}&page_size=100`))).toEqual([
      id('otherHubMonday'),
    ]);
  });

  // Break caught: a page that loses the filter between pages, so that the second page is of everything.
  it('pages inside the filter, in the same order, without a row skipped or repeated', async () => {
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const answer: TestResponse = await ops.client.get(
        `${LIST}?service_date=${MONDAY}&page_size=1${token === null ? '' : `&page_token=${token}`}`,
      );
      expect(answer.status).toBe(200);
      expect(pageOf(answer).items.length).toBeLessThanOrEqual(1);
      seen.push(...idsOf(answer));
      token = pageOf(answer).next_page_token;
      pages += 1;
    } while (token !== null && pages < 10);
    expect(seen).toEqual([id('draftMonday'), id('cancelledMonday'), id('dispatchedMonday')]);
  });

  // Break caught: a filter value that is accepted when it is not one (a state of another case, an unknown state, a day that does not exist, a
  // repeated parameter, an empty value), which would answer an empty list for a mistake and hide it. A query parameter is named by its bare
  // name (the platform's form, contract-validator.test.ts), and a repeated one is refused as not one value and then, for an enum, as not a member.
  it.each([
    ['state=NOPE', 'state', 'enum'],
    ['state=draft', 'state', 'enum'],
    ['state=', 'state', 'enum'],
    ['state=DRAFT&state=CANCELLED', 'state', 'type'],
    ['service_date=2031-02-30', 'service_date', 'format'],
    ['service_date=not-a-date', 'service_date', 'format'],
    ['service_date=2031-6-2', 'service_date', 'format'],
    ['service_date=', 'service_date', 'format'],
    ['service_date=2031-06-02&service_date=2031-06-03', 'service_date', 'type'],
  ])('refuses %s as a validation failure naming the parameter', async (query, parameter, rule) => {
    const refused = await ops.client.get(`${LIST}?${query}`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    const violations = violationsOf(refused);
    expect(violations[0]).toEqual({ in: 'query', pointer: parameter, rule });
    expect(violations.every((each) => each.in === 'query' && each.pointer === parameter)).toBe(
      true,
    );
  });

  // Break caught: a position the list did not make, taken on trust. It is refused by the service (the contract cannot judge an opaque token), so
  // its pointer is the service's form, `/page_token`, which the screens that offer "back to the first page" must recognise.
  it('refuses a position that is not one, naming page_token', async () => {
    const refused = await ops.client.get(`${LIST}?page_token=not-a-position`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(refused)).toEqual([
      { in: 'query', pointer: '/page_token', rule: 'format' },
    ]);
  });

  // Break caught: a day the contract accepts and the database cannot compare (there is no year 0 in it) reaching the statement, which would
  // fail it and answer 500. The service refuses it itself, so its pointer is the service's form (`/service_date`) and not the validator's.
  it('refuses a year of zero, which the contract accepts and the database cannot compare, as a validation failure and not a failed statement', async () => {
    const refused = await ops.client.get(`${LIST}?service_date=0000-01-01`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(violationsOf(refused)).toEqual([
      expect.objectContaining({
        in: 'query',
        rule: 'format',
        pointer: expect.stringMatching(/^\/?service_date$/) as unknown,
      }),
    ]);
  });

  // Break caught: a rider's list widened by a filter (a draft is never shown to its rider) or a filter that does not apply to its list.
  it('applies to a rider’s list inside what it is shown, and shows it no draft', async () => {
    const rider = await arrangedRider(routes.kit, routes.admin);
    const mine = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', serviceDate: MONDAY, assignedRiderId: rider.id }),
    );
    const draft = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DRAFT', serviceDate: MONDAY, assignedRiderId: rider.id }),
    );
    expect(idsOf(await rider.client.get(`${LIST}?service_date=${MONDAY}`))).toEqual([mine.id]);
    expect(idsOf(await rider.client.get(`${LIST}?state=DRAFT`))).toEqual([]);
    expect(idsOf(await rider.client.get(`${LIST}?service_date=${MONDAY}`))).not.toContain(draft.id);
    expect(
      idsOf(await rider.client.get(`${LIST}?state=DISPATCHED&service_date=${TUESDAY}`)),
    ).toEqual([]);
  });
});

describe('an authorised read of another hub is audited, without contents', () => {
  // Break caught: a read of another hub that leaves no record, a list of the actor's own authorised rows recorded as an attempt on another
  // hub (the owner's decision of 1 November 2026, call 10), or a record that carries the manifest.
  it('writes one hub-boundary event for the manifest, one for each foreign hub of a list, and none for the actor’s own hub', async () => {
    const own = manifestOf(await create(wide, await confirmedMany(1, HUB_A)));
    const foreign = manifestOf(await create(wide, await confirmedMany(1, HUB_B)));
    const bundle = await newBundle(routes.admin, [grant('pickup.read', 'all', 'any', 'A')]);
    const reader = await routes.actor(bundle, HUB_A);
    const events = () =>
      routes.rows<{ object_type: string; object_id: string; responsible_hub_id: string }>(
        `select object_type, object_id, responsible_hub_id from audit_event
          where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
        [reader.identity.id],
      );

    expect((await reader.client.get(ONE(own.id))).status).toBe(200);
    expect(await events()).toEqual([]);

    expect((await reader.client.get(ONE(foreign.id))).status).toBe(200);
    expect(await events()).toEqual([
      { object_type: 'PickupManifest', object_id: foreign.id, responsible_hub_id: HUB_B },
    ]);

    expect((await reader.client.get(`${LIST}?page_size=100`)).status).toBe(200);
    const after = await events();
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ object_type: 'HUB', object_id: HUB_B });
    expect(JSON.stringify(after)).not.toContain(foreign.code);

    // Ops of the first hub reads only its own authorised rows, and none is a crossing.
    const opsEvents = () =>
      routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
        [ops.identity.id],
      );
    expect((await ops.client.get(`${LIST}?page_size=100`)).status).toBe(200);
    expect(await opsEvents()).toEqual([]);
  });
});

describe('a rider reads a run from its dispatch, while it is assigned to it', () => {
  async function arrangedRider(): Promise<{ id: string; client: TestClient }> {
    const row = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const device = await insertRiderDevice(routes.admin, row.id);
    const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: row.id,
      registeredDeviceId: device.id,
    });
    return { id: row.id, client: routes.kit.client.fork().bearer(session.token) };
  }

  /** A manifest arranged as the administrator with one stop, since no operation of this task assigns or dispatches. */
  async function run(overrides: Parameters<typeof manifestRow>[1] = {}) {
    const manifest = await insertManifest(routes.admin, manifestRow(HUB_A, overrides));
    const request = await confirmed();
    const stop = await insertStop(routes.admin, stopRow(manifest, request, 1));
    return { manifest, request, stop };
  }

  // Break caught: a draft shown to the rider it is assigned to, a run assigned to another rider shown, or a rider shown nothing of its own
  // dispatched run (call 7).
  it('lists and reads the runs dispatched to it, the one cancelled after its dispatch included, and no other', async () => {
    const rider = await arrangedRider();
    const other = await arrangedRider();
    const dispatched = await run({ state: 'DISPATCHED', assignedRiderId: rider.id });
    const started = await run({ state: 'IN_PROGRESS', assignedRiderId: rider.id });
    const cancelledAfter = await run({
      state: 'CANCELLED',
      assignedRiderId: rider.id,
      dispatchedBeforeCancel: true,
    });
    const draft = await run({ assignedRiderId: rider.id });
    const cancelledBefore = await run({ state: 'CANCELLED', assignedRiderId: rider.id });
    const others = await run({ state: 'DISPATCHED', assignedRiderId: other.id });
    const nobodys = await run();

    const listed = await rider.client.get(`${LIST}?page_size=100`);
    expect(listed.status).toBe(200);
    expect(idsOf(listed).toSorted()).toEqual(
      [dispatched, started, cancelledAfter].map((each) => each.manifest.id).toSorted(),
    );
    for (const visible of [dispatched, started, cancelledAfter]) {
      const answer = await rider.client.get(ONE(visible.manifest.id));
      expect(answer.status, visible.manifest.state).toBe(200);
      expect(manifestOf(answer).stops?.map((stop) => stop.pickup_request_id)).toEqual([
        visible.request,
      ]);
    }
    // The representation is the staff's, so the version is one version: what the rider reads is what Ops reads.
    const staffRead = await ops.client.get(ONE(dispatched.manifest.id));
    const riderRead = await rider.client.get(ONE(dispatched.manifest.id));
    expect(riderRead.header('etag')).toBe(staffRead.header('etag'));
    expect(riderRead.json()).toEqual(staffRead.json());

    // The runs it may not read are answered as an id that matches nothing, in everything but the request's own identifier.
    const nothing = shapeOf(await rider.client.get(ONE(randomUUID())));
    expect(nothing.status).toBe(404);
    for (const hidden of [draft, cancelledBefore, others, nobodys]) {
      const answer = await rider.client.get(ONE(hidden.manifest.id));
      expect(shapeOf(answer), hidden.manifest.state).toEqual(nothing);
      expect(answer.text).not.toContain(hidden.manifest.id);
      expect(answer.text).not.toContain(hidden.manifest.code);
    }
  });

  // Break caught: access that stays with the rider a run was taken from, or does not reach the one it was given (call 7: reassignment).
  it('follows a reassignment at once', async () => {
    const first = await arrangedRider();
    const second = await arrangedRider();
    const { manifest } = await run({ state: 'DISPATCHED', assignedRiderId: first.id });
    expect((await first.client.get(ONE(manifest.id))).status).toBe(200);
    expect((await second.client.get(ONE(manifest.id))).status).toBe(404);

    await routes.admin.query(`update pickup_manifest set assigned_rider_id = $2 where id = $1`, [
      manifest.id,
      second.id,
    ]);
    expect((await first.client.get(ONE(manifest.id))).status).toBe(404);
    expect((await second.client.get(ONE(manifest.id))).status).toBe(200);
    expect(idsOf(await first.client.get(LIST))).not.toContain(manifest.id);
    expect(idsOf(await second.client.get(LIST))).toContain(manifest.id);
  });

  it('is shown an empty page when nothing is dispatched to it', async () => {
    const rider = await arrangedRider();
    const listed = await rider.client.get(LIST);
    expect(listed.status).toBe(200);
    expect(pageOf(listed)).toEqual({ items: [], next_page_token: null });
  });

  it('writes no hub-boundary event for a rider’s read', async () => {
    const rider = await arrangedRider();
    const { manifest } = await run({ state: 'DISPATCHED', assignedRiderId: rider.id });
    expect((await rider.client.get(ONE(manifest.id))).status).toBe(200);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
        [rider.id],
      ),
    ).toEqual([]);
  });
});

describe('a vendor reads no manifest (GBT-C9)', () => {
  // Break caught: a vendor shown a manifest, its stops, or a page of them, or told anything of whether one exists.
  it('is refused the list, a manifest that exists and one that does not, in the same words', async () => {
    const { manifest } = await (async () => {
      const made = await insertManifest(routes.admin, manifestRow(HUB_A));
      const request = await confirmed();
      await insertStop(routes.admin, stopRow(made, request, 1));
      return { manifest: made };
    })();
    const list = await browser.get(LIST);
    expect([list.status, codeOf(list)]).toEqual([403, 'PERMISSION_DENIED']);
    const real = await browser.get(ONE(manifest.id));
    const missing = await browser.get(ONE(randomUUID()));
    expect([real.status, codeOf(real)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(shapeOf(real)).toEqual(shapeOf(missing));
    expect(real.text).not.toContain(manifest.code);
  });
});

describe('the unmanifested pool: the manifested filter of listPickupRequests (AC-SLICE-001-11)', () => {
  /** Every request the list answers for the query, whatever the number of pages. */
  const ids = async (query: string, actor: Actor = ops): Promise<string[]> => {
    const all: string[] = [];
    let token: string | null = null;
    do {
      const answer: TestResponse = await actor.client.get(
        `${REQUESTS}?${query}&page_size=100${token === null ? '' : `&page_token=${token}`}`,
      );
      expect(answer.status, query).toBe(200);
      const page = answer.json() as { items: { id: string }[]; next_page_token: string | null };
      all.push(...page.items.map((item) => item.id));
      token = page.next_page_token;
    } while (token !== null);
    return all;
  };

  // Break caught: a pool that lists a request a manifest holds, drops one whose claim was released, or hides from the request list a request
  // the pool leaves out.
  it('is the confirmed requests no manifest holds, less the ones awaiting the review of their cutoff', async () => {
    const free = await confirmed();
    const held = await confirmed();
    const waiting = await confirmed(HUB_A, { cutoffState: 'PENDING_OPS_REVIEW' });
    const pending = await confirmed(HUB_A, { state: 'PENDING' });
    const cancelled = await confirmed(HUB_A, { state: 'CANCELLED' });
    const released = await confirmed();
    const skipped = await confirmed();
    expect((await create(ops, [held])).status).toBe(201);
    const earlier = await insertManifest(routes.admin, manifestRow(HUB_A));
    await insertStop(routes.admin, stopRow(earlier, released, 1, { releasedAt: new Date() }));
    await insertStop(routes.admin, stopRow(earlier, skipped, 2, { state: 'SKIPPED' }));

    const pool = await ids('state=CONFIRMED&manifested=false');
    expect(pool).toEqual(expect.arrayContaining([free, released]));
    for (const out of [held, waiting, pending, cancelled, skipped]) {
      expect(pool, out).not.toContain(out);
    }

    // The request list is not the pool: the request awaiting its review is in it, and so are the manifested ones.
    const confirmedAll = await ids('state=CONFIRMED');
    expect(confirmedAll).toEqual(expect.arrayContaining([free, held, waiting, released, skipped]));
    expect(confirmedAll).not.toContain(pending);

    // On a manifest: those with a claim no one has released, whatever became of the stop.
    const on = await ids('manifested=true');
    expect(on).toEqual(expect.arrayContaining([held, skipped]));
    for (const out of [free, waiting, pending, cancelled, released]) {
      expect(on, out).not.toContain(out);
    }

    // Not on a manifest, whatever the state: the pending and the cancelled are in it, the claimed are not.
    const off = await ids('manifested=false');
    expect(off).toEqual(expect.arrayContaining([free, waiting, pending, cancelled, released]));
    for (const out of [held, skipped]) expect(off, out).not.toContain(out);
  });

  it('leaves the request a manifest has taken out of the pool at once', async () => {
    const [one, two] = await confirmedMany(2);
    const before = await ids('state=CONFIRMED&manifested=false');
    expect(before).toEqual(expect.arrayContaining([one, two]));
    expect((await create(ops, [one ?? ''])).status).toBe(201);
    const after = await ids('state=CONFIRMED&manifested=false');
    expect(after).toContain(two);
    expect(after).not.toContain(one);
  });

  // Break caught: a pool that shows Ops of one hub another hub's requests.
  it('is the hub’s own', async () => {
    const mine = await confirmed(HUB_A);
    const theirs = await confirmed(HUB_B);
    const pool = await ids('state=CONFIRMED&manifested=false');
    expect(pool).toContain(mine);
    expect(pool).not.toContain(theirs);
  });

  // Break caught: a filter that a caller who cannot read stops is answered quietly, with a pool that is wrong for it (every request
  // unmanifested), and a value that is not a boolean taken as one.
  it('is a staff read: a vendor is told PERMISSION_DENIED, and a value that is not a boolean is a validation failure', async () => {
    for (const query of [
      'manifested=true',
      'manifested=false',
      'state=CONFIRMED&manifested=false',
    ]) {
      const answer = await browser.get(`${REQUESTS}?${query}`);
      expect([answer.status, codeOf(answer)], query).toEqual([403, 'PERMISSION_DENIED']);
    }
    // The same vendor still lists its own requests with no such filter.
    expect((await browser.get(REQUESTS)).status).toBe(200);
    const bad = await ops.client.get(`${REQUESTS}?manifested=maybe`);
    expect([bad.status, codeOf(bad)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});
