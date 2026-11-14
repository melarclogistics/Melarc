import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { handOver } from './support/handed-over.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.33, the blind count (`submitBlindCount`, `hub.intake.count`; `AC-SLICE-001-38`, `-43`, `-76` (the count's half), `-89` (the photos, from the count on); features/hub/hub-intake.md
 * section 5.1 steps 4 and 5; state-machines.md section 7). Against a real PostgreSQL and the real application, each claim:
 *
 * - **The count is the receiver's number and nothing else**: a body that carries the declaration, or anything beside the count, is refused and nothing is committed.
 * - **The response reveals the comparison for the first time**: the declaration, the physical count, the variance and the difference, and the photos of the parcels counted at the door; the
 *   intake goes to `READY_FOR_ITEMIZATION` (a count that matches a declaration above zero) or to `RECONCILIATION_REQUIRED` (a variance, or a zero declaration whatever the variance).
 * - **A count is committed once, and the lock is not a guard**: two receivers who both count get one success and one `STATE_CONFLICT`, whoever holds the lock and however the lock moved
 *   under the `ETag` they read; a retry with the key is not a second count.
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const COUNT = (id: string) => `${ONE(id)}/count`;
const LOCK = (id: string) => `${ONE(id)}/lock`;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  // The launch hub's configuration carries the idle time of the lock for hub A.
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Counted {
  readonly id: string;
  readonly state: string;
  readonly count_phase: string;
  readonly rider_declared_count: number;
  readonly physical_count: number;
  readonly count_variance: string;
  readonly count_difference: number;
  readonly condition: string;
  readonly parcel_photo_ids?: readonly string[];
}

/** The receiver reads the intake (its `ETag`), and counts it: the `ETag` and the key are the ones the read and the retry would carry unless the test says otherwise. */
async function count(
  receiver: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null; key?: string | null } = {},
): Promise<TestResponse> {
  const etag =
    over.etag === undefined
      ? ((await receiver.client.get(ONE(id))).header('etag') ?? '')
      : over.etag;
  return receiver.client.post(COUNT(id), body, {
    origin: OPS,
    headers: {
      ...(etag === null ? {} : { 'If-Match': etag }),
      ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
    },
  });
}

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

const rowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      version: number;
      physical_count: number | null;
      count_variance: string | null;
      count_difference: number | null;
      counted_by: string | null;
      counted_at: Date | null;
      condition: string;
    }>(
      `select state, version, physical_count, count_variance, count_difference, counted_by, counted_at, condition from pickup_intake where id = $1`,
      [id],
    )
  )[0];

const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_id: string | null;
    responsible_hub_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    enhanced: boolean;
    related_ids: Record<string, unknown> | null;
    detail: Record<string, unknown> | null;
  }>(
    `select actor_id, responsible_hub_id, previous_state, resulting_state, enhanced, related_ids, detail from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

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

describe('submitBlindCount: the count, and the comparison it reveals', () => {
  // Break caught: a count whose comparison is wrong (the difference the wrong way round, a variance for the wrong side), whose next state ignores a variance or a zero declaration, that answers
  // without the declaration or in another shape than the contract's, or that is written in another name than the receiver's. AC-SLICE-001-76's count half is the fourth and fifth rows.
  it.each([
    ['a count that matches a declaration above zero', 3, 3, 'MATCH', 0, 'READY_FOR_ITEMIZATION'],
    ['a count below the declaration', 5, 3, 'SHORT', -2, 'RECONCILIATION_REQUIRED'],
    ['a count above the declaration', 2, 3, 'OVER', 1, 'RECONCILIATION_REQUIRED'],
    ['a zero that matches a zero declaration', 0, 0, 'MATCH', 0, 'RECONCILIATION_REQUIRED'],
    ['a count above a zero declaration', 0, 4, 'OVER', 4, 'RECONCILIATION_REQUIRED'],
    ['a count of zero below a declaration', 4, 0, 'SHORT', -4, 'RECONCILIATION_REQUIRED'],
  ] as const)(
    'reveals the comparison, for the first time, in its response: %s',
    async (_name, declared, physical, variance, difference, state) => {
      const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
      const done = await handOver(routes, vendor, days, { collected: [3], declared: [declared] });
      const id = done.intakes[0]?.id ?? '';
      // Before the count the read has no declaration; the count's own response is the first that does.
      const before = await ops.client.get(ONE(id));
      expect(keysOf(before.json())).not.toContain('rider_declared_count');

      const response = await count(ops, id, { physical_count: physical });
      expect(response.status).toBe(200);
      const body = response.json() as Counted;
      expect(body).toMatchObject({
        id,
        state,
        count_phase: 'POST_COUNT',
        rider_declared_count: declared,
        physical_count: physical,
        count_variance: variance,
        count_difference: difference,
        condition: 'OK',
      });
      expect(Object.keys(body)).not.toContain('prefilled_count');
      expect(Object.keys(body)).not.toContain('parcel_photo_ids');
      expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
      expect(response.header('etag')).not.toBe(before.header('etag'));
      expect(await rowOf(id)).toMatchObject({
        state,
        physical_count: physical,
        count_variance: variance,
        count_difference: difference,
        counted_by: ops.identity.id,
        condition: 'OK',
      });
      // A read of the intake now is the same representation, with the same ETag.
      const after = await ops.client.get(ONE(id));
      expect(after.json()).toEqual(body);
      expect(after.header('etag')).toBe(response.header('etag'));
    },
  );

  // Break caught: a count that accepts the rider's declaration as input (echoed back, under its own name or any other), or anything beside the count, or a number that is no count: the
  // request is refused and nothing is committed (AC-SLICE-001-38; §35.5.2).
  it('refuses a body that carries the declaration, or anything but the count, and commits nothing', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await ops.client.get(ONE(id))).header('etag');
    const before = await rowOf(id);
    for (const [name, body] of [
      ['the declaration, beside the count', { physical_count: 3, rider_declared_count: 3 }],
      ['the declaration as another name', { physical_count: 3, declared_count: 3 }],
      ['the declaration alone', { rider_declared_count: 3 }],
      ['an unknown member', { physical_count: 3, note: 'x' }],
      ['no count', {}],
      ['a fraction', { physical_count: 2.5 }],
      ['a text', { physical_count: '3' }],
      ['a negative number', { physical_count: -1 }],
      ['null', { physical_count: null }],
    ] as const) {
      const refused = await count(ops, id, body, { etag });
      expect(refused.status, name).toBe(400);
      expect(codeOf(refused), name).toBe('VALIDATION_FAILED');
      expect(refused.text, name).not.toContain('"rider_declared_count":');
    }
    expect(await rowOf(id)).toEqual(before);
    expect((await events('hub.intake.counted', id)).length).toBe(0);
    // Past what the column holds: a count no database could keep is the malformed body it is.
    const huge = await count(ops, id, { physical_count: 2147483648 }, { etag });
    expect([huge.status, codeOf(huge)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('submitBlindCount: a count is committed once, and the lock is not a guard (AC-SLICE-001-43)', () => {
  // Break caught: a count that waits for the lock (B, who does not hold it, is refused), one that lets both receivers count (the second replaces the first), or one whose second receiver is
  // told anything but STATE_CONFLICT. B counts while A holds the lock; A's count, with the ETag A read, is the second.
  it('lets a receiver who does not hold the lock count, and refuses the holder’s count after it with STATE_CONFLICT', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    expect((await take(a, id)).status).toBe(200);
    const aRead = (await a.client.get(ONE(id))).header('etag');
    const bRead = (await b.client.get(ONE(id))).header('etag');
    expect(aRead).toBe(bRead);

    const first = await count(b, id, { physical_count: 3 }, { etag: bRead });
    expect(first.status).toBe(200);
    const second = await count(a, id, { physical_count: 2 }, { etag: aRead });
    expect([second.status, codeOf(second)]).toEqual([409, 'STATE_CONFLICT']);
    expect(second.text).toContain('already_counted');
    expect(await rowOf(id)).toMatchObject({ physical_count: 3, counted_by: b.identity.id });
    expect((await events('hub.intake.counted', id)).length).toBe(1);
  });

  // Break caught: two counts at the same moment that both succeed or both fail: exactly one wins, the other is told STATE_CONFLICT, and the stored count is the winner's, once.
  it('gives exactly one of two receivers who count at the same moment the count, and the other STATE_CONFLICT', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await a.client.get(ONE(id))).header('etag');
    const [one, other] = await Promise.all([
      count(a, id, { physical_count: 3 }, { etag }),
      count(b, id, { physical_count: 1 }, { etag }),
    ]);
    const outcomes = [one.status, other.status].toSorted();
    expect(outcomes).toEqual([200, 409]);
    const winner = one.status === 200 ? a : b;
    const stored = await rowOf(id);
    expect(stored?.counted_by).toBe(winner.identity.id);
    expect(stored?.physical_count).toBe(winner === a ? 3 : 1);
    expect((await events('hub.intake.counted', id)).length).toBe(1);
  });

  // Break caught: an ETag that moves with the lock, so that a receiver whose lock was refreshed (or taken over by another) is refused its count for a lock: the count's ETag is the one it read.
  it('is not refused for the lock having moved since the receiver read the intake', async () => {
    const a = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const b = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await a.client.get(ONE(id))).header('etag');
    expect((await take(a, id)).status).toBe(200);
    await lockedMinutesAgo(id, a.identity.id, 40);
    expect((await take(b, id)).json()).toMatchObject({ active_receiver_id: b.identity.id });
    const response = await count(a, id, { physical_count: 3 }, { etag });
    expect(response.status).toBe(200);
    expect((await rowOf(id))?.counted_by).toBe(a.identity.id);
  });

  // Break caught: a stale, missing, weak or foreign If-Match that is accepted, or told as anything but STATE_CONFLICT; the count is not committed by a request that did not read the intake.
  it('refuses a weak, malformed and another intake’s ETag with STATE_CONFLICT and a missing one as malformed, and commits nothing', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3, 3], declared: [3, 3] });
    const [first, second] = done.intakes;
    const own = (await ops.client.get(ONE(first?.id ?? ''))).header('etag') ?? '';
    const others = (await ops.client.get(ONE(second?.id ?? ''))).header('etag');
    for (const [name, etag] of [
      ['weak', `W/${own}`],
      ['unquoted', own.slice(1, -1)],
      ['a list', `${own}, ${own}`],
      ['another intake’s', others],
      ['the star', '*'],
    ] as const) {
      const refused = await count(ops, first?.id ?? '', { physical_count: 3 }, { etag });
      expect([refused.status, codeOf(refused)], name).toEqual([409, 'STATE_CONFLICT']);
    }
    // The contract requires the header: a request with none is refused as malformed before it reaches the intake.
    const none = await count(ops, first?.id ?? '', { physical_count: 3 }, { etag: null });
    expect([none.status, codeOf(none)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await rowOf(first?.id ?? ''))?.state).toBe('AWAITING_COUNT');
  });
});

describe('submitBlindCount: a retry is not a second count', () => {
  // Break caught: a retry that counts again (a second event, a second version), one that answers differently from the first, and the same key with another count that is accepted.
  it('answers a retry with the original response, once, and refuses the same key with another count', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await ops.client.get(ONE(id))).header('etag');
    const key = randomUUID();
    const first = await count(ops, id, { physical_count: 2 }, { etag, key });
    expect(first.status).toBe(200);
    const versionAfter = (await rowOf(id))?.version;
    const replay = await count(ops, id, { physical_count: 2 }, { etag, key });
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.header('etag')).toBe(first.header('etag'));
    expect((await rowOf(id))?.version).toBe(versionAfter);
    expect((await events('hub.intake.counted', id)).length).toBe(1);
    const another = await count(ops, id, { physical_count: 3 }, { etag, key });
    expect([another.status, codeOf(another)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect((await rowOf(id))?.physical_count).toBe(2);
  });

  // Break caught: a count with no Idempotency-Key, or one that is not a key, accepted (the retry a flaky connection makes would count twice).
  it('requires an Idempotency-Key in the form of one', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await ops.client.get(ONE(id))).header('etag');
    const missing = await count(ops, id, { physical_count: 3 }, { etag, key: null });
    expect([missing.status, codeOf(missing)]).toEqual([400, 'VALIDATION_FAILED']);
    const malformed = await count(ops, id, { physical_count: 3 }, { etag, key: 'x'.repeat(129) });
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await rowOf(id))?.state).toBe('AWAITING_COUNT');
  });
});

describe('submitBlindCount: who may count, and what it audits', () => {
  // Break caught: a count open to a user without hub.intake.count, to a rider, on another hub's intake or on an id that matches nothing, or an answer that serves the declaration to any of them.
  it('is refused without hub.intake.count, to a rider, on another hub’s intake, and for an id that matches nothing', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const etag = (await ops.client.get(ONE(id))).header('etag');
    const refusals: [string, TestResponse, number, string][] = [
      [
        'a user without the key',
        await count(finance, id, { physical_count: 3 }, { etag }),
        403,
        'PERMISSION_DENIED',
      ],
      [
        'another hub’s officer',
        await count(opsB, id, { physical_count: 3 }, { etag }),
        403,
        'HUB_SCOPE_VIOLATION',
      ],
      [
        'the rider that handed over',
        await done.run.rider.client.post(
          COUNT(id),
          { physical_count: 3 },
          { headers: { 'If-Match': etag ?? '', 'Idempotency-Key': randomUUID() } },
        ),
        403,
        'PERMISSION_DENIED',
      ],
      [
        'an id that matches nothing',
        await count(ops, '00000000-0000-4000-8000-000000000000', { physical_count: 3 }, { etag }),
        404,
        'NOT_FOUND',
      ],
      [
        'an id that is not one',
        await count(ops, 'not-an-id', { physical_count: 3 }, { etag }),
        400,
        'VALIDATION_FAILED',
      ],
    ];
    for (const [who, response, status, code] of refusals) {
      expect([response.status, codeOf(response)], who).toEqual([status, code]);
      expect(keysOf(JSON.parse(response.text || 'null'))).not.toContain('rider_declared_count');
    }
    expect((await rowOf(id))?.state).toBe('AWAITING_COUNT');
  });

  // Break caught: a count that leaves no event, or one that names the wrong counts, the wrong states or the wrong actor; and the ledger is the first place both counts appear together
  // (`hub.intake.counted`), not the event of the handover before it.
  it('writes hub.intake.counted once, with both counts, in the receiver’s name', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [5] });
    const id = done.intakes[0]?.id ?? '';
    expect((await count(ops, id, { physical_count: 3 })).status).toBe(200);
    const written = await events('hub.intake.counted', id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_id: ops.identity.id,
      responsible_hub_id: HUB_A,
      previous_state: 'AWAITING_COUNT',
      resulting_state: 'RECONCILIATION_REQUIRED',
      enhanced: false,
      related_ids: {
        pickup_manifest_id: done.run.manifest.id,
        pickup_request_id: done.intakes[0]?.pickup_request_id,
      },
      detail: {
        physical_count: 3,
        rider_declared_count: 5,
        count_variance: 'SHORT',
        count_difference: -2,
      },
    });
    // The handover's event, before, carried no count of any kind.
    const handover = await routes.rows<{ detail: unknown }>(
      `select detail from audit_event where event_code = 'hub.handover.submitted' and object_id = $1`,
      [done.run.manifest.id],
    );
    expect(JSON.stringify(handover)).not.toMatch(/declared|physical/);
  });

  // Break caught: a count of another hub's intake by a Platform Admin that leaves no trace (audit.md section 5.4).
  it('audits an authorised count on another hub’s intake, once', async () => {
    const admin = await routes.platformAdmin();
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    expect((await count(admin, id, { physical_count: 3 })).status).toBe(200);
    const crossing = await routes.rows<{ responsible_hub_id: string }>(
      `select responsible_hub_id from audit_event where event_code = 'auth.hub_boundary.crossed' and object_id = $1`,
      [id],
    );
    expect(crossing.map((event) => event.responsible_hub_id)).toContain(HUB_A);
  });
});

describe('the parcel photos are readable from the count on (AC-SLICE-001-89; D-A10, OB-S1-81)', () => {
  // Break caught: a count whose response leaves out the photos of the parcels counted at the door (the receiver could not compare them with what it counted), serves another stop's, serves
  // them in another order than they were attached, or gives a stop let through without photos a member that says none. The photos were in no read before (the intake tests hold that).
  it('answers with the stop’s photos, in the order they were attached, from the response to the count on', async () => {
    const ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const done = await handOver(routes, vendor, days, {
      collected: [2, 3],
      declared: [2, 3],
      photos: true,
    });
    const [first, second] = done.intakes;
    const response = await count(ops, first?.id ?? '', { physical_count: 2 });
    expect(response.status).toBe(200);
    // The first stop's photos are the first two the rider made, the second stop's the three after them.
    expect((response.json() as Counted).parcel_photo_ids).toEqual(done.photoIds.slice(0, 2));
    // The other intake is still waiting: nothing of its photos is in any read.
    const waiting = await ops.client.get(ONE(second?.id ?? ''));
    for (const photo of done.photoIds) expect(waiting.text).not.toContain(photo);
    expect(await count(ops, second?.id ?? '', { physical_count: 3 })).toMatchObject({
      status: 200,
    });
    const read = await ops.client.get(ONE(second?.id ?? ''));
    expect((read.json() as Counted).parcel_photo_ids).toEqual(done.photoIds.slice(2, 5));
    // The queue, unfiltered, shows both counted intakes with theirs; the photos of an intake are never another's.
    const all = await ops.client.get(`${INTAKES}?page_size=100`);
    const listed = new Map(
      (all.json() as { items: Counted[] }).items.map((item) => [item.id, item.parcel_photo_ids]),
    );
    expect(listed.get(first?.id ?? '')).toEqual(done.photoIds.slice(0, 2));
    expect(listed.get(second?.id ?? '')).toEqual(done.photoIds.slice(2, 5));
    // And no event carries one.
    const written = await events('hub.intake.counted', first?.id ?? '');
    for (const photo of done.photoIds) expect(JSON.stringify(written)).not.toContain(photo);
  });
});
