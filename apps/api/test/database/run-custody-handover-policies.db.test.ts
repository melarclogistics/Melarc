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
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.24: what the database holds for **every** writer of the custody of a run (`AC-SLICE-001-67` and `-68`; migration `0067`):
 *
 * - **Opening** is the act of the key that opens one, by staff in a hub of the grant, on a run in progress, from the rider who holds the custody,
 *   to another active rider of the hub or to the hub, in the name of the officer who opens it. **Accepting** is the named receiver's under its key
 *   (or the office's, where the hub is the destination) and writes the state, the count, the receiver and the moment and nothing else; **failing**
 *   is the office's and writes the state, the note, the officer and the moment. A resolved handover is frozen, and the two parties, the
 *   destination and the note are never changed.
 * - **One open handover per run**, one destination, the hub the run's own, never to the rider handing over, notes that are text.
 * - **A rider reads the handovers it is a party to** and nothing else; staff those of their hubs; a vendor none.
 * - **A run with a handover pending is not completed by anyone**, and the receiver is shown the run only under the accepting key and only for its
 *   own handover.
 * - **The ledger** takes the receiver's two events with the facts of the act, and nothing the rows do not say.
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

const INITIATE = 'fleet.custody.initiate';
const ACCEPT = 'fleet.custody.accept';

const staff = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'run-custody-handover-policies',
});

const rider = (riderId: string, key: string): SecurityContext => ({
  principalType: 'RIDER',
  principalId: riderId,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId,
  authorizationKey: key,
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'run-custody-handover-policies',
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
  readonly senderId: string;
  readonly receiverId: string;
  readonly manifest: ManifestRow;
  readonly stops: StopRow[];
}

/** A run of hub A in the state given, held by its assigned rider, with a stop in each state given (a summary with each, as a dispatched run has). */
async function run(
  state: ManifestState = 'IN_PROGRESS',
  stopStates: readonly StopState[] = ['PENDING'],
): Promise<Fixture> {
  const senderId = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
  const receiverId = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, { state, assignedRiderId: senderId }),
  );
  const stops: StopRow[] = [];
  for (const [at, stopState] of stopStates.entries()) {
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, HUB_A, { state: 'CONFIRMED' }),
    );
    stops.push(
      await insertStop(
        routes.admin,
        stopRow(manifest, request.id, at + 1, {
          state: stopState,
          ...(state === 'DRAFT'
            ? {}
            : {
                pickupSummary: {
                  reference: request.code,
                  sender_display_name: 'Fixture Sender',
                  declared_package_count: 1,
                  resolved_pickup_location: { address: 'Fixture shop' },
                  location_note: null,
                  contact_phone: null,
                },
              }),
        }),
      ),
    );
  }
  return { senderId, receiverId, manifest, stops };
}

interface Pending extends Fixture {
  readonly id: string;
}

/** A run with a handover pending on it (to the receiver, or to the hub), arranged by the administrator through the guard, as the route leaves one. */
async function pending(
  to: 'RIDER' | 'HUB' = 'RIDER',
  stopStates: readonly StopState[] = ['PENDING'],
): Promise<Pending> {
  const fixture = await run('IN_PROGRESS', stopStates);
  const made = await routes.admin.query<{ id: string }>(
    `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, to_hub_id, initiation_note, initiated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Fixture handover', gen_random_uuid()) returning id`,
    [
      fixture.manifest.id,
      HUB_A,
      fixture.senderId,
      to === 'RIDER' ? fixture.receiverId : null,
      to === 'HUB' ? HUB_A : null,
    ],
  );
  return { ...fixture, id: made.rows[0]?.id ?? '' };
}

const row = async (id: string) =>
  (
    await routes.rows<{ state: string; version: number; parcel_count_taken: number | null }>(
      `select state, version, parcel_count_taken from run_custody_handover where id = $1`,
      [id],
    )
  )[0];

const manifestState = async (id: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [id]))[0]
    ?.state;

const insertHandoverSql = (
  fixture: Fixture,
  over: Partial<{
    from: string;
    toRider: string | null;
    toHub: string | null;
    note: string;
    by: string;
    state: string;
    manifest: string;
    hub: string;
  }>,
  actor: string,
) => {
  const text = (value: string | null): string => (value === null ? 'null' : `'${value}'::uuid`);
  return `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, to_hub_id, initiation_note, initiated_by, state)
     values (gen_random_uuid(), '${over.manifest ?? fixture.manifest.id}', '${over.hub ?? HUB_A}', '${over.from ?? fixture.senderId}',
             ${text(over.toRider === undefined ? fixture.receiverId : over.toRider)}, ${text(over.toHub ?? null)},
             '${over.note ?? 'Fixture handover'}', '${over.by ?? actor}', '${over.state ?? 'PENDING'}') returning id`;
};

describe('opening a handover, as the database holds it for every writer', () => {
  // Break caught: a policy that does not admit the officer's key in a hub of its grant, or admits another key, a rider, another hub or a state
  // other than pending.
  it('admits the opening key in a hub of the grant, and nobody else', async () => {
    const fixture = await run();
    const officer = staff(INITIATE, [HUB_A]);
    for (const hidden of [
      staff('fleet.custody.accept'),
      staff('fleet.custody.read'),
      staff('pickup.manifest.create'),
      staff(INITIATE, [HUB_B]),
      rider(fixture.senderId, INITIATE),
      rider(fixture.receiverId, ACCEPT),
    ]) {
      const result = await attempt(hidden, insertHandoverSql(fixture, {}, hidden.principalId));
      // Refused by the policy's check or by the guard, which reads the run and the rider as the caller's own context sees them and runs first:
      // either way nothing is written.
      expect(['42501', '23514'], hidden.authorizationKey).toContain(codeOf(result));
    }
    expect(
      await routes.rows(`select 1 from run_custody_handover where manifest_id = $1`, [
        fixture.manifest.id,
      ]),
    ).toEqual([]);
    expect(
      idsOf(await attempt(officer, insertHandoverSql(fixture, {}, officer.principalId))),
    ).toHaveLength(1);
  });

  // Break caught: a handover opened on a run that is not in progress, from a rider who does not hold the custody, to a rider who is not active or
  // of the hub, in the name of someone else, or already resolved.
  it.each([
    ['a run that is a draft', async () => run('DRAFT'), {}],
    ['a run that is dispatched', async () => run('DISPATCHED'), {}],
    ['a run that is completed', async () => run('COMPLETED', ['SKIPPED']), {}],
    ['a rider who does not hold the custody', async () => run(), { from: 'RECEIVER' }],
    ['a rider who is suspended', async () => run(), { toRider: 'SUSPENDED' }],
    ['a rider of another hub', async () => run(), { toRider: 'OTHER_HUB' }],
    ['the name of another officer', async () => run(), { by: randomUUID() }],
  ] as const)('refuses an opening on %s', async (_what, arrange, over) => {
    const fixture = await arrange();
    const officer = staff(INITIATE, [HUB_A]);
    const resolved: Record<string, string | null | undefined> = { ...over };
    // A third rider who does not hold the custody and is not the destination: the rule that the origin holds the custody is the one that refuses it.
    if ('from' in over) {
      resolved.from = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    }
    if ('toRider' in over && over.toRider === 'SUSPENDED') {
      resolved.toRider = (
        await insertRider(routes.admin, riderRow({ hubId: HUB_A, status: 'SUSPENDED' }))
      ).id;
    }
    if ('toRider' in over && over.toRider === 'OTHER_HUB') {
      resolved.toRider = (await insertRider(routes.admin, riderRow({ hubId: HUB_B }))).id;
    }
    const result = await attempt(
      officer,
      insertHandoverSql(fixture, resolved, officer.principalId),
    );
    expect(codeOf(result)).toBe('23514');
    expect(
      await routes.rows(`select 1 from run_custody_handover where manifest_id = $1`, [
        fixture.manifest.id,
      ]),
    ).toEqual([]);
  });

  it('refuses a handover that is not pending when opened', async () => {
    const fixture = await run();
    const officer = staff(INITIATE, [HUB_A]);
    const result = await attempt(
      officer,
      insertHandoverSql(fixture, { state: 'COMPLETED' }, officer.principalId),
    );
    expect(['42501', '23514']).toContain(codeOf(result));
  });

  // Break caught: the table's own rules for every writer, the administrator included: both destinations or neither, a hub that is not the run's, a
  // handover to the rider handing over, a blank or an over-long note, a second open handover on a run.
  it.each([
    ['both destinations', { toHub: HUB_A }, '23514'],
    ['no destination', { toRider: null }, '23514'],
    ['a hub that is not the run’s', { toRider: null, toHub: HUB_B }, '23514'],
    ['the rider handing over as the destination', { toRider: 'SENDER' }, '23514'],
    ['a blank note', { note: '   ' }, '23514'],
    ['a note over a thousand characters', { note: 'x'.repeat(1001) }, '23514'],
  ] as const)('refuses %s', async (_what, over, code) => {
    const fixture = await run();
    const resolved =
      'toRider' in over && over.toRider === 'SENDER'
        ? { ...over, toRider: fixture.senderId }
        : over;
    const result = await routes.admin
      .query(insertHandoverSql(fixture, resolved as never, randomUUID()))
      .then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(result).toBe(code);
  });

  it('keeps one open handover per run', async () => {
    const open = await pending();
    const again = await routes.admin.query(insertHandoverSql(open, {}, randomUUID())).then(
      () => 'accepted',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(again).toBe('23505');
  });
});

describe('resolving a handover, as the database holds it for every writer', () => {
  const acceptSql = (id: string, by: string, count = 3, extra = '') =>
    `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = ${String(count)}, accepted_by = '${by}', resolved_at = now()${extra} where id = '${id}' returning id`;
  const failSql = (id: string, by: string, note = 'Did not arrive', extra = '') =>
    `update run_custody_handover set state = 'FAILED', failure_note = '${note}', failed_by = '${by}', resolved_at = now()${extra} where id = '${id}' returning id`;

  // Break caught: a policy that lets someone other than the named receiver accept, the sender among them, or lets a rider reach a handover under
  // a key that is not the accepting one.
  it('admits the acceptance by the named receiver under its key, and nobody else', async () => {
    const open = await pending();
    const stranger = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    for (const hidden of [
      rider(open.senderId, ACCEPT),
      rider(stranger, ACCEPT),
      rider(open.receiverId, 'fleet.custody.read'),
      rider(open.receiverId, 'pickup.run.execute'),
      staff(INITIATE),
      staff(ACCEPT, [HUB_B]),
    ]) {
      const result = await attempt(hidden, acceptSql(open.id, hidden.principalId));
      expect(idsOf(result), `${hidden.principalType} ${hidden.authorizationKey ?? ''}`).toEqual([]);
    }
    expect((await row(open.id))?.state).toBe('PENDING');
    const receiver = rider(open.receiverId, ACCEPT);
    expect(idsOf(await attempt(receiver, acceptSql(open.id, receiver.principalId, 5)))).toEqual([
      open.id,
    ]);
    expect(await row(open.id)).toMatchObject({ state: 'COMPLETED', parcel_count_taken: 5 });
  });

  // Break caught: the office accepting a handover to a rider (the receiver's act), or not able to accept the hub's.
  it('admits the office to accept a handover to the hub only', async () => {
    const toRiderHandover = await pending('RIDER');
    const toHubHandover = await pending('HUB');
    const officer = staff(ACCEPT, [HUB_A]);
    // The guard, which runs before the policy's check, names the rule; the check holds it as well.
    expect(codeOf(await attempt(officer, acceptSql(toRiderHandover.id, officer.principalId)))).toBe(
      '23514',
    );
    expect((await row(toRiderHandover.id))?.state).toBe('PENDING');
    expect(idsOf(await attempt(officer, acceptSql(toHubHandover.id, officer.principalId)))).toEqual(
      [toHubHandover.id],
    );
  });

  // Break caught: an acceptance that writes more than its four columns, in another name, or that fails the handover under the accepting key.
  it.each([
    [
      'another column with it',
      (open: Pending, by: string) => acceptSql(open.id, by, 3, `, failure_note = 'x'`),
      '23514',
    ],
    ['in another name', (open: Pending) => acceptSql(open.id, randomUUID()), '23514'],
    [
      'a failure under the accepting key',
      (open: Pending, by: string) => failSql(open.id, by),
      '23514',
    ],
    ['a count below nothing', (open: Pending, by: string) => acceptSql(open.id, by, -1), '23514'],
  ] as const)('refuses an acceptance with %s', async (_what, build, code) => {
    const open = await pending();
    const receiver = rider(open.receiverId, ACCEPT);
    const result = await attempt(receiver, build(open, receiver.principalId));
    expect(codeOf(result)).toBe(code);
    expect((await row(open.id))?.state).toBe('PENDING');
  });

  // Break caught: a failure by a rider, under the wrong key or in another name, with a blank note, or one that writes the count of an acceptance.
  it('admits the failure by the office under the opening key and nothing else', async () => {
    const open = await pending();
    const officer = staff(INITIATE, [HUB_A]);
    const receiver = rider(open.receiverId, ACCEPT);
    expect(idsOf(await attempt(receiver, failSql(open.id, receiver.principalId)))).toEqual([]);
    expect(idsOf(await attempt(staff(ACCEPT), failSql(open.id, randomUUID())))).toEqual([]);
    expect(idsOf(await attempt(staff(INITIATE, [HUB_B]), failSql(open.id, randomUUID())))).toEqual(
      [],
    );
    expect(codeOf(await attempt(officer, failSql(open.id, randomUUID())))).toBe('23514');
    expect(codeOf(await attempt(officer, failSql(open.id, officer.principalId, '   ')))).toBe(
      '23514',
    );
    expect(
      codeOf(
        await attempt(
          officer,
          `update run_custody_handover set state = 'FAILED', failure_note = 'x', failed_by = '${officer.principalId}', resolved_at = now(), parcel_count_taken = 3 where id = '${open.id}'`,
        ),
      ),
    ).toBe('23514');
    expect((await row(open.id))?.state).toBe('PENDING');
    expect(idsOf(await attempt(officer, failSql(open.id, officer.principalId)))).toEqual([open.id]);
  });

  // Break caught: a resolved handover changed again (an accepted one failed, a failed one accepted), or a column that names the parties, the
  // destination or the note changed, by anyone the runtime grants it to or by the administrator.
  it('freezes a resolved handover, and never changes its parties, destination or note', async () => {
    const accepted = await pending();
    const receiver = rider(accepted.receiverId, ACCEPT);
    expect(idsOf(await attempt(receiver, acceptSql(accepted.id, receiver.principalId)))).toEqual([
      accepted.id,
    ]);
    const officer = staff(INITIATE, [HUB_A]);
    expect(codeOf(await attempt(officer, failSql(accepted.id, officer.principalId)))).toBe('23514');
    const direct = await routes.admin
      .query(`update run_custody_handover set parcel_count_taken = 9 where id = $1`, [accepted.id])
      .then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(direct).toBe('23514');

    // A resolution that also changes what a handover keeps for good is refused whoever writes it: the change of the note is not the acceptance's.
    const resolving = await pending();
    const changedNote = await routes.admin
      .query(
        `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 1, accepted_by = gen_random_uuid(), resolved_at = now(),
                initiation_note = 'A different note' where id = $1`,
        [resolving.id],
      )
      .then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(changedNote).toBe('23514');
    expect((await row(resolving.id))?.state).toBe('PENDING');

    const open = await pending();
    for (const column of [
      `to_rider_id = '${open.senderId}'`,
      `from_rider_id = '${open.receiverId}'`,
      `initiation_note = 'Another note'`,
      `to_hub_id = '${HUB_A}'`,
      `initiated_by = gen_random_uuid()`,
      `manifest_id = gen_random_uuid()`,
    ]) {
      // The runtime login holds no grant on these columns at all; the administrator is stopped by the guard.
      expect(
        codeOf(
          await attempt(
            staff(INITIATE),
            `update run_custody_handover set ${column} where id = '${open.id}'`,
          ),
        ),
        column,
      ).toBe('42501');
      const viaAdmin = await routes.admin
        .query(`update run_custody_handover set ${column} where id = $1`, [open.id])
        .then(
          () => 'accepted',
          (error: unknown) => (error as { code?: string }).code,
        );
      expect(['23514', '23503'], column).toContain(viaAdmin);
    }
    expect((await row(open.id))?.state).toBe('PENDING');
  });
});

describe('the notification worker and the custody table', () => {
  // Break caught: a policy of the run that calls a function the worker may not execute, which would make every text about a run fail in the planner
  // (the first form of this migration did, for a table), or a privilege on the custody table the worker has no use for.
  it('may execute the helper the policies of the run call, and holds no privilege on the custody table', async () => {
    const worker = 'melarc_worker_cap_notification';
    const privilege = async (column: string) =>
      (
        await routes.rows<{ ok: boolean }>(
          `select has_column_privilege('${worker}', 'run_custody_handover', $1, 'SELECT') as ok`,
          [column],
        )
      )[0]?.ok;
    for (const column of [
      'id',
      'manifest_id',
      'to_rider_id',
      'state',
      'from_rider_id',
      'initiation_note',
      'parcel_count_taken',
    ]) {
      expect(await privilege(column), column).toBe(false);
    }
    const table = await routes.rows<{ select: boolean; insert: boolean; update: boolean }>(
      `select has_table_privilege('${worker}', 'run_custody_handover', 'SELECT') as select,
              has_table_privilege('${worker}', 'run_custody_handover', 'INSERT') as insert,
              has_table_privilege('${worker}', 'run_custody_handover', 'UPDATE') as update`,
    );
    expect(table[0]).toEqual({ select: false, insert: false, update: false });
    const execute = (role: string) =>
      routes
        .rows<{ ok: boolean }>(
          `select has_function_privilege('${role}', 'melarc.receiver_stands(uuid)', 'EXECUTE') as ok`,
        )
        .then((rows) => rows[0]?.ok);
    expect(await execute(worker)).toBe(true);
    expect(await execute('melarc_api_runtime')).toBe(true);
    expect(await execute('melarc_provisioning')).toBe(false);
    expect(await execute('public')).toBe(false);
  });
});

describe('the receiver is whoever a handover is pending to, or holds the custody now (melarc.receiver_stands)', () => {
  const stands = async (
    context: SecurityContext,
    manifestId: string,
  ): Promise<boolean | undefined> => {
    const result = await attempt(
      context,
      `select melarc.receiver_stands('${manifestId}') as stands`,
    );
    return 'rows' in result
      ? (result.rows[0] as { stands: boolean } | undefined)?.stands
      : undefined;
  };
  const resolve = (id: string, to: string) =>
    routes.admin.query(
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 1, accepted_by = $2, resolved_at = clock_timestamp() where id = $1`,
      [id, to],
    );
  /** Opens a handover from the current holder to a rider, as the administrator through the guard. */
  const open = async (fixture: Fixture, holder: string, to: string): Promise<string> =>
    (
      await routes.admin.query<{ id: string }>(
        `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
         values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', gen_random_uuid()) returning id`,
        [fixture.manifest.id, HUB_A, holder, to],
      )
    ).rows[0]?.id ?? '';
  const fail = (id: string) =>
    routes.admin.query(
      `update run_custody_handover set state = 'FAILED', failure_note = 'Did not arrive', failed_by = gen_random_uuid(), resolved_at = now() where id = $1`,
      [id],
    );

  // Break caught: a receiver who is not told apart from the sender or a stranger, or from a run that is not the handover's.
  it('is true while a handover to the rider is pending, and for nobody else', async () => {
    const toReceiver = await pending();
    const stranger = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    const id = toReceiver.manifest.id;
    expect(await stands(rider(toReceiver.receiverId, ACCEPT), id)).toBe(true);
    expect(await stands(rider(toReceiver.senderId, ACCEPT), id)).toBe(false);
    expect(await stands(rider(stranger, ACCEPT), id)).toBe(false);
    expect(await stands(rider(toReceiver.receiverId, ACCEPT), (await run()).manifest.id)).toBe(
      false,
    );
  });

  // Break caught: a rider who handed custody on still standing, which would leave it row-level read of a run it no longer holds, under the accepting
  // key, for as long as the rows exist.
  it('is true for the rider that holds the custody after an acceptance, and false once it has handed it on', async () => {
    const first = await pending();
    const third = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    await resolve(first.id, first.receiverId);
    const id = first.manifest.id;
    expect(await stands(rider(first.receiverId, ACCEPT), id)).toBe(true);
    // The sender gave custody away and does not stand for it.
    expect(await stands(rider(first.senderId, ACCEPT), id)).toBe(false);

    // The receiver hands it on: while that is pending both stand (the one that holds it and the one named); once it is accepted only the new one.
    const second = await open(first, first.receiverId, third);
    expect(await stands(rider(first.receiverId, ACCEPT), id)).toBe(true);
    expect(await stands(rider(third, ACCEPT), id)).toBe(true);
    await resolve(second, third);
    expect(await stands(rider(third, ACCEPT), id)).toBe(true);
    expect(await stands(rider(first.receiverId, ACCEPT), id)).toBe(false);
  });

  // Break caught: a handover that failed treated as custody, or a failed one after an acceptance taking the custody away from the one that holds it.
  it('is not made true by a handover that failed, and a failed one does not take the custody away', async () => {
    const failed = await pending();
    await fail(failed.id);
    expect(await stands(rider(failed.receiverId, ACCEPT), failed.manifest.id)).toBe(false);

    const held = await pending();
    await resolve(held.id, held.receiverId);
    const other = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    await fail(await open(held, held.receiverId, other));
    expect(await stands(rider(held.receiverId, ACCEPT), held.manifest.id)).toBe(true);
    expect(await stands(rider(other, ACCEPT), held.manifest.id)).toBe(false);
  });

  // Break caught: a rider who handed custody on still shown the run and its stops, or let complete it, under the accepting key (the review of
  // 2 November 2026); and a key that is not the accepting one reaching them.
  it('shows a rider who handed custody on nothing of the run, and lets it complete nothing', async () => {
    const first = await pending('RIDER', ['SKIPPED']);
    const third = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    await resolve(first.id, first.receiverId);
    await resolve(await open(first, first.receiverId, third), third);
    const manifestRead = `select id from pickup_manifest where id = '${first.manifest.id}'`;
    const stopRead = `select id from pickup_stop where pickup_manifest_id = '${first.manifest.id}'`;
    const complete = `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = '${first.manifest.id}' returning id`;
    // The one that handed it on: nothing, and no completion.
    const gone = rider(first.receiverId, ACCEPT);
    expect(idsOf(await attempt(gone, manifestRead))).toEqual([]);
    expect(idsOf(await attempt(gone, stopRead))).toEqual([]);
    expect(idsOf(await attempt(gone, complete))).toEqual([]);
    expect((await manifestState(first.manifest.id)) ?? '').toBe('IN_PROGRESS');
    // The one that holds it: the run and its stops.
    const holds = rider(third, ACCEPT);
    expect(idsOf(await attempt(holds, manifestRead))).toEqual([first.manifest.id]);
    expect(idsOf(await attempt(holds, stopRead))).toEqual(first.stops.map((each) => each.id));
    // Not through a key that is not the accepting one.
    expect(idsOf(await attempt(rider(third, 'fleet.custody.read'), manifestRead))).toEqual([]);
  });
});

describe('who reads a handover, and who holds the custody', () => {
  // Break caught: a rider who reads a handover it is not a party to, or none it is; a staff reader of another hub; a vendor; or a key that is not
  // a custody key (the keys that read pickups) reading the table.
  it('shows a rider the handovers it is a party to, and staff those of the hubs of their grant', async () => {
    const open = await pending();
    const stranger = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    const read = `select id from run_custody_handover where id = '${open.id}'`;
    for (const visible of [
      rider(open.senderId, 'fleet.custody.read'),
      rider(open.receiverId, 'fleet.custody.read'),
      rider(open.receiverId, ACCEPT),
      staff('fleet.custody.read', [HUB_A]),
      staff('fleet.custody.read'),
      staff(INITIATE, [HUB_A]),
      // The keys that complete a run read the handovers of the run, so that a run is never completed over a pending one.
      staff('pickup.stop.skip', [HUB_A]),
      staff('pickup.request.cancel', [HUB_A]),
    ]) {
      expect(
        idsOf(await attempt(visible, read)),
        `${visible.principalType} ${visible.authorizationKey ?? ''}`,
      ).toEqual([open.id]);
    }
    for (const hidden of [
      rider(stranger, 'fleet.custody.read'),
      rider(open.senderId, 'pickup.read'),
      staff('fleet.custody.read', [HUB_B]),
      staff('pickup.read', [HUB_A]),
      staff('pickup.manifest.create', [HUB_A]),
    ]) {
      expect(
        idsOf(await attempt(hidden, read)),
        `${hidden.principalType} ${hidden.authorizationKey ?? ''}`,
      ).toEqual([]);
    }
    const vendorContext: SecurityContext = {
      principalType: 'VENDOR',
      principalId: randomUUID(),
      sessionId: randomUUID(),
      surface: 'VENDOR_PWA',
      vendorOrganizationId: organisation,
      authorizationKey: 'fleet.custody.read',
      hubScopeMode: 'SET',
      authorizedHubIds: [HUB_A],
      correlationId: 'run-custody-handover-policies',
    };
    expect(idsOf(await attempt(vendorContext, read))).toEqual([]);
  });

  // Break caught: a holder that is the run's rider after a transfer, or the wrong receiver after two, or a rider after the hub took it.
  it('reads the holder from the chain of completed handovers', async () => {
    const open = await pending();
    const holder = (id: string) =>
      routes
        .rows<{ holder: string | null }>(`select melarc.run_custody_holder($1) as holder`, [id])
        .then((r) => r[0]?.holder);
    expect(await holder(open.manifest.id)).toBe(open.senderId);
    const receiver = rider(open.receiverId, ACCEPT);
    await attempt(
      receiver,
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 1, accepted_by = '${receiver.principalId}', resolved_at = now() where id = '${open.id}'`,
    );
    expect(await holder(open.manifest.id)).toBe(open.receiverId);
    // A later handover to the hub, accepted by the office, leaves no rider holding it.
    const second = await routes.admin.query<{ id: string }>(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_hub_id, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $2, 'To the hub', gen_random_uuid()) returning id`,
      [open.manifest.id, HUB_A, open.receiverId],
    );
    const officer = staff(ACCEPT, [HUB_A]);
    await attempt(
      officer,
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 2, accepted_by = '${officer.principalId}', resolved_at = now() where id = '${second.rows[0]?.id ?? ''}'`,
    );
    expect(await holder(open.manifest.id)).toBeNull();
  });
});

describe('a run with a handover pending, as the manifest’s guard holds it', () => {
  // Break caught: a run completed over an open custody record, by any of the keys that complete a run, and by the administrator.
  it.each([INITIATE, ACCEPT, 'pickup.stop.skip', 'pickup.request.cancel'])(
    'is not completed under %s',
    async (key) => {
      const open = await pending('RIDER', ['SKIPPED']);
      const result = await attempt(
        staff(key, [HUB_A]),
        `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = '${open.manifest.id}' returning id`,
      );
      expect(codeOf(result)).toBe('23514');
      const direct = await routes.admin
        .query(
          `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = $1`,
          [open.manifest.id],
        )
        .then(
          () => 'completed',
          (error: unknown) => (error as { code?: string }).code,
        );
      expect(direct).toBe('23514');
      expect(
        (
          await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
            open.manifest.id,
          ])
        )[0]?.state,
      ).toBe('IN_PROGRESS');
    },
  );

  // Break caught: a receiver shown the run under a key a read operation uses, or the run of a handover that is not its own, or its stops of
  // another run, so that a read of the run would have widened by this change.
  it('shows the receiver the run and its stops only under the accepting key and only for its own handover', async () => {
    const open = await pending();
    const other = await pending();
    const manifestRead = (id: string) => `select id from pickup_manifest where id = '${id}'`;
    const stopRead = (id: string) =>
      `select id from pickup_stop where pickup_manifest_id = '${id}'`;
    const receiver = rider(open.receiverId, ACCEPT);
    expect(idsOf(await attempt(receiver, manifestRead(open.manifest.id)))).toEqual([
      open.manifest.id,
    ]);
    expect(idsOf(await attempt(receiver, stopRead(open.manifest.id)))).toEqual(
      open.stops.map((each) => each.id),
    );
    expect(idsOf(await attempt(receiver, manifestRead(other.manifest.id)))).toEqual([]);
    expect(idsOf(await attempt(receiver, stopRead(other.manifest.id)))).toEqual([]);
    for (const key of ['pickup.read', 'fleet.custody.read', 'pickup.run.execute']) {
      const read = rider(open.receiverId, key);
      expect(idsOf(await attempt(read, manifestRead(open.manifest.id))), key).toEqual([]);
      expect(idsOf(await attempt(read, stopRead(open.manifest.id))), key).toEqual([]);
    }
    // The officer's custody keys show the run of the hub of the grant, and no other.
    expect(idsOf(await attempt(staff(INITIATE, [HUB_A]), manifestRead(open.manifest.id)))).toEqual([
      open.manifest.id,
    ]);
    expect(idsOf(await attempt(staff(INITIATE, [HUB_B]), manifestRead(open.manifest.id)))).toEqual(
      [],
    );
  });
});

describe('the ledger takes the receiver’s two events with the facts of its act', () => {
  interface Event {
    readonly code: string;
    readonly object: string;
    readonly objectType: string;
    readonly enhanced: boolean;
    readonly previous: string | null;
    readonly resulting: string | null;
    readonly hub: string | null;
    readonly related: Record<string, string> | null;
  }

  const insertEvent = (context: SecurityContext, event: Event): Promise<Result> => {
    const text = (value: string | null): string => (value === null ? 'null' : `'${value}'`);
    const related = event.related === null ? 'null' : `'${JSON.stringify(event.related)}'::jsonb`;
    return attempt(
      context,
      `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, responsible_hub_id, object_type,
                               object_id, correlation_id, previous_state, resulting_state, related_ids, outcome, enhanced, serialisation_version)
       values (gen_random_uuid(), '${event.code}', now(), 'RIDER', '${context.principalId}'::uuid, 'RIDER_ANDROID',
               ${event.hub === null ? 'null' : `'${event.hub}'::uuid`}, '${event.objectType}', '${event.object}'::uuid,
               'run-custody-handover-policies', ${text(event.previous)}, ${text(event.resulting)}, ${related}, 'SUCCEEDED',
               ${String(event.enhanced)}, 1)`,
    );
  };

  /** A handover the receiver has accepted, so that the rows say what the event may say. */
  async function accepted(): Promise<Pending> {
    const open = await pending('RIDER', ['SKIPPED']);
    await routes.admin.query(
      `update run_custody_handover set state = 'COMPLETED', parcel_count_taken = 1, accepted_by = to_rider_id, resolved_at = now() where id = $1`,
      [open.id],
    );
    return open;
  }
  const honest = (open: Pending): Event => ({
    code: 'fleet.custody.accepted',
    object: open.id,
    objectType: 'RunCustodyHandover',
    enhanced: true,
    previous: 'PENDING',
    resulting: 'COMPLETED',
    hub: HUB_A,
    related: {
      pickup_manifest_id: open.manifest.id,
      from_rider_id: open.senderId,
      to_rider_id: open.receiverId,
    },
  });

  // Break caught: the receiver's acceptance unaudited (the act would commit with no record, or not commit), or its enhanced tier lost.
  it('takes fleet.custody.accepted, enhanced, about its own handover', async () => {
    const open = await accepted();
    const receiver = rider(open.receiverId, ACCEPT);
    expect(codeOf(await insertEvent(receiver, honest(open)))).toBeUndefined();
  });

  // Break caught: a row that is not the facts of the act: another hub, other states, other identifiers or one more, the event not enhanced, an
  // object that is not the handover, another key, or a rider that is not the receiver.
  it.each([
    ['another hub', (e: Event) => ({ ...e, hub: HUB_B })],
    ['no hub', (e: Event) => ({ ...e, hub: null })],
    ['other states', (e: Event) => ({ ...e, previous: 'COMPLETED' })],
    [
      'another receiver in the identifiers',
      (e: Event) => ({ ...e, related: { ...e.related, to_rider_id: randomUUID() } as never }),
    ],
    [
      'one identifier more',
      (e: Event) => ({ ...e, related: { ...e.related, extra: randomUUID() } as never }),
    ],
    [
      'one identifier less',
      (e: Event) => ({
        ...e,
        related: { pickup_manifest_id: e.related?.pickup_manifest_id ?? '' },
      }),
    ],
    ['not enhanced', (e: Event) => ({ ...e, enhanced: false })],
    ['another object', (e: Event) => ({ ...e, object: randomUUID() })],
    ['another object type', (e: Event) => ({ ...e, objectType: 'PickupManifest' })],
  ] as const)('refuses an event with %s', async (_what, change) => {
    const open = await accepted();
    const receiver = rider(open.receiverId, ACCEPT);
    expect(codeOf(await insertEvent(receiver, change(honest(open))))).toBe('42501');
  });

  it('refuses the event under another key, from another rider and for a handover not yet accepted', async () => {
    const open = await accepted();
    expect(
      codeOf(await insertEvent(rider(open.receiverId, 'pickup.run.execute'), honest(open))),
    ).toBe('42501');
    expect(codeOf(await insertEvent(rider(open.senderId, ACCEPT), honest(open)))).toBe('42501');
    const notYet = await pending();
    expect(codeOf(await insertEvent(rider(notYet.receiverId, ACCEPT), honest(notYet)))).toBe(
      '42501',
    );
  });

  // Break caught: the receiver's completion of the run unrecorded, or recorded for a run it did not complete.
  it('takes pickup.manifest.completed for the run its acceptance completed, and no other', async () => {
    const open = await accepted();
    await routes.admin.query(
      `update pickup_manifest set state = 'COMPLETED', completed_at = now() where id = $1`,
      [open.manifest.id],
    );
    const receiver = rider(open.receiverId, ACCEPT);
    const completed: Event = {
      code: 'pickup.manifest.completed',
      object: open.manifest.id,
      objectType: 'PickupManifest',
      enhanced: false,
      previous: 'IN_PROGRESS',
      resulting: 'COMPLETED',
      hub: HUB_A,
      related: { rider_id: open.senderId },
    };
    expect(codeOf(await insertEvent(receiver, completed))).toBeUndefined();
    expect(
      codeOf(await insertEvent(receiver, { ...completed, related: { rider_id: open.receiverId } })),
    ).toBe('42501');
    expect(codeOf(await insertEvent(receiver, { ...completed, hub: HUB_B }))).toBe('42501');
    const stillRunning = await pending();
    expect(
      codeOf(
        await insertEvent(rider(stillRunning.receiverId, ACCEPT), {
          ...completed,
          object: stillRunning.manifest.id,
          related: { rider_id: stillRunning.senderId },
        }),
      ),
    ).toBe('42501');
  });
});
