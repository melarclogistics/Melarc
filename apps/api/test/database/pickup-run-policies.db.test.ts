import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type ManifestRow,
  type ManifestState,
  type StopRow,
  type StopState,
} from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { HUB_A, HUB_B, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.22: what the database holds for **every** writer of a rider's two acts (`AC-SLICE-001-14`, `-16` and `-80`; matrix rows `GBT-D1` to
 * `GBT-D3` as writes; the registry rows `PickupManifest` and `PickupStop`; migration `0065`):
 *
 * - **The start** is one update of one row: a rider's own run, dispatched to it, under the key that works a run, from `DISPATCHED` to
 *   `IN_PROGRESS` with its moment, and nothing else. A colleague's run, a draft, another key, a forged hub scope and every principal but a
 *   rider reach no row; the guard refuses every other move and every other column.
 * - **The arrival** is one update of one stop of such a run once it is in progress: `PENDING` to `ARRIVED` with the moment, and nothing else.
 *   The moment is written by that act alone: the two staff keys that skip a stop (the cancellation of a request, the planning) may not write it.
 * - **The ledger** takes the two events of these acts from the rider's context, about the rider's own run or stop, from its own surface and
 *   under the key of the act, and nothing else; each carries the facts of its act (the states, the hub of its object, the identifiers it
 *   relates), and the arm that took only its sign-out is unchanged for everything it refused.
 */
let routes: StaffRoutes;
let organisation: string;

beforeAll(async () => {
  routes = await startStaffRoutes();
  organisation = (await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }))).organizationId;
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const KEY = 'pickup.run.execute';

const riderContext = (riderId: string, key: string = KEY): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'pickup-run-policies',
});

const staffContext = (key: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: 'ALL',
  authorizedHubIds: [],
  correlationId: 'pickup-run-policies',
});

type Result = { readonly rows: unknown[] } | { readonly code: string | undefined };

/** What a statement does as a context: the rows it returned, or the SQLSTATE of the error the database raised. */
async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    return { code: serverErrorIn(error)?.code ?? 'other' };
  }
}

const idsOf = (result: Result): string[] =>
  'rows' in result ? result.rows.map((row) => (row as { id: string }).id) : [];
const codeOf = (result: Result): string | undefined => ('code' in result ? result.code : undefined);

interface Fixture {
  readonly riderId: string;
  readonly manifest: ManifestRow;
  readonly stop: StopRow;
}

async function fixture(
  state: ManifestState = 'IN_PROGRESS',
  stopState: StopState = 'PENDING',
  rider?: string,
): Promise<Fixture> {
  const riderId = rider ?? (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state,
      assignedRiderId: riderId,
      ...(state === 'CANCELLED' ? { dispatchedBeforeCancel: true } : {}),
    }),
  );
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
  );
  // A run that has gone out carries the summary the dispatch gave its stops; the guard of a stop lets only that key make it, so it is written with the stop.
  const summary = {
    reference: request.code,
    sender_display_name: 'Fixture Sender',
    declared_package_count: 1,
    resolved_pickup_location: { address: 'Fixture shop' },
    location_note: null,
    contact_phone: null,
  };
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, {
      state: stopState,
      ...(state === 'DRAFT' ? {} : { pickupSummary: summary }),
    }),
  );
  return { riderId, manifest, stop };
}

const startSql = (id: string, set = `state = 'IN_PROGRESS', started_at = now()`) =>
  `update pickup_manifest set ${set} where id = '${id}' returning id`;
const arriveSql = (id: string, set = `state = 'ARRIVED', arrived_at = now()`) =>
  `update pickup_stop set ${set} where id = '${id}' returning id`;

describe('the start of a run, as the database holds it for every writer', () => {
  // Break caught: a policy that does not admit the rider's own start, or one that admits it to a run that is not ready, with a key that
  // is not the act's, or from a context that is not a rider's.
  it('admits a rider’s start of its own dispatched run, and nobody else’s', async () => {
    const own = await fixture('DISPATCHED');
    const other = await fixture('DISPATCHED');
    // For a rider that is not the run's, or that does not hold the key of the act, the run is **hidden**: the statement finds no row and is
    // no error, which is the USING of the policy and not a refusal by its check or by the guard.
    expect(await attempt(riderContext(own.riderId), startSql(other.manifest.id))).toEqual({
      rows: [],
    });
    expect(
      await attempt(riderContext(own.riderId, 'pickup.read'), startSql(own.manifest.id)),
    ).toEqual({ rows: [] });
    // A rider who forges the hub scope of staff reaches the staff branch of no policy: a rider has no hub dimension.
    const forged: SecurityContext = {
      ...riderContext(own.riderId, 'pickup.manifest.dispatch'),
      hubScopeMode: 'ALL',
    };
    expect(await attempt(forged, startSql(own.manifest.id))).toEqual({ rows: [] });
    // Staff reach it under no key, the act's included (a rider-only key is not an officer's).
    for (const key of [KEY, 'pickup.manifest.dispatch', 'pickup.manifest.create', 'pickup.read']) {
      expect(idsOf(await attempt(staffContext(key), startSql(own.manifest.id)))).toEqual([]);
    }
    expect(
      (await routes.rows(`select state from pickup_manifest where id = $1`, [own.manifest.id]))[0],
    ).toEqual({
      state: 'DISPATCHED',
    });

    expect(idsOf(await attempt(riderContext(own.riderId), startSql(own.manifest.id)))).toEqual([
      own.manifest.id,
    ]);
    expect(
      (
        await routes.rows(
          `select state, started_at is not null as moment from pickup_manifest where id = $1`,
          [own.manifest.id],
        )
      )[0],
    ).toEqual({
      state: 'IN_PROGRESS',
      moment: true,
    });
  });

  // Break caught: a draft shown to its rider by the update path, or a run cancelled before it went out being started.
  it('reaches no row for a draft or for a run cancelled before it went out: the rider was never shown them', async () => {
    const draft = await fixture('DRAFT');
    const unsent = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'CANCELLED', assignedRiderId: draft.riderId }),
    );
    expect(await attempt(riderContext(draft.riderId), startSql(draft.manifest.id))).toEqual({
      rows: [],
    });
    expect(await attempt(riderContext(draft.riderId), startSql(unsent.id))).toEqual({ rows: [] });
  });

  // Break caught: a guard that lets the rider's key do more than start a dispatched run: any other move of the state, a move from any
  // other state, a change of any other column, a start with no moment.
  it.each([
    [
      'a run cancelled after it went out',
      'CANCELLED',
      `state = 'IN_PROGRESS', started_at = now()`,
      '23514',
    ],
    ['a run already started', 'IN_PROGRESS', `state = 'IN_PROGRESS', started_at = now()`, '23514'],
    ['a completed run', 'COMPLETED', `state = 'IN_PROGRESS', started_at = now()`, '23514'],
    ['a move to CANCELLED', 'DISPATCHED', `state = 'CANCELLED'`, '23514'],
    ['a move to COMPLETED', 'DISPATCHED', `state = 'COMPLETED'`, '23514'],
    ['a moment without the state', 'DISPATCHED', `started_at = now()`, '23514'],
    ['a state without the moment', 'DISPATCHED', `state = 'IN_PROGRESS'`, '23514'],
    [
      'another rider given the run',
      'DISPATCHED',
      `state = 'IN_PROGRESS', started_at = now(), assigned_rider_id = gen_random_uuid()`,
      '23514',
    ],
    [
      'the moment of dispatch changed',
      'DISPATCHED',
      `state = 'IN_PROGRESS', started_at = now(), dispatched_at = now() + interval '1 day'`,
      '23514',
    ],
    [
      'the day changed',
      'DISPATCHED',
      `state = 'IN_PROGRESS', started_at = now(), service_date = '2030-01-01'`,
      '42501',
    ],
    [
      'the code changed',
      'DISPATCHED',
      `state = 'IN_PROGRESS', started_at = now(), code = 'ACC-MF-AAAAAA'`,
      '42501',
    ],
    // The login holds the column since the system's completion of a run (S1.23, migration 0066), so what refuses a rider's start that also sets it is
    // no longer a missing grant but the guard of the manifest, which lets the rider's key write the state and the moment of the start and nothing else.
    [
      'the completion moment set',
      'DISPATCHED',
      `state = 'IN_PROGRESS', started_at = now(), completed_at = now()`,
      '23514',
    ],
  ] as const)('refuses %s', async (_label, state, set, expected) => {
    const run = await fixture(state);
    const result = await attempt(riderContext(run.riderId), startSql(run.manifest.id, set));
    expect(codeOf(result)).toBe(expected);
    expect(
      (await routes.rows(`select state from pickup_manifest where id = $1`, [run.manifest.id]))[0],
    ).toEqual({ state });
  });
});

describe('the arrival at a stop, as the database holds it for every writer', () => {
  // Break caught (GBT-D2 and D3 as writes): a rider who arrives at a colleague's stop, under another key, from a forged scope, or as staff.
  it('admits a rider’s arrival at its own stop of a run in progress, and nobody else’s', async () => {
    const own = await fixture('IN_PROGRESS');
    const other = await fixture('IN_PROGRESS');
    expect(await attempt(riderContext(own.riderId), arriveSql(other.stop.id))).toEqual({
      rows: [],
    });
    expect(await attempt(riderContext(own.riderId, 'pickup.read'), arriveSql(own.stop.id))).toEqual(
      { rows: [] },
    );
    const forged: SecurityContext = {
      ...riderContext(own.riderId, 'pickup.manifest.dispatch'),
      hubScopeMode: 'ALL',
    };
    expect(await attempt(forged, arriveSql(own.stop.id))).toEqual({ rows: [] });
    for (const key of [KEY, 'pickup.request.cancel', 'pickup.manifest.create', 'pickup.read']) {
      expect(idsOf(await attempt(staffContext(key), arriveSql(own.stop.id)))).toEqual([]);
    }
    expect(
      (await routes.rows(`select state from pickup_stop where id = $1`, [own.stop.id]))[0],
    ).toEqual({ state: 'PENDING' });

    expect(idsOf(await attempt(riderContext(own.riderId), arriveSql(own.stop.id)))).toEqual([
      own.stop.id,
    ]);
    expect(
      (
        await routes.rows(
          `select state, arrived_at is not null as moment from pickup_stop where id = $1`,
          [own.stop.id],
        )
      )[0],
    ).toEqual({
      state: 'ARRIVED',
      moment: true,
    });
  });

  // Break caught: a guard that lets the rider's key do more than arrive: at a stop of a run that has not started, from any other state,
  // to any other state, with another column changed or with no moment.
  it.each([
    [
      'a run that is only dispatched',
      'DISPATCHED',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now()`,
    ],
    [
      'a run cancelled after it went out',
      'CANCELLED',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now()`,
    ],
    [
      'a stop already arrived at',
      'IN_PROGRESS',
      'ARRIVED',
      `state = 'ARRIVED', arrived_at = now()`,
    ],
    ['a stop skipped', 'IN_PROGRESS', 'SKIPPED', `state = 'ARRIVED', arrived_at = now()`],
    ['a stop collected', 'IN_PROGRESS', 'COLLECTED', `state = 'ARRIVED', arrived_at = now()`],
    ['a move to SKIPPED', 'IN_PROGRESS', 'PENDING', `state = 'SKIPPED'`],
    ['a move to COLLECTED', 'IN_PROGRESS', 'PENDING', `state = 'COLLECTED', arrived_at = now()`],
    ['a move to FAILED', 'IN_PROGRESS', 'PENDING', `state = 'FAILED', arrived_at = now()`],
    ['a state without the moment', 'IN_PROGRESS', 'PENDING', `state = 'ARRIVED'`],
    ['a moment without the state', 'IN_PROGRESS', 'PENDING', `arrived_at = now()`],
    [
      'the place in the order changed',
      'IN_PROGRESS',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now(), sequence = 9`,
    ],
    [
      'the claim released',
      'IN_PROGRESS',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now(), released_at = now()`,
    ],
    [
      'the summary taken away',
      'IN_PROGRESS',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now(), pickup_summary = null`,
    ],
    [
      'the resolution moment set',
      'IN_PROGRESS',
      'PENDING',
      `state = 'ARRIVED', arrived_at = now(), resolved_at = now()`,
    ],
  ] as const)('refuses an arrival at %s', async (_label, state, stopState, set) => {
    const run = await fixture(state, stopState);
    const before = (
      await routes.rows(`select state from pickup_stop where id = $1`, [run.stop.id])
    )[0];
    const result = await attempt(riderContext(run.riderId), arriveSql(run.stop.id, set));
    // The policy admits the rider to lock its own stop in any state, so that the application refuses a stop that has moved on and does not
    // hide it; what the row may become is the guard's, and it refuses each of these, whatever the application does.
    expect(codeOf(result)).toBe('23514');
    expect(idsOf(result)).toEqual([]);
    expect(
      (await routes.rows(`select state from pickup_stop where id = $1`, [run.stop.id]))[0],
    ).toEqual(before);
  });
});

describe('the moment of an arrival is written by the rider’s act and by no other key', () => {
  const SNAPSHOT = `'{"reason_code":"REQUEST_CANCELLED","label":"Request cancelled","skipped_at":"2026-11-03T10:00:00Z"}'::jsonb`;
  const skipSql = (id: string, more = '') =>
    `update pickup_stop set state = 'SKIPPED', resolved_at = now(), skip_snapshot = ${SNAPSHOT}${more} where id = '${id}' returning id`;
  const arrivalOf = async (id: string) =>
    (
      await routes.rows<{ state: string; arrived_at: Date | null }>(
        `select state, arrived_at from pickup_stop where id = $1`,
        [id],
      )
    )[0];

  // Break caught: the grant of the moment, which belongs to the runtime login and not to a key, reaching the two staff keys that skip a stop
  // (the cancellation of a request, and the planning that cancels a manifest), so that either could write an arrival nobody made. Each control
  // is the same skip without the arrival, which they may write, and passes; the refusal is the guard's, 23514, for the arrival alone.
  it.each([
    ['the cancellation of a request', 'pickup.request.cancel', ''],
    ['the planning', 'pickup.manifest.create', ', released_at = now()'],
  ] as const)(
    '%s skips a stop and leaves its arrival alone, and is refused a change of it',
    async (_label, key, release) => {
      const context = staffContext(key);
      for (const [stopState, change] of [
        ['PENDING', `, arrived_at = now()`],
        ['ARRIVED', `, arrived_at = now()`],
        ['ARRIVED', `, arrived_at = null`],
      ] as const) {
        const control = await fixture('DISPATCHED', stopState);
        const before = await arrivalOf(control.stop.id);
        expect(
          idsOf(await attempt(context, skipSql(control.stop.id, release))),
          `${key} ${stopState}`,
        ).toEqual([control.stop.id]);
        expect(await arrivalOf(control.stop.id)).toEqual({
          state: 'SKIPPED',
          arrived_at: before?.arrived_at,
        });

        const refused = await fixture('DISPATCHED', stopState);
        const untouched = await arrivalOf(refused.stop.id);
        expect(
          codeOf(await attempt(context, skipSql(refused.stop.id, release + change))),
          `${key} ${stopState}${change}`,
        ).toBe('23514');
        expect(await arrivalOf(refused.stop.id)).toEqual(untouched);
      }
    },
  );
});

describe('the ledger takes the two events of these acts from the rider’s context', () => {
  interface Event {
    readonly code: string;
    readonly object: string;
    readonly actor_type?: string;
    readonly actor_id?: string;
    readonly surface_context?: string;
    readonly object_type?: string;
    readonly outcome?: string;
    readonly enhanced?: boolean;
    readonly responsible_hub_id?: string | null;
    readonly previous_state?: string | null;
    readonly resulting_state?: string | null;
    readonly related_ids?: Readonly<Record<string, string>> | null;
  }

  /** What an honest event of the act says: its object, the states it moved between, the hub of the object and the identifiers it relates. */
  const honest = (
    run: Fixture,
    code: 'pickup.manifest.started' | 'pickup.stop.arrived',
    rider: string = run.riderId,
  ): Event =>
    code === 'pickup.stop.arrived'
      ? {
          code,
          object: run.stop.id,
          previous_state: 'PENDING',
          resulting_state: 'ARRIVED',
          responsible_hub_id: run.stop.hubId,
          related_ids: {
            pickup_manifest_id: run.stop.manifestId,
            pickup_request_id: run.stop.requestId,
            rider_id: rider,
          },
        }
      : {
          code,
          object: run.manifest.id,
          previous_state: 'DISPATCHED',
          resulting_state: 'IN_PROGRESS',
          responsible_hub_id: run.manifest.hubId,
          related_ids: { rider_id: rider },
        };

  const insertEvent = (context: SecurityContext, event: Event): Promise<Result> => {
    const merged = {
      actor_type: 'RIDER',
      actor_id: context.principalId,
      surface_context: 'RIDER_ANDROID',
      object_type: event.code === 'pickup.stop.arrived' ? 'PickupStop' : 'PickupManifest',
      outcome: 'SUCCEEDED',
      enhanced: false,
      responsible_hub_id: null,
      previous_state: null,
      resulting_state: null,
      related_ids: null,
      ...event,
    };
    const text = (value: string | null): string => (value === null ? 'null' : `'${value}'`);
    const related =
      merged.related_ids === null ? 'null' : `'${JSON.stringify(merged.related_ids)}'::jsonb`;
    const hub =
      merged.responsible_hub_id === null ? 'null' : `'${merged.responsible_hub_id}'::uuid`;
    return attempt(
      context,
      `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type,
                               object_id, correlation_id, previous_state, resulting_state, related_ids, outcome, enhanced, serialisation_version)
       values (gen_random_uuid(), '${merged.code}', now(), '${merged.actor_type}', '${merged.actor_id}'::uuid,
               '${merged.surface_context}', ${hub}, '${merged.object_type}', '${merged.object}'::uuid,
               'pickup-run-policies', ${text(merged.previous_state)}, ${text(merged.resulting_state)}, ${related},
               '${merged.outcome}', ${String(merged.enhanced)}, 1)`,
    );
  };

  // Break caught: the rider's start and arrival unaudited (the act would commit with no record, or not commit), or the arm widened.
  it('takes pickup.manifest.started for the rider’s own run and pickup.stop.arrived for its own stop', async () => {
    const run = await fixture('IN_PROGRESS');
    const context = riderContext(run.riderId);
    for (const code of ['pickup.manifest.started', 'pickup.stop.arrived'] as const) {
      const event = honest(run, code);
      const taken = await insertEvent(context, event);
      expect(codeOf(taken), code).toBeUndefined();
      // The ledger shows a rider none of it, so what was taken is read from the administrator's connection.
      expect(
        await routes.rows(
          `select actor_type, responsible_hub_id, previous_state, resulting_state, related_ids
             from audit_event where event_code = $1 and object_id = $2`,
          [code, event.object],
        ),
        code,
      ).toEqual([
        {
          actor_type: 'RIDER',
          responsible_hub_id: event.responsible_hub_id,
          previous_state: event.previous_state,
          resulting_state: event.resulting_state,
          related_ids: event.related_ids,
        },
      ]);
    }
  });

  type Build = (own: Fixture, other: Fixture) => Event;

  // Break caught: a rider writing a fact about a colleague's run or stop, about another actor, from another surface, under another key, an
  // outcome it did not have, an enhanced event (whose failure would abort the act, which is not the rider's to decide), the wrong object.
  const aboutOthers: readonly (readonly [string, Build])[] = [
    ['another rider’s run', (own, other) => honest(other, 'pickup.manifest.started', own.riderId)],
    ['another rider’s stop', (own, other) => honest(other, 'pickup.stop.arrived', own.riderId)],
    [
      'another actor',
      (own) => ({ ...honest(own, 'pickup.manifest.started'), actor_id: randomUUID() }),
    ],
    [
      'the staff actor type',
      (own) => ({ ...honest(own, 'pickup.manifest.started'), actor_type: 'STAFF' }),
    ],
    [
      'another surface',
      (own) => ({ ...honest(own, 'pickup.manifest.started'), surface_context: 'OPS_PORTAL' }),
    ],
    [
      'a failed outcome',
      (own) => ({ ...honest(own, 'pickup.manifest.started'), outcome: 'REJECTED' }),
    ],
    ['an enhanced tier', (own) => ({ ...honest(own, 'pickup.manifest.started'), enhanced: true })],
    [
      'a run recorded as a stop',
      (own) => ({ ...honest(own, 'pickup.manifest.started'), object_type: 'PickupStop' }),
    ],
    [
      'a stop recorded as a run',
      (own) => ({ ...honest(own, 'pickup.stop.arrived'), object_type: 'PickupManifest' }),
    ],
  ];
  it.each(aboutOthers)('refuses an event about %s', async (_label, build) => {
    const own = await fixture('IN_PROGRESS');
    const other = await fixture('IN_PROGRESS');
    const result = await insertEvent(riderContext(own.riderId), build(own, other));
    expect(codeOf(result)).toBe('42501');
  });

  // Break caught (the review of 2 November 2026): a ledger row that is not the facts of the act, because the policy checked who wrote it and
  // about what and not what it says. Each differs from the honest event of the act in one fact: the hub whose Ops read the trail, the
  // states the act moved between, and the identifiers the event relates (the rider, and for a stop its run and its request).
  const wrongFacts: readonly (readonly [string, (own: Fixture) => Event])[] = [
    [
      'a run in another hub',
      (own: Fixture) => ({ ...honest(own, 'pickup.manifest.started'), responsible_hub_id: HUB_B }),
    ],
    [
      'a run in no hub',
      (own: Fixture) => ({ ...honest(own, 'pickup.manifest.started'), responsible_hub_id: null }),
    ],
    [
      'a stop in another hub',
      (own: Fixture) => ({ ...honest(own, 'pickup.stop.arrived'), responsible_hub_id: HUB_B }),
    ],
    [
      'a stop in no hub',
      (own: Fixture) => ({ ...honest(own, 'pickup.stop.arrived'), responsible_hub_id: null }),
    ],
    [
      'a start from a draft',
      (own: Fixture) => ({ ...honest(own, 'pickup.manifest.started'), previous_state: 'DRAFT' }),
    ],
    [
      'a start that completed the run',
      (own: Fixture) => ({
        ...honest(own, 'pickup.manifest.started'),
        resulting_state: 'COMPLETED',
      }),
    ],
    [
      'a start with no states',
      (own: Fixture) => ({
        ...honest(own, 'pickup.manifest.started'),
        previous_state: null,
        resulting_state: null,
      }),
    ],
    [
      'an arrival at a stop already arrived at',
      (own: Fixture) => ({ ...honest(own, 'pickup.stop.arrived'), previous_state: 'ARRIVED' }),
    ],
    [
      'an arrival that collected the stop',
      (own: Fixture) => ({ ...honest(own, 'pickup.stop.arrived'), resulting_state: 'COLLECTED' }),
    ],
    [
      'a start naming another rider',
      (own: Fixture) => ({
        ...honest(own, 'pickup.manifest.started'),
        related_ids: { rider_id: randomUUID() },
      }),
    ],
    [
      'a start relating nothing',
      (own: Fixture) => ({ ...honest(own, 'pickup.manifest.started'), related_ids: null }),
    ],
    [
      'a start relating one thing more',
      (own: Fixture) => ({
        ...honest(own, 'pickup.manifest.started'),
        related_ids: { rider_id: own.riderId, pickup_request_id: randomUUID() },
      }),
    ],
    [
      'an arrival naming another rider',
      (own: Fixture) => ({
        ...honest(own, 'pickup.stop.arrived'),
        related_ids: { ...honest(own, 'pickup.stop.arrived').related_ids, rider_id: randomUUID() },
      }),
    ],
    [
      'an arrival naming another run',
      (own: Fixture) => ({
        ...honest(own, 'pickup.stop.arrived'),
        related_ids: {
          ...honest(own, 'pickup.stop.arrived').related_ids,
          pickup_manifest_id: randomUUID(),
        },
      }),
    ],
    [
      'an arrival naming another request',
      (own: Fixture) => ({
        ...honest(own, 'pickup.stop.arrived'),
        related_ids: {
          ...honest(own, 'pickup.stop.arrived').related_ids,
          pickup_request_id: randomUUID(),
        },
      }),
    ],
    [
      'an arrival that does not name its request',
      (own: Fixture) => ({
        ...honest(own, 'pickup.stop.arrived'),
        related_ids: {
          pickup_manifest_id: own.stop.manifestId,
          rider_id: own.riderId,
        },
      }),
    ],
    [
      'an arrival relating one thing more',
      (own: Fixture) => ({
        ...honest(own, 'pickup.stop.arrived'),
        related_ids: { ...honest(own, 'pickup.stop.arrived').related_ids, extra: randomUUID() },
      }),
    ],
    [
      'an arrival relating nothing',
      (own: Fixture) => ({ ...honest(own, 'pickup.stop.arrived'), related_ids: null }),
    ],
  ];
  it.each(wrongFacts)('refuses an event with %s', async (_label, build) => {
    const own = await fixture('IN_PROGRESS');
    const result = await insertEvent(riderContext(own.riderId), build(own));
    expect(codeOf(result)).toBe('42501');
  });

  // Break caught: the arm widened to any event of the rider's own, or to a context that holds another key.
  it.each([
    'pickup.manifest.dispatched',
    'pickup.manifest.completed',
    'pickup.manifest.cancelled',
    'pickup.request.created',
    'pickup.request.cancelled',
    'pickup.stop.skipped',
    'staff.identity.created',
  ])('refuses %s', async (code) => {
    const run = await fixture('IN_PROGRESS');
    const result = await insertEvent(riderContext(run.riderId), {
      ...honest(run, 'pickup.manifest.started'),
      code,
    });
    expect(codeOf(result)).toBe('42501');
  });

  it('refuses the two events under a key that is not the act’s', async () => {
    const run = await fixture('IN_PROGRESS');
    const context = riderContext(run.riderId, 'pickup.read');
    for (const code of ['pickup.manifest.started', 'pickup.stop.arrived'] as const) {
      expect(codeOf(await insertEvent(context, honest(run, code))), code).toBe('42501');
    }
  });
});

/**
 * What the cancellation of a request is held to for **every** writer (S1.22 correction; the Product Owner's review of 2 November 2026, on
 * OB-S1-38): a rider's arrival judges the stop alone, and that is sound only because the database guarantees what the cancellation's
 * transaction does, however the statements are written. The request is cancelled and its stop skipped **together** (the office's
 * cancellation is immediate and atomic, and no step is asked of anyone first), so the rule is checked at the **end of the transaction**.
 */
describe('a cancelled request is never held by a stop that is still to be worked, whoever writes', () => {
  const CANCEL_REQUEST = `state = 'CANCELLED', cancelled_at = now(), cancelled_by = '5eed0000-0000-4000-8000-0000000000e1'`;
  const SKIP = `state = 'SKIPPED', resolved_at = now(), skip_snapshot = '{"reason_code":"REQUEST_CANCELLED","label":"Request cancelled","skipped_at":"2026-11-03T10:00:00Z"}'::jsonb`;
  const cancelRequestSql = (requestId: string) =>
    `update pickup_request set ${CANCEL_REQUEST} where id = '${requestId}'`;
  const skipStopSql = (stopId: string) => `update pickup_stop set ${SKIP} where id = '${stopId}'`;

  /** A transaction of its own on a connection of its own, ended by the test either way. */
  async function inTransaction(
    statements: readonly string[],
    ending: 'commit' | 'rollback' = 'commit',
  ): Promise<string | undefined> {
    const client = clientFor(routes.database.urlFor('postgres'));
    await client.connect();
    try {
      await client.query('begin');
      for (const text of statements) await client.query(text);
      await client.query(ending);
      return undefined;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      return serverErrorIn(error)?.code ?? 'other';
    } finally {
      await client.end();
    }
  }

  const requestStateOf = async (id: string) =>
    (
      await routes.rows<{ state: string }>(`select state from pickup_request where id = $1`, [id])
    )[0]?.state;

  // Break caught: a cancellation that leaves a stop to be worked behind (the request cancelled and the stop not touched), which a rider
  // would then arrive at; the database refuses the transaction **at its end**, for a stop not yet arrived at and for one that has been.
  it.each(['PENDING', 'ARRIVED'] as const)(
    'refuses at the end of the transaction a request cancelled with its %s stop left behind, and cancels nothing',
    async (stopState) => {
      const run = await fixture('IN_PROGRESS', stopState);
      expect(await inTransaction([cancelRequestSql(run.stop.requestId)])).toBe('23514');
      expect(await requestStateOf(run.stop.requestId)).toBe('CONFIRMED');
      expect(
        (await routes.rows(`select state from pickup_stop where id = $1`, [run.stop.id]))[0],
      ).toEqual({ state: stopState });
    },
  );

  // Break caught: the rule judged at each statement (which would refuse the legitimate cancellation, the request first and the stop
  // after) or not judged at all. Either order of the two statements is the one transaction, and the stop keeps what it held.
  it.each(['PENDING', 'ARRIVED'] as const)(
    'lets the request and its %s stop be changed together, in either order',
    async (stopState) => {
      for (const order of ['request first', 'stop first'] as const) {
        const run = await fixture('IN_PROGRESS', stopState);
        const statements = [cancelRequestSql(run.stop.requestId), skipStopSql(run.stop.id)];
        expect(
          await inTransaction(order === 'request first' ? statements : statements.toReversed()),
          order,
        ).toBeUndefined();
        expect(await requestStateOf(run.stop.requestId), order).toBe('CANCELLED');
        expect(
          (await routes.rows(`select state from pickup_stop where id = $1`, [run.stop.id]))[0],
          order,
        ).toEqual({ state: 'SKIPPED' });
      }
    },
  );

  // Break caught: a rule wider than the invariant: a request cancelled after its stop was worked (collected, failed, skipped), or one that no
  // stop holds, is an ordinary cancellation and is not refused.
  it.each(['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'] as const)(
    'does not refuse the cancellation of a request whose stop is %s',
    async (stopState) => {
      const run = await fixture('IN_PROGRESS', stopState);
      expect(await inTransaction([cancelRequestSql(run.stop.requestId)])).toBeUndefined();
      expect(await requestStateOf(run.stop.requestId)).toBe('CANCELLED');
    },
  );

  it('does not refuse the cancellation of a request that no stop holds', async () => {
    const free = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    expect(await inTransaction([cancelRequestSql(free.id)])).toBeUndefined();
    expect(await requestStateOf(free.id)).toBe('CANCELLED');
  });

  // Break caught: a rule that counts a stop that holds nothing: one that has released its claim no longer holds its request, so neither the
  // cancellation of that request nor the making of such a stop for a cancelled one is a stop left to be worked. (Its release and its skip are
  // one act, so such a row is arranged here as only the administrator can.)
  it('does not count a stop that has released its claim', async () => {
    const manifest = await insertManifest(routes.admin, manifestRow(HUB_A, { state: 'DRAFT' }));
    const held = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    const released = new Date('2026-11-03T10:00:00Z');
    await insertStop(routes.admin, stopRow(manifest, held.id, 1, { releasedAt: released }));
    expect(await inTransaction([cancelRequestSql(held.id)])).toBeUndefined();
    expect(await requestStateOf(held.id)).toBe('CANCELLED');

    const cancelled = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CANCELLED' }),
    );
    await expect(
      insertStop(routes.admin, stopRow(manifest, cancelled.id, 2, { releasedAt: released })),
    ).resolves.toBeDefined();
  });

  // Break caught: the other side of the same rule, which a writer of stops could break: a stop still to be worked made for a request that is
  // already cancelled (alone, or in the transaction that cancels the request).
  it('refuses at the end of the transaction a stop to be worked made for a cancelled request', async () => {
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DRAFT', assignedRiderId: null }),
    );
    const cancelled = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CANCELLED' }),
    );
    const made = stopRow(manifest, cancelled.id, 1);
    const insert = `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, state)
                    values ('${made.id}', '${manifest.id}', '${cancelled.id}', '${HUB_A}', 1, 'PENDING')`;
    expect(await inTransaction([insert])).toBe('23514');
    expect(await routes.rows(`select id from pickup_stop where id = $1`, [made.id])).toEqual([]);

    // Cancelled in the same transaction as the stop is made: the same refusal, and the same acceptance if the stop is skipped as well.
    const open = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    const second = stopRow(manifest, open.id, 2);
    const insertSecond = `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, state)
                          values ('${second.id}', '${manifest.id}', '${open.id}', '${HUB_A}', 2, 'PENDING')`;
    expect(await inTransaction([insertSecond, cancelRequestSql(open.id)])).toBe('23514');
    expect(
      await inTransaction([insertSecond, cancelRequestSql(open.id), skipStopSql(second.id)]),
    ).toBe(undefined);

    // The rule is about where the transaction leaves the two rows, in this order too: the request cancelled first, the stop made after it and
    // skipped before the end, is a consistent end.
    const late = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    const third = stopRow(manifest, late.id, 3);
    const insertThird = `insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, state)
                         values ('${third.id}', '${manifest.id}', '${late.id}', '${HUB_A}', 3, 'PENDING')`;
    expect(
      await inTransaction([cancelRequestSql(late.id), insertThird, skipStopSql(third.id)]),
    ).toBe(undefined);
  });

  // Break caught: the rule checked only for the writers a test thought of. The staff context that holds the key of the cancellation is the one
  // writer the application has, and it is held to the same transaction-end rule as the administrator, under the policies of both tables.
  it('holds the staff context of the cancellation to the same rule', async () => {
    const left = await fixture('IN_PROGRESS', 'PENDING');
    const context = staffContext('pickup.request.cancel');
    const cancelOnly = await routes.built.service
      .transactionWithContext(context, async (tx) => {
        await tx.execute(sql.raw(cancelRequestSql(left.stop.requestId)));
      })
      .then(
        () => undefined,
        (error: unknown) => serverErrorIn(error)?.code ?? 'other',
      );
    expect(cancelOnly).toBe('23514');
    expect(await requestStateOf(left.stop.requestId)).toBe('CONFIRMED');

    const whole = await fixture('IN_PROGRESS', 'ARRIVED');
    await routes.built.service.transactionWithContext(context, async (tx) => {
      await tx.execute(sql.raw(cancelRequestSql(whole.stop.requestId)));
      await tx.execute(sql.raw(skipStopSql(whole.stop.id)));
    });
    expect(await requestStateOf(whole.stop.requestId)).toBe('CANCELLED');
  });
});

/**
 * The stop the cancellation of a request skips is held to **the skip and nothing else** (S1.22 correction; the review of 2 November 2026):
 * the cancel key keeps the stop's place in the order, its claim on the request and the arrival the rider recorded. A grant is per login and
 * not per key, so what the key may write is the guard's to say.
 */
describe('the key of the cancellation of a request skips a stop and changes nothing else of it', () => {
  const key = 'pickup.request.cancel';
  const SNAPSHOT = `'{"reason_code":"REQUEST_CANCELLED","label":"Request cancelled","skipped_at":"2026-11-03T10:00:00Z"}'::jsonb`;
  const SKIP = `state = 'SKIPPED', resolved_at = now(), skip_snapshot = ${SNAPSHOT}`;
  const stopOf = async (id: string) =>
    (
      await routes.rows(
        `select state, sequence, released_at, arrived_at, resolved_at, skip_snapshot, pickup_summary from pickup_stop where id = $1`,
        [id],
      )
    )[0];

  // Break caught: the grant of `sequence` and `released_at` (migration 0060, made to the login and not to a key) reaching this key: a
  // cancellation that moves the stop to another place in the order, or releases its claim so that the cancelled request could be planned again.
  it.each([
    ['moves the stop to another place', `${SKIP}, sequence = 9`, ['PENDING', 'ARRIVED']],
    ['releases its claim', `${SKIP}, released_at = now()`, ['PENDING', 'ARRIVED']],
    ['writes an arrival', `${SKIP}, arrived_at = now()`, ['PENDING', 'ARRIVED']],
    // A stop that was never arrived at has no arrival to take away, so this statement changes nothing about it and is the skip.
    ['takes the arrival away', `${SKIP}, arrived_at = null`, ['ARRIVED']],
  ] as const)('refuses a skip that %s', async (_label, set, stopStates) => {
    for (const stopState of stopStates) {
      const run = await fixture('DISPATCHED', stopState);
      const before = await stopOf(run.stop.id);
      const result = await attempt(
        staffContext(key),
        `update pickup_stop set ${set} where id = '${run.stop.id}' returning id`,
      );
      expect(codeOf(result), `${stopState}: ${set}`).toBe('23514');
      expect(await stopOf(run.stop.id)).toEqual(before);
    }
  });

  // Break caught: a key that does something other than skip: any other state, a change that leaves the stop to be worked, or a skip with no
  // moment or no reason (a resolved stop whose reason and moment are missing is not the system's skip).
  it.each([
    ['arrives at the stop', `state = 'ARRIVED', arrived_at = now()`],
    ['collects the stop', `state = 'COLLECTED', arrived_at = now(), resolved_at = now()`],
    ['writes a moment of resolution and no skip', `resolved_at = now()`],
    ['writes a reason and no skip', `skip_snapshot = ${SNAPSHOT}`],
    ['skips with no moment', `state = 'SKIPPED', skip_snapshot = ${SNAPSHOT}`],
    ['skips with no reason', `state = 'SKIPPED', resolved_at = now()`],
    [
      'skips for another reason than the cancellation',
      `state = 'SKIPPED', resolved_at = now(), skip_snapshot = '{"reason_code":"ROAD","skipped_at":"2026-11-03T10:00:00Z"}'::jsonb`,
    ],
  ] as const)('refuses a statement that %s', async (_label, set) => {
    const run = await fixture('DISPATCHED', 'PENDING');
    const before = await stopOf(run.stop.id);
    const result = await attempt(
      staffContext(key),
      `update pickup_stop set ${set} where id = '${run.stop.id}' returning id`,
    );
    // The guard answers first where the statement is its to refuse; the policy's check answers a state it does not admit.
    expect(['23514', '42501']).toContain(codeOf(result));
    expect(await stopOf(run.stop.id)).toEqual(before);
  });

  // The control of the two tests above: the skip itself, for a stop not yet arrived at and for one that has been, writes exactly the state,
  // the moment and the reason; the order, the claim, the arrival and the summary are as they were.
  it.each(['PENDING', 'ARRIVED'] as const)(
    'writes the skip of a %s stop and keeps everything else',
    async (stopState) => {
      const run = await fixture('DISPATCHED', stopState);
      const before = await stopOf(run.stop.id);
      const result = await attempt(
        staffContext(key),
        `update pickup_stop set ${SKIP} where id = '${run.stop.id}' returning id`,
      );
      expect(idsOf(result)).toEqual([run.stop.id]);
      const after = await stopOf(run.stop.id);
      expect(after).toMatchObject({
        state: 'SKIPPED',
        sequence: before?.sequence,
        released_at: before?.released_at,
        arrived_at: before?.arrived_at,
        pickup_summary: before?.pickup_summary,
      });
      expect(after?.resolved_at).not.toBeNull();
      expect(after?.skip_snapshot).toMatchObject({ reason_code: 'REQUEST_CANCELLED' });
    },
  );

  // Break caught: the key reaching a stop that is no longer to be worked (resolved stops are frozen), and a stop of another hub.
  it('reaches no stop that is resolved, and no stop of a hub outside its grant', async () => {
    for (const resolved of ['COLLECTED', 'FAILED', 'SKIPPED'] as const) {
      const run = await fixture('IN_PROGRESS', resolved);
      expect(
        idsOf(
          await attempt(
            staffContext(key),
            `update pickup_stop set ${SKIP} where id = '${run.stop.id}' returning id`,
          ),
        ),
      ).toEqual([]);
    }
    const run = await fixture('DISPATCHED', 'PENDING');
    const outside: SecurityContext = {
      ...staffContext(key),
      hubScopeMode: 'SET',
      authorizedHubIds: [HUB_B],
    };
    expect(
      idsOf(
        await attempt(
          outside,
          `update pickup_stop set ${SKIP} where id = '${run.stop.id}' returning id`,
        ),
      ),
    ).toEqual([]);
  });
});

/**
 * A run is completed only when none of its stops is still to be worked, and started only while one is (S1.22 correction): the first
 * move to `COMPLETED` is written by a later task, and the rule it must keep is already the database's; `arriveAtPickupStop` reads its run
 * unlocked and is correct only because a run in progress cannot leave that state while one of its stops is still to be worked.
 */
describe('a run is completed only with nothing left to work, and started only with something to work', () => {
  const completeSql = (id: string) =>
    `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = '${id}'`;

  // Break caught: a run completed while a stop is still to be worked (pending or arrived at), by any writer.
  it.each(['PENDING', 'ARRIVED'] as const)(
    'refuses the completion of a run that has a %s stop',
    async (stopState) => {
      const run = await fixture('IN_PROGRESS', stopState);
      // The administrator is subject to no policy, so what refuses it is the guard, which holds for every writer.
      const direct = await routes.admin.query(completeSql(run.manifest.id)).then(
        () => 'completed',
        (error: unknown) => serverErrorIn(error)?.code ?? 'other',
      );
      expect(direct).toBe('23514');
      expect(
        (
          await routes.rows(`select state from pickup_manifest where id = $1`, [run.manifest.id])
        )[0],
      ).toEqual({ state: 'IN_PROGRESS' });
    },
  );

  // Break caught: a rule that refuses every completion, or that counts the stops it should not: a run all of whose stops are resolved (any
  // of the four), and a run with a pending stop of ANOTHER run, are completed.
  it.each(['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'] as const)(
    'completes a run whose only stop is %s',
    async (stopState) => {
      const run = await fixture('IN_PROGRESS', stopState);
      const other = await fixture('IN_PROGRESS', 'PENDING');
      await routes.admin.query(completeSql(run.manifest.id));
      expect(
        (
          await routes.rows(`select state from pickup_manifest where id = $1`, [run.manifest.id])
        )[0],
      ).toEqual({ state: 'COMPLETED' });
      expect(
        (
          await routes.rows(`select state from pickup_manifest where id = $1`, [other.manifest.id])
        )[0],
      ).toEqual({ state: 'IN_PROGRESS' });
    },
  );

  // Break caught: the rider's key starting a run with nothing to work (the application refuses it first; this is the database's own hold for
  // every writer): every stop skipped, resolved or none at all.
  it('refuses the start of a run that has no stop to be worked, as the rider’s key', async () => {
    const skipped = await fixture('DISPATCHED', 'SKIPPED');
    const collected = await fixture('DISPATCHED', 'COLLECTED');
    for (const run of [skipped, collected]) {
      expect(codeOf(await attempt(riderContext(run.riderId), startSql(run.manifest.id)))).toBe(
        '23514',
      );
      expect(
        (
          await routes.rows(`select state from pickup_manifest where id = $1`, [run.manifest.id])
        )[0],
      ).toEqual({ state: 'DISPATCHED' });
    }
    // The same run with a stop to be worked starts (the control, and the other stop's state does not matter).
    const mixed = await fixture('DISPATCHED', 'PENDING');
    expect(idsOf(await attempt(riderContext(mixed.riderId), startSql(mixed.manifest.id)))).toEqual([
      mixed.manifest.id,
    ]);
  });
});
