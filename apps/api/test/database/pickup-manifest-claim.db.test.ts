import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type ManifestRow,
  type StopState,
} from './support/manifests.js';
import { ARRANGER, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { HUB_A, HUB_B, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.20, the manifest and its stop as the database holds them for **every** writer (`AC-SLICE-001-11`; the Product Owner's decisions of 29
 * October and 1 November 2026, plan section 11, calls 4 and 6; state-machines.md sections 4 and 5; data-scope-registry.md `PickupManifest`
 * and `PickupStop`):
 *
 * - **A stop is the claim on its request, until the claim is explicitly released.** A skip, a failure and a collection do not release it, and
 *   the release is the one thing that does, once, never undone: the partial unique index and the guard hold this whatever the application
 *   does, so that no task that comes later can make a skipped stop free its request by accident.
 * - The stop cannot name another hub than its manifest's; its identity, the moves of its state and of its manifest's, and the freeze of a
 *   resolved or ended record are the guards'; the version moves with the row.
 * - What the runtime login may do: read by hub and key (staff), by assignment from dispatch (a rider), nothing (a vendor), insert a
 *   draft manifest and its pending stops under the creating key in a hub of the grant, and (migration 0059) resolve a stop that is still
 *   to be worked as skipped under the cancelling key of a request in a hub of the grant. It holds no update of a manifest, no update of a
 *   stop beyond `state`, `resolved_at` and `skip_snapshot`, and no delete.
 */
let routes: StaffRoutes;
let organisation: string;
let organisationB: string;

beforeAll(async () => {
  routes = await startStaffRoutes();
  organisation = (await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }))).organizationId;
  organisationB = (await insertVendor(routes.admin, vendorRow({ hubId: HUB_B }))).organizationId;
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const request = async (hub: string = HUB_A): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(hub === HUB_B ? organisationB : organisation, hub, { state: 'CONFIRMED' }),
    )
  ).id;

const manifest = (hub: string = HUB_A, overrides: Partial<ManifestRow> = {}) =>
  insertManifest(routes.admin, manifestRow(hub, overrides));

/** The error the database raised for a statement, by its SQLSTATE and the constraint it names. */
async function refusal(
  text: string,
  values: unknown[] = [],
): Promise<{ code: string | undefined; constraint: string | undefined; message: string }> {
  try {
    await routes.admin.query(text, values);
  } catch (error) {
    const found = error as { code?: string; constraint?: string; message: string };
    return { code: found.code, constraint: found.constraint, message: found.message };
  }
  throw new Error('the statement was not refused');
}

describe('a stop is the claim on its request (call 4)', () => {
  // Break caught: two unreleased stops for one request, which would put a request on two runs.
  it('lets one unreleased stop hold a request, on this manifest or on another', async () => {
    const claimed = await request();
    const first = await manifest();
    const second = await manifest();
    await insertStop(routes.admin, stopRow(first, claimed, 1));
    for (const [target, sequence] of [
      [second, 1],
      [first, 2],
    ] as const) {
      const refused = await refusal(
        `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), target.id, claimed, target.hubId, sequence],
      );
      expect([refused.code, refused.constraint]).toEqual(['23505', 'pickup_stop_request_claim']);
    }
  });

  // Break caught: a claim that a stop gives up by reaching a state: a skip, a failure or a collection (call 4: "skipped" records what
  // happened to a stop and does not make another run safe).
  it.each<StopState>([
    'PENDING',
    'ARRIVED',
    'COLLECTED',
    'PARTIALLY_COLLECTED',
    'FAILED',
    'SKIPPED',
  ])('keeps the claim of a %s stop', async (state) => {
    const claimed = await request();
    const first = await manifest();
    await insertStop(routes.admin, stopRow(first, claimed, 1, { state }));
    const second = await manifest();
    const refused = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
         values ($1, $2, $3, $4, 1)`,
      [randomUUID(), second.id, claimed, second.hubId],
    );
    expect([refused.code, refused.constraint]).toEqual(['23505', 'pickup_stop_request_claim']);
  });

  // Break caught: a skip that frees its request in the database, which a later task could depend on without noticing.
  it('keeps the claim of a stop that moves to SKIPPED, FAILED or COLLECTED', async () => {
    for (const [from, to] of [
      ['PENDING', 'SKIPPED'],
      ['ARRIVED', 'SKIPPED'],
    ] as const) {
      const claimed = await request();
      const holder = await manifest();
      const stop = await insertStop(routes.admin, stopRow(holder, claimed, 1, { state: from }));
      await routes.admin.query(
        `update pickup_stop set state = $2, skip_snapshot = '{"reason_code":"ROAD","note":"x","skipped_at":"2026-11-03T09:00:00.000Z"}'::jsonb
          where id = $1`,
        [stop.id, to],
      );
      const [row] = await routes.rows<{ released_at: Date | null }>(
        `select released_at from pickup_stop where id = $1`,
        [stop.id],
      );
      expect(row?.released_at).toBeNull();
      const other = await manifest();
      expect(
        (
          await refusal(
            `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
             values ($1, $2, $3, $4, 1)`,
            [randomUUID(), other.id, claimed, other.hubId],
          )
        ).constraint,
      ).toBe('pickup_stop_request_claim');
    }
  });

  // Break caught: a release that does not free the request, or one that frees it for one stop only and not for the history that follows.
  it('is released by an explicit release alone: the request can then be claimed again, once at a time', async () => {
    const claimed = await request();
    const first = await manifest();
    const stop = await insertStop(routes.admin, stopRow(first, claimed, 1, { state: 'SKIPPED' }));
    await routes.admin.query(`update pickup_stop set released_at = now() where id = $1`, [stop.id]);

    const second = await manifest();
    await insertStop(routes.admin, stopRow(second, claimed, 1));
    const third = await manifest();
    expect(
      (
        await refusal(
          `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
           values ($1, $2, $3, $4, 1)`,
          [randomUUID(), third.id, claimed, third.hubId],
        )
      ).constraint,
    ).toBe('pickup_stop_request_claim');

    // The history is kept: the released stop is still there, and releases can pile up.
    await routes.admin.query(
      `update pickup_stop set released_at = now() where pickup_request_id = $1 and released_at is null`,
      [claimed],
    );
    await insertStop(routes.admin, stopRow(third, claimed, 1));
    const history = await routes.rows<{ released: boolean }>(
      `select released_at is not null as released from pickup_stop where pickup_request_id = $1 order by created_at, id`,
      [claimed],
    );
    expect(history.map((row) => row.released)).toEqual([true, true, false]);
  });

  // Break caught: a release that can be taken back or moved, which would let a claim lapse and return.
  it('never changes or clears a release once it is made', async () => {
    const claimed = await request();
    const holder = await manifest();
    const stop = await insertStop(routes.admin, stopRow(holder, claimed, 1));
    await routes.admin.query(
      `update pickup_stop set released_at = '2026-11-03T10:00:00Z' where id = $1`,
      [stop.id],
    );
    for (const change of [`released_at = null`, `released_at = now()`]) {
      const refused = await refusal(`update pickup_stop set ${change} where id = $1`, [stop.id]);
      expect(refused.code, change).toBe('23514');
      expect(refused.message, change).toContain('release');
    }
    const [row] = await routes.rows<{ released_at: Date }>(
      `select released_at from pickup_stop where id = $1`,
      [stop.id],
    );
    expect(row?.released_at.toISOString()).toBe('2026-11-03T10:00:00.000Z');
  });
});

describe('the guard of a stop', () => {
  // Break caught: a stop moved to another manifest, request or hub, which would move the claim and the hub's records with it.
  it('keeps its manifest, its request and its hub', async () => {
    const claimed = await request();
    const holder = await manifest();
    const stop = await insertStop(routes.admin, stopRow(holder, claimed, 1));
    const otherManifest = await manifest();
    const otherRequest = await request();
    for (const change of [
      [`pickup_manifest_id = $2`, otherManifest.id],
      [`pickup_request_id = $2`, otherRequest],
    ] as const) {
      const refused = await refusal(`update pickup_stop set ${change[0]} where id = $1`, [
        stop.id,
        change[1],
      ]);
      expect(refused.code, change[0]).toBe('23514');
    }
  });

  // Break caught: the reason a request was carried over rewritten after the manifest was made (migration 0059), by any writer, so that the
  // record of why overdue work was planned could be tidied away: set once with the stop, never changed, never cleared. A carry-over also
  // always names its reason.
  it('keeps the reason a request was carried over for, once the stop is made', async () => {
    const claimed = await request();
    const holder = await manifest();
    const stop = await insertStop(
      routes.admin,
      stopRow(holder, claimed, 1, {
        carryoverSnapshot: { reason_code: 'A', label: 'A', note: null },
      }),
    );
    const other = await request();
    const otherStop = await insertStop(routes.admin, stopRow(holder, other, 2));
    for (const change of [
      `carryover_snapshot = null`,
      `carryover_snapshot = '{"reason_code":"B","label":"B","note":null}'::jsonb`,
    ]) {
      const refused = await refusal(`update pickup_stop set ${change} where id = $1`, [stop.id]);
      expect(refused.code, change).toBe('23514');
      expect(refused.message, change).toContain('carry-over');
    }
    // A stop that was made on its own day does not gain one later, and a snapshot that names no reason is not a carry-over.
    const gained = await refusal(
      `update pickup_stop set carryover_snapshot = '{"reason_code":"B"}'::jsonb where id = $1`,
      [otherStop.id],
    );
    expect(gained.code).toBe('23514');
    const nameless = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, carryover_snapshot)
       values ($1, $2, $3, $4, 3, '{"label":"B"}'::jsonb)`,
      [randomUUID(), holder.id, await request(), holder.hubId],
    );
    expect([nameless.code, nameless.constraint]).toEqual(['23514', 'pickup_stop_carryover_facts']);
    const [row] = await routes.rows<{ carryover_snapshot: { reason_code: string } }>(
      `select carryover_snapshot from pickup_stop where id = $1`,
      [stop.id],
    );
    expect(row?.carryover_snapshot.reason_code).toBe('A');
  });

  // Break caught: a state machine the database does not hold, so that a task that comes later can skip a step or take one back.
  it.each<[StopState, StopState, boolean]>([
    ['PENDING', 'ARRIVED', true],
    ['PENDING', 'SKIPPED', true],
    ['ARRIVED', 'COLLECTED', true],
    ['ARRIVED', 'PARTIALLY_COLLECTED', true],
    ['ARRIVED', 'FAILED', true],
    ['ARRIVED', 'SKIPPED', true],
    ['PENDING', 'COLLECTED', false],
    ['PENDING', 'FAILED', false],
    ['ARRIVED', 'PENDING', false],
    ['COLLECTED', 'ARRIVED', false],
    ['FAILED', 'COLLECTED', false],
    ['SKIPPED', 'PENDING', false],
    ['SKIPPED', 'ARRIVED', false],
  ])('moves a stop from %s to %s: %s', async (from, to, allowed) => {
    const holder = await manifest();
    const stop = await insertStop(
      routes.admin,
      stopRow(holder, await request(), 1, { state: from }),
    );
    // The facts the target state implies, as the acts that will write them do.
    const facts: Record<StopState, string> = {
      PENDING: `arrived_at = null`,
      ARRIVED: `arrived_at = now()`,
      COLLECTED: `arrived_at = coalesce(arrived_at, now()), resolved_at = now()`,
      PARTIALLY_COLLECTED: `arrived_at = coalesce(arrived_at, now()), resolved_at = now()`,
      FAILED: `arrived_at = coalesce(arrived_at, now()), resolved_at = now(), failure_category = 'ACCESS_DENIED'`,
      SKIPPED: `resolved_at = now()`,
    };
    const statement = `update pickup_stop set state = $2, ${facts[to]} where id = $1`;
    if (allowed) {
      await routes.admin.query(statement, [stop.id, to]);
      const [row] = await routes.rows<{ state: string }>(
        `select state from pickup_stop where id = $1`,
        [stop.id],
      );
      expect(row?.state).toBe(to);
    } else {
      const refused = await refusal(statement, [stop.id, to]);
      expect(refused.code).toBe('23514');
    }
  });

  // Break caught: a resolved stop that can be rewritten, which would change what a rider reported after the fact.
  it('is frozen once resolved, but for the release of its claim', async () => {
    const holder = await manifest();
    const stop = await insertStop(
      routes.admin,
      stopRow(holder, await request(), 1, { state: 'COLLECTED' }),
    );
    const refused = await refusal(`update pickup_stop set arrived_at = now() where id = $1`, [
      stop.id,
    ]);
    expect(refused.code).toBe('23514');
    await routes.admin.query(`update pickup_stop set released_at = now() where id = $1`, [stop.id]);
  });

  // Break caught: a version that does not move with the row, or moves without a change, so that the ETag of the manifest read means nothing.
  it('moves the version with a change and keeps it for an update that changes nothing', async () => {
    const holder = await manifest();
    const stop = await insertStop(routes.admin, stopRow(holder, await request(), 1));
    const versionOf = async (): Promise<number> =>
      Number(
        (
          await routes.rows<{ version: number }>(`select version from pickup_stop where id = $1`, [
            stop.id,
          ])
        )[0]?.version,
      );
    expect(await versionOf()).toBe(1);
    await routes.admin.query(`update pickup_stop set state = 'PENDING' where id = $1`, [stop.id]);
    expect(await versionOf()).toBe(1);
    await routes.admin.query(
      `update pickup_stop set state = 'ARRIVED', arrived_at = now() where id = $1`,
      [stop.id],
    );
    expect(await versionOf()).toBe(2);
    // The caller cannot choose the version.
    await routes.admin.query(
      `update pickup_stop set version = 99, resolved_at = null where id = $1`,
      [stop.id],
    );
    expect(await versionOf()).toBe(2);
  });
});

describe('the guard of a manifest', () => {
  // Break caught: a manifest whose code, hub, day or maker can be changed after it was published to riders and vendors.
  it.each([
    ['its code', `code = 'ACC-MF-ZZZZZZ'`],
    ['its hub', `responsible_hub_id = '${HUB_B}'`],
    ['its day', `service_date = '2026-11-04'`],
    ['its maker', `created_by = '${randomUUID()}'`],
    ['its identity', `id = '${randomUUID()}'`],
  ])('keeps %s', async (_label, change) => {
    const target = await manifest();
    const refused = await refusal(`update pickup_manifest set ${change} where id = $1`, [
      target.id,
    ]);
    expect(refused.code).toBe('23514');
  });

  // Break caught: a state machine the database does not hold (state-machines.md section 4).
  it.each<[ManifestRow['state'], ManifestRow['state'], boolean]>([
    ['DRAFT', 'DISPATCHED', true],
    ['DRAFT', 'CANCELLED', true],
    ['DISPATCHED', 'IN_PROGRESS', true],
    ['DISPATCHED', 'CANCELLED', true],
    ['IN_PROGRESS', 'COMPLETED', true],
    ['DRAFT', 'IN_PROGRESS', false],
    ['DRAFT', 'COMPLETED', false],
    ['DISPATCHED', 'DRAFT', false],
    ['IN_PROGRESS', 'CANCELLED', false],
    ['IN_PROGRESS', 'DISPATCHED', false],
    ['COMPLETED', 'IN_PROGRESS', false],
    ['CANCELLED', 'DRAFT', false],
  ])('moves a manifest from %s to %s: %s', async (from, to, allowed) => {
    const rider = (
      await routes.admin.query<{ id: string }>(
        `insert into rider_identity (id, phone, full_name, status, primary_hub_id)
         values (gen_random_uuid(), $1, 'Rider', 'ACTIVE', $2) returning id`,
        [`+999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, HUB_A],
      )
    ).rows[0]?.id;
    const target = await manifest(HUB_A, {
      state: from,
      assignedRiderId: from === 'DRAFT' ? null : (rider ?? null),
    });
    // The moments each target state implies, as the acts that will write them do.
    const facts: Record<ManifestRow['state'], string> = {
      DRAFT: `dispatched_at = null`,
      DISPATCHED: `assigned_rider_id = coalesce(assigned_rider_id, '${rider ?? ''}'), assigned_at = coalesce(assigned_at, now()), dispatched_at = now()`,
      IN_PROGRESS: `assigned_rider_id = coalesce(assigned_rider_id, '${rider ?? ''}'), assigned_at = coalesce(assigned_at, now()), dispatched_at = coalesce(dispatched_at, now()), started_at = now()`,
      COMPLETED: `assigned_rider_id = coalesce(assigned_rider_id, '${rider ?? ''}'), assigned_at = coalesce(assigned_at, now()), dispatched_at = coalesce(dispatched_at, now()), started_at = coalesce(started_at, now()), completed_at = now()`,
      CANCELLED: `completed_at = completed_at`,
    };
    const statement = `update pickup_manifest set state = $2, ${facts[to]} where id = $1`;
    if (allowed) {
      await routes.admin.query(statement, [target.id, to]);
      const [row] = await routes.rows<{ state: string }>(
        `select state from pickup_manifest where id = $1`,
        [target.id],
      );
      expect(row?.state).toBe(to);
    } else {
      const refused = await refusal(statement, [target.id, to]);
      expect(refused.code).toBe('23514');
    }
  });

  // Break caught: an ended manifest that can still be changed (state-machines.md section 4: COMPLETED and CANCELLED are terminal).
  it.each(['COMPLETED', 'CANCELLED'] as const)('is frozen once %s', async (state) => {
    const rider = (
      await routes.admin.query<{ id: string }>(
        `insert into rider_identity (id, phone, full_name, status, primary_hub_id)
         values (gen_random_uuid(), $1, 'Rider', 'ACTIVE', $2) returning id`,
        [`+999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, HUB_A],
      )
    ).rows[0]?.id;
    const target = await manifest(HUB_A, { state, assignedRiderId: rider ?? null });
    const refused = await refusal(`update pickup_manifest set assigned_at = now() where id = $1`, [
      target.id,
    ]);
    expect(refused.code).toBe('23514');
  });

  // Break caught: a version that does not move with the row, which is the whole of the ETag's guarantee for a change the representation
  // does not show.
  it('moves the version with a change and keeps it for one that changes nothing', async () => {
    const target = await manifest();
    const versionOf = async (): Promise<number> =>
      Number(
        (
          await routes.rows<{ version: number }>(
            `select version from pickup_manifest where id = $1`,
            [target.id],
          )
        )[0]?.version,
      );
    expect(await versionOf()).toBe(1);
    await routes.admin.query(`update pickup_manifest set state = 'DRAFT' where id = $1`, [
      target.id,
    ]);
    expect(await versionOf()).toBe(1);
    await routes.admin.query(`update pickup_manifest set state = 'CANCELLED' where id = $1`, [
      target.id,
    ]);
    expect(await versionOf()).toBe(2);
  });
});

describe('what ties a stop to its manifest and its request', () => {
  // Break caught: a stop in another hub than its manifest, which would put a hub's stop in a run another hub's staff reads.
  it('cannot name another hub than its manifest’s', async () => {
    const claimed = await request(HUB_B);
    const holder = await manifest(HUB_A);
    const refused = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
       values ($1, $2, $3, $4, 1)`,
      [randomUUID(), holder.id, claimed, HUB_B],
    );
    expect([refused.code, refused.constraint]).toEqual(['23503', 'pickup_stop_manifest_fkey']);
  });

  it('cannot name a request or a manifest that does not exist', async () => {
    const holder = await manifest();
    const noRequest = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
       values ($1, $2, $3, $4, 1)`,
      [randomUUID(), holder.id, randomUUID(), holder.hubId],
    );
    expect([noRequest.code, noRequest.constraint]).toEqual(['23503', 'pickup_stop_request_fkey']);
    const noManifest = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
       values ($1, $2, $3, $4, 1)`,
      [randomUUID(), randomUUID(), await request(), HUB_A],
    );
    expect([noManifest.code, noManifest.constraint]).toEqual([
      '23503',
      'pickup_stop_manifest_fkey',
    ]);
  });

  // Break caught: a place in the order held by two stops at once, or an exchange of places that has to pass through such a state refused.
  it('gives each stop of a manifest a place of its own, checked at the end of the statement that changes them', async () => {
    const holder = await manifest();
    const [a, b] = [
      await insertStop(routes.admin, stopRow(holder, await request(), 1)),
      await insertStop(routes.admin, stopRow(holder, await request(), 2)),
    ];
    const clash = await refusal(`update pickup_stop set sequence = 1 where id = $1`, [b.id]);
    expect([clash.code, clash.constraint]).toEqual(['23505', 'pickup_stop_sequence_key']);
    await routes.admin.query(
      `update pickup_stop set sequence = case when id = $1 then 2 else 1 end where id in ($1, $2)`,
      [a.id, b.id],
    );
    const order = await routes.rows<{ id: string }>(
      `select id from pickup_stop where pickup_manifest_id = $1 order by sequence`,
      [holder.id],
    );
    expect(order.map((row) => row.id)).toEqual([b.id, a.id]);
    const zero = await refusal(`update pickup_stop set sequence = 0 where id = $1`, [a.id]);
    expect([zero.code, zero.constraint]).toEqual(['23514', 'pickup_stop_sequence_positive']);
  });

  // Break caught: a row that says a state its facts contradict (the CHECK constraints are what the guards leave to the operations).
  it.each([
    ['a draft manifest that was dispatched', `state = 'DRAFT', dispatched_at = now()`],
    ['a dispatched manifest with no rider', `state = 'DISPATCHED', dispatched_at = now()`],
    ['a rider without the moment of assignment', `assigned_rider_id = gen_random_uuid()`],
  ])('refuses %s', async (_label, change) => {
    const target = await manifest();
    const refused = await refusal(`update pickup_manifest set ${change} where id = $1`, [
      target.id,
    ]);
    expect(['23514', '23503']).toContain(refused.code);
  });
});

describe('what the runtime login may do with them', () => {
  const grantsOf = async (table: string): Promise<string[]> =>
    (
      await routes.rows<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where grantee = 'melarc_api_runtime' and table_schema = 'public' and table_name = $1 order by privilege_type`,
        [table],
      )
    ).map((row) => row.privilege_type);

  // Break caught: a grant to change or remove a manifest or a stop, which no task of this slice earns (nothing is ever deleted; the
  // changes are the guards' and arrive with the operations that make them).
  it('holds SELECT and INSERT on both tables, as tables, and nothing else', async () => {
    expect(await grantsOf('pickup_manifest')).toEqual(['INSERT', 'SELECT']);
    expect(await grantsOf('pickup_stop')).toEqual(['INSERT', 'SELECT']);
  });

  const updatableColumnsOf = async (table: string): Promise<string[]> =>
    (
      await routes.rows<{ column_name: string }>(
        `select column_name from information_schema.column_privileges
          where grantee = 'melarc_api_runtime' and table_schema = 'public' and table_name = $1 and privilege_type = 'UPDATE'
          order by column_name`,
        [table],
      )
    ).map((row) => row.column_name);

  // Break caught: a column of the stop that no act has business changing (the carry-over reason, the version, the identity, the
  // request and the hub it names), or a column of the manifest (its code, its day, its hub, the moment it completed), becoming writable by
  // the runtime login. Only what the acts of the slice set is granted, and the policies and guards say who may use it and how: the
  // planning, the dispatch and the resolution of a stop (S1.20, S1.21) and, since S1.22, the moment a rider arrived at a stop and the moment
  // it started a run, and, since S1.28, the category and the reason of a failure.
  it('may update nine columns of a stop and six of a manifest, the ones its planning, its dispatch, its resolution, the rider’s three acts and the system’s completion set, and no other', async () => {
    expect(await updatableColumnsOf('pickup_stop')).toEqual([
      'arrived_at',
      'failure_category',
      'failure_reason_snapshot',
      'pickup_summary',
      'released_at',
      'resolved_at',
      'sequence',
      'skip_snapshot',
      'state',
    ]);
    expect(await updatableColumnsOf('pickup_manifest')).toEqual([
      'assigned_at',
      'assigned_rider_id',
      'completed_at',
      'dispatched_at',
      'started_at',
      'state',
    ]);
  });

  it('has the tables owned by the owner, with row-level security enabled and forced', async () => {
    const found = await routes.rows<{
      relname: string;
      owner: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c where c.relname in ('pickup_manifest', 'pickup_stop') order by c.relname`,
    );
    expect(found).toEqual([
      { relname: 'pickup_manifest', owner: 'melarc_owner', enabled: true, forced: true },
      { relname: 'pickup_stop', owner: 'melarc_owner', enabled: true, forced: true },
    ]);
  });

  const staff = (hubs: readonly string[] | 'ALL', key: string): SecurityContext => ({
    principalType: 'STAFF',
    principalId: randomUUID(),
    sessionId: randomUUID(),
    surface: 'OPS_PORTAL',
    authorizationKey: key,
    hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
    authorizedHubIds: hubs === 'ALL' ? [] : hubs,
    correlationId: 'pickup-manifest-claim',
  });
  const run = <T>(
    context: SecurityContext,
    work: (execute: (text: string) => Promise<unknown[]>) => Promise<T>,
  ) =>
    routes.built.service.transactionWithContext(context, async (tx) =>
      work(async (text) => (await tx.execute(sql.raw(text))).rows),
    );

  // Break caught: a staff policy that ignores the hub, ignores the key, or reads a hub the operation does not reach.
  it('shows staff the manifests and stops of the hubs of the grant under a key of the pickup domain, and no others', async () => {
    const inA = await manifest(HUB_A);
    const inB = await manifest(HUB_B);
    const stopA = await insertStop(routes.admin, stopRow(inA, await request(HUB_A), 1));
    const stopB = await insertStop(routes.admin, stopRow(inB, await request(HUB_B), 1));
    const ids = `'${inA.id}', '${inB.id}'`;
    const stopIds = `'${stopA.id}', '${stopB.id}'`;
    const ofA = staff([HUB_A], 'pickup.read');
    expect(
      await run(ofA, async (q) => [
        ...(await q(`select id from pickup_manifest where id in (${ids})`)),
        ...(await q(`select id from pickup_stop where id in (${stopIds})`)),
      ]),
    ).toEqual([{ id: inA.id }, { id: stopA.id }]);
    const everywhere = staff('ALL', 'pickup.read');
    expect(
      (await run(everywhere, (q) => q(`select id from pickup_manifest where id in (${ids})`)))
        .length,
    ).toBe(2);
    // A key of another domain reads neither, and a hub of the grant that is not the row's reads nothing.
    for (const context of [
      staff([HUB_A], 'dispatch.read'),
      staff([HUB_B], 'hub.read'),
      staff([], 'pickup.read'),
    ]) {
      expect(
        await run(context, async (q) => [
          ...(await q(`select id from pickup_manifest where id in (${ids})`)),
          ...(await q(`select id from pickup_stop where id in (${stopIds})`)),
        ]),
      ).toEqual([]);
    }
  });

  // Break caught: an insert policy that admits a manifest in a hub outside the grant, in a state but the draft, or under any key but the
  // creating one; a stop that is not pending or is born released; a stop of another hub than the grant's.
  it('admits a draft manifest and its pending stops under the creating key in a hub of the grant, and nothing else', async () => {
    const created = staff([HUB_A], 'pickup.manifest.create');
    const requestId = await request(HUB_A);
    const manifestId = randomUUID();
    const insertManifestSql = (id: string, hub: string, state = 'DRAFT') =>
      `insert into pickup_manifest (id, code, responsible_hub_id, service_date, state, created_by)
       values ('${id}', 'ACC-MF-${id
         .slice(0, 6)
         .toUpperCase()
         .replaceAll(
           /[01OIL]/g,
           '2',
         )}', '${hub}', '2026-11-03', '${state}', '${created.principalId}')`;
    const insertStopSql = (manifest: string, hub: string, sequence: number, extra = '') =>
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence${extra === '' ? '' : ', released_at'})
       values ('${randomUUID()}', '${manifest}', '${requestId}', '${hub}', ${String(sequence)}${extra === '' ? '' : `, ${extra}`})`;

    await run(created, async (q) => q(insertManifestSql(manifestId, HUB_A)));
    await run(created, async (q) => q(insertStopSql(manifestId, HUB_A, 1)));

    const refusedAs = async (
      context: SecurityContext,
      text: string,
    ): Promise<string | undefined> => {
      try {
        await run(context, (q) => q(text));
      } catch (error) {
        return (
          (error as { cause?: { code?: string }; code?: string }).cause?.code ??
          (error as { code?: string }).code
        );
      }
      return undefined;
    };
    const otherId = randomUUID();
    // The wrong key, the wrong hub, a state but the draft: each refused by the policy of the insert (42501).
    expect(await refusedAs(staff([HUB_A], 'pickup.read'), insertManifestSql(otherId, HUB_A))).toBe(
      '42501',
    );
    expect(await refusedAs(created, insertManifestSql(otherId, HUB_B))).toBe('42501');
    expect(await refusedAs(created, insertManifestSql(otherId, HUB_A, 'CANCELLED'))).toBe('42501');
    expect(
      await refusedAs(staff([HUB_A], 'pickup.read'), insertStopSql(manifestId, HUB_A, 2)),
    ).toBe('42501');
    expect(await refusedAs(created, insertStopSql(manifestId, HUB_A, 3, 'now()'))).toBe('42501');
    // The runtime login holds no delete, whatever the policy says, and a manifest is updated only under the planning keys (S1.21): a reading
    // key may change none (the grant allows the statement and the policy finds it no row).
    expect(
      await run(staff([HUB_A], 'pickup.read'), (q) =>
        q(`update pickup_manifest set state = 'CANCELLED' where id = '${manifestId}' returning id`),
      ),
    ).toEqual([]);
    expect(
      await routes.rows(`select state from pickup_manifest where id = $1`, [manifestId]),
    ).toEqual([{ state: 'DRAFT' }]);
    // The creating key skips no stop on its own: a skip that leaves the claim held is refused by the guard of the stop (the cancellation
    // of a manifest skips a stop and releases its claim together).
    expect(
      await refusedAs(
        created,
        `update pickup_stop set state = 'SKIPPED' where pickup_manifest_id = '${manifestId}'`,
      ),
    ).toBe('23514');
    expect(
      await routes.rows(`select state from pickup_stop where pickup_manifest_id = $1`, [
        manifestId,
      ]),
    ).toEqual([{ state: 'PENDING' }]);
    expect(
      await refusedAs(
        created,
        `delete from pickup_stop where pickup_manifest_id = '${manifestId}'`,
      ),
    ).toBe('42501');
    expect(await refusedAs(created, `delete from pickup_manifest where id = '${manifestId}'`)).toBe(
      '42501',
    );
  });

  // Break caught: a policy of the update that ignores the key (any staff key could resolve a stop), the hub (a staff member of another
  // hub could), the state (a stop already collected, failed or skipped could be rewritten as a skip: custody erased), the claim (a stop
  // whose claim was released could), or the state it moves to (a stop moved on to ARRIVED or COLLECTED by a cancellation); and a grant of
  // more columns than the resolution sets.
  it('admits the resolution of a stop that is still to be worked as skipped under the cancelling key in a hub of the grant, and nothing else', async () => {
    const cancelling = staff([HUB_A], 'pickup.request.cancel');
    const fresh = async (
      hub: string,
      state: StopState = 'PENDING',
      releasedAt: Date | null = null,
    ) =>
      insertStop(
        routes.admin,
        stopRow(await manifest(hub), await request(hub), 1, { state, releasedAt }),
      );
    const skip = (id: string, extra = '', more = '') =>
      `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
         skip_snapshot = '{"reason_code":"REQUEST_CANCELLED","skipped_at":"2026-11-03T09:00:00.000Z"}'::jsonb${more}
       where id = '${id}' ${extra} returning id`;
    const stateOf = async (id: string) =>
      (await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [id]))[0]
        ?.state;
    const refusedAs = async (
      context: SecurityContext,
      text: string,
    ): Promise<string | undefined> => {
      try {
        await run(context, (q) => q(text));
      } catch (error) {
        return (
          (error as { cause?: { code?: string }; code?: string }).cause?.code ??
          (error as { code?: string }).code
        );
      }
      return undefined;
    };

    // Admitted: a stop that is to be worked, pending or arrived at, in a hub of the grant (or of an all-hub grant).
    const pending = await fresh(HUB_A);
    const arrived = await fresh(HUB_A, 'ARRIVED');
    const inB = await fresh(HUB_B);
    expect(await run(cancelling, (q) => q(skip(pending.id)))).toEqual([{ id: pending.id }]);
    expect(await run(cancelling, (q) => q(skip(arrived.id)))).toEqual([{ id: arrived.id }]);
    expect(await run(staff('ALL', 'pickup.request.cancel'), (q) => q(skip(inB.id)))).toEqual([
      { id: inB.id },
    ]);
    expect([await stateOf(pending.id), await stateOf(arrived.id), await stateOf(inB.id)]).toEqual([
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
    ]);

    // Not admitted: the statement is allowed by the grant and finds no row, and the stop is as it was.
    const target = await fresh(HUB_A);
    const settled = [
      await fresh(HUB_A, 'COLLECTED'),
      await fresh(HUB_A, 'PARTIALLY_COLLECTED'),
      await fresh(HUB_A, 'FAILED'),
      await fresh(HUB_A, 'SKIPPED'),
    ];
    const released = await fresh(HUB_A, 'PENDING', new Date('2026-11-03T10:00:00Z'));
    for (const [context, why] of [
      [staff([HUB_A], 'pickup.manifest.assign'), 'the assigning key'],
      [staff([HUB_A], 'pickup.read'), 'a reading key'],
      [staff([HUB_A], 'pickup.request.cancel_chargeable'), 'the key of a chargeable cancellation'],
      [staff([HUB_B], 'pickup.request.cancel'), 'a hub other than the stop’s'],
      [staff([], 'pickup.request.cancel'), 'no hub'],
    ] as const) {
      expect(await run(context, (q) => q(skip(target.id))), why).toEqual([]);
    }
    expect(await stateOf(target.id)).toBe('PENDING');
    for (const stop of settled) {
      expect(await run(cancelling, (q) => q(skip(stop.id))), stop.state).toEqual([]);
    }
    expect(await run(cancelling, (q) => q(skip(released.id)))).toEqual([]);
    expect(await Promise.all([...settled, released].map((stop) => stateOf(stop.id)))).toEqual([
      'COLLECTED',
      'PARTIALLY_COLLECTED',
      'FAILED',
      'SKIPPED',
      'PENDING',
    ]);

    // Refused, and the row is whole afterwards (a refusal that wrote half of a statement, or a code that came from the wrong layer, is a
    // different defect from one that merely refused): the columns the login is not granted at all (the grant, 42501) ...
    const wholeRow = async (id: string) =>
      (await routes.rows(`select * from pickup_stop where id = $1`, [id]))[0];
    const untouched = await wholeRow(target.id);
    for (const change of [
      `carryover_snapshot = '{"reason_code":"X"}'::jsonb`,
      'version = 9',
      `responsible_hub_id = '${HUB_B}'`,
    ]) {
      expect(
        await refusedAs(
          cancelling,
          `update pickup_stop set ${change} where id = '${target.id}' returning id`,
        ),
        change,
      ).toBe('42501');
      expect(await wholeRow(target.id), change).toEqual(untouched);
    }
    // ... and the columns the login is granted for other acts, which this key may not write (S1.22 correction): the guard of the stop holds the
    // key to the skip, so it answers first, `23514`, before the policy's check is reached. A move to any state but SKIPPED, the place in the
    // order, the claim and the arrival: none of them is the skip's to change. (Before the guard held the key, these were `42501` only by the
    // policy's check of the state, and the same columns **written together with the skip** were accepted.)
    for (const change of [
      `state = 'ARRIVED'`,
      'sequence = 2',
      'released_at = now()',
      'arrived_at = now()',
    ]) {
      expect(
        await refusedAs(
          cancelling,
          `update pickup_stop set ${change} where id = '${target.id}' returning id`,
        ),
        change,
      ).toBe('23514');
      expect(await wholeRow(target.id), change).toEqual(untouched);
    }
    // The skip with any of them beside it is refused whole, and the stop is as it was.
    for (const beside of ['sequence = 9', 'released_at = now()', 'arrived_at = now()']) {
      expect(await refusedAs(cancelling, skip(target.id, '', `, ${beside}`)), beside).toBe('23514');
      expect(await wholeRow(target.id), beside).toEqual(untouched);
    }
    expect(await stateOf(target.id)).toBe('PENDING');
  });

  // Break caught (S1.21, migration 0060): the planning keys opened wider than the three acts they exist for. The assigning key may give a draft a
  // rider and the moment and mark a confirmed request, and change nothing else; the creating key may order the stops of a manifest that has
  // not gone further than dispatch, or cancel a manifest by skipping its stops and releasing their claims together, and change nothing else;
  // each only in a hub of the grant. A policy that ignored the key, the hub or the state of what it changes, or a guard that let a key do the
  // other's act, would pass the application's own tests and fail here.
  it('admits the planning of a manifest under its own keys, in a hub of the grant, and nothing else', async () => {
    const assigning = staff([HUB_A], 'pickup.manifest.assign');
    const creating = staff([HUB_A], 'pickup.manifest.create');
    const refusedAs = async (
      context: SecurityContext,
      text: string,
    ): Promise<string | undefined> => {
      try {
        await run(context, (q) => q(text));
      } catch (error) {
        return (
          (error as { cause?: { code?: string }; code?: string }).cause?.code ??
          (error as { code?: string }).code
        );
      }
      return undefined;
    };
    const rows = (context: SecurityContext, text: string) => run(context, (q) => q(text));
    const stateOfManifest = async (id: string) =>
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          id,
        ])
      )[0]?.state;
    const riderId = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;

    // The manifest: the assigning key gives a draft a rider and the moment.
    const draft = await manifest(HUB_A);
    const give = `update pickup_manifest set assigned_rider_id = '${riderId}', assigned_at = now() where id = '${draft.id}' returning id`;
    expect(await rows(assigning, give)).toEqual([{ id: draft.id }]);
    expect(await rows(staff([HUB_B], 'pickup.manifest.assign'), give)).toEqual([]);
    expect(await rows(staff([HUB_A], 'pickup.read'), give)).toEqual([]);
    expect(
      await refusedAs(
        assigning,
        `update pickup_manifest set state = 'CANCELLED' where id = '${draft.id}'`,
      ),
    ).toBe('23514');
    expect(
      await refusedAs(
        creating,
        `update pickup_manifest set assigned_at = now() where id = '${draft.id}'`,
      ),
    ).toBe('23514');
    // The creating key cancels, and cannot send a manifest out.
    expect(await stateOfManifest(draft.id)).toBe('DRAFT');
    expect(['42501', '23514']).toContain(
      await refusedAs(
        creating,
        `update pickup_manifest set state = 'DISPATCHED' where id = '${draft.id}'`,
      ),
    );
    expect(await stateOfManifest(draft.id)).toBe('DRAFT');

    // The stops: ordering, and the cancellation that skips and releases together.
    const ordered = await manifest(HUB_A);
    const first = await insertStop(routes.admin, stopRow(ordered, await request(HUB_A), 1));
    const second = await insertStop(routes.admin, stopRow(ordered, await request(HUB_A), 2));
    const third = await insertStop(routes.admin, stopRow(ordered, await request(HUB_A), 3));
    const place = (id: string, text: string) =>
      `update pickup_stop set ${text} where id = '${id}' returning id`;
    expect(await rows(creating, place(first.id, 'sequence = 7'))).toEqual([{ id: first.id }]);
    expect(
      await rows(staff([HUB_B], 'pickup.manifest.create'), place(first.id, 'sequence = 8')),
    ).toEqual([]);
    expect(await rows(staff([HUB_A], 'pickup.read'), place(first.id, 'sequence = 8'))).toEqual([]);
    expect(await rows(assigning, place(first.id, 'sequence = 8'))).toEqual([]);
    expect(await refusedAs(creating, place(first.id, 'sequence = 8, released_at = now()'))).toBe(
      '23514',
    );
    const skip =
      `state = 'SKIPPED', resolved_at = now(), released_at = now(), ` +
      `skip_snapshot = '{"reason_code":"MANIFEST_CANCELLED","skipped_at":"2026-11-03T09:00:00.000Z"}'::jsonb`;
    expect(await rows(creating, place(second.id, skip))).toEqual([{ id: second.id }]);
    expect(
      await refusedAs(creating, place(third.id, `state = 'SKIPPED', resolved_at = now()`)),
    ).toBe('23514');
    expect(await refusedAs(creating, place(third.id, 'released_at = now()'))).toBe('23514');
    // A manifest that has been cancelled is past ordering and past a second cancellation.
    const gone = await manifest(HUB_A, { state: 'CANCELLED' });
    const stopOfGone = await insertStop(
      routes.admin,
      stopRow(gone, await request(HUB_A), 1, { state: 'SKIPPED' }),
    );
    expect(await rows(creating, place(stopOfGone.id, 'sequence = 4'))).toEqual([]);
    expect(
      await routes.rows(`select sequence from pickup_stop where id = $1`, [stopOfGone.id]),
    ).toEqual([{ sequence: 1 }]);

    // The request: the assigning key marks a confirmed request in its hub as committed to a rider, while a stop that holds its claim sits on a
    // manifest that has one (the draft above has a rider), and does nothing else to it. The evidence is proved in the test that follows.
    const confirmedRequest = await request(HUB_A);
    await insertStop(routes.admin, stopRow(draft, confirmedRequest, 1));
    const mark = `update pickup_request set rider_assigned = true where id = '${confirmedRequest}' returning id`;
    expect(await rows(staff([HUB_B], 'pickup.manifest.assign'), mark)).toEqual([]);
    // The creating key is admitted to a confirmed request in its hub for one act, the lowering of a mark, and never raises it.
    expect(await refusedAs(creating, mark)).toBe('23514');
    expect(await rows(assigning, mark)).toEqual([{ id: confirmedRequest }]);
    expect(
      await refusedAs(
        assigning,
        `update pickup_request set rider_assigned = false where id = '${confirmedRequest}'`,
      ),
    ).toBe('23514');
    expect(
      await refusedAs(
        assigning,
        `update pickup_request set state = 'CANCELLED', rider_assigned = true where id = '${confirmedRequest}'`,
      ),
    ).toBe('23514');
    const pending = (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(organisation, HUB_A, { state: 'PENDING' }),
      )
    ).id;
    expect(
      await rows(
        assigning,
        `update pickup_request set rider_assigned = true where id = '${pending}' returning id`,
      ),
    ).toEqual([]);

    // The rider: the assigning key reads the rider in the hubs of its grant, and a reading key of the pickup domain does not.
    const readRider = `select id from rider_identity where id = '${riderId}'`;
    expect(await rows(assigning, readRider)).toEqual([{ id: riderId }]);
    expect(await rows(staff([HUB_B], 'pickup.manifest.assign'), readRider)).toEqual([]);
    expect(await rows(staff([HUB_A], 'pickup.read'), readRider)).toEqual([]);
  });

  // Break caught (S1.21, migration 0064; the Product Owner's decision of 2 November 2026, OB-S1-35): the mark of a rider commitment raised for a
  // request no stop holds, or held on a manifest without a rider, or whose claim was released; lowered while a stop still holds the request
  // (a request claimed by a later manifest unmarked by an act on its earlier one), or when no claim was ever released; changed by any key but
  // the two acts that own it; or changed together with anything else. The same holds for every writer, whatever the application does.
  it('raises the mark of a rider commitment only on a held claim of a manifest with a rider, lowers it only once the claim is released, and lets no other key touch it', async () => {
    const assigning = staff([HUB_A], 'pickup.manifest.assign');
    const releasing = staff([HUB_A], 'pickup.manifest.create');
    const rider = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    const attempt = async (
      context: SecurityContext,
      text: string,
    ): Promise<{ code: string | undefined; message: string | undefined } | undefined> => {
      try {
        await run(context, (q) => q(text));
      } catch (error) {
        const found = error as {
          cause?: { code?: string; message?: string };
          code?: string;
          message?: string;
        };
        return {
          code: found.cause?.code ?? found.code,
          message: found.cause?.message ?? found.message,
        };
      }
      return undefined;
    };
    const markOf = async (id: string) =>
      (
        await routes.rows<{ rider_assigned: boolean }>(
          `select rider_assigned from pickup_request where id = $1`,
          [id],
        )
      )[0]?.rider_assigned;
    const raise = (id: string) =>
      `update pickup_request set rider_assigned = true where id = '${id}'`;
    const lower = (id: string, extra = '') =>
      `update pickup_request set rider_assigned = false ${extra} where id = '${id}'`;

    /** A confirmed request held by a stop of a manifest (with a rider or without one), the claim released or not, its mark as given. */
    const held = async (over: { rider?: boolean; released?: boolean; marked?: boolean } = {}) => {
      const id = await request(HUB_A);
      const holder = await manifest(HUB_A, over.rider === false ? {} : { assignedRiderId: rider });
      await insertStop(
        routes.admin,
        stopRow(holder, id, 1, {
          state: over.released === true ? 'SKIPPED' : 'PENDING',
          releasedAt: over.released === true ? new Date('2026-11-03T10:00:00Z') : null,
        }),
      );
      if (over.marked === true) {
        await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
          id,
        ]);
      }
      return id;
    };

    // Raised: on the held claim of a manifest that has a rider, and on nothing else.
    const committed = await held();
    expect(await attempt(assigning, raise(committed))).toBeUndefined();
    expect(await markOf(committed)).toBe(true);
    for (const [why, id] of [
      ['a request no stop holds', await request(HUB_A)],
      ['a request held on a manifest with no rider', await held({ rider: false })],
      ['a request whose claim was released', await held({ released: true })],
    ] as const) {
      const refused = await attempt(assigning, raise(id));
      expect([why, refused?.code]).toEqual([why, '23514']);
      expect(refused?.message, why).toContain(
        'only while a stop that has not released its claim holds it',
      );
      expect(await markOf(id), why).toBe(false);
    }
    // The assigning key never takes the mark back, and does not raise it together with anything else.
    const taken = await attempt(assigning, lower(committed));
    expect(taken?.code).toBe('23514');
    expect(taken?.message).toContain('never takes the mark back');
    const withMore = await attempt(
      assigning,
      `update pickup_request set rider_assigned = true, current_item_description = 'x' where id = '${await held()}'`,
    );
    expect(withMore?.code).toBe('23514');
    expect(withMore?.message).toContain('changes nothing else');

    // Lowered: once the claim is released and no stop holds the request, under the key of the manifest's cancellation, in a hub of the grant.
    const released = await held({ released: true, marked: true });
    expect(await attempt(releasing, lower(released))).toBeUndefined();
    expect(await markOf(released)).toBe(false);
    // Not while a stop holds it: a request claimed by a later manifest has an old, released stop and a current one, and keeps its mark.
    const later = await held({ released: true, marked: true });
    const second = await manifest(HUB_A, { assignedRiderId: rider });
    await insertStop(routes.admin, stopRow(second, later, 1));
    const claimedAgain = await attempt(releasing, lower(later));
    expect(claimedAgain?.code).toBe('23514');
    expect(claimedAgain?.message).toContain(
      'only when its claim has been released and no stop holds it any more',
    );
    const stillHeld = await held({ marked: true });
    expect((await attempt(releasing, lower(stillHeld)))?.code).toBe('23514');
    // Not when no claim was ever released (nothing the cancellation did gives the mark up), and never raised by this key.
    const never = await request(HUB_A);
    await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
      never,
    ]);
    expect((await attempt(releasing, lower(never)))?.code).toBe('23514');
    const raised = await attempt(releasing, raise(await held({ released: true })));
    expect(raised?.code).toBe('23514');
    expect(raised?.message).toContain('never gives it');
    // The lowering changes the mark and nothing else.
    const plain = await held({ released: true, marked: true });
    const andMore = await attempt(releasing, lower(plain, `, current_item_description = 'x'`));
    expect(andMore?.code).toBe('23514');
    expect(andMore?.message).toContain('changes nothing else');
    expect(await Promise.all([later, stillHeld, never, plain].map((id) => markOf(id)))).toEqual([
      true,
      true,
      true,
      true,
    ]);

    // The policy: a hub other than the request's, a state but confirmed, and a key that is neither of the two find no row or are refused.
    const elsewhere = await held({ released: true, marked: true });
    expect(
      await run(staff([HUB_B], 'pickup.manifest.create'), (q) =>
        q(`${lower(elsewhere)} returning id`),
      ),
    ).toEqual([]);
    expect(
      await run(staff([HUB_A], 'pickup.read'), (q) => q(`${lower(elsewhere)} returning id`)),
    ).toEqual([]);
    expect(await markOf(elsewhere)).toBe(true);
    const cancelled = await held({ released: true, marked: true });
    await routes.admin.query(
      `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancelled_by_actor_type = 'OPS' where id = $1`,
      [cancelled, ARRANGER],
    );
    expect(await run(releasing, (q) => q(`${lower(cancelled)} returning id`))).toEqual([]);
    expect(await markOf(cancelled)).toBe(true);
    // Any other key that may update a request changes the mark by none of its acts.
    for (const key of [
      'pickup.request.cancel',
      'pickup.request.confirm',
      'pickup.attempt.extend',
    ]) {
      const other = await held({ released: true, marked: true });
      const changed = await attempt(staff([HUB_A], key), lower(other));
      expect([key, changed?.code]).toEqual([key, '23514']);
      expect(changed?.message, key).toContain(
        'only the assignment of a rider and the cancellation of a manifest',
      );
      expect(await markOf(other), key).toBe(true);
    }
  });

  // Break caught (the reviewer's finding on migration 0064; OB-S1-33): the assumption the guard of the mark stands on, left implicit. The guard reads
  // the stops through row-level security, and that read is complete only while a request and every stop that holds or held it are in one hub. So a
  // request keeps its hub for every writer (claimed or never claimed), a stop keeps its hub, and a stop is in the hub of its manifest by foreign
  // key; the application makes every stop in the one hub of its requests. A change that lets a request change hub must reconcile all of this
  // first (OB-S1-33), and this test is what it will have to change on purpose.
  it('keeps a request in its hub for every writer, and a stop in its manifest’s hub, which is what the guard of the mark relies on', async () => {
    const held = await request(HUB_A);
    const holder = await manifest(HUB_A);
    const stop = await insertStop(routes.admin, stopRow(holder, held, 1));
    for (const [why, id] of [
      ['a request that a stop holds', held],
      ['a request that no stop has held', await request(HUB_A)],
    ] as const) {
      const refused = await refusal(
        `update pickup_request set responsible_hub_id = $2 where id = $1`,
        [id, HUB_B],
      );
      expect([why, refused.code]).toEqual([why, '23514']);
      expect(refused.message, why).toContain(
        'a pickup request keeps its identity, its sender, its hub',
      );
    }
    const moved = await refusal(`update pickup_stop set responsible_hub_id = $2 where id = $1`, [
      stop.id,
      HUB_B,
    ]);
    expect(moved.code).toBe('23514');
    expect(moved.message).toContain('a pickup stop keeps its manifest, its request, its hub');
    const elsewhere = await refusal(
      `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence)
       values ($1, $2, $3, $4, 2)`,
      [randomUUID(), holder.id, await request(HUB_A), HUB_B],
    );
    expect([elsewhere.code, elsewhere.constraint]).toEqual(['23503', 'pickup_stop_manifest_fkey']);
    // None of the refused statements changed a row.
    expect(
      await routes.rows(`select responsible_hub_id from pickup_request where id = $1`, [held]),
    ).toEqual([{ responsible_hub_id: HUB_A }]);
    expect(
      await routes.rows(`select responsible_hub_id from pickup_stop where id = $1`, [stop.id]),
    ).toEqual([{ responsible_hub_id: HUB_A }]);
  });

  /** The SQLSTATE a statement is refused with in a context, or nothing when it is not refused. */
  const refusedIn = async (context: SecurityContext, text: string): Promise<string | undefined> => {
    try {
      await run(context, (q) => q(text));
    } catch (error) {
      return (
        (error as { cause?: { code?: string }; code?: string }).cause?.code ??
        (error as { code?: string }).code
      );
    }
    return undefined;
  };
  /** A summary of the six members the contract names, as the dispatch of a manifest makes it. */
  const SUMMARY = {
    reference: 'ACC-PR-7K3M9Q',
    sender_display_name: 'Ama Serwaa Fashions',
    declared_package_count: 3,
    resolved_pickup_location: { address: '12 Oxford Street, Osu' },
    location_note: null,
    contact_phone: '+233201234567',
  };
  const given = (summary: unknown) => `'${JSON.stringify(summary)}'::jsonb`;
  const place = async (over: { status?: string; hub?: string } = {}) =>
    insertRider(
      routes.admin,
      riderRow({ hubId: over.hub ?? HUB_A, status: over.status ?? 'ACTIVE' }),
    );

  // Break caught (S1.21, migration 0063): the dispatch key opened wider than the act it exists for, or a manifest that reaches a rider without
  // what dispatch gives it. The key sends a draft out, only to an active rider of the manifest's own hub, only when a stop is still to be
  // worked and every such stop has its summary (OB-S1-21: no stop reaches a rider without one), and changes the state and the moment of
  // dispatch and nothing else; each only in a hub of the grant. The same holds for every writer, whatever the application does.
  it('admits the dispatch of a manifest under its own key: an active rider of its hub, a summary on every stop to be worked, and nothing else', async () => {
    const dispatching = staff([HUB_A], 'pickup.manifest.dispatch');
    const send = (id: string) =>
      `update pickup_manifest set state = 'DISPATCHED', dispatched_at = now() where id = '${id}' returning id`;
    const summarise = (id: string) =>
      `update pickup_stop set pickup_summary = ${given(SUMMARY)} where id = '${id}' returning id`;
    const stateOfManifest = async (id: string) =>
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          id,
        ])
      )[0]?.state;
    const arranged = async (rider: { id: string }, hub: string = HUB_A) => {
      const draft = await manifest(hub, { assignedRiderId: rider.id });
      const stop = await insertStop(routes.admin, stopRow(draft, await request(hub), 1));
      return { draft, stop };
    };

    // Admitted: every stop to be worked has its summary, the rider is active and of the hub.
    const rider = await place();
    const ready = await arranged(rider);
    expect(await run(dispatching, (q) => q(summarise(ready.stop.id)))).toEqual([
      { id: ready.stop.id },
    ]);
    expect(await run(dispatching, (q) => q(send(ready.draft.id)))).toEqual([
      { id: ready.draft.id },
    ]);
    expect(await stateOfManifest(ready.draft.id)).toBe('DISPATCHED');

    // Refused: no summary on a stop still to be worked.
    const bare = await arranged(await place());
    expect(await refusedIn(dispatching, send(bare.draft.id))).toBe('23514');
    // Refused: a rider that is not active, that belongs to another hub, or none.
    for (const [why, who] of [
      ['a suspended rider', await place({ status: 'SUSPENDED' })],
      ['an offboarded rider', await place({ status: 'OFFBOARDED' })],
      ['a rider of another hub', await place({ hub: HUB_B })],
    ] as const) {
      const case_ = await arranged(who);
      await run(dispatching, (q) => q(summarise(case_.stop.id)));
      expect(await refusedIn(dispatching, send(case_.draft.id)), why).toBe('23514');
      expect(await stateOfManifest(case_.draft.id), why).toBe('DRAFT');
    }
    const riderless = await manifest(HUB_A);
    const riderlessStop = await insertStop(routes.admin, stopRow(riderless, await request(), 1));
    await run(dispatching, (q) => q(summarise(riderlessStop.id)));
    expect(await refusedIn(dispatching, send(riderless.id))).toBe('23514');
    // Refused: nothing left to be worked.
    const resolvedOnly = await manifest(HUB_A, { assignedRiderId: (await place()).id });
    await insertStop(routes.admin, stopRow(resolvedOnly, await request(), 1, { state: 'SKIPPED' }));
    expect(await refusedIn(dispatching, send(resolvedOnly.id))).toBe('23514');

    // The key does nothing else to a manifest: not another column with the dispatch, not a cancellation, not a manifest that has gone out.
    const other = await arranged(await place());
    await run(dispatching, (q) => q(summarise(other.stop.id)));
    expect(
      await refusedIn(
        dispatching,
        `update pickup_manifest set state = 'DISPATCHED', dispatched_at = now(), assigned_at = now() where id = '${other.draft.id}'`,
      ),
    ).toBe('23514');
    expect(['42501', '23514']).toContain(
      await refusedIn(
        dispatching,
        `update pickup_manifest set state = 'CANCELLED' where id = '${other.draft.id}'`,
      ),
    );
    expect(
      await refusedIn(
        dispatching,
        `update pickup_manifest set state = 'IN_PROGRESS' where id = '${ready.draft.id}'`,
      ),
    ).toBeDefined();
    expect(await stateOfManifest(other.draft.id)).toBe('DRAFT');

    // And not for a hub or a key it does not hold: the statement finds no row, or is refused, and the manifest is as it was.
    const elsewhere = await arranged(await place({ hub: HUB_B }), HUB_B);
    expect(
      await run(staff([HUB_A], 'pickup.manifest.dispatch'), (q) => q(send(elsewhere.draft.id))),
    ).toEqual([]);
    const third = await arranged(await place());
    await run(dispatching, (q) => q(summarise(third.stop.id)));
    for (const key of ['pickup.manifest.create', 'pickup.manifest.assign', 'pickup.read']) {
      const answer = await refusedIn(staff([HUB_A], key), send(third.draft.id));
      expect(['42501', '23514', undefined], key).toContain(answer);
      expect(await stateOfManifest(third.draft.id), key).toBe('DRAFT');
    }
  });

  // Break caught (OB-S1-21): a summary written by any key but the dispatch key, over a stop that is resolved, released or already has one, or
  // changed after it was made; and a summary that holds more than the contract names.
  it('admits the summary of a stop to the dispatch key alone, once, and holds it to the six members the contract names', async () => {
    const dispatching = staff([HUB_A], 'pickup.manifest.dispatch');
    const rider = await place();
    const draft = await manifest(HUB_A, { assignedRiderId: rider.id });
    const stop = await insertStop(routes.admin, stopRow(draft, await request(), 1));
    const summarise = (id: string, summary: unknown = SUMMARY) =>
      `update pickup_stop set pickup_summary = ${given(summary)} where id = '${id}' returning id`;
    const summaryOf = async (id: string) =>
      (
        await routes.rows<{ pickup_summary: unknown }>(
          `select pickup_summary from pickup_stop where id = $1`,
          [id],
        )
      )[0]?.pickup_summary;

    // Another key, another hub, a manifest that is not a draft, a stop that is resolved or released: nothing is written.
    for (const key of [
      'pickup.manifest.create',
      'pickup.manifest.assign',
      'pickup.request.cancel',
      'pickup.read',
    ]) {
      const answer = await refusedIn(staff([HUB_A], key), summarise(stop.id));
      expect(['42501', '23514', undefined], key).toContain(answer);
    }
    expect(
      await run(staff([HUB_B], 'pickup.manifest.dispatch'), (q) => q(summarise(stop.id))),
    ).toEqual([]);
    const gone = await manifest(HUB_A, { state: 'CANCELLED', assignedRiderId: rider.id });
    const resolved = await insertStop(
      routes.admin,
      stopRow(gone, await request(), 1, { state: 'SKIPPED' }),
    );
    const sent = await manifest(HUB_A, { state: 'DISPATCHED', assignedRiderId: rider.id });
    const onSent = await insertStop(routes.admin, stopRow(sent, await request(), 1));
    const released = await insertStop(
      routes.admin,
      stopRow(await manifest(HUB_A), await request(), 1, {
        releasedAt: new Date('2026-11-03T10:00:00Z'),
      }),
    );
    for (const target of [resolved, onSent, released]) {
      expect(await run(dispatching, (q) => q(summarise(target.id)))).toEqual([]);
    }
    expect(await summaryOf(stop.id)).toBeNull();

    // The dispatch key makes it once, and never changes it; nor does anyone else.
    expect(await run(dispatching, (q) => q(summarise(stop.id)))).toEqual([{ id: stop.id }]);
    expect(await summaryOf(stop.id)).toEqual(SUMMARY);
    expect(
      await run(dispatching, (q) =>
        q(summarise(stop.id, { ...SUMMARY, reference: 'ACC-PR-OTHER2' })),
      ),
    ).toEqual([]);
    expect(
      await run(dispatching, (q) =>
        q(`update pickup_stop set pickup_summary = null where id = '${stop.id}' returning id`),
      ),
    ).toEqual([]);
    // The dispatch key's own policy hides a stop that has a summary (the empty answers above), so what holds a change by anyone else is the
    // guard. The administrator asserts no key and reaches it, and it names the rule: the message tells this layer from the one that follows it.
    const changed = await refusal(
      `update pickup_stop set pickup_summary = ${given({ ...SUMMARY, reference: 'ACC-PR-OTHER2' })} where id = $1`,
      [stop.id],
    );
    expect(changed.code).toBe('23514');
    expect(changed.message).toContain('made once and never changed');
    expect(await summaryOf(stop.id)).toEqual(SUMMARY);

    // A stop that has none is given one by the dispatch key alone (the administrator asserts no key), and that key changes nothing else of the
    // stop with it: not its place in the run, and not the release of its claim.
    const bare = await insertStop(routes.admin, stopRow(await manifest(HUB_A), await request(), 1));
    const unkeyed = await refusal(
      `update pickup_stop set pickup_summary = ${given(SUMMARY)} where id = $1`,
      [bare.id],
    );
    expect(unkeyed.code).toBe('23514');
    expect(unkeyed.message).toContain('only the dispatch of a manifest makes the summary');
    for (const alongside of ['sequence = 9', 'released_at = now()']) {
      expect(
        await refusedIn(
          dispatching,
          `update pickup_stop set pickup_summary = ${given(SUMMARY)}, ${alongside} where id = '${bare.id}'`,
        ),
        alongside,
      ).toBe('23514');
    }
    expect(await summaryOf(bare.id)).toBeNull();

    // What the table holds a summary to: six members, of the types the contract gives them, and a place of its five members.
    for (const [why, summary] of [
      ['a payer', { ...SUMMARY, payer_intent: 'SENDER_PAYS_FULL' }],
      ['a price', { ...SUMMARY, price: 3500 }],
      [
        'a member of the place that is not one',
        { ...SUMMARY, resolved_pickup_location: { address: 'x', zone: 'ACCRA' } },
      ],
      [
        'a missing contact',
        Object.fromEntries(Object.entries(SUMMARY).filter(([key]) => key !== 'contact_phone')),
      ],
      [
        'a missing note',
        Object.fromEntries(Object.entries(SUMMARY).filter(([key]) => key !== 'location_note')),
      ],
      ['a count that is text', { ...SUMMARY, declared_package_count: 'three' }],
      ['a place with no address', { ...SUMMARY, resolved_pickup_location: { landmark: 'x' } }],
      ['a place that is text', { ...SUMMARY, resolved_pickup_location: 'x' }],
      ['an address that is a number', { ...SUMMARY, resolved_pickup_location: { address: 7 } }],
      ['a reference that is a number', { ...SUMMARY, reference: 7 }],
      ['a sender that is a number', { ...SUMMARY, sender_display_name: 7 }],
      ['a note that is a number', { ...SUMMARY, location_note: 7 }],
      ['a contact that is a number', { ...SUMMARY, contact_phone: 7 }],
      ['an array', [SUMMARY]],
    ] as const) {
      const fresh = await insertStop(
        routes.admin,
        stopRow(await manifest(HUB_A), await request(), 1),
      );
      // Under the dispatch key, so that the guard and the policy let the statement through and the table's check is what refuses it.
      let refusedBy: { code?: string; constraint?: string } | undefined;
      try {
        await run(dispatching, (q) => q(summarise(fresh.id, summary)));
      } catch (error) {
        refusedBy = (error as { cause?: { code?: string; constraint?: string } }).cause;
      }
      expect([why, refusedBy?.code, refusedBy?.constraint]).toEqual([
        why,
        '23514',
        'pickup_stop_summary_shape',
      ]);
    }
  });

  // Break caught (the Product Owner, 2 November 2026): the reach of an officer's grant standing in for a rider's hub. The assigning key gives a
  // draft an ACTIVE rider of the manifest's own hub and no other, whatever the grant lets the officer see, and never takes the rider away.
  it('admits the assignment of a rider to the manifest’s own hub alone, though the grant reaches another', async () => {
    const wide = staff([HUB_A, HUB_B], 'pickup.manifest.assign');
    const give = (id: string, riderId: string | null) =>
      `update pickup_manifest set assigned_rider_id = ${riderId === null ? 'null' : `'${riderId}'`}, assigned_at = now() where id = '${id}' returning id`;
    const draft = await manifest(HUB_A);
    const own = await place();
    const away = await place({ hub: HUB_B });
    const suspended = await place({ status: 'SUSPENDED' });

    // The officer can see the rider of the other hub, and cannot give it this manifest.
    expect(
      await run(wide, (q) => q(`select id from rider_identity where id = '${away.id}'`)),
    ).toEqual([{ id: away.id }]);
    expect(await refusedIn(wide, give(draft.id, away.id))).toBe('23514');
    expect(await refusedIn(wide, give(draft.id, suspended.id))).toBe('23514');
    expect(await refusedIn(wide, give(draft.id, null))).toBe('23514');
    expect(
      await routes.rows(`select assigned_rider_id from pickup_manifest where id = $1`, [draft.id]),
    ).toEqual([{ assigned_rider_id: null }]);

    expect(await run(wide, (q) => q(give(draft.id, own.id)))).toEqual([{ id: draft.id }]);
    // Another rider of the same hub replaces it; the rider of another hub still cannot.
    const second = await place();
    expect(await run(wide, (q) => q(give(draft.id, second.id)))).toEqual([{ id: draft.id }]);
    expect(await refusedIn(wide, give(draft.id, away.id))).toBe('23514');
  });
});
