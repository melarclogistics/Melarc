import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FleetRunCustody } from '../../src/fleet/fleet-run-custody.adapter.js';
import { PickupRunAccess } from '../../src/pickup/pickup-run-access.adapter.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { RUN_ACCESS, type RunAccess } from '../../src/platform/domain-ports/run-access.port.js';
import { RUN_CUSTODY, type RunCustody } from '../../src/platform/domain-ports/run-custody.port.js';
import { ApiException } from '../../src/platform/http/api-exception.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { withHandle } from './support/handle.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.24, the two ports through which `pickup` (the run) and `fleet` (the custody of its parcels) meet (`platform/domain-ports/`; the readiness check's
 * F-32; the Product Owner's decision of 3 November 2026). Against a real PostgreSQL, on the ports the real application wired, each claim:
 *
 * - **The composition root binds each port to the adapter of the domain that owns it**, once.
 * - **A port works on the caller's transaction and no other.** It sees what the transaction has written and not committed (which no one else sees),
 *   and what it writes goes with the transaction when it is rolled back. This is what keeps the custody and the completion of a run one atomic piece
 *   of work.
 * - **The locks are the run's own, as they were**: `lock` takes the run's lock and not its stops'; the completion is asked of the custody domain only
 *   once the run's lock is held, and is refused for a run with a custody handover pending, one with work left, one that collected, and one that is
 *   not in progress.
 * - **A run is reached as a read of it would be**: a run out of the caller's scope is not found.
 *
 * The acts that use the ports are proved in `run-custody-handover.db.test.ts` and `pickup-run-completion.db.test.ts`, including that a failure of a
 * port inside an act leaves nothing of the act behind.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let ops: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const INITIATE = 'fleet.custody.initiate';
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;

const access = (): RunAccess => routes.kit.app.app.get<RunAccess>(RUN_ACCESS, { strict: false });
const custody = (): RunCustody =>
  routes.kit.app.app.get<RunCustody>(RUN_CUSTODY, { strict: false });

/** The officer's context for the key that reads, locks and completes a run in the custody domain: a hub of the grant, or every hub. */
const officer = (
  hubs: 'ALL' | readonly string[] = 'ALL',
  key: string = INITIATE,
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: ops.identity.id,
  sessionId: ops.sessionId,
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'run-ports',
});

const inTransaction = <T>(
  work: (handle: TransactionHandle, tx: DatabaseTransaction) => Promise<T>,
  context: SecurityContext = officer(),
): Promise<T> => withHandle(routes.built.service, context, work);

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    ...over,
  });

const stateOf = (manifestId: string): Promise<string | undefined> =>
  routes
    .rows<{ state: string }>(`select state from pickup_manifest where id = $1`, [manifestId])
    .then((rows) => rows[0]?.state);

const completions = (manifestId: string) =>
  routes.rows(
    `select id from audit_event where event_code = 'pickup.manifest.completed' and object_id = $1`,
    [manifestId],
  );

/** A handover that is pending, committed, as the database holds it once an officer has opened one. */
async function pendingHandover(arranged: ArrangedRun): Promise<string> {
  const receiver = await arrangedRider(routes.kit, routes.admin);
  const inserted = await routes.admin.query<{ id: string }>(
    `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, 'Fixture handover', $5) returning id`,
    [arranged.manifest.id, HUB_A, arranged.rider.id, receiver.id, ops.identity.id],
  );
  return inserted.rows[0]?.id ?? '';
}

/** Opens a handover in the transaction `tx` stands for, as the officer, through the key's policy and the table's guard: not committed. */
async function openInside(
  tx: DatabaseTransaction,
  arranged: ArrangedRun,
  receiverId: string,
): Promise<void> {
  await tx.execute(
    sql`insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, initiation_note, initiated_by)
        values (${randomUUID()}::uuid, ${arranged.manifest.id}::uuid, ${HUB_A}::uuid, ${arranged.rider.id}::uuid, ${receiverId}::uuid,
                'Fixture handover', ${ops.identity.id}::uuid)`,
  );
}

describe('the composition root binds each port to the adapter of the domain that owns it', () => {
  // Break caught: a port bound to nothing (an act that fails closed for ever), to the other domain's adapter, or to two instances that do not share
  // what they were given.
  it('gives the run port to pickup’s adapter and the custody port to fleet’s, one instance of each', () => {
    expect(access()).toBeInstanceOf(PickupRunAccess);
    expect(custody()).toBeInstanceOf(FleetRunCustody);
    expect(access()).toBe(access());
    expect(custody()).toBe(custody());
  });
});

describe('RunCustody: the custody domain answers in the caller’s own transaction', () => {
  // Break caught: a custody check that is always false (a run closed over an open record) or always true (a run never closed), or that reads a
  // handover that has resolved as if it stood.
  it('says whether a handover is pending: no for a run with none, yes while one stands, no once it has resolved', async () => {
    const arranged = await run({ stops: 1 });
    const pending = (): Promise<boolean> =>
      inTransaction((handle) => custody().hasPendingHandover(handle, arranged.manifest.id));

    // Another run has a handover pending: it is not this run's, and does not make this run's answer yes.
    await pendingHandover(await run({ stops: 1 }));
    expect(await pending()).toBe(false);
    const handoverId = await pendingHandover(arranged);
    expect(await pending()).toBe(true);
    await routes.admin.query(
      `update run_custody_handover set state = 'FAILED', failure_note = 'Did not arrive', failed_by = $2, resolved_at = clock_timestamp() where id = $1`,
      [handoverId, ops.identity.id],
    );
    expect(await pending()).toBe(false);
  });

  // Break caught: a port that reads on a connection of its own, which would not see what the act has just written and would report a handover that
  // the same act opened as not there; or one that wrote something that the rollback did not take back.
  it('sees a handover this transaction opened and has not committed, which no one else sees, and nothing once it is rolled back', async () => {
    const arranged = await run({ stops: 1 });
    const receiver = await arrangedRider(routes.kit, routes.admin);
    const everyone = (): Promise<unknown[]> =>
      routes.rows(`select id from run_custody_handover where manifest_id = $1`, [
        arranged.manifest.id,
      ]);

    await expect(
      inTransaction(async (handle, tx) => {
        await openInside(tx, arranged, receiver.id);
        expect(await custody().hasPendingHandover(handle, arranged.manifest.id)).toBe(true);
        // Another connection is not in this transaction: it sees nothing of it.
        expect(await everyone()).toEqual([]);
        throw new Error('the act failed after the port was used');
      }),
    ).rejects.toThrow('the act failed after the port was used');

    expect(await everyone()).toEqual([]);
    expect(
      await inTransaction((handle) => custody().hasPendingHandover(handle, arranged.manifest.id)),
    ).toBe(false);
  });
});

describe('RunAccess: reaching a run from outside its domain', () => {
  // Break caught: facts of a run that are another's (the wrong state, the wrong hub), or a run found for a caller whose scope does not hold it.
  it('reads a run as a read of it would: its facts for the hub of the grant, and nothing for another hub or an id that matches nothing', async () => {
    const arranged = await run({ stops: 1 });

    expect(await inTransaction((handle) => access().peek(handle, arranged.manifest.id))).toEqual({
      id: arranged.manifest.id,
      state: 'IN_PROGRESS',
      responsibleHubId: HUB_A,
    });
    // The state is the run's own, whatever it is: a run that is not in progress is told as what it is.
    const dispatched = await run({ stops: 1, state: 'DISPATCHED' });
    expect(await inTransaction((handle) => access().peek(handle, dispatched.manifest.id))).toEqual({
      id: dispatched.manifest.id,
      state: 'DISPATCHED',
      responsibleHubId: HUB_A,
    });
    expect(
      await inTransaction(
        (handle) => access().peek(handle, arranged.manifest.id),
        officer([HUB_B]),
      ),
    ).toBeUndefined();
    expect(await inTransaction((handle) => access().peek(handle, randomUUID()))).toBeUndefined();
    expect(await inTransaction((handle) => access().lock(handle, randomUUID()))).toBeUndefined();
    expect(
      await inTransaction((handle) => access().lockWithVersion(handle, randomUUID())),
    ).toBeUndefined();
  });

  // Break caught: a lock that is not taken (two acts on one run would not be put in a line), or that takes the stops' locks too (the order of locks
  // of the completion would then be broken: an act holding a run in progress and waiting for a stop).
  it('takes the run’s lock and not its stops’, and lets it go with the transaction', async () => {
    const lockedBy = (id: string, table: string, column: string): Promise<string | undefined> =>
      routes.admin
        .query(`select id from ${table} where ${column} = $1 for update nowait`, [id])
        .then(
          () => 'free',
          (error: unknown) => (error as { code?: string }).code,
        );

    // A run in progress, which is what the custody acts lock under their own key, and a draft, which the dispatch locks under its key: the loader locks
    // the stops of a draft or a dispatched run only when it is asked to, so it is there that a port which asked for them would be seen.
    const cases = [
      { state: 'IN_PROGRESS', key: INITIATE },
      { state: 'DRAFT', key: 'pickup.manifest.dispatch' },
    ] as const;
    for (const { state, key } of cases) {
      const arranged = await run({ stops: 2, state });
      const id = arranged.manifest.id;
      const takers: readonly (readonly [
        string,
        (handle: TransactionHandle) => Promise<unknown>,
      ])[] = [
        ['lock', (handle) => access().lock(handle, id)],
        ['lockWithVersion', (handle) => access().lockWithVersion(handle, id)],
      ];
      for (const [name, take] of takers) {
        const said = `${name} of a run ${state}`;
        await inTransaction(
          async (handle) => {
            expect(await take(handle), said).toBeDefined();
            // 55P03: the lock is not available, because this transaction holds the run.
            expect(await lockedBy(id, 'pickup_manifest', 'id'), said).toBe('55P03');
            // The stops are not held.
            expect(await lockedBy(id, 'pickup_stop', 'pickup_manifest_id'), said).toBe('free');
          },
          officer('ALL', key),
        );
        // The transaction has ended: the lock went with it.
        expect(await lockedBy(id, 'pickup_manifest', 'id'), said).toBe('free');
      }
    }
  });

  // Break caught: a version that is not the one a read of the run answers with (a client that read a run could never act on it), or one that accepts
  // a token that is not the run's: missing, weak, a list, `*`, or another run's.
  it('versions a run as a read of it does, and refuses every token that is not the run’s as a conflict', async () => {
    const arranged = await run({ stops: 1 });
    const another = await run({ stops: 1 });
    const read = async (id: string): Promise<string> =>
      (await ops.client.get(MANIFEST(id))).header('etag') ?? '';
    const etag = await read(arranged.manifest.id);
    const foreign = await read(another.manifest.id);
    expect(etag).not.toBe('');

    await inTransaction(async (handle) => {
      const locked = await access().lockWithVersion(handle, arranged.manifest.id);
      expect(locked).toMatchObject({ state: 'IN_PROGRESS', responsibleHubId: HUB_A, etag });
      if (locked === undefined) throw new Error('the run was not found');
      expect(() => {
        access().requireCurrentVersion(etag, locked);
      }).not.toThrow();
      for (const token of [
        undefined,
        '',
        `W/${etag}`,
        '*',
        `${etag}, ${etag}`,
        foreign,
        'garbage',
      ]) {
        let thrown: unknown;
        try {
          access().requireCurrentVersion(token, locked);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, String(token)).toBeInstanceOf(ApiException);
        expect((thrown as ApiException).code, String(token)).toBe('STATE_CONFLICT');
      }
    });
  });
});

describe('RunAccess.completeIfSettled: the system’s completion, in the act’s transaction', () => {
  // Break caught: a completion that commits on its own (a run completed though the act that settled it failed), or that is not visible to the act
  // that made it (the act could not read its own result).
  it('completes a settled run in the caller’s transaction: seen there at once, by no one else before the commit, and taken back by a rollback', async () => {
    const arranged = await run({ stops: 1, stopStates: ['SKIPPED'] });
    const id = arranged.manifest.id;

    await expect(
      inTransaction(async (handle, tx) => {
        expect(await access().completeIfSettled(handle, id, 'CUSTODY_HANDOVER_RESOLVED')).toBe(
          true,
        );
        const inside = await tx.execute(
          sql`select state from pickup_manifest where id = ${id}::uuid`,
        );
        expect((inside.rows[0] as { state: string }).state).toBe('COMPLETED');
        expect(await stateOf(id)).toBe('IN_PROGRESS');
        throw new Error('the act failed after the completion');
      }),
    ).rejects.toThrow('the act failed after the completion');
    expect(await stateOf(id)).toBe('IN_PROGRESS');
    expect(await completions(id)).toEqual([]);

    expect(
      await inTransaction((handle) =>
        access().completeIfSettled(handle, id, 'CUSTODY_HANDOVER_RESOLVED'),
      ),
    ).toBe(true);
    expect(await stateOf(id)).toBe('COMPLETED');
    expect(await completions(id)).toHaveLength(1);
  });

  // Break caught: a run closed over work that is left, over a parcel that was collected, over a custody record that stands, or one that was never in
  // progress; and a completion that asks the custody domain before it holds the run (the answer could then change under it).
  it('completes nothing that has work left, has collected, has a handover pending, or is not in progress', async () => {
    const settle = async (arranged: ArrangedRun): Promise<boolean> =>
      inTransaction((handle) =>
        access().completeIfSettled(handle, arranged.manifest.id, 'LAST_STOP_SKIPPED'),
      );

    const toWork = await run({ stops: 2, stopStates: ['SKIPPED', 'PENDING'] });
    const collected = await run({ stops: 2, stopStates: ['SKIPPED', 'COLLECTED'] });
    const held = await run({ stops: 1, stopStates: ['SKIPPED'] });
    await pendingHandover(held);
    const dispatched = await run({ stops: 1, stopStates: ['SKIPPED'], state: 'DISPATCHED' });

    for (const arranged of [toWork, collected, held, dispatched]) {
      expect(await settle(arranged), arranged.manifest.id).toBe(false);
    }
    expect(await stateOf(toWork.manifest.id)).toBe('IN_PROGRESS');
    expect(await stateOf(collected.manifest.id)).toBe('IN_PROGRESS');
    expect(await stateOf(held.manifest.id)).toBe('IN_PROGRESS');
    expect(await stateOf(dispatched.manifest.id)).toBe('DISPATCHED');
    expect(await completions(held.manifest.id)).toEqual([]);
  });

  // Break caught: the completion asking the custody domain on a connection of its own, which would not see a handover that the same act has opened
  // and not committed: the run would close over the very record the act has just written.
  it('is held back by a handover that the same transaction opened and has not committed', async () => {
    const arranged = await run({ stops: 1, stopStates: ['SKIPPED'] });
    const receiver = await arrangedRider(routes.kit, routes.admin);

    await inTransaction(async (handle, tx) => {
      await openInside(tx, arranged, receiver.id);
      expect(
        await access().completeIfSettled(handle, arranged.manifest.id, 'LAST_STOP_SKIPPED'),
      ).toBe(false);
    });
    expect(await stateOf(arranged.manifest.id)).toBe('IN_PROGRESS');
  });
});
