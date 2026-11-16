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
import { insertPickupRequest, pickupRequestRow, setHubSetting } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { HUB_A, HUB_B, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.31: what the database holds for **every** writer and reader of an intake (`AC-SLICE-001-39`, `-75`, `-76`, `-77` as far as a table can hold them; domain-model.md section 6.6;
 * state-machines.md sections 4 and 7; the migration of the hub handover):
 *
 * - **The declaration is withheld structurally.** The application's login holds no `SELECT` on `rider_declared_count` or on what the form was pre-filled with, so no read model, no join
 *   and no `select *` can carry them, whatever the policy admits, whoever asks; `hub.read` does not lift it.
 * - **Who reads an intake**: staff under `hub.read`, in the hubs of the grant; the rider who handed it over, under the key of the handover alone; nobody else.
 * - **An intake is opened only by a handover** of a completed run, for a request collected on it, in the name of the custody holder, at `AWAITING_COUNT`, with the receipt time of the
 *   run's completion; the set of a run's intakes is exactly its collected requests, held at the end of the transaction for every writer.
 * - **An intake keeps what was declared and when**; its states move one way, and a count once made is kept.
 * - **The key of the handover completes a run** that collected something, by the custody holder, with nothing pending, and nothing else; the ledger takes its two events with the facts of the act.
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

const HANDOVER = 'hub.handover.submit';

const staff = (key: string, hubs: readonly string[] | 'ALL' = 'ALL'): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'pickup-intake-rules',
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
  correlationId: 'pickup-intake-rules',
});

const vendorContext = (organizationId: string): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  vendorOrganizationId: organizationId,
  authorizationKey: 'pickup.read',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'pickup-intake-rules',
});

type Result =
  { readonly rows: unknown[] } | { readonly code: string | undefined; readonly message: string };

/** What a statement does as a context: the rows it returned, or the SQLSTATE and the text of the error the database raised. */
async function attempt(context: SecurityContext, text: string): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(
      context,
      async (tx) => (await tx.execute(sql.raw(text))).rows,
    );
    return { rows };
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code ?? 'other', message: server?.message ?? String(error) };
  }
}
/** Several statements in one transaction of one context, which ends (and so judges what is deferred) when the last has run. */
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last;
    });
    return { rows };
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code ?? 'other', message: server?.message ?? String(error) };
  }
}
const idsOf = (result: Result): string[] =>
  'rows' in result ? result.rows.map((row) => (row as { id: string }).id) : [];
const codeOf = (result: Result): string | undefined => ('code' in result ? result.code : undefined);
const messageOf = (result: Result): string => ('message' in result ? result.message : '');

interface Fixture {
  readonly holderId: string;
  readonly receiverId: string;
  readonly hubId: string;
  readonly manifest: ManifestRow;
  readonly stops: StopRow[];
}

/** A run of the hub in the state given, held by its assigned rider, with a stop in each state given, each for a request of its own. */
async function run(
  state: ManifestState,
  stopStates: readonly StopState[],
  hubId: string = HUB_A,
): Promise<Fixture> {
  const holderId = (await insertRider(routes.admin, riderRow({ hubId }))).id;
  const receiverId = (await insertRider(routes.admin, riderRow({ hubId }))).id;
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(hubId, { state, assignedRiderId: holderId }),
  );
  const stops: StopRow[] = [];
  for (const [at, stopState] of stopStates.entries()) {
    const request = await insertPickupRequest(
      routes.admin,
      pickupRequestRow(organisation, hubId, { state: 'CONFIRMED' }),
    );
    stops.push(
      await insertStop(
        routes.admin,
        stopRow(manifest, request.id, at + 1, {
          state: stopState,
          pickupSummary: {
            reference: request.code,
            sender_display_name: 'Fixture Sender',
            declared_package_count: 3,
            resolved_pickup_location: { address: 'Fixture shop' },
            location_note: null,
            contact_phone: null,
          },
        }),
      ),
    );
  }
  return { holderId, receiverId, hubId, manifest, stops };
}

const code = (): string =>
  `ACC-IN-${randomUUID()
    .replaceAll(/[^2-9A-HJKMNP-Z]/gi, '')
    .toUpperCase()
    .padEnd(6, 'K')
    .slice(0, 6)}`;

interface IntakeValues {
  readonly id?: string;
  readonly requestId: string;
  readonly by?: string;
  readonly declared?: number;
  readonly prefilled?: number;
  readonly state?: string;
  readonly manifestId?: string;
  readonly hubId?: string;
  readonly handedOverAt?: string;
  /**
   * Whether the statement asks for the row back (the handover does). **A statement that asks for it is judged by the read policy as well as by the insert policy**, so a test of the insert policy
   * alone says no.
   */
  readonly returning?: boolean;
}
/** The columns the application's login may insert are named, and the state and the receipt only where the test gives them (the handover gives neither: the database does). */
const insertIntakeSql = (fixture: Fixture, values: IntakeValues): string =>
  `insert into pickup_intake (id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, ${values.handedOverAt === undefined ? '' : 'handed_over_at, '}declaration_captured_at, ${values.state === undefined ? '' : 'state, '}rider_declared_count, prefilled_count)
   values ('${values.id ?? randomUUID()}', '${code()}', '${values.hubId ?? fixture.hubId}', '${values.requestId}', '${values.manifestId ?? fixture.manifest.id}',
           '${values.by ?? fixture.holderId}', ${values.handedOverAt === undefined ? '' : `'${values.handedOverAt}', `}'2026-11-03T15:00:00Z', ${values.state === undefined ? '' : `'${values.state}', `}
           ${String(values.declared ?? 3)}, ${String(values.prefilled ?? 3)})
   ${values.returning === false ? '' : 'returning id'}`;

/**
 * A custody handover of the run that was accepted: arranged as the administrator with the guards of the handover table off for the statement (the guard opens a handover pending and on a
 * run in progress, and the tests here need one on a run that is over), so that the receiver holds the run's parcels.
 */
async function custodyAccepted(fixture: Fixture): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by, state, parcel_count_taken, accepted_by, resolved_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', gen_random_uuid(), 'COMPLETED', 3, $4, now())`,
      [fixture.manifest.id, HUB_A, fixture.holderId, fixture.receiverId],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

/** The error an administrator's statement or transaction raises, or `undefined` when it does not. */
async function adminRefusal(
  statements: readonly string[],
): Promise<{ code?: string; message: string } | undefined> {
  await routes.admin.query('begin');
  try {
    for (const statement of statements) await routes.admin.query(statement);
    await routes.admin.query('commit');
    return undefined;
  } catch (error) {
    await routes.admin.query('rollback');
    const raised = error as { code?: string; message?: string };
    return {
      ...(raised.code === undefined ? {} : { code: raised.code }),
      message: raised.message ?? '',
    };
  }
}

/** A completed run of hub A that was handed over: its collected stops each have an intake, as the handover leaves them. */
async function handedOver(
  stopStates: readonly StopState[] = ['COLLECTED', 'COLLECTED'],
  hubId: string = HUB_A,
  declared: readonly number[] = [],
): Promise<Fixture & { intakes: string[] }> {
  const fixture = await run('COMPLETED', stopStates, hubId);
  const collected = fixture.stops.filter(
    (stop) => stop.state === 'COLLECTED' || stop.state === 'PARTIALLY_COLLECTED',
  );
  const intakes = collected.map(() => randomUUID());
  await routes.admin.query('begin');
  try {
    for (const [at, stop] of collected.entries()) {
      await routes.admin.query(
        insertIntakeSql(fixture, {
          id: intakes[at],
          requestId: stop.requestId,
          ...(declared[at] === undefined ? {} : { declared: declared[at] }),
        }),
      );
    }
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
  return { ...fixture, intakes };
}

const intakeRow = async (id: string) =>
  (await routes.rows(`select * from pickup_intake where id = $1`, [id]))[0];

describe('the declaration is withheld structurally', () => {
  // Break caught: a grant of SELECT on the whole table, or on either hidden column, to the application's login: any read model could then carry the declaration (or what it was pre-filled
  // with, which says as much), a join, a whole-row reference and `select *` included. hub.read does not lift it.
  it('refuses the application’s login every read that reaches rider_declared_count or prefilled_count, as every kind of reader', async () => {
    const done = await handedOver();
    const readers: [string, SecurityContext][] = [
      ['staff, all hubs, hub.read', staff('hub.read')],
      ['staff of the hub, hub.read', staff('hub.read', [HUB_A])],
      ['the rider, under the key of the handover', rider(done.holderId, HANDOVER)],
    ];
    const reaches = [
      `select rider_declared_count from pickup_intake`,
      `select prefilled_count from pickup_intake`,
      `select * from pickup_intake`,
      `select i.* from pickup_intake i`,
      `select to_jsonb(i) from pickup_intake i`,
      `select row_to_json(i) from pickup_intake i`,
      `select i from pickup_intake i`,
      `select id from pickup_intake where rider_declared_count = 3`,
      `select id from pickup_intake order by prefilled_count`,
      `select count(*) from pickup_intake group by rider_declared_count`,
      `select i.id from pickup_manifest m join pickup_intake i on i.pickup_manifest_id = m.id where i.prefilled_count > 0`,
    ];
    for (const [who, context] of readers) {
      for (const text of reaches) {
        const result = await attempt(context, text);
        expect(codeOf(result), `${who}: ${text}`).toBe('42501');
      }
    }
  });

  // Break caught: the columns the pre-count reads need left out of the grant (a read model that cannot be built).
  it('lets the same readers read every other column', async () => {
    const done = await handedOver();
    const columns = `id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, handed_over_at, declaration_captured_at, state, physical_count,
                     counted_at, counted_by, count_variance, count_difference, condition, active_receiver_id, lock_acquired_at, version`;
    const staffRead = await attempt(
      staff('hub.read', [HUB_A]),
      `select ${columns} from pickup_intake`,
    );
    // The database holds the intakes of the other tests of this file too: the ones just made are among those read.
    expect(idsOf(staffRead)).toEqual(expect.arrayContaining(done.intakes));
  });

  // Break caught: an INSERT privilege that lets a login write what only the handover writes (a count, a receiver, a condition) when it opens an intake.
  it('lets the application’s login insert the columns of a handover and no later column', async () => {
    const done = await run('COMPLETED', ['COLLECTED']);
    const [stop] = done.stops;
    const result = await attempt(
      rider(done.holderId, HANDOVER),
      `insert into pickup_intake (id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, declaration_captured_at, rider_declared_count, prefilled_count, physical_count)
       values (gen_random_uuid(), '${code()}', '${HUB_A}', '${stop?.requestId ?? ''}', '${done.manifest.id}', '${done.holderId}', now(), 3, 3, 3)`,
    );
    expect(codeOf(result)).toBe('42501');
  });

  // Break caught: a grant of UPDATE beyond the two columns of the lock (S1.32), or of DELETE, on an intake to the application's login before a task that needs it exists.
  it('lets the application’s login change the two columns of the lock and nothing else, and remove nothing', async () => {
    const done = await handedOver();
    for (const text of [
      `update pickup_intake set state = 'COUNTED'`,
      `delete from pickup_intake`,
    ]) {
      expect(codeOf(await attempt(staff('hub.read'), text)), text).toBe('42501');
    }
    // The two columns of the lock are granted to the login (S1.32) and written under the key of the count alone: under any other key no policy admits a row, so nothing is changed.
    expect(
      await attempt(
        staff('hub.read'),
        `update pickup_intake set active_receiver_id = gen_random_uuid() returning id`,
      ),
    ).toEqual({ rows: [] });
    expect(await intakeRow(done.intakes[0] ?? '')).toMatchObject({
      state: 'AWAITING_COUNT',
      active_receiver_id: null,
    });
  });
});

describe('who reads an intake', () => {
  // Break caught: a policy that reads by key alone (a hub's intake shown to another hub), by any hub.read holder of any hub, or one that shows a rider, a vendor or a staff member of
  // another key anything.
  it('shows staff under hub.read the intakes of the hubs of the grant, and nobody else anything', async () => {
    const here = await handedOver(['COLLECTED'], HUB_A);
    const there = await handedOver(['COLLECTED'], HUB_B);
    const ids = (result: Result) => idsOf(result).sort();
    const read = `select id from pickup_intake`;

    expect(ids(await attempt(staff('hub.read', [HUB_A]), read))).toEqual(
      expect.arrayContaining(here.intakes),
    );
    expect(ids(await attempt(staff('hub.read', [HUB_A]), read))).not.toEqual(
      expect.arrayContaining(there.intakes),
    );
    expect(ids(await attempt(staff('hub.read', [HUB_B]), read))).toEqual(
      expect.arrayContaining(there.intakes),
    );
    expect(ids(await attempt(staff('hub.read', [HUB_B]), read))).not.toEqual(
      expect.arrayContaining(here.intakes),
    );
    expect(ids(await attempt(staff('hub.read'), read))).toEqual(
      expect.arrayContaining([...here.intakes, ...there.intakes]),
    );
    expect(idsOf(await attempt(staff('hub.read', []), read))).toEqual([]);
    // Another key reads none of them, whatever the hubs. (`hub.intake.count` reads the intakes of its hubs since S1.32, below: the receiver takes the lock and is shown the intake.)
    for (const key of ['pickup.read', 'fleet.custody.read', 'pickup.run.execute']) {
      expect(idsOf(await attempt(staff(key), read)), key).toEqual([]);
    }
    // A vendor of the request reads none.
    expect(idsOf(await attempt(vendorContext(organisation), read))).toEqual([]);
    // A rider reads none under any key but the handover's, and under it only its own.
    for (const key of ['pickup.read', 'pickup.run.execute', 'fleet.custody.read', 'hub.read']) {
      expect(idsOf(await attempt(rider(here.holderId, key), read)), key).toEqual([]);
    }
    expect(ids(await attempt(rider(here.holderId, HANDOVER), read))).toEqual(here.intakes.sort());
    expect(idsOf(await attempt(rider(there.holderId, HANDOVER), read))).toEqual(there.intakes);
    expect(idsOf(await attempt(rider(here.receiverId, HANDOVER), read))).toEqual([]);
  });

  // Break caught: a probe policy that admits more than one id for a statement, or a context other than staff, or no probe policy at all (a staff member's miss on another hub's intake
  // could not be told from a record that does not exist; S1.32 reads by id).
  it('lets a staff probe see which hub the one intake it names belongs to, and nothing else', async () => {
    const there = await handedOver(['COLLECTED'], HUB_B);
    const answer = await attempt(
      staff('hub.read', [HUB_A]),
      `select set_config('melarc.scope_probe_id', '${there.intakes[0] ?? ''}', true), (select count(*) from pickup_intake)`,
    );
    expect('rows' in answer).toBe(true);
    const probed = await attemptAll(staff('hub.read', [HUB_A]), [
      `select set_config('melarc.scope_probe_id', '${there.intakes[0] ?? ''}', true)`,
      `select id, responsible_hub_id from pickup_intake`,
    ]);
    // The statement reads the intakes of its own hub and the one it probed: of the other hub, that one and no other.
    const seen =
      'rows' in probed ? (probed.rows as { id: string; responsible_hub_id: string }[]) : [];
    expect(seen.filter((row) => row.responsible_hub_id === HUB_B)).toEqual([
      { id: there.intakes[0], responsible_hub_id: HUB_B },
    ]);
    const otherHubs = await attemptAll(staff('hub.read', [HUB_A]), [
      `select id, responsible_hub_id from pickup_intake`,
    ]);
    expect(
      ('rows' in otherHubs ? (otherHubs.rows as { responsible_hub_id: string }[]) : []).some(
        (row) => row.responsible_hub_id === HUB_B,
      ),
    ).toBe(false);
    const asRider = await attemptAll(rider(there.holderId, 'pickup.run.execute'), [
      `select set_config('melarc.scope_probe_id', '${there.intakes[0] ?? ''}', true)`,
      `select id from pickup_intake`,
    ]);
    expect(idsOf(asRider)).toEqual([]);
  });
});

describe('an intake is opened only by a handover, as the database holds it for every writer', () => {
  // Break caught: an intake for a request with nothing collected (the failed stop's), a pending one's, one of another run, or none of a stop at all: §22.2, never an empty intake.
  it('refuses an intake for a request that was not collected on the run', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED', 'FAILED', 'SKIPPED', 'PENDING']);
    const other = await run('COMPLETED', ['COLLECTED']);
    for (const requestId of [
      fixture.stops[1]?.requestId ?? '',
      fixture.stops[2]?.requestId ?? '',
      fixture.stops[3]?.requestId ?? '',
      other.stops[0]?.requestId ?? '',
      randomUUID(),
    ]) {
      // Refused at the insert, by the rule that the request was collected on this run, and not left to the end of the transaction or to a key.
      const refused = await adminRefusal([insertIntakeSql(fixture, { requestId })]);
      expect(refused?.code, requestId).toBe('23514');
      expect(refused?.message, requestId).toMatch(/for a request that was collected on its run/);
    }
    expect(
      await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
        fixture.manifest.id,
      ]),
    ).toEqual([]);
  });

  // Break caught: an intake on a run that is not completed (a handover that opens intakes and leaves the run in progress), or in a state other than the first.
  it('refuses an intake on a run that is not completed, and one that is not opened at AWAITING_COUNT', async () => {
    const running = await run('IN_PROGRESS', ['COLLECTED']);
    const refusedRunning = await adminRefusal([
      insertIntakeSql(running, { requestId: running.stops[0]?.requestId ?? '' }),
    ]);
    expect(refusedRunning?.code).toBe('23514');
    // At the insert, by the rule of the table, and not at the end of the transaction.
    expect(refusedRunning?.message).toMatch(/opened by the hub handover of a completed run/);

    const done = await run('COMPLETED', ['COLLECTED']);
    for (const state of [
      'COUNTED',
      'RECONCILIATION_REQUIRED',
      'READY_FOR_ITEMIZATION',
      'ITEMIZING',
      'CLOSED',
    ]) {
      const refused = await adminRefusal([
        insertIntakeSql(done, { requestId: done.stops[0]?.requestId ?? '', state }),
      ]);
      expect(refused?.code, state).toBe('23514');
    }
    const unknown = await adminRefusal([
      insertIntakeSql(done, { requestId: done.stops[0]?.requestId ?? '', state: 'CANCELLED' }),
    ]);
    expect(unknown?.code).toBe('23514');
  });

  // Break caught: an intake in the name of someone who does not hold the run's parcels: a colleague, the receiver while the custody is still the assigned rider's, the assigned rider after
  // it handed custody over, a rider of another hub.
  it('refuses an intake in the name of anyone but the custody holder of the run', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED']);
    const requestId = fixture.stops[0]?.requestId ?? '';
    const colleague = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    for (const by of [fixture.receiverId, colleague]) {
      const refused = await adminRefusal([insertIntakeSql(fixture, { requestId, by })]);
      expect(refused?.code, by).toBe('23514');
      expect(refused?.message).toMatch(/custody/);
    }
    // After a handover of the custody that was accepted, the receiver holds it and the assigned rider does not.
    await custodyAccepted(fixture);
    expect(
      (await adminRefusal([insertIntakeSql(fixture, { requestId, by: fixture.holderId })]))?.code,
    ).toBe('23514');
    expect(
      await adminRefusal([insertIntakeSql(fixture, { requestId, by: fixture.receiverId })]),
    ).toBeUndefined();
  });

  // Break caught: a policy that lets a rider write an intake in the name of another (the policy's own rule, `handed_over_by` is the caller, which no guard of the table states: the guard asks
  // whether the name is the custody holder's), or under a key that is not the handover's.
  it('admits to a rider an intake in its own name under the key of the handover, and no other', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED']);
    const requestId = fixture.stops[0]?.requestId ?? '';
    await custodyAccepted(fixture);
    // The assigned rider has handed the custody over: it still reads its run under the key, so the guard sees the whole truth. In the receiver's name (the holder's) the guard passes and the
    // policy alone refuses it; in its own name the guard refuses it, whoever holds the policy.
    // (The statements that follow do not ask for the row back: one that does is judged by the read policy too, which says the same, and the insert policy would not be shown by itself.)
    const inTheHoldersName = await attempt(
      rider(fixture.holderId, HANDOVER),
      insertIntakeSql(fixture, { requestId, by: fixture.receiverId, returning: false }),
    );
    expect(codeOf(inTheHoldersName)).toBe('42501');
    const inItsOwnName = await attempt(
      rider(fixture.holderId, HANDOVER),
      insertIntakeSql(fixture, { requestId, by: fixture.holderId }),
    );
    expect(codeOf(inItsOwnName)).toBe('23514');
    expect(messageOf(inItsOwnName)).toMatch(/custody holder/);
    // The holder under another key, and a staff context under the handover's key: no policy admits either.
    const holderRun = await run('COMPLETED', ['COLLECTED']);
    const holderRequest = holderRun.stops[0]?.requestId ?? '';
    expect(
      codeOf(
        await attempt(
          rider(holderRun.holderId, 'pickup.run.execute'),
          insertIntakeSql(holderRun, { requestId: holderRequest, returning: false }),
        ),
      ),
    ).toBe('42501');
    // (The guard reads the run as the writer, and a staff context is shown none under this key: it is refused there, before the policy is asked.)
    expect(
      codeOf(
        await attempt(
          staff(HANDOVER),
          insertIntakeSql(holderRun, { requestId: holderRequest, returning: false }),
        ),
      ),
    ).toMatch(/^(23514|42501)$/);
    expect(
      await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
        holderRun.manifest.id,
      ]),
    ).toEqual([]);
  });

  // Break caught: a receipt moment that the writer chooses (an intake handed over before the run was completed, or after), instead of the moment the run was completed by the handover.
  it('keeps the receipt as the moment the run was completed, whatever the writer gives', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED', 'COLLECTED']);
    const [first, second] = fixture.stops;
    await routes.admin.query('begin');
    await routes.admin.query(
      insertIntakeSql(fixture, {
        requestId: first?.requestId ?? '',
        handedOverAt: '2020-01-01T00:00:00Z',
      }),
    );
    await routes.admin.query(
      insertIntakeSql(fixture, {
        requestId: second?.requestId ?? '',
        handedOverAt: '2999-01-01T00:00:00Z',
      }),
    );
    await routes.admin.query('commit');
    const stored = await routes.rows<{ handed_over_at: Date; completed_at: Date }>(
      `select i.handed_over_at, m.completed_at from pickup_intake i join pickup_manifest m on m.id = i.pickup_manifest_id where m.id = $1`,
      [fixture.manifest.id],
    );
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row.handed_over_at.getTime()).toBe(row.completed_at.getTime());
  });

  // Break caught: a second intake for one request of a run (a double click, a replay that was not caught).
  it('refuses a second intake for the same request of the same run', async () => {
    const done = await handedOver(['COLLECTED']);
    const refused = await adminRefusal([
      insertIntakeSql(done, { requestId: done.stops[0]?.requestId ?? '' }),
    ]);
    expect(refused?.code).toBe('23505');
  });

  // Break caught: a negative declaration or pre-fill.
  it('refuses a declaration or a pre-fill below zero, and accepts a zero', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED']);
    const requestId = fixture.stops[0]?.requestId ?? '';
    expect(
      (await adminRefusal([insertIntakeSql(fixture, { requestId, declared: -1 })]))?.code,
    ).toBe('23514');
    expect(
      (await adminRefusal([insertIntakeSql(fixture, { requestId, prefilled: -1 })]))?.code,
    ).toBe('23514');
    expect(
      await adminRefusal([insertIntakeSql(fixture, { requestId, declared: 0 })]),
    ).toBeUndefined();
  });
});

describe('the intakes of a handover are exactly the run’s collected requests, held at the end of the transaction', () => {
  // Break caught: a deferred check that is missing, that judges only one side, or that passes while a collected request has no intake: a handover with a row too few.
  it('refuses the end of a transaction that opens intakes for some of the collected requests only', async () => {
    const fixture = await run('COMPLETED', [
      'COLLECTED',
      'PARTIALLY_COLLECTED',
      'COLLECTED',
      'FAILED',
    ]);
    const [a, b] = fixture.stops;
    const refused = await adminRefusal([
      insertIntakeSql(fixture, { requestId: a?.requestId ?? '' }),
      insertIntakeSql(fixture, { requestId: b?.requestId ?? '' }),
    ]);
    expect(refused?.code).toBe('23514');
    expect(refused?.message).toMatch(/exactly the collected requests/);
    expect(
      await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
        fixture.manifest.id,
      ]),
    ).toEqual([]);
  });

  // Break caught: the same check on the other side: a run completed by the handover's key whose collected requests have no intakes at all.
  it('refuses the end of a transaction that completes a run that collected something and opens no intake for it', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED', 'FAILED']);
    const result = await attemptAll(rider(fixture.holderId, HANDOVER), [
      `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp() where id = '${fixture.manifest.id}'`,
    ]);
    expect(codeOf(result)).toBe('23514');
    expect(messageOf(result)).toMatch(/exactly the collected requests/);
    expect(
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          fixture.manifest.id,
        ])
      )[0],
    ).toMatchObject({ state: 'IN_PROGRESS' });
  });

  // Break caught: a deferred check that cannot be satisfied by the real handover (the run's completion and its intakes written together by the holder), or that reads what the holder's own
  // context cannot see and so passes or fails by accident.
  it('lets the custody holder complete the run and open every intake together, in its own context', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED']);
    const [a, b] = fixture.stops;
    const result = await attemptAll(rider(fixture.holderId, HANDOVER), [
      `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp() where id = '${fixture.manifest.id}'`,
      insertIntakeSql(fixture, { requestId: a?.requestId ?? '' }),
      insertIntakeSql(fixture, { requestId: b?.requestId ?? '' }),
    ]);
    expect('rows' in result, messageOf(result)).toBe(true);
    expect(
      (
        await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
          fixture.manifest.id,
        ])
      ).length,
    ).toBe(2);
  });

  // Break caught: a context changed before the commit that makes the check read nothing and pass (the lesson of 0090): the writer cannot hide the stops, or its own intakes, from the check.
  it('is not passed by a writer that changes its context before the end of the transaction', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED', 'COLLECTED']);
    const [a] = fixture.stops;
    const result = await attemptAll(rider(fixture.holderId, HANDOVER), [
      `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp() where id = '${fixture.manifest.id}'`,
      insertIntakeSql(fixture, { requestId: a?.requestId ?? '' }),
      `select set_config('melarc.principal_type', 'VENDOR', true), set_config('melarc.authorization_key', 'pickup.read', true)`,
    ]);
    expect(codeOf(result)).toBe('23514');
    expect(
      (
        await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
          fixture.manifest.id,
        ])
      ).length,
    ).toBe(0);
  });

  const swapContext = `select set_config('melarc.principal_type', 'VENDOR', true), set_config('melarc.authorization_key', 'pickup.read', true)`;

  // Break caught: the check on the side of the intake that opens passing because it cannot find the intake it was asked to judge (the run was completed before, so the check of the run does
  // not fire: this is the intake's alone). Each side fails closed by itself, and each is shown by a transaction the other side does not take part in.
  it('is not passed, on the side of the intake, by a writer that opens the intakes of a completed run and changes its context', async () => {
    const fixture = await run('COMPLETED', ['COLLECTED']);
    const result = await attemptAll(rider(fixture.holderId, HANDOVER), [
      insertIntakeSql(fixture, { requestId: fixture.stops[0]?.requestId ?? '' }),
      swapContext,
    ]);
    expect(codeOf(result)).toBe('23514');
    expect(messageOf(result)).toMatch(/the intake that was opened is not there to be judged/);
    expect(
      await routes.rows(`select id from pickup_intake where pickup_manifest_id = $1`, [
        fixture.manifest.id,
      ]),
    ).toEqual([]);
  });

  // Break caught: the check on the side of the run passing because it cannot find the run: a writer completes a run that collected something, opens no intake, and changes its context
  // before the end (nothing is read, so no intake is owed). The check of the intake does not fire here: there is none.
  it('is not passed, on the side of the run, by a writer that completes a run and changes its context', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED']);
    const result = await attemptAll(rider(fixture.holderId, HANDOVER), [
      `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp() where id = '${fixture.manifest.id}'`,
      swapContext,
    ]);
    expect(codeOf(result)).toBe('23514');
    expect(messageOf(result)).toMatch(/the run of the intakes is not there to be judged/);
    expect(
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          fixture.manifest.id,
        ])
      )[0],
    ).toMatchObject({ state: 'IN_PROGRESS' });
  });
});

describe('an intake keeps what was declared and when, and its states move one way', () => {
  const frozen: [string, string][] = [
    ['rider_declared_count', `rider_declared_count = rider_declared_count + 1`],
    ['prefilled_count', `prefilled_count = prefilled_count + 1`],
    ['handed_over_at', `handed_over_at = handed_over_at + interval '1 minute'`],
    [
      'declaration_captured_at',
      `declaration_captured_at = declaration_captured_at + interval '1 minute'`,
    ],
    ['handed_over_by', `handed_over_by = '${randomUUID()}'`],
    ['pickup_request_id', `pickup_request_id = '${randomUUID()}'`],
    ['pickup_manifest_id', `pickup_manifest_id = '${randomUUID()}'`],
    ['responsible_hub_id', `responsible_hub_id = '${HUB_B}'`],
    ['code', `code = 'ACC-IN-AAAAAA'`],
    ['id', `id = gen_random_uuid()`],
  ];

  // Break caught: a guard that lets the declaration (or any fact of the handover) change for a writer that has no policy to stop it: the administrator, the owner, a later task's login.
  it('refuses every writer a change of the declaration, of the handover’s facts and of the intake’s identity', async () => {
    const done = await handedOver(['COLLECTED']);
    const id = done.intakes[0] ?? '';
    for (const [name, assignment] of frozen) {
      const refused = await adminRefusal([
        `update pickup_intake set ${assignment} where id = '${id}'`,
      ]);
      expect(refused?.code, name).toBe('23514');
    }
    expect(await intakeRow(id)).toMatchObject({
      rider_declared_count: 3,
      prefilled_count: 3,
      state: 'AWAITING_COUNT',
      version: 1,
    });
  });

  const counted = `physical_count = 3, counted_at = now(), counted_by = gen_random_uuid(), count_variance = 'MATCH', count_difference = 0`;

  // Break caught: a state machine that skips COUNTED, or that lets an intake be counted with no count (or hold a count while it waits for one).
  it('moves an intake from AWAITING_COUNT to COUNTED with its count, and by no other way', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED', 'COLLECTED']);
    const [first, second, third] = done.intakes;
    for (const state of [
      'READY_FOR_ITEMIZATION',
      'RECONCILIATION_REQUIRED',
      'ITEMIZING',
      'CLOSED',
    ]) {
      const refused = await adminRefusal([
        `update pickup_intake set state = '${state}', ${counted} where id = '${first ?? ''}'`,
      ]);
      expect(refused?.code, state).toBe('23514');
    }
    // Counted with no count, and a count with the state left waiting.
    expect(
      (
        await adminRefusal([
          `update pickup_intake set state = 'COUNTED' where id = '${second ?? ''}'`,
        ])
      )?.code,
    ).toBe('23514');
    expect(
      (await adminRefusal([`update pickup_intake set ${counted} where id = '${second ?? ''}'`]))
        ?.code,
    ).toBe('23514');
    // The one move that is allowed, with the count.
    expect(
      await adminRefusal([
        `update pickup_intake set state = 'COUNTED', ${counted} where id = '${third ?? ''}'`,
      ]),
    ).toBeUndefined();
    expect(await intakeRow(third ?? '')).toMatchObject({
      state: 'COUNTED',
      physical_count: 3,
      count_variance: 'MATCH',
      rider_declared_count: 3,
      version: 2,
    });
  });

  // Break caught: a count that can be rewritten once it was made (the declared count, the hub count and the variance survive adjudication unchanged).
  it('keeps a count as it was made, and the machine moving forward only', async () => {
    const done = await handedOver(['COLLECTED']);
    const id = done.intakes[0] ?? '';
    expect(
      await adminRefusal([
        `update pickup_intake set state = 'COUNTED', ${counted} where id = '${id}'`,
      ]),
    ).toBeUndefined();
    for (const assignment of [
      `physical_count = 4`,
      `counted_at = counted_at + interval '1 minute'`,
      `counted_by = gen_random_uuid()`,
      `count_variance = 'SHORT'`,
      `count_difference = 1`,
    ]) {
      expect(
        (await adminRefusal([`update pickup_intake set ${assignment} where id = '${id}'`]))?.code,
        assignment,
      ).toBe('23514');
    }
    expect(
      (await adminRefusal([`update pickup_intake set state = 'AWAITING_COUNT' where id = '${id}'`]))
        ?.code,
    ).toBe('23514');
    expect(
      await adminRefusal([
        `update pickup_intake set state = 'READY_FOR_ITEMIZATION' where id = '${id}'`,
      ]),
    ).toBeUndefined();
    expect(
      (await adminRefusal([`update pickup_intake set state = 'COUNTED' where id = '${id}'`]))?.code,
    ).toBe('23514');
  });

  // Break caught: a version that moves for a change that is not one, or does not move for one that is (the intake's ETag, S1.32).
  it('moves the version when the row changes and not when it does not', async () => {
    const done = await handedOver(['COLLECTED']);
    const id = done.intakes[0] ?? '';
    await routes.admin.query(`update pickup_intake set state = state where id = $1`, [id]);
    expect(await intakeRow(id)).toMatchObject({ version: 1 });
    // The advisory lock is not a change of the intake that moves its ETag (S1.32, migration 0093).
    await routes.admin.query(
      `update pickup_intake set active_receiver_id = gen_random_uuid(), lock_acquired_at = now() where id = $1`,
      [id],
    );
    expect(await intakeRow(id)).toMatchObject({ version: 1 });
    // A change of the intake does (the count; a condition is found only after it, S1.34).
    await routes.admin.query(
      `update pickup_intake set state = 'COUNTED', physical_count = 3, counted_at = now(), counted_by = gen_random_uuid(), count_variance = 'MATCH', count_difference = 0 where id = $1`,
      [id],
    );
    expect(await intakeRow(id)).toMatchObject({ version: 2 });
  });
});

describe('the key of the hub handover completes a run, and the database holds when', () => {
  const complete = (fixture: Fixture): string =>
    `update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp() where id = '${fixture.manifest.id}'`;

  // OB-S1-44. Break caught: a key that cannot read the custody table, so that the manifest's guard sees no handover and lets the run be completed over an open custody record (the
  // writer passes by what it cannot see). The assigned rider still holds the custody while a handover to another rider is pending, and the run is not completed over it.
  it('refuses the completion while a custody handover is pending, for the writer that holds the custody', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED']);
    await routes.admin.query(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', gen_random_uuid())`,
      [fixture.manifest.id, HUB_A, fixture.holderId, fixture.receiverId],
    );
    const refused = await attempt(rider(fixture.holderId, HANDOVER), complete(fixture));
    expect(codeOf(refused)).toBe('23514');
    expect(messageOf(refused)).toMatch(/custody handover/);
    // The control: with the handover failed, the same writer is not refused for it (it reaches the next rule: the intakes are owed at the end).
    await routes.admin.query(
      `update run_custody_handover set state = 'FAILED', failure_note = 'No show', failed_by = gen_random_uuid(), resolved_at = now() where manifest_id = $1`,
      [fixture.manifest.id],
    );
    const afterwards = await attempt(rider(fixture.holderId, HANDOVER), complete(fixture));
    expect(messageOf(afterwards)).not.toMatch(/custody handover/);
  });

  // Break caught: a completion by a rider that is not the custody holder (the assigned rider after it handed the custody over, a rider with no relation), or by any other principal.
  it('refuses the completion to anyone who does not hold the run’s parcels', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED']);
    await custodyAccepted(fixture);
    const stranger = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    // The assigned rider reads its run under the key, so the policy admits the row, and it is the guard that refuses: the parcels are the receiver's.
    const former = await attempt(rider(fixture.holderId, HANDOVER), complete(fixture));
    expect(codeOf(former)).toBe('23514');
    expect(messageOf(former)).toMatch(/completed by the one who holds its parcels/);
    for (const [who, context] of [
      ['a rider with no relation', rider(stranger, HANDOVER)],
      ['staff', staff(HANDOVER)],
    ] as const) {
      const result = await attempt(context, complete(fixture));
      // The policy shows the writer no row to change: the run is not completed.
      expect('rows' in result ? result.rows.length : 0, who).toBe(0);
    }
    expect(
      (
        await routes.rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [
          fixture.manifest.id,
        ])
      )[0],
    ).toMatchObject({ state: 'IN_PROGRESS' });
  });

  // Break caught: a key that completes a run that collected nothing (that is the system's, with no handover and no intake), or one that changes more of the manifest than its state and moment.
  it('completes a run that collected something and nothing else: not a run with nothing collected, not another column', async () => {
    const empty = await run('IN_PROGRESS', ['FAILED', 'SKIPPED']);
    const refusedEmpty = await attempt(rider(empty.holderId, HANDOVER), complete(empty));
    expect(codeOf(refusedEmpty)).toBe('23514');
    expect(messageOf(refusedEmpty)).toMatch(/nothing collected|system/);

    const fixture = await run('IN_PROGRESS', ['COLLECTED']);
    for (const assignment of [
      `state = 'COMPLETED', completed_at = clock_timestamp(), assigned_rider_id = '${fixture.receiverId}'`,
      `state = 'COMPLETED', completed_at = clock_timestamp(), started_at = now()`,
      `state = 'COMPLETED'`,
    ]) {
      const refused = await attempt(
        rider(fixture.holderId, HANDOVER),
        `update pickup_manifest set ${assignment} where id = '${fixture.manifest.id}'`,
      );
      expect(codeOf(refused), assignment).toBe('23514');
    }
  });

  // Break caught: a completion with a stop still to be worked.
  it('refuses the completion while a stop is still to be worked, whoever writes it', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED', 'ARRIVED']);
    const refused = await attempt(rider(fixture.holderId, HANDOVER), complete(fixture));
    expect(codeOf(refused)).toBe('23514');
    expect(messageOf(refused)).toMatch(/still to be worked/);
  });

  // Break caught: the key writing to a run in progress without completing it. The transition table of the guard lets a statement that leaves the state alone through, so the branch of the key is the
  // one rule that holds the key to completing and to nothing else.
  it('writes nothing to a run it does not complete', async () => {
    const fixture = await run('IN_PROGRESS', ['COLLECTED']);
    for (const assignment of [
      `started_at = started_at + interval '1 minute'`,
      `assigned_rider_id = '${fixture.receiverId}'`,
    ]) {
      const refused = await attempt(
        rider(fixture.holderId, HANDOVER),
        `update pickup_manifest set ${assignment} where id = '${fixture.manifest.id}'`,
      );
      expect(codeOf(refused), assignment).toBe('23514');
      expect(messageOf(refused), assignment).toMatch(
        /completes a run in progress and does nothing else/,
      );
    }
    expect(
      (
        await routes.rows<{ state: string; assigned_rider_id: string }>(
          `select state, assigned_rider_id from pickup_manifest where id = $1`,
          [fixture.manifest.id],
        )
      )[0],
    ).toMatchObject({ state: 'IN_PROGRESS', assigned_rider_id: fixture.holderId });
  });
});

describe('the ledger takes the events of the handover with the facts of the act', () => {
  const event = (
    fixture: Fixture,
    over: Partial<{
      code: string;
      actor: string;
      related: string;
      objectType: string;
      objectId: string;
      outcome: string;
      enhanced: boolean;
      previous: string | null;
      resulting: string | null;
      surface: string;
      detail: string;
    }> = {},
  ): string => {
    const related =
      over.related ??
      `jsonb_build_object('pickup_manifest_id', '${fixture.manifest.id}', 'rider_id', '${fixture.holderId}', 'intake_ids', (select coalesce(jsonb_agg(i.id::text order by i.id), '[]'::jsonb) from pickup_intake i where i.pickup_manifest_id = '${fixture.manifest.id}'))`;
    const state = (value: string | null | undefined): string =>
      value === undefined || value === null ? 'null' : `'${value}'`;
    // What the event says of itself, as the application writes it: the handover names how many intakes it opened (never a count of parcels), the completion says who completed the run and why.
    const detail =
      over.detail ??
      ((over.code ?? 'hub.handover.submitted') === 'hub.handover.submitted'
        ? `jsonb_build_object('intakes_opened', (select count(*) from pickup_intake i where i.pickup_manifest_id = '${fixture.manifest.id}' and i.handed_over_by = '${over.actor ?? fixture.holderId}'))`
        : `jsonb_build_object('completed_by', 'CUSTODY_HOLDER', 'cause', 'HUB_HANDOVER')`);
    return `insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id, correlation_id, responsible_hub_id, previous_state, resulting_state,
                                     related_ids, detail, outcome, enhanced, serialisation_version)
            values (gen_random_uuid(), '${over.code ?? 'hub.handover.submitted'}', now(), 'RIDER', '${over.actor ?? fixture.holderId}', '${over.surface ?? 'RIDER_ANDROID'}',
                    '${over.objectType ?? 'PickupManifest'}', '${over.objectId ?? fixture.manifest.id}', 'pickup-intake-rules', '${HUB_A}',
                    ${state(over.previous)}, ${state(over.resulting)}, ${related}, ${detail}, '${over.outcome ?? 'SUCCEEDED'}', ${String(over.enhanced ?? false)}, 1)`;
  };

  // Break caught: an arm of the ledger that admits the rider's handover events to a rider who did not hand over, for another run, naming other intakes, as another outcome or tier, or under
  // another key. The ledger is the record of the act, and the arm binds it to the stored facts.
  it('admits the event of the handover to the rider who handed over, bound to its intakes, and to no one else', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED']);
    const stranger = (await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id;
    const good = await attempt(rider(done.holderId, HANDOVER), event(done));
    expect('rows' in good, messageOf(good)).toBe(true);

    for (const [name, text, context] of [
      ['another rider', event(done, { actor: stranger }), rider(stranger, HANDOVER)],
      ['another key', event(done), rider(done.holderId, 'pickup.run.execute')],
      ['staff', event(done), staff(HANDOVER)],
      [
        'another run’s intakes',
        event(done, {
          related: `jsonb_build_object('pickup_manifest_id', '${done.manifest.id}', 'rider_id', '${done.holderId}', 'intake_ids', jsonb_build_array('${randomUUID()}'))`,
        }),
        rider(done.holderId, HANDOVER),
      ],
      [
        'a missing intake',
        event(done, {
          related: `jsonb_build_object('pickup_manifest_id', '${done.manifest.id}', 'rider_id', '${done.holderId}', 'intake_ids', jsonb_build_array('${done.intakes[0] ?? ''}'))`,
        }),
        rider(done.holderId, HANDOVER),
      ],
      ['enhanced', event(done, { enhanced: true }), rider(done.holderId, HANDOVER)],
      ['rejected', event(done, { outcome: 'REJECTED' }), rider(done.holderId, HANDOVER)],
      ['another surface', event(done, { surface: 'OPS_PORTAL' }), rider(done.holderId, HANDOVER)],
      // Before the blind count no event carries a count of parcels: a member the arm does not name is refused, and so is a number of intakes the rows do not hold.
      [
        'a count in the detail',
        event(done, { detail: `jsonb_build_object('intakes_opened', 2, 'declared_count', 3)` }),
        rider(done.holderId, HANDOVER),
      ],
      [
        'another number of intakes',
        event(done, { detail: `jsonb_build_object('intakes_opened', 99)` }),
        rider(done.holderId, HANDOVER),
      ],
      [
        'a state change the handover does not make',
        event(done, { previous: 'IN_PROGRESS', resulting: 'COMPLETED' }),
        rider(done.holderId, HANDOVER),
      ],
      // (The run's own identifier under another object type: the rule on the type is shown by itself, and not by there being no run of that identifier.)
      [
        'another object type',
        event(done, { objectType: 'PickupIntake' }),
        rider(done.holderId, HANDOVER),
      ],
    ] as const) {
      expect(codeOf(await attempt(context, text)), name).toBe('42501');
    }
  });

  // Break caught: the completion's event admitted for a run that is not completed, or for a rider that is not the one that holds it.
  it('admits the completion event to the custody holder for a run it completed, and to no one else', async () => {
    const done = await handedOver(['COLLECTED']);
    const completed = (actor: string, runId: string, previous = 'IN_PROGRESS'): string =>
      event(done, {
        code: 'pickup.manifest.completed',
        actor,
        objectId: runId,
        previous,
        resulting: 'COMPLETED',
        related: `jsonb_build_object('rider_id', '${actor}')`,
      });
    const good = await attempt(
      rider(done.holderId, HANDOVER),
      completed(done.holderId, done.manifest.id),
    );
    expect('rows' in good, messageOf(good)).toBe(true);
    const running = await run('IN_PROGRESS', ['COLLECTED']);
    expect(
      codeOf(
        await attempt(
          rider(running.holderId, HANDOVER),
          completed(running.holderId, running.manifest.id),
        ),
      ),
      'a run still in progress',
    ).toBe('42501');
    expect(
      codeOf(
        await attempt(
          rider(done.receiverId, HANDOVER),
          completed(done.receiverId, done.manifest.id),
        ),
      ),
      'a rider that holds nothing',
    ).toBe('42501');
    // A count in the detail, and a run whose intakes the rider did not open (a run the system completed has none).
    expect(
      codeOf(
        await attempt(
          rider(done.holderId, HANDOVER),
          event(done, {
            code: 'pickup.manifest.completed',
            previous: 'IN_PROGRESS',
            resulting: 'COMPLETED',
            related: `jsonb_build_object('rider_id', '${done.holderId}')`,
            detail: `jsonb_build_object('completed_by', 'CUSTODY_HOLDER', 'cause', 'HUB_HANDOVER', 'collected', 3)`,
          }),
        ),
      ),
      'a count in the detail',
    ).toBe('42501');
    const settled = await run('COMPLETED', ['FAILED']);
    expect(
      codeOf(
        await attempt(
          rider(settled.holderId, HANDOVER),
          completed(settled.holderId, settled.manifest.id),
        ),
      ),
      'a run that has no intake of the rider',
    ).toBe('42501');
  });
});

/*
 * S1.32 (`acquireIntakeLock`, `getHubIntake`, `listHubIntakes`; `AC-SLICE-001-37`, `-43`, `-77`; state-machines.md section 7, the row "acquire receive lock"; hub-intake.md section 5.1
 * steps 2 and 3): what the database holds, for every writer and reader, of the advisory lock and of the declaration once the count is committed.
 *
 * - **The lock is advisory and moves nothing but itself.** The key of the count writes the two columns of the lock in its own name, on an intake that is waiting for its count, and
 *   no others; the moment is the database's; another receiver takes a held lock over only after the hub's idle time (`intake_lock_idle_ttl_minutes`, a hub setting) and never where
 *   the hub has none; and **no move of the lock moves the version**, which is the intake's `ETag`: a lock that moved it would refuse a count for a reason that is no fact of the intake.
 * - **The declaration is read after the count and not before**, by one function that answers it only for an intake past `AWAITING_COUNT`, to staff under a reading key, in the hubs the
 *   table shows them.
 */
const LOCK_TTL = 'intake_lock_idle_ttl_minutes';
const COUNT = 'hub.intake.count';

/**
 * The lock of an intake as another receiver left it some minutes ago. The moment of a lock is the database's, so an old one is arranged as an operator's repair would be, with the
 * triggers off (the guard would give the moment of now).
 */
async function lockedMinutesAgo(
  intakeId: string,
  receiverId: string,
  minutes: number,
): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update pickup_intake set active_receiver_id = $2, lock_acquired_at = now() - make_interval(mins => $3) where id = $1`,
      [intakeId, receiverId, minutes],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

/** The act on the lock as the application writes it: the two columns, in the receiver's own name. The moment it gives is a lie that the database must not keep. */
const lockSql = (id: string, receiver: string): string =>
  `update pickup_intake set active_receiver_id = '${receiver}', lock_acquired_at = now() - interval '3 hours' where id = '${id}' returning id, active_receiver_id, lock_acquired_at, version`;

/** An intake that has been counted, as the count of S1.33 leaves it (arranged as the administrator, through the state machine of the guard). */
async function counted(id: string): Promise<void> {
  await routes.admin.query(
    `update pickup_intake set state = 'COUNTED', physical_count = 3, counted_at = now(), counted_by = gen_random_uuid(), count_variance = 'MATCH', count_difference = 0 where id = $1`,
    [id],
  );
}

const lockOf = async (id: string) =>
  (await intakeRow(id)) as {
    active_receiver_id: string | null;
    lock_acquired_at: Date | null;
    version: number;
    state: string;
  };
const secondsSince = (moment: Date | null): number =>
  moment === null ? Number.NaN : Math.abs(Date.now() - moment.getTime()) / 1000;

describe('the receive lock (S1.32): what the database holds for every writer', () => {
  beforeAll(async () => {
    // Hub A has the development value of the Product Owner's decision D-13: fifteen minutes. Hub B has none, on purpose (below).
    await setHubSetting(routes.admin, HUB_A, LOCK_TTL, 15, 'minutes');
  });

  // Break caught: a lock that is not written in the receiver's own name, that keeps the moment the writer gives (a lock that is born old, so that any receiver may take it at once), or
  // that moves the version, which is the ETag of the intake and which the count compares (AC-SLICE-001-43: the lock is not a guard).
  it('gives the lock to the staff member in their own name, at the database’s moment, and does not move the version', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A);
    const id = done.intakes[0] ?? '';
    const receiver = staff(COUNT, [HUB_A]);
    const taken = await attempt(receiver, lockSql(id, receiver.principalId));
    expect('rows' in taken ? taken.rows : []).toHaveLength(1);
    const row = await lockOf(id);
    expect(row).toMatchObject({
      active_receiver_id: receiver.principalId,
      state: 'AWAITING_COUNT',
      version: 1,
    });
    expect(secondsSince(row.lock_acquired_at)).toBeLessThan(120);
  });

  // Break caught: a policy that lets a staff member write the lock in another's name, on another hub's intake or under another key, and a guard that lets it be taken on an intake that has
  // been counted (the guard holds the administrator as well, which no policy stops).
  it('refuses a lock in another member’s name, on another hub’s intake, under another key, and on an intake that is no longer waiting for its count', async () => {
    const here = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A);
    const there = await handedOver(['COLLECTED'], HUB_B);
    const receiver = staff(COUNT, [HUB_A]);
    const [open, over] = here.intakes;
    // In another's name: the check of the policy.
    expect(codeOf(await attempt(receiver, lockSql(open ?? '', randomUUID())))).toBe('42501');
    // Another hub's intake, and the other keys: the statement finds no row it may write.
    const writes: [string, SecurityContext, string][] = [
      ['another hub’s intake', receiver, there.intakes[0] ?? ''],
      ['hub.read', staff('hub.read', [HUB_A]), open ?? ''],
      ['pickup.read', staff('pickup.read', [HUB_A]), open ?? ''],
    ];
    for (const [name, context, target] of writes) {
      const result = await attempt(context, lockSql(target, context.principalId));
      expect('rows' in result ? result.rows : result, name).toEqual([]);
    }
    expect((await lockOf(there.intakes[0] ?? '')).active_receiver_id).toBeNull();
    expect((await lockOf(open ?? '')).active_receiver_id).toBeNull();
    // An intake that has been counted waits for nothing: a lock is not taken on it, by the staff member or by the administrator.
    await counted(over ?? '');
    expect(codeOf(await attempt(receiver, lockSql(over ?? '', receiver.principalId)))).toBe(
      '23514',
    );
    const administrator = await adminRefusal([
      `update pickup_intake set active_receiver_id = gen_random_uuid(), lock_acquired_at = now() where id = '${over ?? ''}'`,
    ]);
    expect(administrator?.code).toBe('23514');
    expect((await lockOf(over ?? '')).active_receiver_id).toBeNull();
  });

  // Break caught: a takeover before the hub's idle time (the lock is then no lock), one that never comes (the lock is then a wall), a holder that cannot refresh its own, and a refresh that
  // keeps the old moment (the lock would grow idle while its holder works).
  it('lets another receiver take a held lock over only after the hub’s idle time, and the holder refresh its own whenever it likes', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A);
    const [recent, idle] = done.intakes;
    const holder = staff(COUNT, [HUB_A]);
    const other = staff(COUNT, [HUB_A]);
    // Held five minutes against a fifteen-minute time: the other receiver may not take it; the holder refreshes it, and the moment is again the database's.
    await lockedMinutesAgo(recent ?? '', holder.principalId, 5);
    expect(codeOf(await attempt(other, lockSql(recent ?? '', other.principalId)))).toBe('23514');
    expect((await lockOf(recent ?? '')).active_receiver_id).toBe(holder.principalId);
    const refreshed = await attempt(holder, lockSql(recent ?? '', holder.principalId));
    expect('rows' in refreshed).toBe(true);
    expect(secondsSince((await lockOf(recent ?? '')).lock_acquired_at)).toBeLessThan(120);
    // Held twenty minutes: the other receiver takes it over, in its own name, at the database's moment.
    await lockedMinutesAgo(idle ?? '', holder.principalId, 20);
    const taken = await attempt(other, lockSql(idle ?? '', other.principalId));
    expect('rows' in taken).toBe(true);
    const row = await lockOf(idle ?? '');
    expect(row.active_receiver_id).toBe(other.principalId);
    expect(secondsSince(row.lock_acquired_at)).toBeLessThan(120);
  });

  // Break caught: a takeover permitted where the hub has no idle time or one that is no whole number of minutes of a day (a default invented, or a lock that anyone may take at once),
  // and a missing setting that also stops a free lock being taken or the holder refreshing its own (the lock must degrade takeover, not correctness).
  it('permits no takeover where the hub has no idle time or one that is not a whole number of minutes in a day, and still gives a free lock and refreshes the holder’s own', async () => {
    // Hub B has never been given the setting.
    const none = await handedOver(['COLLECTED'], HUB_B);
    const holderB = staff(COUNT, [HUB_B]);
    const otherB = staff(COUNT, [HUB_B]);
    const idB = none.intakes[0] ?? '';
    expect('rows' in (await attempt(holderB, lockSql(idB, holderB.principalId)))).toBe(true);
    await lockedMinutesAgo(idB, holderB.principalId, 600);
    expect(codeOf(await attempt(otherB, lockSql(idB, otherB.principalId))), 'no setting').toBe(
      '23514',
    );
    expect('rows' in (await attempt(holderB, lockSql(idB, holderB.principalId)))).toBe(true);

    // Hub A, given values that are no minutes of a day. A week idle is idle for any reading, so only the setting can refuse the takeover.
    const here = await handedOver(['COLLECTED'], HUB_A);
    const idA = here.intakes[0] ?? '';
    const holderA = staff(COUNT, [HUB_A]);
    const otherA = staff(COUNT, [HUB_A]);
    for (const value of ['fifteen', 0, -5, 1441, 1.5, null, true]) {
      await setHubSetting(routes.admin, HUB_A, LOCK_TTL, value, 'minutes');
      await lockedMinutesAgo(idA, holderA.principalId, 7 * 24 * 60);
      expect(
        codeOf(await attempt(otherA, lockSql(idA, otherA.principalId))),
        JSON.stringify(value),
      ).toBe('23514');
    }
    // The values at the two ends of the range are valid.
    for (const value of [1, 1440]) {
      await setHubSetting(routes.admin, HUB_A, LOCK_TTL, value, 'minutes');
      await lockedMinutesAgo(idA, holderA.principalId, 7 * 24 * 60);
      expect(
        'rows' in (await attempt(otherA, lockSql(idA, otherA.principalId))),
        String(value),
      ).toBe(true);
    }
    await setHubSetting(routes.admin, HUB_A, LOCK_TTL, 15, 'minutes');
  });

  // Break caught: a grant wider than the lock (the key could write a count, a state or a condition, or clear a lock) and a delete. Each statement also takes the lock in the receiver's own name, so
  // that the check of the lock's policy (which would refuse a statement that leaves the lock unheld) passes and the grant of the columns is the one layer that is asked.
  it('gives the key of the count the two columns of the lock and no others, and no delete', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A);
    const id = done.intakes[0] ?? '';
    const receiver = staff(COUNT, [HUB_A]);
    for (const assignment of [
      `state = 'COUNTED'`,
      `physical_count = 3`,
      `condition = 'DAMAGED'`,
      `counted_by = '${receiver.principalId}'`,
      `rider_declared_count = 0`,
      `handed_over_by = '${receiver.principalId}'`,
      `version = 9`,
    ]) {
      expect(
        codeOf(
          await attempt(
            receiver,
            `update pickup_intake set active_receiver_id = '${receiver.principalId}', lock_acquired_at = now(), ${assignment} where id = '${id}'`,
          ),
        ),
        assignment,
      ).toBe('42501');
    }
    expect(codeOf(await attempt(receiver, `delete from pickup_intake where id = '${id}'`))).toBe(
      '42501',
    );
    expect(await intakeRow(id)).toMatchObject({
      state: 'AWAITING_COUNT',
      physical_count: null,
      condition: 'OK',
      rider_declared_count: 3,
      version: 1,
    });
  });

  // Break caught: a version trigger that counts the lock as a change, so that the ETag one receiver read moves under it each time another receiver (or it itself) refreshes the lock, and a
  // count carrying that ETag is refused for a reason that is no fact of the intake: the lock would then be a guard. A change of anything else still moves it.
  it('leaves the version where it was through every move of the lock, and moves it for a change of anything else', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A);
    const id = done.intakes[0] ?? '';
    const first = staff(COUNT, [HUB_A]);
    const second = staff(COUNT, [HUB_A]);
    await attempt(first, lockSql(id, first.principalId));
    await attempt(first, lockSql(id, first.principalId));
    await lockedMinutesAgo(id, first.principalId, 30);
    await attempt(second, lockSql(id, second.principalId));
    expect(await lockOf(id)).toMatchObject({ active_receiver_id: second.principalId, version: 1 });
    await counted(id);
    expect((await lockOf(id)).version).toBe(2);
  });

  // Break caught: a guard that keeps the moment a writer gives, one that lets a moment stand without its receiver (or a receiver without its moment), and one that refuses to clear the
  // lock (the count of S1.33 or an operator may release it).
  it('keeps the moment the database’s for every writer, and clears the lock with its receiver and not without', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A);
    const id = done.intakes[0] ?? '';
    expect(
      await adminRefusal([
        `update pickup_intake set active_receiver_id = gen_random_uuid(), lock_acquired_at = now() - interval '3 hours' where id = '${id}'`,
      ]),
    ).toBeUndefined();
    expect(secondsSince((await lockOf(id)).lock_acquired_at)).toBeLessThan(120);
    // A receiver cannot be cleared and leave its moment (the check of the table keeps the two together); a moment cleared alone while a receiver is held is given back as the database's.
    expect(
      (
        await adminRefusal([
          `update pickup_intake set active_receiver_id = null where id = '${id}'`,
        ])
      )?.code,
    ).toBe('23514');
    expect(
      await adminRefusal([`update pickup_intake set lock_acquired_at = null where id = '${id}'`]),
    ).toBeUndefined();
    expect(secondsSince((await lockOf(id)).lock_acquired_at)).toBeLessThan(120);
    expect(
      await adminRefusal([
        `update pickup_intake set active_receiver_id = null, lock_acquired_at = null where id = '${id}'`,
      ]),
    ).toBeUndefined();
    expect(await lockOf(id)).toMatchObject({
      active_receiver_id: null,
      lock_acquired_at: null,
      version: 1,
    });
  });

  // Break caught: a policy that gives the key of the count no read (the receiver could not be shown the intake it took) or the whole table (another hub's intakes), or a rider's context under
  // the key the same.
  it('shows the key of the count the intakes of its own hubs and no other hub’s', async () => {
    const here = await handedOver(['COLLECTED'], HUB_A);
    const there = await handedOver(['COLLECTED'], HUB_B);
    const read = `select id from pickup_intake`;
    const seen = idsOf(await attempt(staff(COUNT, [HUB_A]), read));
    expect(seen).toEqual(expect.arrayContaining(here.intakes));
    expect(seen.some((id) => there.intakes.includes(id))).toBe(false);
    expect(idsOf(await attempt(staff(COUNT, []), read))).toEqual([]);
    expect(idsOf(await attempt(rider(here.holderId, COUNT), read))).toEqual([]);
    expect(idsOf(await attempt(vendorContext(organisation), read))).toEqual([]);
  });
});

describe('the declaration after the count (S1.32; OB-S1-92)', () => {
  const declared = (ids: readonly string[]): string =>
    `select intake_id, rider_declared_count from melarc.hub_intake_after_count(array[${ids
      .map((id) => `'${id}'`)
      .join(', ')}]::uuid[]) order by intake_id`;

  // Break caught: a function that answers for an intake that is waiting for its count (the blind count read away), or answers nothing for one that has been counted (the page that
  // shows the comparison could not be built), or answers a number other than the rider's.
  it('answers the declaration of an intake that has been counted, and nothing for one that is waiting for its count', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A);
    const [waiting, over] = done.intakes;
    await counted(over ?? '');
    for (const key of ['hub.read', COUNT]) {
      const answer = await attempt(staff(key, [HUB_A]), declared([waiting ?? '', over ?? '']));
      expect(answer, key).toEqual({ rows: [{ intake_id: over, rider_declared_count: 3 }] });
    }
    expect(await attempt(staff('hub.read', [HUB_A]), declared([]))).toEqual({ rows: [] });
  });

  // Break caught: a definer function that serves the declaration to a context the table would not show the intake to (another hub's staff), or to a context that is not staff under a
  // reading key (a rider, even of its own handover, a vendor, a staff member of another key): it would be a route round the grants.
  it('answers no one the table would not show the intake to, and refuses every context that is not staff under a reading key', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A);
    const id = done.intakes[0] ?? '';
    await counted(id);
    expect(await attempt(staff('hub.read', [HUB_B]), declared([id]))).toEqual({ rows: [] });
    expect(await attempt(staff('hub.read', []), declared([id]))).toEqual({ rows: [] });
    expect(await attempt(staff('hub.read'), declared([id]))).toEqual({
      rows: [{ intake_id: id, rider_declared_count: 3 }],
    });
    const refused: [string, SecurityContext][] = [
      ['a staff member of another key', staff('pickup.read', [HUB_A])],
      ['the rider of the handover', rider(done.holderId, HANDOVER)],
      ['a rider of another key', rider(done.holderId, 'pickup.run.execute')],
      ['a rider under a reading key', rider(done.holderId, 'hub.read')],
      ['a rider under the key of the count', rider(done.holderId, COUNT)],
      ['a vendor', vendorContext(organisation)],
    ];
    for (const [name, context] of refused) {
      expect(codeOf(await attempt(context, declared([id]))), name).toBe('42501');
    }
  });
});

/*
 * S1.33 (`submitBlindCount`; `AC-SLICE-001-38`, `-43`, `-76`; state-machines.md section 7; hub-intake.md section 5.1 steps 4 and 5): what the database holds, for every writer, of the count.
 *
 * - **The comparison is the database's.** The application's login cannot read the declaration, so the count is committed by one function of the database (`melarc.commit_blind_count`), which
 *   reads the declaration as the owner, makes the difference and the variance, writes the count and takes the intake from `AWAITING_COUNT` to `COUNTED` and then, as the System does, to
 *   `READY_FOR_ITEMIZATION` (a count that matches a declaration above zero, with no condition finding) or to `RECONCILIATION_REQUIRED` (a variance, a finding, **or a zero declaration
 *   whatever the variance**). It answers the declaration, which is its first legal appearance, and the photos of the parcels counted at the door.
 * - **And the guard holds the same for every other writer**: a count's difference and variance are the comparison of its number with the declaration, its moment is the database's, and the
 *   System's two moves are made only for the counts they are for.
 */
const commit = (id: string, physical: number): string =>
  `select intake_id, rider_declared_count, parcel_photo_ids from melarc.commit_blind_count('${id}', ${String(physical)})`;

const countOf = async (id: string) =>
  (await intakeRow(id)) as {
    state: string;
    physical_count: number | null;
    count_variance: string | null;
    count_difference: number | null;
    counted_by: string | null;
    counted_at: Date | null;
    condition: string;
    version: number;
  };

describe('the blind count (S1.33): what the database holds for every writer', () => {
  // Break caught: a count whose comparison is wrong (the difference taken the wrong way, a variance for the wrong side), whose next state ignores a zero declaration or a variance, that
  // answers without the declaration, or that is written in another name than the receiver's.
  it.each([
    ['a count that matches a declaration above zero', 3, 3, 'MATCH', 0, 'READY_FOR_ITEMIZATION'],
    ['a count below the declaration', 5, 3, 'SHORT', -2, 'RECONCILIATION_REQUIRED'],
    ['a count above the declaration', 2, 3, 'OVER', 1, 'RECONCILIATION_REQUIRED'],
    ['a zero that matches a zero declaration', 0, 0, 'MATCH', 0, 'RECONCILIATION_REQUIRED'],
    ['a count above a zero declaration', 0, 4, 'OVER', 4, 'RECONCILIATION_REQUIRED'],
  ] as const)(
    'makes the comparison and the System’s move inside the database: %s',
    async (_name, declared, physical, variance, difference, state) => {
      const done = await handedOver(['COLLECTED'], HUB_A, [declared]);
      const id = done.intakes[0] ?? '';
      const receiver = staff(COUNT, [HUB_A]);
      expect(await attempt(receiver, commit(id, physical))).toEqual({
        rows: [{ intake_id: id, rider_declared_count: declared, parcel_photo_ids: [] }],
      });
      const row = await countOf(id);
      expect(row).toMatchObject({
        state,
        physical_count: physical,
        count_variance: variance,
        count_difference: difference,
        counted_by: receiver.principalId,
        condition: 'OK',
      });
      expect(secondsSince(row.counted_at)).toBeLessThan(120);
    },
  );

  // Break caught: a count that can be made twice (the second would replace the receiver's number), by a context that is not a receiver (another key, a rider, a vendor, another hub), or for a
  // number that is no count; and one that leaves part of itself behind when it is refused.
  it('counts an intake once, for staff under the key of the count in its hubs, and nothing else', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A, [3, 3]);
    const [first, second] = done.intakes;
    const receiver = staff(COUNT, [HUB_A]);
    expect('rows' in (await attempt(receiver, commit(first ?? '', 3)))).toBe(true);
    // Counted again: the function's own check says so (the guard of the table would refuse the same write, with its own words).
    const again = await attempt(staff(COUNT, [HUB_A]), commit(first ?? '', 4));
    expect(codeOf(again)).toBe('23514');
    expect(messageOf(again)).toMatch(/counted once/);
    expect((await countOf(first ?? '')).physical_count).toBe(3);
    // Refused by the function's own first check (who may commit a count): the policies of the table would refuse most of these statements as well, with other words.
    const notReceivers: [string, SecurityContext][] = [
      ['a staff member under a reading key', staff('hub.read', [HUB_A])],
      ['a staff member of another key', staff('pickup.read', [HUB_A])],
      ['the rider of the handover', rider(done.holderId, HANDOVER)],
      ['a rider under the key of the count', rider(done.holderId, COUNT)],
      ['a vendor', vendorContext(organisation)],
    ];
    for (const [name, context] of notReceivers) {
      const refused = await attempt(context, commit(second ?? '', 3));
      expect(codeOf(refused), name).toBe('42501');
      expect(messageOf(refused), name).toMatch(/committed by a receiver/);
    }
    // A receiver of another hub, or of none, finds no such intake: the table shows it nothing.
    for (const [name, context] of [
      ['a staff member of another hub', staff(COUNT, [HUB_B])],
      ['a staff member with no hub', staff(COUNT, [])],
    ] as const) {
      const refused = await attempt(context, commit(second ?? '', 3));
      expect(codeOf(refused), name).toBe('42501');
      expect(messageOf(refused), name).toMatch(/no such intake/);
    }
    // A number that is no count: the function says so (the check of the table would refuse a negative one with its own code), and a number past the column's range is no call at all.
    const negative = await attempt(receiver, commit(second ?? '', -1));
    expect(codeOf(negative)).toBe('22023');
    expect(codeOf(await attempt(receiver, commit(second ?? '', 2147483648)))).toBeDefined();
    expect(await countOf(second ?? '')).toMatchObject({
      state: 'AWAITING_COUNT',
      physical_count: null,
      version: 1,
    });
  });

  // Break caught: a guard that takes a count with a difference or a variance that is not the comparison (a writer that is not the function: the administrator, a later task's login), that keeps
  // the moment the writer gives, or that lets the intake reach the count with no comparison at all.
  it('holds the comparison for every writer: the difference and the variance are those of the declaration, and the moment is the database’s', async () => {
    const done = await handedOver(
      ['COLLECTED', 'COLLECTED', 'COLLECTED', 'COLLECTED'],
      HUB_A,
      [3, 3, 3, 3],
    );
    const [wrongDifference, wrongVariance, rightButOld, noComparison] = done.intakes;
    const counting = (id: string, difference: string, variance: string, at = 'now()') =>
      `update pickup_intake set state = 'COUNTED', physical_count = 5, counted_at = ${at}, counted_by = gen_random_uuid(), count_variance = ${variance}, count_difference = ${difference} where id = '${id}'`;
    expect(
      (await adminRefusal([counting(wrongDifference ?? '', '0', `'OVER'`)]))?.code,
      'a difference that is not physical minus declared',
    ).toBe('23514');
    expect(
      (await adminRefusal([counting(wrongVariance ?? '', '2', `'SHORT'`)]))?.code,
      'a variance for the other side',
    ).toBe('23514');
    expect(
      (await adminRefusal([counting(noComparison ?? '', 'null', 'null')]))?.code,
      'no comparison',
    ).toBe('23514');
    expect(
      await adminRefusal([
        counting(rightButOld ?? '', '2', `'OVER'`, `now() - interval '3 hours'`),
      ]),
    ).toBeUndefined();
    expect(secondsSince((await countOf(rightButOld ?? '')).counted_at)).toBeLessThan(120);
    for (const id of [wrongDifference, wrongVariance, noComparison]) {
      expect((await countOf(id ?? '')).state).toBe('AWAITING_COUNT');
    }
  });

  // Break caught: the System's move made for a count it is not for: an intake with a variance, a zero declaration or a finding sent to itemization, or a clean count sent to reconciliation.
  it('moves a counted intake as the System does, and by no other rule, for every writer', async () => {
    const done = await handedOver(
      ['COLLECTED', 'COLLECTED', 'COLLECTED', 'COLLECTED'],
      HUB_A,
      [3, 3, 0, 3],
    );
    const [clean, short, zero, finding] = done.intakes;
    const countedAs = async (id: string, physical: number, variance: string, difference: number) =>
      routes.admin.query(
        `update pickup_intake set state = 'COUNTED', physical_count = $2, counted_at = now(), counted_by = gen_random_uuid(), count_variance = $3, count_difference = $4 where id = $1`,
        [id, physical, variance, difference],
      );
    await countedAs(clean ?? '', 3, 'MATCH', 0);
    await countedAs(short ?? '', 1, 'SHORT', -2);
    await countedAs(zero ?? '', 0, 'MATCH', 0);
    await countedAs(finding ?? '', 3, 'MATCH', 0);
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(`update pickup_intake set condition = 'DAMAGED' where id = $1`, [
        finding ?? '',
      ]);
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback');
      throw error;
    }
    const move = (id: string, to: string) =>
      adminRefusal([`update pickup_intake set state = '${to}' where id = '${id}'`]);
    for (const [name, id] of [
      ['a variance', short],
      ['a zero declaration', zero],
      ['a finding', finding],
    ] as const) {
      expect((await move(id ?? '', 'READY_FOR_ITEMIZATION'))?.code, name).toBe('23514');
      expect(await move(id ?? '', 'RECONCILIATION_REQUIRED'), name).toBeUndefined();
    }
    expect((await move(clean ?? '', 'RECONCILIATION_REQUIRED'))?.code, 'a clean count').toBe(
      '23514',
    );
    expect(await move(clean ?? '', 'READY_FOR_ITEMIZATION')).toBeUndefined();
  });
});

/*
 * S1.34 (`recordIntakeCondition`, `adjudicateDiscrepancy`; `AC-SLICE-001-41`, `-42`, `-76`; state-machines.md section 7; hub-intake.md sections 5.1 and 5.2): what the database holds, for every writer, of
 * the findings made after the count.
 *
 * - **Two operations of the database write a finding and move the intake in one change**: the receiver's recording of a condition (`melarc.record_intake_condition`, under `hub.intake.count`) and Senior
 *   Ops's adjudication (`melarc.adjudicate_discrepancy`, under `hub.osd.adjudicate`: Ops Staff do not hold the key). Neither can change a count.
 * - **The findings are appended and never changed**, and the guard gives their hub and their moment and holds that the evidence they cite is the intake's own and is stored.
 * - **The one edge a condition needs**: an intake cleared for itemization goes back to reconciliation, only with a condition that is not OK; a condition is found after the count and before itemization starts.
 */
const OSD = 'hub.osd.adjudicate';

/** An intake that has been counted: clean (cleared for itemization) or with a variance (in reconciliation), as the count of S1.33 leaves it, arranged as the administrator through the guard. */
async function countedAs(id: string, kind: 'READY' | 'RECONCILIATION'): Promise<void> {
  const physical = kind === 'READY' ? 3 : 1;
  await routes.admin.query(
    `update pickup_intake set state = 'COUNTED', physical_count = $2, counted_at = now(), counted_by = gen_random_uuid(), count_variance = $3, count_difference = $4 where id = $1`,
    [id, physical, kind === 'READY' ? 'MATCH' : 'SHORT', physical - 3],
  );
  await routes.admin.query(`update pickup_intake set state = $2 where id = $1`, [
    id,
    kind === 'READY' ? 'READY_FOR_ITEMIZATION' : 'RECONCILIATION_REQUIRED',
  ]);
}

/** A piece of evidence about an intake, as the evidence operations leave it (arranged as the administrator with the guards off for the statement). */
async function intakeEvidence(
  intakeId: string,
  options: {
    readonly by: string;
    readonly purpose?: string;
    readonly state?: 'STORED' | 'PENDING_UPLOAD';
  },
): Promise<string> {
  const id = randomUUID();
  const stored = (options.state ?? 'STORED') === 'STORED';
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, responsible_hub_id, access_rule, retention_policy,
                             state, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at, uploaded_at, validated_signature, scanner, scanner_signature_version, scanned_at)
       values ($1, 'PICKUP_INTAKE', $2, $3, now() - interval '1 minute', $4, 'STAFF', 'ev/' || replace(gen_random_uuid()::text, '-', ''), $5, 'SUBJECT_READERS', 'PICKUP_INTAKE_EVIDENCE',
               $6, 'image/jpeg', 12, repeat('a', 64), 900, now() + interval '15 minutes',
               case when $7::boolean then now() end, case when $7::boolean then 'JPEG' end, case when $7::boolean then 'test' end, case when $7::boolean then '1' end, case when $7::boolean then now() end)`,
      [
        id,
        intakeId,
        options.purpose ?? 'CONDITION',
        options.by,
        HUB_A,
        stored ? 'STORED' : 'PENDING_UPLOAD',
        stored,
      ],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
  return id;
}

const uuids = (values: readonly string[]): string =>
  `array[${values.map((value) => `'${value}'`).join(', ')}]::uuid[]`;
const recordCondition = (
  intake: string,
  condition: string,
  evidence: readonly string[] = [],
  note: string | null = 'seen at the bench',
): string =>
  `select previous_state, resulting_state from melarc.record_intake_condition('${intake}', '${randomUUID()}', '${condition}', ${note === null ? 'null' : `'${note}'`}, ${uuids(evidence)})`;
const adjudicate = (
  intake: string,
  outcome: string,
  options: { condition?: string; evidence?: readonly string[]; note?: string | null } = {},
): string =>
  `select previous_state, resulting_state from melarc.adjudicate_discrepancy('${intake}', '${randomUUID()}', '${outcome}', ${options.condition === undefined ? 'null' : `'${options.condition}'`}, ${options.note === undefined ? `'weighed by Senior Ops'` : options.note === null ? 'null' : `'${options.note}'`}, ${uuids(options.evidence ?? [])})`;
const findingsOf = async (intakeId: string) =>
  routes.rows<{
    kind: string;
    condition: string | null;
    outcome: string | null;
    note: string | null;
    evidence_ids: string[];
    recorded_by: string;
    responsible_hub_id: string;
    recorded_at: Date;
  }>(
    `select kind, condition, outcome, note, evidence_ids, recorded_by, responsible_hub_id, recorded_at from pickup_intake_finding where pickup_intake_id = $1 order by recorded_at, id`,
    [intakeId],
  );
const countFacts = async (id: string) => {
  const row = await countOf(id);
  return {
    physical_count: row.physical_count,
    count_variance: row.count_variance,
    count_difference: row.count_difference,
  };
};

describe('the receiver’s condition (S1.34): what the database holds for every writer', () => {
  // Break caught: a condition that does not send a cleared intake back to reconciliation (AC-SLICE-001-41: the case routes to senior review), that changes a count, that is recorded without its
  // evidence, in another name than the receiver's, or that leaves no finding.
  it('records a condition on a count that matched, appends the finding, and sends the case to Senior Ops without touching a count', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'READY');
    const receiver = staff(COUNT, [HUB_A]);
    const photo = await intakeEvidence(id, { by: receiver.principalId });
    const before = await countFacts(id);
    const answer = await attempt(receiver, recordCondition(id, 'DAMAGED', [photo]));
    expect(answer).toEqual({
      rows: [
        { previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'RECONCILIATION_REQUIRED' },
      ],
    });
    expect(await countOf(id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      condition: 'DAMAGED',
    });
    expect(await countFacts(id)).toEqual(before);
    const [finding, ...rest] = await findingsOf(id);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: 'CONDITION',
      condition: 'DAMAGED',
      outcome: null,
      note: 'seen at the bench',
      evidence_ids: [photo],
      recorded_by: receiver.principalId,
      responsible_hub_id: HUB_A,
    });
    expect(secondsSince(finding?.recorded_at ?? null)).toBeLessThan(120);
  });

  // Break caught: a recording of OK that moves the case (it would send every clean intake to Senior Ops), or one that leaves no finding, or a condition that is not OK on an intake already in reconciliation
  // that moves its state (the case is open already).
  it('records OK as a finding that changes nothing, and a condition on an intake already in reconciliation leaves its state', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A, [3, 3]);
    const [clean, open] = done.intakes;
    await countedAs(clean ?? '', 'READY');
    await countedAs(open ?? '', 'RECONCILIATION');
    const receiver = staff(COUNT, [HUB_A]);
    const versionBefore = (await countOf(clean ?? '')).version;
    expect(await attempt(receiver, recordCondition(clean ?? '', 'OK', [], null))).toEqual({
      rows: [{ previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'READY_FOR_ITEMIZATION' }],
    });
    expect(await countOf(clean ?? '')).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      condition: 'OK',
      version: versionBefore,
    });
    expect(await findingsOf(clean ?? '')).toHaveLength(1);
    expect(await attempt(receiver, recordCondition(open ?? '', 'OTHER'))).toEqual({
      rows: [
        { previous_state: 'RECONCILIATION_REQUIRED', resulting_state: 'RECONCILIATION_REQUIRED' },
      ],
    });
    expect(await countOf(open ?? '')).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      condition: 'OTHER',
    });
  });

  // Break caught: a condition recorded before the count (the blind count's own evidence), after itemization has started, or twice (a second recording would replace the first).
  it('refuses a condition before the count, after itemization starts, and a second one', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED', 'COLLECTED'], HUB_A, [3, 3, 3]);
    const [waiting, itemizing, again] = done.intakes;
    await countedAs(itemizing ?? '', 'READY');
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      itemizing ?? '',
    ]);
    await countedAs(again ?? '', 'READY');
    const receiver = staff(COUNT, [HUB_A]);
    const photo = await intakeEvidence(again ?? '', { by: receiver.principalId });
    expect(codeOf(await attempt(receiver, recordCondition(waiting ?? '', 'OK', [], null)))).toBe(
      '23514',
    );
    expect(codeOf(await attempt(receiver, recordCondition(itemizing ?? '', 'OK', [], null)))).toBe(
      '23514',
    );
    expect(
      'rows' in (await attempt(receiver, recordCondition(again ?? '', 'DAMAGED', [photo]))),
    ).toBe(true);
    const second = await attempt(receiver, recordCondition(again ?? '', 'OTHER', []));
    expect(codeOf(second)).toBe('23514');
    expect(messageOf(second)).toMatch(/recorded once/);
  });

  // Break caught: "once" judged by what the intake's condition is now and not by what was recorded (the audit of 15 November 2026, point 1): a recording of OK leaves the condition OK, so a second recording,
  // of anything, was taken as the first. The history of the findings is what says it was recorded.
  it('refuses a second recording after OK: the intake’s condition did not change, the finding is what says it was recorded', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'READY');
    const receiver = staff(COUNT, [HUB_A]);
    const photo = await intakeEvidence(id, { by: receiver.principalId });
    expect(await attempt(receiver, recordCondition(id, 'OK', [], null))).toEqual({
      rows: [{ previous_state: 'READY_FOR_ITEMIZATION', resulting_state: 'READY_FOR_ITEMIZATION' }],
    });
    for (const [condition, evidence] of [
      ['OK', []],
      ['OTHER', []],
      ['DAMAGED', [photo]],
    ] as const) {
      const second = await attempt(receiver, recordCondition(id, condition, evidence));
      expect(codeOf(second), condition).toBe('23514');
      expect(messageOf(second), condition).toMatch(/recorded once/);
    }
    expect(await countOf(id)).toMatchObject({ state: 'READY_FOR_ITEMIZATION', condition: 'OK' });
    expect(await findingsOf(id)).toHaveLength(1);
  });

  // Break caught: a receiver given another turn when Senior Ops adjudicates the condition back to OK (the corrections are Senior Ops's): the intake looks as it did before any recording, but the receiver has recorded.
  it('refuses the receiver a recording after Senior Ops has adjudicated the condition back to OK', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'READY');
    const receiver = staff(COUNT, [HUB_A]);
    const photo = await intakeEvidence(id, { by: receiver.principalId });
    expect(await attempt(receiver, recordCondition(id, 'DAMAGED', [photo]))).toMatchObject({
      rows: [{ resulting_state: 'RECONCILIATION_REQUIRED' }],
    });
    expect(
      await attempt(
        staff(OSD, [HUB_A]),
        adjudicate(id, 'ACCEPTED', { condition: 'OK', note: 'The box is sound' }),
      ),
    ).toEqual({
      rows: [
        { previous_state: 'RECONCILIATION_REQUIRED', resulting_state: 'READY_FOR_ITEMIZATION' },
      ],
    });
    expect(await countOf(id)).toMatchObject({ state: 'READY_FOR_ITEMIZATION', condition: 'OK' });
    const again = await attempt(receiver, recordCondition(id, 'OTHER', []));
    expect(codeOf(again)).toBe('23514');
    expect(messageOf(again)).toMatch(/recorded once/);
    expect(await countOf(id)).toMatchObject({ state: 'READY_FOR_ITEMIZATION', condition: 'OK' });
    expect((await findingsOf(id)).map((finding) => finding.kind)).toEqual([
      'CONDITION',
      'ADJUDICATION',
    ]);
  });

  // Break caught: two recordings that both pass the check (the second reads before the first has written): exactly one wins and one finding is kept, whatever the order.
  it('keeps one recording when two receivers record at once', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED', 'COLLECTED'], HUB_A, [3, 3, 3]);
    for (const intake of done.intakes) {
      await countedAs(intake, 'READY');
      const receivers = [staff(COUNT, [HUB_A]), staff(COUNT, [HUB_A])] as const;
      const answers = await Promise.all(
        receivers.map((receiver) => attempt(receiver, recordCondition(intake, 'OK', [], null))),
      );
      expect(answers.filter((answer) => 'rows' in answer)).toHaveLength(1);
      const refused = answers.filter((answer) => !('rows' in answer));
      expect(refused.map(codeOf)).toEqual(['23514']);
      expect(messageOf(refused[0] ?? { rows: [] })).toMatch(/recorded once/);
      expect(await findingsOf(intake)).toHaveLength(1);
    }
  });

  // Break caught: a rule that only the operation holds. A second CONDITION finding of one intake is refused to every writer, the owner included (a unique index, not a check in a function).
  it('holds one condition finding for each intake against any writer, the administrator included', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'READY');
    expect(
      'rows' in (await attempt(staff(COUNT, [HUB_A]), recordCondition(id, 'OK', [], null))),
    ).toBe(true);
    const insert = `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, recorded_by)
                    values (gen_random_uuid(), $1, $2, 'CONDITION', 'OK', gen_random_uuid())`;
    await expect(routes.admin.query(insert, [id, HUB_A])).rejects.toMatchObject({ code: '23505' });
    expect(await findingsOf(id)).toHaveLength(1);
    // An adjudication is not a recording of a condition: any number of them may follow it.
    const adjudication = `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, outcome, note, recorded_by)
                          values (gen_random_uuid(), $1, $2, 'ADJUDICATION', null, 'ESCALATED', 'looked at', gen_random_uuid())`;
    await routes.admin.query(adjudication, [id, HUB_A]);
    await routes.admin.query(adjudication, [id, HUB_A]);
    expect(await findingsOf(id)).toHaveLength(3);
  });

  // Break caught: a damaged or tampered condition recorded with no evidence, with evidence that is not stored, that is another intake's, of another purpose, or one that cites nothing that exists.
  it('refuses damage or tampering whose evidence is missing, not stored, another intake’s, of another purpose, or made up', async () => {
    const done = await handedOver(
      ['COLLECTED', 'COLLECTED', 'COLLECTED', 'COLLECTED', 'COLLECTED', 'COLLECTED'],
      HUB_A,
      [3, 3, 3, 3, 3, 3],
    );
    for (const intake of done.intakes) await countedAs(intake, 'READY');
    const [none, pending, foreign, wrongPurpose, madeUp, twice] = done.intakes;
    const receiver = staff(COUNT, [HUB_A]);
    const twicePhoto = await intakeEvidence(twice ?? '', { by: receiver.principalId });
    const another = await intakeEvidence(none ?? '', { by: receiver.principalId });
    const pendingPhoto = await intakeEvidence(pending ?? '', {
      by: receiver.principalId,
      state: 'PENDING_UPLOAD',
    });
    const adjudicatorsPhoto = await intakeEvidence(wrongPurpose ?? '', {
      by: receiver.principalId,
      purpose: 'OSD',
    });
    const refusals: [string, string, RegExp][] = [
      ['no evidence', recordCondition(none ?? '', 'TAMPERED', []), /supporting evidence/],
      [
        'evidence that is not stored',
        recordCondition(pending ?? '', 'DAMAGED', [pendingPhoto]),
        /stored/,
      ],
      ['another intake’s evidence', recordCondition(foreign ?? '', 'DAMAGED', [another]), /stored/],
      [
        'evidence of another purpose',
        recordCondition(wrongPurpose ?? '', 'DAMAGED', [adjudicatorsPhoto]),
        /stored/,
      ],
      [
        'evidence that does not exist',
        recordCondition(madeUp ?? '', 'DAMAGED', [randomUUID()]),
        /stored/,
      ],
      [
        'evidence cited twice',
        recordCondition(twice ?? '', 'DAMAGED', [twicePhoto, twicePhoto]),
        /once/,
      ],
    ];
    for (const [name, text, message] of refusals) {
      const refused = await attempt(receiver, text);
      expect(codeOf(refused), name).toBe('23514');
      expect(messageOf(refused), name).toMatch(message);
    }
    for (const intake of done.intakes) {
      expect(await findingsOf(intake), intake).toEqual([]);
      expect((await countOf(intake)).state).toBe('READY_FOR_ITEMIZATION');
    }
  });

  // Break caught: a condition open to a key that is not the count's (a reader, the adjudicator, another domain's), to a rider or a vendor, or on another hub's intake; a way for the login to write a finding.
  it('is recorded by staff under the key of the count in the hubs of their grant, and by nobody else', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'READY');
    const notReceivers: [string, SecurityContext][] = [
      ['a staff member under a reading key', staff('hub.read', [HUB_A])],
      ['the adjudicator', staff(OSD, [HUB_A])],
      ['a staff member of another key', staff('pickup.read', [HUB_A])],
      ['the rider of the handover', rider(done.holderId, HANDOVER)],
      ['a rider under the key of the count', rider(done.holderId, COUNT)],
      ['a vendor', vendorContext(organisation)],
    ];
    for (const [name, context] of notReceivers) {
      const refused = await attempt(context, recordCondition(id, 'OK', [], null));
      expect(codeOf(refused), name).toBe('42501');
      expect(messageOf(refused), name).toMatch(/by a receiver/);
    }
    for (const context of [staff(COUNT, [HUB_B]), staff(COUNT, [])]) {
      const refused = await attempt(context, recordCondition(id, 'OK', [], null));
      expect(codeOf(refused)).toBe('42501');
      expect(messageOf(refused)).toMatch(/no such intake/);
    }
    // The login holds no way to write a finding itself, whoever it is.
    expect(
      codeOf(
        await attempt(
          staff(COUNT, [HUB_A]),
          `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, recorded_by) values (gen_random_uuid(), '${id}', '${HUB_A}', 'CONDITION', 'OK', gen_random_uuid())`,
        ),
      ),
    ).toBe('42501');
    expect(await findingsOf(id)).toEqual([]);
  });
});

describe('the adjudication (S1.34): what the database holds for every writer', () => {
  // Break caught: an adjudication that rewrites a count (the declared count, the hub count and the variance survive it unchanged), that does not clear the case (ACCEPTED, WRITTEN_OFF, VENDOR_NOTIFIED),
  // that clears one it should only record (ESCALATED), or that leaves no finding with its reason and its author. AC-SLICE-001-76: a zero declaration is resolved by Senior Ops with a reason.
  it.each([
    ['ACCEPTED', 'READY_FOR_ITEMIZATION'],
    ['WRITTEN_OFF', 'READY_FOR_ITEMIZATION'],
    ['VENDOR_NOTIFIED', 'READY_FOR_ITEMIZATION'],
    ['ESCALATED', 'RECONCILIATION_REQUIRED'],
  ] as const)(
    'adjudicates with the outcome %s: finding appended, counts unchanged, the case %s',
    async (outcome, resulting) => {
      const done = await handedOver(['COLLECTED'], HUB_A, [0]);
      const id = done.intakes[0] ?? '';
      // A zero declaration that was counted at zero: it matches, and goes to reconciliation all the same.
      await routes.admin.query(
        `update pickup_intake set state = 'COUNTED', physical_count = 0, counted_at = now(), counted_by = gen_random_uuid(), count_variance = 'MATCH', count_difference = 0 where id = $1`,
        [id],
      );
      await routes.admin.query(
        `update pickup_intake set state = 'RECONCILIATION_REQUIRED' where id = $1`,
        [id],
      );
      const senior = staff(OSD, [HUB_A]);
      const before = await countFacts(id);
      expect(await attempt(senior, adjudicate(id, outcome))).toEqual({
        rows: [{ previous_state: 'RECONCILIATION_REQUIRED', resulting_state: resulting }],
      });
      expect((await countOf(id)).state).toBe(resulting);
      expect(await countFacts(id)).toEqual(before);
      const [finding, ...rest] = await findingsOf(id);
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({
        kind: 'ADJUDICATION',
        outcome,
        condition: null,
        note: 'weighed by Senior Ops',
        evidence_ids: [],
        recorded_by: senior.principalId,
        responsible_hub_id: HUB_A,
      });
    },
  );

  // Break caught: an adjudication without a reason (blank, or only spaces), on an intake that is not in reconciliation (waiting, cleared, being itemized, closed), or twice for one resolution; a condition it
  // sets that is damaged or tampered with no stored evidence of the intake (the receiver's photos may be cited, and are).
  it('needs a reason, an intake in reconciliation, and for damage or tampering stored evidence of the intake, which may be the receiver’s', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED', 'COLLECTED'], HUB_A, [3, 3, 3]);
    const [open, cleared, waiting] = done.intakes;
    await countedAs(open ?? '', 'RECONCILIATION');
    await countedAs(cleared ?? '', 'READY');
    const senior = staff(OSD, [HUB_A]);
    const receiverPhoto = await intakeEvidence(open ?? '', { by: randomUUID() });
    for (const note of [null, '', '   ']) {
      const refused = await attempt(senior, adjudicate(open ?? '', 'ACCEPTED', { note }));
      expect(codeOf(refused), String(note)).toBe('23514');
      expect(messageOf(refused), String(note)).toMatch(/says why/);
    }
    for (const [name, id] of [
      ['cleared for itemization', cleared],
      ['waiting for its count', waiting],
    ] as const) {
      expect(codeOf(await attempt(senior, adjudicate(id ?? '', 'ACCEPTED'))), name).toBe('23514');
    }
    const bare = await attempt(
      senior,
      adjudicate(open ?? '', 'ACCEPTED', { condition: 'DAMAGED' }),
    );
    expect(codeOf(bare)).toBe('23514');
    expect(messageOf(bare)).toMatch(/supporting evidence/);
    // The receiver's photo (not the adjudicator's own, but stored and the intake's) supports the condition the adjudication sets.
    expect(
      await attempt(
        senior,
        adjudicate(open ?? '', 'ACCEPTED', { condition: 'DAMAGED', evidence: [receiverPhoto] }),
      ),
    ).toEqual({
      rows: [
        { previous_state: 'RECONCILIATION_REQUIRED', resulting_state: 'READY_FOR_ITEMIZATION' },
      ],
    });
    expect(await countOf(open ?? '')).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      condition: 'DAMAGED',
    });
    // Adjudicated once: the case is no longer in reconciliation.
    expect(codeOf(await attempt(senior, adjudicate(open ?? '', 'ACCEPTED')))).toBe('23514');
    expect(await findingsOf(cleared ?? '')).toEqual([]);
    expect(await findingsOf(waiting ?? '')).toEqual([]);
  });

  // Break caught: the adjudication open to Ops Staff (AC-SLICE-001-42, -76: they do not hold the key), to a reader, to a receiver, a rider or a vendor, or on another hub's intake.
  it('is made by staff under the key of the adjudication in the hubs of their grant, and by nobody else', async () => {
    const done = await handedOver(['COLLECTED'], HUB_A, [3]);
    const id = done.intakes[0] ?? '';
    await countedAs(id, 'RECONCILIATION');
    const notAdjudicators: [string, SecurityContext][] = [
      ['a receiver under the key of the count', staff(COUNT, [HUB_A])],
      ['a staff member under a reading key', staff('hub.read', [HUB_A])],
      ['the rider of the handover', rider(done.holderId, HANDOVER)],
      ['a vendor', vendorContext(organisation)],
    ];
    for (const [name, context] of notAdjudicators) {
      const refused = await attempt(context, adjudicate(id, 'ACCEPTED'));
      expect(codeOf(refused), name).toBe('42501');
      expect(messageOf(refused), name).toMatch(/by Senior Ops/);
    }
    for (const context of [staff(OSD, [HUB_B]), staff(OSD, [])]) {
      const refused = await attempt(context, adjudicate(id, 'ACCEPTED'));
      expect(codeOf(refused)).toBe('42501');
      expect(messageOf(refused)).toMatch(/no such intake/);
    }
    expect((await countOf(id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(await findingsOf(id)).toEqual([]);
  });
});

describe('the findings and the edge a condition needs, for every writer (S1.34)', () => {
  // Break caught: a finding that can be changed or removed (by the administrator, the owner or a later task's login), whose hub or moment is the writer's, or whose kind and facts do not agree.
  it('keeps a finding as it was, gives it the intake’s hub and the database’s moment, and holds what each kind is', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED'], HUB_A, [3, 3]);
    const [id, waiting] = [done.intakes[0] ?? '', done.intakes[1] ?? ''];
    await countedAs(id, 'READY');
    // Written by the administrator with a hub and a moment of its own choosing: the guard gives the intake's hub and the database's moment. It is the intake's one CONDITION finding (a second is the
    // unique index's to refuse: 0097), so everything after it is judged against it.
    const written = await adminRefusal([
      `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, recorded_by, recorded_at) values (gen_random_uuid(), '${id}', '${HUB_B}', 'CONDITION', 'OTHER', gen_random_uuid(), now() - interval '3 hours')`,
    ]);
    expect(written).toBeUndefined();
    const mine = (await findingsOf(id)).find((finding) => finding.condition === 'OTHER');
    expect(mine?.responsible_hub_id).toBe(HUB_A);
    expect(secondsSince(mine?.recorded_at ?? null)).toBeLessThan(120);
    for (const statement of [
      `update pickup_intake_finding set note = 'rewritten' where pickup_intake_id = '${id}'`,
      `delete from pickup_intake_finding where pickup_intake_id = '${id}'`,
    ]) {
      expect((await adminRefusal([statement]))?.code, statement).toBe('23514');
    }
    // What each kind is: an adjudication with no outcome or no reason, a condition with an outcome or none, damage with no evidence, a kind that is none.
    for (const [name, columns, values] of [
      ['an adjudication with no outcome', 'kind, note', `'ADJUDICATION', 'why'`],
      ['an adjudication with no reason', 'kind, outcome', `'ADJUDICATION', 'ACCEPTED'`],
      ['a condition with an outcome', 'kind, condition, outcome', `'CONDITION', 'OK', 'ACCEPTED'`],
      ['a condition with none', 'kind', `'CONDITION'`],
      ['damage with no evidence', 'kind, condition', `'CONDITION', 'DAMAGED'`],
      ['a kind that is none', 'kind, condition', `'REMARK', 'OK'`],
    ] as const) {
      const refused = await adminRefusal([
        `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, recorded_by, ${columns}) values (gen_random_uuid(), '${id}', '${HUB_A}', gen_random_uuid(), ${values})`,
      ]);
      expect(refused?.code, name).toBe('23514');
    }
    // A finding is made after the count, and about an intake.
    const before = await adminRefusal([
      `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, recorded_by) values (gen_random_uuid(), '${waiting}', '${HUB_A}', 'CONDITION', 'OK', gen_random_uuid())`,
    ]);
    expect(before?.code).toBe('23514');
    expect(before?.message).toMatch(/after the blind count/);
    const nothing = await adminRefusal([
      `insert into pickup_intake_finding (id, pickup_intake_id, responsible_hub_id, kind, condition, recorded_by) values (gen_random_uuid(), gen_random_uuid(), '${HUB_A}', 'CONDITION', 'OK', gen_random_uuid())`,
    ]);
    expect(nothing?.code).toBe('23514');
    expect(nothing?.message).toMatch(/about an intake/);
  });

  // Break caught: a policy that shows findings to a key that does not read them, to another hub, to a rider or a vendor.
  it('shows the findings of an intake to the staff of its hubs under the three keys that read intakes, and to nobody else', async () => {
    const here = await handedOver(['COLLECTED'], HUB_A, [3]);
    const there = await handedOver(['COLLECTED'], HUB_B, [3]);
    const [mine, theirs] = [here.intakes[0] ?? '', there.intakes[0] ?? ''];
    for (const intake of [mine, theirs]) await countedAs(intake, 'READY');
    expect(
      'rows' in (await attempt(staff(COUNT, [HUB_A]), recordCondition(mine, 'OK', [], null))),
    ).toBe(true);
    expect(
      'rows' in (await attempt(staff(COUNT, [HUB_B]), recordCondition(theirs, 'OK', [], null))),
    ).toBe(true);
    const read = `select pickup_intake_id as id from pickup_intake_finding`;
    for (const key of ['hub.read', COUNT, OSD]) {
      const seen = idsOf(await attempt(staff(key, [HUB_A]), read));
      expect(seen, key).toContain(mine);
      expect(seen, key).not.toContain(theirs);
    }
    for (const context of [
      staff('pickup.read', [HUB_A]),
      staff('hub.read', []),
      rider(here.holderId, 'hub.read'),
      rider(here.holderId, HANDOVER),
      vendorContext(organisation),
    ]) {
      expect(idsOf(await attempt(context, read))).toEqual([]);
    }
  });

  // Break caught: an intake cleared for itemization that goes back to reconciliation for nothing (a clean state moved by any writer), a condition changed on an intake that is waiting for its count or being
  // itemized, or the edge missing (the receiver's condition then has nowhere to send the case).
  it('moves a cleared intake back to reconciliation only for a condition that is not OK, and changes the condition only after the count and before itemization', async () => {
    const done = await handedOver(['COLLECTED', 'COLLECTED', 'COLLECTED'], HUB_A, [3, 3, 3]);
    const [cleared, waiting, itemizing] = [
      done.intakes[0] ?? '',
      done.intakes[1] ?? '',
      done.intakes[2] ?? '',
    ];
    await countedAs(cleared, 'READY');
    await countedAs(itemizing, 'READY');
    await routes.admin.query(`update pickup_intake set state = 'ITEMIZING' where id = $1`, [
      itemizing,
    ]);
    const refusal = (statement: string) => adminRefusal([statement]);
    expect(
      (
        await refusal(
          `update pickup_intake set state = 'RECONCILIATION_REQUIRED' where id = '${cleared}'`,
        )
      )?.code,
      'with the condition OK',
    ).toBe('23514');
    expect(
      (await refusal(`update pickup_intake set condition = 'DAMAGED' where id = '${waiting}'`))
        ?.code,
      'waiting for its count',
    ).toBe('23514');
    expect(
      (await refusal(`update pickup_intake set condition = 'DAMAGED' where id = '${itemizing}'`))
        ?.code,
      'being itemized',
    ).toBe('23514');
    expect(
      await refusal(
        `update pickup_intake set state = 'RECONCILIATION_REQUIRED', condition = 'TAMPERED' where id = '${cleared}'`,
      ),
    ).toBeUndefined();
    expect(await countOf(cleared)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      condition: 'TAMPERED',
    });
    // An intake that is being itemized does not go back.
    expect(
      (
        await refusal(
          `update pickup_intake set state = 'RECONCILIATION_REQUIRED', condition = 'TAMPERED' where id = '${itemizing}'`,
        )
      )?.code,
    ).toBe('23514');
  });
});
