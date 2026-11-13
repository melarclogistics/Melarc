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
        insertIntakeSql(fixture, { id: intakes[at], requestId: stop.requestId }),
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

  // Break caught: a grant of UPDATE or DELETE on an intake to the application's login before a task that needs it exists.
  it('lets the application’s login neither change nor remove an intake', async () => {
    const done = await handedOver();
    for (const text of [
      `update pickup_intake set state = 'COUNTED'`,
      `update pickup_intake set active_receiver_id = gen_random_uuid()`,
      `delete from pickup_intake`,
    ]) {
      expect(codeOf(await attempt(staff('hub.read'), text)), text).toBe('42501');
    }
    expect(await intakeRow(done.intakes[0] ?? '')).toMatchObject({ state: 'AWAITING_COUNT' });
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
    // Another key reads none of them, whatever the hubs.
    for (const key of [
      'pickup.read',
      'hub.intake.count',
      'fleet.custody.read',
      'pickup.run.execute',
    ]) {
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
    await routes.admin.query(
      `update pickup_intake set active_receiver_id = gen_random_uuid(), lock_acquired_at = now() where id = $1`,
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
