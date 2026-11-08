import type pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { checkOpenStops, isClear } from '../../src/tools/database/open-stop-check.js';
import { runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { DB_MIGRATE, DB_OPEN_STOPS, killAll, requireBuild, run } from '../support/api-process.js';
import { builtBefore, type Built } from './support/history-before.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { HUB_A } from './support/rls-fixture.js';
import { clientFor } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * The upgrade to migration 0065 (S1.22; the Product Owner's decision of 2 November 2026: run the documented preflight with sufficient visibility,
 * and stop the migration if it finds a violation). The migration adds a constraint, checked at the end of a transaction, that a cancelled
 * request and a stop that holds it and is still to be worked never coexist. It checks what a transaction writes and not what is already there, so
 * a pair that exists is found by the first write to either row; the check finds it first. Against databases built before the migration by the real
 * runner:
 *
 * - **The check finds exactly the pairs the rule forbids**, and none of the controls that are not (a cancelled request whose stop was skipped, a
 *   stop whose claim was released, a confirmed request, a stop already collected).
 * - **It needs the administrator's login**: the migration login reads these tables through row-level security and finds nothing, which would pass
 *   for the wrong reason.
 * - **It changes nothing**, and the command it is run by is read-only by construction (a read-only transaction, no flag that writes).
 * - **What it protects against is real**: a pair left in place and migrated over refuses the first write to its stop, at the end of the
 *   transaction.
 * - **The command is the one the owner runs**, from the build, with the exit code the owner reads: 2 for a pair, 0 when clear.
 */
const NEW_FROM = 65;

interface Pairs {
  /** The two forbidden pairs: a pending stop and an arrived stop, each held by a cancelled request. */
  readonly violating: readonly { readonly request: string; readonly stop: string }[];
  readonly controls: readonly string[];
}

async function leavePairs(admin: pg.Client): Promise<Pairs> {
  const vendor = await insertVendor(admin, vendorRow({ hubId: HUB_A }));
  const request = async (state: 'CANCELLED' | 'CONFIRMED'): Promise<string> =>
    (await insertPickupRequest(admin, pickupRequestRow(vendor.organizationId, HUB_A, { state })))
      .id;
  const manifest = await insertManifest(admin, manifestRow(HUB_A));
  const released = new Date('2026-11-03T10:00:00Z');
  let place = 0;
  const stop = async (
    requestId: string,
    over: Parameters<typeof stopRow>[3] = {},
  ): Promise<string> => {
    place += 1;
    return (await insertStop(admin, stopRow(manifest, requestId, place, over))).id;
  };

  const pending = await request('CANCELLED');
  const arrived = await request('CANCELLED');
  const skipped = await request('CANCELLED');
  const letGo = await request('CANCELLED');
  const collected = await request('CANCELLED');
  const confirmed = await request('CONFIRMED');
  const violating = [
    { request: pending, stop: await stop(pending, { state: 'PENDING' }) },
    { request: arrived, stop: await stop(arrived, { state: 'ARRIVED' }) },
  ];
  // The controls: what a cancellation leaves (a skipped stop), a claim released, a request that is not cancelled, a stop already worked.
  await stop(skipped, { state: 'SKIPPED' });
  await stop(letGo, { state: 'PENDING', releasedAt: released });
  await stop(confirmed, { state: 'PENDING' });
  await stop(collected, { state: 'COLLECTED' });
  return { violating, controls: [skipped, letGo, confirmed, collected] };
}

const wholeTables = async (admin: pg.Client): Promise<string> =>
  JSON.stringify([
    (await admin.query('select * from pickup_stop order by id')).rows,
    (await admin.query('select * from pickup_request order by id')).rows,
    (await admin.query('select * from pickup_manifest order by id')).rows,
  ]);

describe('the check finds the pairs the constraint of migration 0065 would not', () => {
  let built: Built | undefined;
  afterEach(async () => {
    await built?.done();
    built = undefined;
  });

  // Break caught: a check that misses a pair (a pending stop or an arrived one), or reports a control: a cancelled request whose stop the
  // cancellation skipped, a stop whose claim is released, a request that is not cancelled, a stop already collected.
  it('finds a pending and an arrived stop held by a cancelled request, and nothing else', async () => {
    built = await builtBefore(NEW_FROM);
    const left = await leavePairs(built.admin);

    const report = await checkOpenStops(built.admin);
    expect(report.tables).toBe(true);
    expect(report.open.map((each) => each.requestId).toSorted()).toEqual(
      left.violating.map((pair) => pair.request).toSorted(),
    );
    expect(report.open.map((each) => each.stopId).toSorted()).toEqual(
      left.violating.map((pair) => pair.stop).toSorted(),
    );
    expect(report.open.map((each) => each.stopState).toSorted()).toEqual(['ARRIVED', 'PENDING']);
    for (const control of left.controls) {
      expect(report.open.map((each) => each.requestId)).not.toContain(control);
    }
    expect(report.open.every((each) => each.manifestCode.length > 0)).toBe(true);
    expect(isClear(report)).toBe(false);
  });

  it('says clear for a database that holds none, and for one that holds only the controls', async () => {
    built = await builtBefore(NEW_FROM);
    expect(isClear(await checkOpenStops(built.admin))).toBe(true);
    const left = await leavePairs(built.admin);
    await built.admin.query(`delete from pickup_stop where pickup_request_id = any($1::uuid[])`, [
      left.violating.map((pair) => pair.request),
    ]);
    expect(isClear(await checkOpenStops(built.admin))).toBe(true);
  });

  // Break caught: the reason this is a command and not a step of the migration. The migration's login reads these tables through forced
  // row-level security and sees no row; a check made there would say "clear" over a database that holds a pair.
  it('finds nothing as the migration login, which is why it is made as the administrator', async () => {
    built = await builtBefore(NEW_FROM);
    await leavePairs(built.admin);
    const migrator = clientFor(built.target.urlFor(MIGRATION_ROLE));
    await migrator.connect();
    try {
      expect((await checkOpenStops(migrator)).open).toEqual([]);
    } finally {
      await migrator.end();
    }
    expect((await checkOpenStops(built.admin)).open).toHaveLength(2);
  });

  // Break caught: a check that fails on a database from before the tables exist, which is a database it must be able to say "clear" about:
  // before the pickup request (migration 0045) and between it and the manifests (migration 0058).
  it.each([[45], [58]])(
    'says clear, and that there is nothing to check, for a database built before migration %i',
    async (from) => {
      built = await builtBefore(from);
      const report = await checkOpenStops(built.admin);
      expect(report).toMatchObject({ tables: false, open: [] });
      expect(isClear(report)).toBe(true);
    },
  );

  // Break caught: a check that writes anything, a row, a lock that outlives it, a sequence of the version.
  it('changes nothing by looking', async () => {
    built = await builtBefore(NEW_FROM);
    await leavePairs(built.admin);
    const before = await wholeTables(built.admin);
    await checkOpenStops(built.admin);
    expect(await wholeTables(built.admin)).toBe(before);
  });

  // Break caught: a preflight that is not worth running: the constraint of the migration not refusing what is left. A pair migrated over is
  // found by the first write to its stop, at the end of that transaction, so the pair has to be put right before the migration or the
  // office's next act on that stop fails.
  it('is worth running: migrated over, a pair refuses the first write to its stop', async () => {
    built = await builtBefore(NEW_FROM);
    const left = await leavePairs(built.admin);
    await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) });
    const stop = left.violating[0]?.stop ?? '';
    const refused = await built.admin
      .query(`update pickup_stop set sequence = sequence where id = $1`, [stop])
      .then(
        () => undefined,
        (error: unknown) => error as { code?: string; constraint?: string },
      );
    expect(refused?.code).toBe('23514');
    expect(refused?.constraint).toBe('pickup_stop_cancelled_request');
    // And the check still finds it after the migration: it is a fact about the rows and not about the version of the schema.
    expect((await checkOpenStops(built.admin)).open.map((each) => each.stopId)).toContain(stop);
  });
});

describe('the built command, run as the owner runs it', () => {
  beforeAll(requireBuild);
  afterEach(killAll);

  // Break caught: a procedure that works as a function and not as the command: an argument, a safety rule, a connection, an exit code or a
  // line that differs from what the library does, a command that prints a credential or writes anything, or a migration that does not apply
  // once the pairs are put right. The exit code is what the owner reads: 2 means a pair is there and the migration must not be applied.
  it('exits 2 over a pair and lists it, exits 0 once it is resolved, and then the migration applies', async () => {
    const built = await builtBefore(NEW_FROM);
    try {
      const left = await leavePairs(built.admin);
      const settings = built.target.settings;
      const local = {
        MELARC_PG_HOST: settings.host,
        MELARC_PG_PORT: String(settings.port),
        MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
        MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
        MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
      };
      const asFound = await wholeTables(built.admin);

      const found = await run(DB_OPEN_STOPS, local, [built.target.name], 40_000);
      expect(found.code, found.stderr).toBe(2);
      expect(found.stdout).toContain('cancelled requests that still hold a stop to be worked: 2');
      for (const pair of left.violating) {
        expect(found.stdout).toContain(pair.request);
        expect(found.stdout).toContain(pair.stop);
      }
      expect(found.stdout).toContain('result: NOT clear');
      expect(found.stdout).toMatch(/do not apply migration 0065/i);
      expect(found.stderr).toBe('');
      expect(await wholeTables(built.admin)).toBe(asFound);

      // The pairs are put right by the stop the cancellation would have skipped (what the rule's own answer is), here as the administrator.
      await built.admin.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(),
                skip_snapshot = jsonb_build_object('reason_code', 'REQUEST_CANCELLED', 'label', 'Request cancelled', 'skipped_at', now())
          where id = any($1::uuid[])`,
        [left.violating.map((pair) => pair.stop)],
      );
      const clear = await run(DB_OPEN_STOPS, local, [built.target.name], 40_000);
      expect(clear.code, clear.stderr).toBe(0);
      expect(clear.stdout).toContain('cancelled requests that still hold a stop to be worked: 0');
      expect(clear.stdout.trimEnd().split('\n').at(-1)).toBe('result: clear');

      const migrated = await run(
        DB_MIGRATE,
        { DATABASE_MIGRATION_URL: built.target.urlFor(MIGRATION_ROLE) },
        [],
        60_000,
      );
      expect(migrated.code, migrated.stderr).toBe(0);

      for (const finished of [found, clear, migrated]) {
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

  // Break caught: a flag that writes, a database that is not a development or test one reaching the server, or a second database.
  it('refuses an option, a second database and a database that is not disposable, before it connects', async () => {
    const attempts: [string[], RegExp][] = [
      [['melarc_dev', '--reconcile'], /unknown option/],
      [['melarc_dev', 'melarc_other'], /one database at a time/],
      [['production'], /refusing to act on database/],
    ];
    for (const [args, message] of attempts) {
      const refused = await run(
        DB_OPEN_STOPS,
        {
          MELARC_PG_HOST: '127.0.0.1',
          MELARC_PG_PORT: '1',
          MELARC_PG_ADMIN_PASSWORD: 'unused-value-for-a-refused-command',
          MELARC_PG_MIGRATION_PASSWORD: 'unused-value-for-a-refused-command',
          MELARC_PG_RUNTIME_PASSWORD: 'unused-value-for-a-refused-command',
        },
        args,
        40_000,
      );
      expect(refused.code, args.join(' ')).toBe(1);
      expect(refused.stderr, args.join(' ')).toMatch(message);
      expect(refused.stdout).toBe('');
    }
  }, 120_000);
});
