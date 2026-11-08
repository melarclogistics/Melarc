import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  checkCommitmentMarks,
  isConsistent,
  runCommitmentMarks,
  type MarkedRequest,
} from '../../src/tools/database/commitment-marks.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  DB_COMMITMENT_MARKS,
  DB_MIGRATE,
  killAll,
  requireBuild,
  run,
} from '../support/api-process.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { builtBefore } from './support/history-before.js';
import { HUB_A } from './support/rls-fixture.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * The upgrade to migration 0064 (OB-S1-35; the Product Owner's decision of 2 November 2026, the reviewer's findings): the migration changes what
 * the database enforces and **repairs nothing**, and a clean install proves nothing about a database that already holds the old marks. Here the
 * database is built the way it was before (the migrations through 0063, applied by the real runner), is left what the old behavior leaves (a
 * mark raised by the assignment of a rider and never lowered when the manifest was cancelled), and is then taken through the upgrade.
 *
 * **The order is the documented one** (MIGRATION_AND_SEEDING.md section 5.5, the plan's S1.21 block): check, record, reconcile what the check
 * found, and only then apply the migration. The reconciliation therefore runs under the guard of the old behavior, which the migration replaces:
 * a test that reconciled after the migration would show that the reconciliation works under the new guard and say nothing about the guard it
 * is documented to run under (the reviewer's finding of 2 November 2026). Each test reads the catalogue to say under which guard it reconciled,
 * so that is a fact it observed and not a property of how it was ordered.
 *
 * - **The check finds the old marks and changes nothing by looking.** The migration cannot make the check, because its login reads these
 *   tables through row-level security and would find nothing; the cluster administrator's login can.
 * - **The reconciliation puts right only a confirmed request that disagrees with its current claim**, in both directions, under a lock, and
 *   leaves everything else exactly as it was: a request cancelled after assignment keeps its mark, its decision and its snapshot, to the last
 *   column; a request claimed by a later manifest that has a rider keeps its mark.
 * - **The migration then applies on the reconciled data and changes no request**, and the check says the database agrees with its claims.
 * - **The other order is the recovery path**: a database migrated before it was checked is checked and reconciled under the new guard.
 * - **The commands are the ones the owner runs**, in that order, from the build.
 */
const NEW_FROM = 64;

/** How many migrations the real runner applies to a database built before `from`: migration 0064 and any that follow it. */
function migrationsFrom(from: number): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length - from;
}

const ids = (list: readonly MarkedRequest[]): string[] => list.map((each) => each.id).toSorted();

const wholeRow = async (admin: pg.Client, id: string): Promise<Record<string, unknown>> => {
  const found = await admin.query(`select * from pickup_request where id = $1`, [id]);
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error('the request is missing');
  return row;
};

/** The whole row of each request, one statement after another: one connection runs one statement at a time. */
async function rowsOf(
  admin: pg.Client,
  requests: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const rows: Record<string, Record<string, unknown>> = {};
  for (const id of requests) rows[id] = await wholeRow(admin, id);
  return rows;
}

async function marksOf(
  admin: pg.Client,
  requests: readonly string[],
): Promise<Record<string, boolean>> {
  const found = await admin.query<{ id: string; rider_assigned: boolean }>(
    `select id, rider_assigned from pickup_request where id = any($1::uuid[])`,
    [requests],
  );
  return Object.fromEntries(found.rows.map((row) => [row.id, row.rider_assigned]));
}

/** The columns in which two readings of one row differ. */
const differing = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  Object.keys(before)
    .filter((column) => JSON.stringify(before[column]) !== JSON.stringify(after[column]))
    .toSorted();

/**
 * What the database enforces about the mark right now, read from its catalogue: which guard is installed, whether that guard's trigger is
 * enabled (`O`) and whether the release policy of migration 0064 exists. A test that reconciles says under which guard it did.
 */
interface Enforcement {
  readonly guard: '0060' | '0064';
  readonly guardTrigger: string;
  readonly releasePolicy: boolean;
}

async function enforcement(admin: pg.Client): Promise<Enforcement> {
  const found = await admin.query<{
    source: string;
    guard_trigger: string | null;
    policy: boolean;
  }>(
    `select pg_get_functiondef('melarc.pickup_request_guard()'::regprocedure) as source,
            (select t.tgenabled::text from pg_trigger t
              where t.tgname = 'pickup_request_guard' and t.tgrelid = 'public.pickup_request'::regclass) as guard_trigger,
            exists (select 1 from pg_policies
                     where schemaname = 'public' and tablename = 'pickup_request' and policyname = 'pickup_request_release') as policy`,
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('the catalogue answered nothing');
  let guard: Enforcement['guard'] | undefined;
  if (
    row.source.includes(
      'only the assignment of a rider and the cancellation of a manifest change the mark',
    )
  ) {
    guard = '0064';
  } else if (
    row.source.includes(
      'the assignment of a rider marks a request as having one and changes nothing else',
    )
  ) {
    guard = '0060';
  }
  if (guard === undefined) {
    throw new Error(
      'the guard of a pickup request is neither the one of migration 0060 nor of 0064',
    );
  }
  return { guard, guardTrigger: row.guard_trigger ?? 'none', releasePolicy: row.policy };
}

/** The database as migration 0063 leaves it: the guard of migration 0060 is in force, enabled, and the release policy of 0064 does not exist. */
const AS_0063_LEFT_IT: Enforcement = { guard: '0060', guardTrigger: 'O', releasePolicy: false };

interface Leavings {
  readonly x1: string;
  readonly x2: string;
  readonly x3: string;
  readonly y: string;
  readonly y2: string;
  readonly z: string;
  readonly w: string;
  readonly all: readonly string[];
}

/**
 * What the old behavior left in a database built before 0064, arranged as the administrator (past row-level security). M1 had a rider and was
 * cancelled: its claims were released and the marks were not lowered (x1, x2 and x3). Before that cancellation the office had cancelled x3 after
 * assignment and charged it. x2 was then claimed by M4, whose rider is assigned (so its mark is true again, rightly). M2 holds y and y2 with a
 * rider, but y2 was never marked. M3 has no rider and holds w, which carries a mark nothing explains. z has never been on a manifest.
 *
 * Stale (marked, held by nothing that has a rider): x1 and w. Missing (held by a manifest that has a rider, not marked): y2. Right as they
 * are: x2 and y. Frozen: x3 (cancelled, with its mark and its decision). Never touched: z.
 */
async function leaveTheOldMarks(admin: pg.Client): Promise<Leavings> {
  const vendor = await insertVendor(admin, vendorRow({ hubId: HUB_A }));
  const request = async (): Promise<string> =>
    (
      await insertPickupRequest(
        admin,
        pickupRequestRow(vendor.organizationId, HUB_A, { state: 'CONFIRMED' }),
      )
    ).id;
  const rider = async (): Promise<string> =>
    (await insertRider(admin, riderRow({ hubId: HUB_A }))).id;
  const [r1, r2, r4] = [await rider(), await rider(), await rider()];
  const [x1, x2, x3, y, y2, z, w] = [
    await request(),
    await request(),
    await request(),
    await request(),
    await request(),
    await request(),
    await request(),
  ];

  const released = new Date('2026-11-03T10:00:00Z');
  const m1 = await insertManifest(
    admin,
    manifestRow(HUB_A, { state: 'CANCELLED', assignedRiderId: r1 }),
  );
  const m2 = await insertManifest(admin, manifestRow(HUB_A, { assignedRiderId: r2 }));
  const m3 = await insertManifest(admin, manifestRow(HUB_A));
  const m4 = await insertManifest(admin, manifestRow(HUB_A, { assignedRiderId: r4 }));
  for (const [at, id] of [x1, x2, x3].entries()) {
    await insertStop(admin, stopRow(m1, id, at + 1, { state: 'SKIPPED', releasedAt: released }));
  }
  await insertStop(admin, stopRow(m2, y, 1));
  await insertStop(admin, stopRow(m2, y2, 2));
  await insertStop(admin, stopRow(m3, w, 1));
  await insertStop(admin, stopRow(m4, x2, 1));
  await admin.query(`update pickup_request set rider_assigned = true where id = any($1::uuid[])`, [
    [x1, x2, x3, y, w],
  ]);
  await admin.query(
    `update pickup_request
        set state = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = $2, cancelled_by_actor_type = 'OPS',
            cancellation_reason_code = 'FIXTURE_REASON', cancellation_reason_label = 'Fixture reason',
            cancellation_charge_outcome = 'APPLIED',
            cancellation_charge_snapshot = '{"amount_minor":2000,"setting_key":"cancellation_charge_amount","effective_version":"1"}'::jsonb,
            cancellation_charge_reason_code = 'FIXTURE_REASON', cancellation_charge_reason_label = 'Fixture reason'
      where id = $1`,
    [x3, randomUUID()],
  );
  return { x1, x2, x3, y, y2, z, w, all: [x1, x2, x3, y, y2, z, w] };
}

/** The marks as the old behavior left them. */
const asLeft = (left: Leavings): Record<string, boolean> => ({
  [left.x1]: true,
  [left.x2]: true,
  [left.x3]: true,
  [left.y]: true,
  [left.y2]: false,
  [left.z]: false,
  [left.w]: true,
});

/** The marks once every confirmed request agrees with its claim (x3 is cancelled and keeps what it was decided on). */
const asReconciled = (left: Leavings): Record<string, boolean> => ({
  [left.x1]: false,
  [left.x2]: true,
  [left.x3]: true,
  [left.y]: true,
  [left.y2]: true,
  [left.z]: false,
  [left.w]: false,
});

describe('the upgrade to migration 0064 from the database as 0063 left it', () => {
  // Break caught: an upgrade that is clean on a fresh install and wrong on a database that holds the old marks, taken in the order the
  // procedure documents: a check that cannot see them or that changes data by looking, a reconciliation that does not work under the guard
  // of the old behavior (the only one in force when it is documented to run), one that reaches a request it should not (a cancelled request
  // and its decision, a request that a later manifest with a rider holds), a migration that repairs or breaks a mark it was never asked to.
  it('checks, reconciles under the guard of 0063, and only then migrates, in the documented order', async () => {
    const built = await builtBefore(NEW_FROM);
    const { admin, target } = built;
    try {
      const left = await leaveTheOldMarks(admin);
      expect(await enforcement(admin)).toEqual(AS_0063_LEFT_IT);
      expect(await marksOf(admin, left.all)).toEqual(asLeft(left));

      // 1. The check: the leavings are found, and nothing is changed by looking.
      const asFound = await rowsOf(admin, left.all);
      const first = await runCommitmentMarks(admin, { reconcile: false });
      expect(first.consistent).toBe(false);
      expect(first.reconciled).toBeUndefined();
      expect(first.before).toMatchObject({
        requestsTable: true,
        claimTables: true,
        confirmed: 6,
        keptMarked: 1,
      });
      expect(ids(first.before.stale)).toEqual([left.x1, left.w].toSorted());
      expect(ids(first.before.missing)).toEqual([left.y2]);
      expect(await rowsOf(admin, left.all)).toEqual(asFound);

      // 2. The reconciliation, with the migration NOT applied: it runs under the guard of the old behavior, which it is documented to run
      // under, and puts right the confirmed requests that disagree with their claims, in both directions, and nothing else.
      const done = await runCommitmentMarks(admin, { reconcile: true });
      expect(await enforcement(admin)).toEqual(AS_0063_LEFT_IT);
      expect(done.consistent).toBe(true);
      expect(ids(done.reconciled?.lowered ?? [])).toEqual([left.x1, left.w].toSorted());
      expect(ids(done.reconciled?.raised ?? [])).toEqual([left.y2]);
      expect(await marksOf(admin, left.all)).toEqual(asReconciled(left));
      const reconciled = await rowsOf(admin, left.all);
      // x3 (cancelled after assignment, charged) and the requests that already agreed are exactly as they were, every column and the version.
      for (const id of [left.x2, left.x3, left.y, left.z])
        expect(reconciled[id]).toEqual(asFound[id]);
      expect(reconciled[left.x3]?.cancellation_charge_outcome).toBe('APPLIED');
      // The requests that were put right changed their mark and the version the database moves with it, so a view read before is refused, and
      // nothing else.
      for (const id of [left.x1, left.w, left.y2]) {
        expect(differing(asFound[id] ?? {}, reconciled[id] ?? {})).toEqual([
          'rider_assigned',
          'version',
        ]);
        expect(reconciled[id]?.version).toBe(Number(asFound[id]?.version) + 1);
      }
      expect(isConsistent(await checkCommitmentMarks(admin))).toBe(true);

      // 3. The migration applies on the reconciled data and changes no request. It replaces the guard and adds the release policy.
      expect((await runMigrations({ url: target.urlFor(MIGRATION_ROLE) })).applied).toBe(
        migrationsFrom(NEW_FROM),
      );
      expect(await enforcement(admin)).toEqual({
        guard: '0064',
        guardTrigger: 'O',
        releasePolicy: true,
      });
      expect(await rowsOf(admin, left.all)).toEqual(reconciled);

      // 4. The check again: the database agrees with its claims, and a reconciliation that is asked for finds nothing to do.
      const last = await runCommitmentMarks(admin, { reconcile: true });
      expect(last.consistent).toBe(true);
      expect(last.reconciled).toBeUndefined();
      expect(last.before).toMatchObject({ confirmed: 6, keptMarked: 1, stale: [], missing: [] });
      expect(await rowsOf(admin, left.all)).toEqual(reconciled);
    } finally {
      await built.done();
    }
  }, 120_000);

  // Break caught: a recovery that does not work. A database that was migrated before it was checked (the order the procedure forbids, taken by
  // mistake, or an environment that migrates by itself) must still be checked and put right, under the guard the migration installed: the
  // migration repaired nothing, the check finds the same leavings, and the reconciliation works with the new guard in force.
  it('still checks and reconciles a database that was migrated before it was checked, under the guard 0064 installed', async () => {
    const built = await builtBefore(NEW_FROM);
    const { admin, target } = built;
    try {
      const left = await leaveTheOldMarks(admin);
      const asFound = await rowsOf(admin, left.all);

      // The migration applies with the old marks present, and repairs none of them.
      expect((await runMigrations({ url: target.urlFor(MIGRATION_ROLE) })).applied).toBe(
        migrationsFrom(NEW_FROM),
      );
      expect(await enforcement(admin)).toEqual({
        guard: '0064',
        guardTrigger: 'O',
        releasePolicy: true,
      });
      expect(await rowsOf(admin, left.all)).toEqual(asFound);
      expect(await marksOf(admin, left.all)).toEqual(asLeft(left));

      const checked = await checkCommitmentMarks(admin);
      expect(ids(checked.stale)).toEqual([left.x1, left.w].toSorted());
      expect(ids(checked.missing)).toEqual([left.y2]);

      const done = await runCommitmentMarks(admin, { reconcile: true });
      expect(done.consistent).toBe(true);
      expect(ids(done.reconciled?.lowered ?? [])).toEqual([left.x1, left.w].toSorted());
      expect(ids(done.reconciled?.raised ?? [])).toEqual([left.y2]);
      expect(await marksOf(admin, left.all)).toEqual(asReconciled(left));
      const reconciled = await rowsOf(admin, left.all);
      for (const id of [left.x2, left.x3, left.y, left.z])
        expect(reconciled[id]).toEqual(asFound[id]);
      expect(reconciled[left.x3]?.cancellation_charge_outcome).toBe('APPLIED');
      for (const id of [left.x1, left.w, left.y2]) {
        expect(reconciled[id]?.version).toBe(Number(asFound[id]?.version) + 1);
      }

      // Done, and done again changes nothing.
      expect(isConsistent(await checkCommitmentMarks(admin))).toBe(true);
      const again = await runCommitmentMarks(admin, { reconcile: true });
      expect(again.reconciled).toBeUndefined();
      expect(again.consistent).toBe(true);
      expect(await rowsOf(admin, left.all)).toEqual(reconciled);
    } finally {
      await built.done();
    }
  }, 120_000);

  // Break caught: a procedure that touches a database that needs nothing (the commonest case, the owner's development database today): a
  // reconciliation that moves a version or a mark of a request that agrees with its claim, or a migration that does not apply on it.
  it('has nothing to reconcile in a database whose marks already agree, and migrates it as it is', async () => {
    const built = await builtBefore(NEW_FROM);
    const { admin, target } = built;
    try {
      const vendor = await insertVendor(admin, vendorRow({ hubId: HUB_A }));
      const confirmed = async (): Promise<string> =>
        (
          await insertPickupRequest(
            admin,
            pickupRequestRow(vendor.organizationId, HUB_A, { state: 'CONFIRMED' }),
          )
        ).id;
      const [held, free, returned] = [await confirmed(), await confirmed(), await confirmed()];
      const rider = (await insertRider(admin, riderRow({ hubId: HUB_A }))).id;
      const onRun = await insertManifest(admin, manifestRow(HUB_A, { assignedRiderId: rider }));
      const cancelled = await insertManifest(
        admin,
        manifestRow(HUB_A, { state: 'CANCELLED', assignedRiderId: rider }),
      );
      await insertStop(admin, stopRow(onRun, held, 1));
      await insertStop(
        admin,
        stopRow(cancelled, returned, 1, {
          state: 'SKIPPED',
          releasedAt: new Date('2026-11-03T10:00:00Z'),
        }),
      );
      await admin.query(`update pickup_request set rider_assigned = true where id = $1`, [held]);
      const everyone = [held, free, returned];
      const asFound = await rowsOf(admin, everyone);

      const first = await runCommitmentMarks(admin, { reconcile: true });
      expect(first.consistent).toBe(true);
      expect(first.reconciled).toBeUndefined();
      expect(first.before).toMatchObject({ confirmed: 3, keptMarked: 0, stale: [], missing: [] });
      expect(await rowsOf(admin, everyone)).toEqual(asFound);

      expect((await runMigrations({ url: target.urlFor(MIGRATION_ROLE) })).applied).toBe(
        migrationsFrom(NEW_FROM),
      );
      expect(await rowsOf(admin, everyone)).toEqual(asFound);
      expect(isConsistent(await checkCommitmentMarks(admin))).toBe(true);
    } finally {
      await built.done();
    }
  }, 120_000);

  // Break caught: a database that has not got the manifest tables yet (the owner's development database, today) read as inconsistent, or
  // as consistent for a reason that is not true. No manifest can hold a request there, so any mark on a confirmed request is one nothing
  // explains.
  it('reads a database before the manifest tables as having nothing that can hold a request', async () => {
    const built = await builtBefore(58);
    try {
      const vendor = await insertVendor(built.admin, vendorRow({ hubId: HUB_A }));
      const confirmed = async (): Promise<string> =>
        (
          await insertPickupRequest(
            built.admin,
            pickupRequestRow(vendor.organizationId, HUB_A, { state: 'CONFIRMED' }),
          )
        ).id;
      const [one, two] = [await confirmed(), await confirmed()];

      const clean = await runCommitmentMarks(built.admin, { reconcile: false });
      expect(clean.consistent).toBe(true);
      expect(clean.before).toMatchObject({
        requestsTable: true,
        claimTables: false,
        confirmed: 2,
        keptMarked: 0,
      });

      await built.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
        one,
      ]);
      const dirty = await runCommitmentMarks(built.admin, { reconcile: true });
      expect(ids(dirty.before.stale)).toEqual([one]);
      expect(ids(dirty.reconciled?.lowered ?? [])).toEqual([one]);
      expect(dirty.consistent).toBe(true);
      const left = await built.admin.query<{ id: string; rider_assigned: boolean }>(
        `select id, rider_assigned from pickup_request where id = any($1::uuid[]) order by id`,
        [[one, two]],
      );
      expect(left.rows.every((row) => !row.rider_assigned)).toBe(true);
    } finally {
      await built.done();
    }
  }, 120_000);

  it('has nothing to check in a database that has no pickup requests yet', async () => {
    const built = await builtBefore(45);
    try {
      const report = await checkCommitmentMarks(built.admin);
      expect(report).toMatchObject({ requestsTable: false, claimTables: false, confirmed: 0 });
      expect(isConsistent(report)).toBe(true);
    } finally {
      await built.done();
    }
  }, 120_000);
});

describe('the built commands, run in the order the procedure documents', () => {
  beforeAll(requireBuild);
  afterEach(killAll);

  // Break caught: a procedure that works as functions and not as the commands the owner runs, in the order the owner runs them (stop, build,
  // `db:commitment-marks`, record, `db:commitment-marks --reconcile`, `db:migrate`): an argument, a safety rule, a connection, an exit code or
  // a line that differs from what the library does, a command that prints a credential, or a migration that does not apply on what the
  // reconciliation left. The exit code is what the owner reads: 2 means the database does not agree with its claims, 0 that it does.
  it('checks (exit 2), reconciles (exit 0), migrates and checks again (exit 0), changing only what each step is for', async () => {
    const built = await builtBefore(NEW_FROM);
    const { admin, target } = built;
    try {
      const left = await leaveTheOldMarks(admin);
      const settings = target.settings;
      const local = {
        MELARC_PG_HOST: settings.host,
        MELARC_PG_PORT: String(settings.port),
        MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
        MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
        MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
      };
      const asFound = await rowsOf(admin, left.all);
      expect(await enforcement(admin)).toEqual(AS_0063_LEFT_IT);

      // `pnpm --filter @melarc/api run db:commitment-marks <database>`: says what disagrees and how to put it right, and changes nothing.
      const checked = await run(DB_COMMITMENT_MARKS, local, [target.name], 40_000);
      expect(checked.code, checked.stderr).toBe(2);
      expect(checked.stdout).toContain(
        'stale marks (marked, held by no manifest that has a rider): 2',
      );
      expect(checked.stdout).toContain(
        'missing marks (held by a manifest that has a rider, not marked): 1',
      );
      for (const id of [left.x1, left.w, left.y2]) expect(checked.stdout).toContain(id);
      expect(checked.stdout).toContain('result: NOT consistent');
      expect(checked.stderr).toBe('');
      expect(await rowsOf(admin, left.all)).toEqual(asFound);

      // `... --reconcile`, with the migration not applied: under the guard of 0063.
      const reconciled = await run(
        DB_COMMITMENT_MARKS,
        local,
        [target.name, '--reconcile'],
        40_000,
      );
      expect(reconciled.code, reconciled.stderr).toBe(0);
      expect(reconciled.stdout).toContain('reconciled: lowered 2, raised 1');
      expect(reconciled.stdout).toContain('result: consistent after reconciling');
      expect(reconciled.stderr).toBe('');
      expect(await enforcement(admin)).toEqual(AS_0063_LEFT_IT);
      expect(await marksOf(admin, left.all)).toEqual(asReconciled(left));
      const afterReconciling = await rowsOf(admin, left.all);
      for (const id of [left.x2, left.x3, left.y, left.z]) {
        expect(afterReconciling[id]).toEqual(asFound[id]);
      }

      // `pnpm --filter @melarc/api run db:migrate`, aimed at the database as a deployment aims it.
      const pending = migrationsFrom(NEW_FROM);
      const migrated = await run(
        DB_MIGRATE,
        { DATABASE_MIGRATION_URL: target.urlFor(MIGRATION_ROLE) },
        [],
        60_000,
      );
      expect(migrated.code, migrated.stderr).toBe(0);
      expect(migrated.stdout).toContain(
        `applied ${String(pending)} migration${pending === 1 ? '' : 's'}`,
      );
      expect((await enforcement(admin)).releasePolicy).toBe(true);
      expect(await rowsOf(admin, left.all)).toEqual(afterReconciling);

      // The check once more, as the last line of the record: the database agrees with its claims.
      const again = await run(DB_COMMITMENT_MARKS, local, [target.name], 40_000);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain('result: consistent');
      expect(again.stdout).not.toContain('NOT consistent');

      for (const finished of [checked, reconciled, migrated, again]) {
        const printed = finished.stdout + finished.stderr;
        for (const secret of [
          settings.adminPassword,
          settings.migrationPassword,
          settings.runtimePassword,
        ]) {
          expect(printed).not.toContain(secret);
        }
        expect(printed).not.toMatch(/postgres:\/\//);
      }
    } finally {
      await built.done();
    }
  }, 240_000);
});
