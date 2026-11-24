import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangeCounted, handOver } from './support/handed-over.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.32, the reads of the receiving side and the advisory receive lock (`listHubIntakes`, `getHubIntake`, `acquireIntakeLock`; `hub.read`, `hub.read`, `hub.intake.count`;
 * `AC-SLICE-001-37`, `-43` (its first half: the lock shows who is receiving and is taken over after the idle time) and `-77`; features/hub/hub-intake.md section 5.1 steps 2 and 3;
 * state-machines.md section 7). Against a real PostgreSQL and the real application, each claim:
 *
 * - **No read of an intake that has not been counted carries the rider's declaration**, a zero one included, in any property, and the queue lists the intakes of the hub with the run, the
 *   rider that handed over, the time of the handover and who is receiving, and none of another hub.
 * - **An intake that has been counted is `HubIntakePostCount`**, which carries the declaration beside the count and the comparison.
 * - **The lock is advisory**: it is taken when free, shown to another receiver without a change, refreshed by its holder and taken over after the hub's idle time (never where the hub has
 *   none), it stops no read, and **it never moves the `ETag`** of the intake.
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const LOCK = (id: string) => `${ONE(id)}/lock`;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  // The launch hub's configuration carries the idle time of the lock (fifteen minutes, the development value of D-13) for hub A; hub B has none, on purpose.
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Page {
  readonly items: readonly Record<string, unknown>[];
  readonly next_page_token: string | null;
}

/** The receiver takes (or refreshes, or is shown) the lock. */
const take = (actor: Actor, id: string): Promise<TestResponse> =>
  actor.client.post(LOCK(id), {}, { origin: OPS });

/** Every key of a JSON value, however deep. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)]);
  }
  return [];
}

/**
 * The blind-count check, as a script reads a response for the property (`AC-SLICE-001-37`, `-77`): the declaration is no key of the answer at any depth, and the answer, read as text, names
 * neither it nor the number the rider's form was pre-filled with.
 */
function expectNoDeclaration(response: TestResponse): void {
  expect(keysOf(response.json())).not.toContain('rider_declared_count');
  expect(response.text).not.toMatch(/rider_declared_count|prefilled|declared_count/);
}

const PRE_COUNT_KEYS = [
  'active_receiver_id',
  'code',
  'count_phase',
  'declaration_captured_at',
  'handed_over_at',
  'handed_over_by',
  'hub_id',
  'id',
  'lock_acquired_at',
  'pickup_manifest_id',
  'pickup_request_id',
  'state',
  // The vendor, by name (Run G1, Part 1, item 4): said by every read of an intake, as receiving names a vendor with photos; no declaration, count or parcel is in it.
  'vendor_name',
];

/** The lock of an intake as another receiver left it some minutes ago (the moment of a lock is the database's, so an old one is arranged with the triggers off). */
async function lockedMinutesAgo(id: string, receiverId: string, minutes: number): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update pickup_intake set active_receiver_id = $2, lock_acquired_at = now() - make_interval(mins => $3) where id = $1`,
      [id, receiverId, minutes],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

const rowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      active_receiver_id: string | null;
      lock_acquired_at: Date | null;
    }>(
      `select state, version, active_receiver_id, lock_acquired_at from pickup_intake where id = $1`,
      [id],
    )
  )[0];

const events = (code: string, objectId: string) =>
  routes.rows<{ responsible_hub_id: string | null; enhanced: boolean }>(
    `select responsible_hub_id, enhanced from audit_event where event_code = $1 and object_id = $2`,
    [code, objectId],
  );

describe('listHubIntakes: the awaiting-receive queue (AC-SLICE-001-77)', () => {
  // Break caught: a queue that serves the declaration (as a property of the item, or flagged for a zero), lists another hub's intake, leaves out the run, the rider, the time or the receiver, or
  // drops the intake that carries a zero declaration (the queue must list it, and show nothing of the zero).
  it('lists the intakes awaiting count at the hub with their run, rider, time and receiver, and never a declaration, a zero one included, nor another hub’s intake', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const here = await handOver(routes, vendor, days, {
      collected: [3, 3, 3],
      declared: [3, 0, 5],
    });
    const there = await handOver(routes, vendor, days, { collected: [3], hubId: HUB_B });

    const queue = await ops.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    expect(queue.status).toBe(200);
    expectNoDeclaration(queue);
    const items = (queue.json() as Page).items;
    const mine = items.filter((item) => item.pickup_manifest_id === here.run.manifest.id);
    expect(mine.map((item) => item.id).toSorted()).toEqual(
      here.intakes.map((intake) => intake.id).toSorted(),
    );
    for (const item of mine) {
      expect(Object.keys(item).toSorted()).toEqual(PRE_COUNT_KEYS);
      expect(item).toMatchObject({
        state: 'AWAITING_COUNT',
        count_phase: 'PRE_COUNT',
        hub_id: HUB_A,
        handed_over_by: here.run.rider.id,
        active_receiver_id: null,
        lock_acquired_at: null,
      });
      expect(new Date(item.handed_over_at as string).getTime()).toBeGreaterThan(0);
    }
    // Another hub's intake is not returned, and its hub's officer reads its own.
    expect(items.some((item) => item.id === there.intakes[0]?.id)).toBe(false);
    expect(items.every((item) => item.hub_id === HUB_A)).toBe(true);
    const theirs = await opsB.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    expectNoDeclaration(theirs);
    const theirItems = (theirs.json() as Page).items;
    expect(theirItems.map((item) => item.id)).toContain(there.intakes[0]?.id);
    expect(theirItems.some((item) => here.intakes.some((intake) => intake.id === item.id))).toBe(
      false,
    );
  });

  // Break caught: a queue that does not show who is receiving (the second receiver would not learn that the first has the intake).
  it('shows who is actively receiving, and since when', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    expect((await take(ops, id)).status).toBe(200);
    const queue = await other.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    const item = (queue.json() as Page).items.find((each) => each.id === id);
    expect(item).toMatchObject({ active_receiver_id: ops.identity.id });
    expect(typeof item?.lock_acquired_at).toBe('string');
    expectNoDeclaration(queue);
  });

  // Break caught: a page that repeats or skips an intake across the boundary, an order that moves under a reader who is paging, a token that ends the queue early, or one that never ends.
  it('is paged oldest first by the opaque position, with no intake repeated or skipped', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3, 3, 3] });
    const seen: Record<string, unknown>[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const query = `state=AWAITING_COUNT&page_size=2${token === null ? '' : `&page_token=${encodeURIComponent(token)}`}`;
      const page: TestResponse = await ops.client.get(`${INTAKES}?${query}`);
      expect(page.status).toBe(200);
      const body = page.json() as Page;
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items);
      token = body.next_page_token;
      pages += 1;
    } while (token !== null && pages < 100);
    expect(token).toBeNull();
    expect(pages).toBeGreaterThanOrEqual(2);
    const ids = seen.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const intake of done.intakes) expect(ids).toContain(intake.id);
    const order = seen.map((item) => `${String(item.handed_over_at)}|${String(item.id)}`);
    expect(order).toEqual(order.toSorted());
  });

  // Break caught: a filter judged leniently (a state that is no state answered with an empty queue that hides the mistake), or a page size past the bound.
  it('refuses a state that is no state, a page size out of range and a token that is not one, naming the parameter', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    for (const [query, name] of [
      ['state=SOMEWHERE', 'state'],
      ['page_size=0', 'page_size'],
      ['page_size=100000', 'page_size'],
      ['page_token=not-a-position', 'page_token'],
    ] as const) {
      const refused = await ops.client.get(`${INTAKES}?${query}`);
      expect(refused.status, query).toBe(400);
      expect(codeOf(refused), query).toBe('VALIDATION_FAILED');
      // The contract's own validation and the service's both name the parameter (one writes its pointer with a leading slash, the other without).
      const violations = (
        refused.json() as { details?: { violations?: { in: string; pointer: string }[] } }
      ).details?.violations;
      expect(
        violations?.some(
          (violation) => violation.in === 'query' && violation.pointer.replace(/^\//, '') === name,
        ),
        query,
      ).toBe(true);
    }
  });

  // Break caught: a queue that serves a vendor, a rider or a staff member who does not hold hub.read (AC-SLICE-001-77: a user without hub.read is refused with PERMISSION_DENIED).
  it('refuses a user without hub.read, a rider and a vendor with PERMISSION_DENIED', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const asked = [
      ['a user without hub.read', await finance.client.get(INTAKES)],
      ['the rider that handed over', await done.run.rider.client.get(INTAKES)],
    ] as const;
    for (const [who, refused] of asked) {
      expect(refused.status, who).toBe(403);
      expect(codeOf(refused), who).toBe('PERMISSION_DENIED');
    }
  });

  // Break caught: a list that reads an intake of another hub without saying so (audit.md section 5.4), or one that writes the event for the actor's own hub.
  it('audits an authorised read of another hub’s intakes, once for the hub, and writes nothing for the actor’s own hub', async () => {
    const admin = await routes.platformAdmin();
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const own = await ops.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    expect(own.status).toBe(200);
    const before = await routes.rows<{ count: number }>(
      `select count(*)::int as count from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
      [ops.identity.id],
    );
    expect(before[0]?.count).toBe(0);
    const crossing = await admin.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    expect(crossing.status).toBe(200);
    const written = await routes.rows<{ responsible_hub_id: string; related_ids: unknown }>(
      `select responsible_hub_id, related_ids from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1`,
      [admin.identity.id],
    );
    expect(written.map((event) => event.responsible_hub_id)).toContain(HUB_A);
    expect(JSON.stringify(written)).toContain('listHubIntakes');
    expect(done.intakes.length).toBe(1);
  });
});

describe('getHubIntake: one intake (AC-SLICE-001-37)', () => {
  // Break caught: a read that carries rider_declared_count before the count commits, for any intake and for a zero declaration, under any property name, or that leaves out the ETag.
  it('answers HubIntakePreCount for an intake awaiting its count: no declaration in any property, a zero one included, and an ETag', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3, 3], declared: [0, 7] });
    for (const intake of done.intakes) {
      const read = await ops.client.get(ONE(intake.id));
      expect(read.status).toBe(200);
      expectNoDeclaration(read);
      expect(Object.keys(read.json() as object).toSorted()).toEqual(PRE_COUNT_KEYS);
      expect(read.json()).toMatchObject({
        id: intake.id,
        state: 'AWAITING_COUNT',
        count_phase: 'PRE_COUNT',
        pickup_manifest_id: done.run.manifest.id,
        handed_over_by: done.run.rider.id,
      });
      expect(read.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    }
  });

  // Break caught: a read of an intake that has been counted that is still the pre-count shape (the page that shows the comparison could not be built), one that serves the declaration of a
  // different intake, or one that carries more of the row than the contract's shape (the number the form was pre-filled with).
  it('answers HubIntakePostCount for an intake that has been counted: the declaration beside the physical count and the comparison, and no more of the row', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3, 3], declared: [5, 2] });
    const [first, second] = done.intakes;
    await arrangeCounted(routes, first?.id ?? '', 3, 5);
    await arrangeCounted(routes, second?.id ?? '', 3, 2);
    const over = await ops.client.get(ONE(first?.id ?? ''));
    expect(over.status).toBe(200);
    expect(over.json()).toMatchObject({
      id: first?.id,
      state: 'COUNTED',
      count_phase: 'POST_COUNT',
      rider_declared_count: 5,
      physical_count: 3,
      count_variance: 'SHORT',
      count_difference: -2,
      condition: 'OK',
    });
    const short = await ops.client.get(ONE(second?.id ?? ''));
    expect(short.json()).toMatchObject({
      rider_declared_count: 2,
      physical_count: 3,
      count_variance: 'OVER',
      count_difference: 1,
    });
    expect(Object.keys(over.json() as object).toSorted()).toEqual(
      [
        ...PRE_COUNT_KEYS,
        'condition',
        'count_difference',
        'count_variance',
        'physical_count',
        'rider_declared_count',
      ].toSorted(),
    );
    expect(over.text).not.toMatch(/prefilled/);
    // The queue shows the same intakes as they are, in the same shape, beside the ones still waiting.
    const all = await ops.client.get(`${INTAKES}?page_size=100`);
    const listed = (all.json() as Page).items.find((item) => item.id === first?.id);
    expect(listed).toMatchObject({ count_phase: 'POST_COUNT', rider_declared_count: 5 });
    const waiting = await ops.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    expectNoDeclaration(waiting);
    expect((waiting.json() as Page).items.some((item) => item.id === first?.id)).toBe(false);
  });

  // Break caught: an ETag that moves with the lock (a receiver's count would be refused for a lock), or that does not move with a fact of the intake (the count that was committed).
  it('has an ETag that does not move with the lock and moves with the facts of the intake', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    const first = (await ops.client.get(ONE(id))).header('etag');
    expect(first).not.toBeNull();
    expect((await take(ops, id)).status).toBe(200);
    expect((await ops.client.get(ONE(id))).header('etag')).toBe(first);
    await lockedMinutesAgo(id, ops.identity.id, 40);
    expect((await take(other, id)).json()).toMatchObject({ active_receiver_id: other.identity.id });
    expect((await other.client.get(ONE(id))).header('etag')).toBe(first);
    expect((await rowOf(id))?.version).toBe(1);
    await arrangeCounted(routes, id, 3, 3);
    const counted = (await ops.client.get(ONE(id))).header('etag');
    expect(counted).not.toBe(first);
  });

  // Break caught: an id that matches nothing answered as another hub's intake (or the reverse), a vendor or rider told anything of an intake, and a user without hub.read served.
  it('answers NOT_FOUND for an id that matches nothing, HUB_SCOPE_VIOLATION for another hub’s intake, and PERMISSION_DENIED to a user without hub.read', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    const missing = await ops.client.get(ONE('00000000-0000-4000-8000-000000000000'));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'NOT_FOUND']);
    const foreign = await opsB.client.get(ONE(id));
    expect([foreign.status, codeOf(foreign)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expectNoDeclaration(foreign);
    const without = await finance.client.get(ONE(id));
    expect([without.status, codeOf(without)]).toEqual([403, 'PERMISSION_DENIED']);
    const rider = await done.run.rider.client.get(ONE(id));
    expect([rider.status, codeOf(rider)]).toEqual([403, 'PERMISSION_DENIED']);
    const malformed = await ops.client.get(ONE('not-an-id'));
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a read of another hub's intake that leaves no trace (audit.md section 5.4), and one of the actor's own hub that does.
  it('audits an authorised read of another hub’s intake, once, and a read of the actor’s own hub writes nothing', async () => {
    const admin = await routes.platformAdmin();
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    expect((await ops.client.get(ONE(id))).status).toBe(200);
    expect(await events('auth.hub_boundary.crossed', id)).toHaveLength(0);
    expect((await admin.client.get(ONE(id))).status).toBe(200);
    expect(await events('auth.hub_boundary.crossed', id)).toEqual([
      { responsible_hub_id: HUB_A, enhanced: true },
    ]);
  });
});

describe('acquireIntakeLock: the advisory receive lock (AC-SLICE-001-43, first half)', () => {
  // Break caught: a lock that is not taken when free, that is taken from a holder who is active, that changes when another receiver only asks, that is not refreshed for its holder, or that
  // stops a read (the lock is advisory: B reads the intake while A holds it).
  it('takes a free lock, shows its holder to another receiver and changes nothing, refreshes it for its holder, and stops no read', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';

    const first = await take(a, id);
    expect(first.status).toBe(200);
    expectNoDeclaration(first);
    expect(first.json()).toMatchObject({
      id,
      count_phase: 'PRE_COUNT',
      state: 'AWAITING_COUNT',
      active_receiver_id: a.identity.id,
    });
    const heldSince = (first.json() as { lock_acquired_at: string }).lock_acquired_at;
    expect(new Date(heldSince).getTime()).toBeGreaterThan(Date.now() - 120_000);

    const shown = await take(b, id);
    expect(shown.status).toBe(200);
    expect(shown.json()).toMatchObject({
      active_receiver_id: a.identity.id,
      lock_acquired_at: heldSince,
    });
    expect((await rowOf(id))?.active_receiver_id).toBe(a.identity.id);

    const read = await b.client.get(ONE(id));
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ active_receiver_id: a.identity.id });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const refreshed = await take(a, id);
    expect(refreshed.json()).toMatchObject({ active_receiver_id: a.identity.id });
    const moment = (refreshed.json() as { lock_acquired_at: string }).lock_acquired_at;
    expect(new Date(moment).getTime()).toBeGreaterThan(new Date(heldSince).getTime());
    expect((await rowOf(id))?.version).toBe(1);
  });

  // Break caught: a takeover before the hub's idle time (the lock is no lock), or one that never comes (the lock is a wall): five minutes idle against fifteen is refused, twenty is taken.
  it('lets another receiver take the lock over only after the hub’s idle time', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3, 3] });
    const [recent, idle] = done.intakes;
    await lockedMinutesAgo(recent?.id ?? '', a.identity.id, 5);
    const refused = await take(b, recent?.id ?? '');
    expect(refused.status).toBe(200);
    expect(refused.json()).toMatchObject({ active_receiver_id: a.identity.id });
    await lockedMinutesAgo(idle?.id ?? '', a.identity.id, 20);
    const taken = await take(b, idle?.id ?? '');
    expect(taken.status).toBe(200);
    expect(taken.json()).toMatchObject({ active_receiver_id: b.identity.id });
    expect((await rowOf(idle?.id ?? ''))?.active_receiver_id).toBe(b.identity.id);
    expect((await rowOf(recent?.id ?? ''))?.active_receiver_id).toBe(a.identity.id);
  });

  // Break caught: a default idle time invented for a hub that has none (the Product Owner's value is hub A's, and hub B was given none): no takeover there, however long the holder has been
  // idle, but the free lock is still taken and the holder still refreshes its own.
  it('offers no takeover where the hub has no idle time, and still takes a free lock and refreshes the holder’s own', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const done = await handOver(routes, vendor, days, { collected: [3], hubId: HUB_B });
    const id = done.intakes[0]?.id ?? '';
    expect((await take(a, id)).json()).toMatchObject({ active_receiver_id: a.identity.id });
    await lockedMinutesAgo(id, a.identity.id, 24 * 60);
    const shown = await take(b, id);
    expect(shown.status).toBe(200);
    expect(shown.json()).toMatchObject({ active_receiver_id: a.identity.id });
    const refreshed = await take(a, id);
    expect(refreshed.json()).toMatchObject({ active_receiver_id: a.identity.id });
    expect(
      new Date((refreshed.json() as { lock_acquired_at: string }).lock_acquired_at).getTime(),
    ).toBeGreaterThan(Date.now() - 120_000);
  });

  // Break caught: a lock taken on an intake that has been counted (nothing waits to be received), or the declaration withheld from the shape a counted intake is answered in.
  it('shows an intake that has been counted as it is, as HubIntakePostCount, and takes no lock on it', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [4] });
    const id = done.intakes[0]?.id ?? '';
    await arrangeCounted(routes, id, 3, 4);
    const answered = await take(ops, id);
    expect(answered.status).toBe(200);
    expect(answered.json()).toMatchObject({
      count_phase: 'POST_COUNT',
      rider_declared_count: 4,
      physical_count: 3,
      active_receiver_id: null,
      lock_acquired_at: null,
    });
    expect((await rowOf(id))?.active_receiver_id).toBeNull();
  });

  // Break caught: a lock that is open to a user who does not hold hub.intake.count, to a rider, or on another hub's intake, and an id that matches nothing answered as a hub's intake.
  it('is refused without hub.intake.count, to a rider, on another hub’s intake, and for an id that matches nothing', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    const refusals: [string, TestResponse, number, string][] = [
      ['a user without the key', await take(finance, id), 403, 'PERMISSION_DENIED'],
      ['another hub’s officer', await take(opsB, id), 403, 'HUB_SCOPE_VIOLATION'],
      [
        'an id that matches nothing',
        await take(ops, '00000000-0000-4000-8000-000000000000'),
        404,
        'NOT_FOUND',
      ],
      [
        'the rider that handed over',
        await done.run.rider.client.post(LOCK(id), {}),
        403,
        'PERMISSION_DENIED',
      ],
    ];
    for (const [who, response, status, code] of refusals) {
      expect([response.status, codeOf(response)], who).toEqual([status, code]);
    }
    expect((await rowOf(id))?.active_receiver_id).toBeNull();
  });

  // Break caught: a lock request that counts as the person acting, so that a receiving page left open on a screen, refreshing its own lock, keeps an unattended session alive for ever
  // (SECURITY_DESIGN.md section 13.3). A read, which is the person's own act, does extend it.
  it('is background activity: the page keeping its lock does not extend the session, and a read does', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    const activity = async (): Promise<number> =>
      (
        await routes.rows<{ ago: number }>(
          `select extract(epoch from (clock_timestamp() - last_activity_at))::float8 as ago from session where id = $1`,
          [ops.sessionId],
        )
      )[0]?.ago ?? Number.NaN;
    // Five minutes pass for the session, by changing the data (the guard of a session forbids it to the application, and rightly).
    await routes.admin.query('alter table session disable trigger session_guard');
    try {
      await routes.admin.query(
        `update session set issued_at = issued_at - interval '5 minutes', last_activity_at = last_activity_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' where id = $1`,
        [ops.sessionId],
      );
    } finally {
      await routes.admin.query('alter table session enable trigger session_guard');
    }
    expect((await take(ops, id)).status).toBe(200);
    expect(await activity()).toBeGreaterThan(240);
    expect((await ops.client.get(ONE(id))).status).toBe(200);
    expect(await activity()).toBeLessThan(60);
  });

  // Break caught: a lock taken on another hub's intake by a Platform Admin that leaves no trace (audit.md section 5.4).
  it('audits an authorised lock on another hub’s intake, once', async () => {
    const admin = await routes.platformAdmin();
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    expect((await take(admin, id)).status).toBe(200);
    expect(await events('auth.hub_boundary.crossed', id)).toEqual([
      { responsible_hub_id: HUB_A, enhanced: true },
    ]);
  });
});

/** What a read of a photo intake carries that this file reads: the third shape of an intake (S1.35b). */
interface PhotoIntake {
  readonly id: string;
  readonly count_phase: string;
  readonly receiving_mode: string;
  readonly rider_declared_count: number;
  readonly parcels: readonly {
    readonly origin: string;
    readonly state: string;
    readonly photo_evidence_id: string | null;
  }[];
}

describe('the door photos on the receiving reads (AC-SLICE-001-92; D-D1 reverses AC-SLICE-001-89 and OB-S1-81 for a photo intake)', () => {
  // Break caught: a photo intake read in the blind-count shape as before D-D1 (its door photos hidden, its declaration withheld, no parcels), or a read that names a photo of another stop: the queue, the
  // intake and the lock show each parcel of the stop with its own door photo, from the handover on, and the rider's number beside them (the officer counts against the photos, not blind).
  it('shows the stop’s door photos as the parcels of its intake, in the queue, the intake and the lock, from the handover on', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [2, 3], photos: true });
    expect(done.photoIds).toHaveLength(5);
    const [first, second] = done.intakes;
    const id = first?.id ?? '';
    const queue = await ops.client.get(`${INTAKES}?state=AWAITING_COUNT&page_size=100`);
    const one = await ops.client.get(ONE(id));
    const locked = await take(ops, id);
    expect([queue.status, one.status, locked.status]).toEqual([200, 200, 200]);

    const listed = (queue.json() as { items: PhotoIntake[] }).items;
    const ofFirst = [
      listed.find((item) => item.id === id),
      one.json(),
      locked.json(),
    ] as PhotoIntake[];
    for (const shown of ofFirst) {
      expect(shown.count_phase).toBe('CHECK_IN');
      expect(shown.receiving_mode).toBe('PHOTO_CHECK_IN');
      expect(shown.rider_declared_count).toBe(done.declared[0]);
      expect(shown.parcels.map((parcel) => [parcel.origin, parcel.state])).toEqual([
        ['DOOR_PHOTO', 'EXPECTED'],
        ['DOOR_PHOTO', 'EXPECTED'],
      ]);
      expect(shown.parcels.map((parcel) => parcel.photo_evidence_id).toSorted()).toEqual(
        done.photoIds.slice(0, 2).toSorted(),
      );
    }
    // The second stop's intake is the same in the queue, with its own three photos and none of the first's.
    const other = listed.find((item) => item.id === second?.id);
    expect(other?.parcels.map((parcel) => parcel.photo_evidence_id).toSorted()).toEqual(
      done.photoIds.slice(2).toSorted(),
    );
  });

  // Break caught: the narrow rule that D-D1 leaves lost: a stop with no photos is counted blind (D-D3), and its intake still shows no declaration, no parcel and nothing about a photo before the count.
  it('keeps the narrow rule for a blind-count intake: a stop with no photos has none to show, and its declaration stays withheld before the count', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const id = done.intakes[0]?.id ?? '';
    const read = await ops.client.get(ONE(id));
    expect(read.status).toBe(200);
    expectNoDeclaration(read);
    expect(Object.keys(read.json() as object).toSorted()).toEqual(PRE_COUNT_KEYS);
    expect(keysOf(read.json()).filter((key) => /photo|evidence|parcel/i.test(key))).toEqual([]);
  });
});

/** The intakes a handover opened are the ones every test above reads: a last look at what the handover itself answered, so that a change to the shape of either is seen in one place. */
describe('the handover and the reads answer one shape', () => {
  // Break caught: the handover's answer and the read of the same intake drifting apart (two builders of one shape).
  it('answers the same representation from the handover and from the read', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const opened = done.intakes[0];
    expect(opened).toBeDefined();
    const read = await ops.client.get(ONE(opened?.id ?? ''));
    // The read says what the handover says and, beside it, the vendor's name (which a rider's handover cannot read: only staff read the names of the receiving side).
    const { vendor_name: named, ...rest } = read.json() as Record<string, unknown>;
    expect(rest).toEqual(opened);
    expect(typeof named).toBe('string');
  });
});
