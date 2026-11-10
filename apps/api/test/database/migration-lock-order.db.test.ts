import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  bundleLockKey,
  fixedLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { MigrationLockOrderError } from '../../src/tools/database/policy-keys.js';
import {
  MIGRATIONS_FOLDER,
  MigrationKeyWaitError,
  runMigrations,
} from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { builtBefore, historyBefore, type Built } from './support/history-before.js';
import { clientFor, createTestDatabase, scalar, withClient } from './support/test-database.js';

/**
 * The order of a run of migrations (run 4, Stage 1, item 3). The migrator applies every pending migration in one transaction, so a table lock one file takes
 * (an index build on `pickup_request`, an `ALTER TABLE audit_event`) is held until the whole run commits. The files after it that take a policy key
 * (0075 to 0079) then waited for a key that an application transaction holds, and that transaction was waiting for the table: a deadlock. The runner takes every
 * key the run's files name before its first statement, so the application transaction and the migrator can no longer wait for each other.
 */
const FIRST_NEW = 74;
const COMMITTED = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql')).length;
const SEEDED_BUNDLE = '5eed0001-0000-4000-8000-000000000003';

async function until(
  condition: () => Promise<boolean>,
  what: string,
  within = 20_000,
): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > within) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * What the schema is, as the catalogue says it, section by section (tables with their owner, row-level security and privileges, columns, constraints, indexes, policies,
 * grants, triggers, functions with their privileges, types), as one JSON line for each row in a fixed order. The data is not in it.
 */
const SCHEMAS = "('public', 'melarc', 'drizzle')";
const SCHEMA_SECTIONS: Readonly<Record<string, string>> = {
  tables: `select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ${SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'S') order by 1, 2`,
  columns: `select table_schema, table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default, is_generated, generation_expression
              from information_schema.columns where table_schema in ${SCHEMAS} order by 1, 2, 4`,
  constraints: `select c.conrelid::regclass::text as on_table, c.conname, c.contype, pg_get_constraintdef(c.oid) as definition
                  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${SCHEMAS} order by 1, 2`,
  indexes: `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${SCHEMAS} order by 1, 2, 3`,
  policies: `select schemaname, tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
               from pg_policies where schemaname in ${SCHEMAS} order by 1, 2, 3`,
  grants: `select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants where table_schema in ${SCHEMAS} order by 1, 2, 3, 4`,
  columnGrants: `select grantee, table_schema, table_name, column_name, privilege_type from information_schema.role_column_grants where table_schema in ${SCHEMAS} order by 1, 2, 3, 4, 5`,
  triggers: `select t.tgrelid::regclass::text as on_table, t.tgname, pg_get_triggerdef(t.oid) as definition from pg_trigger t where not t.tgisinternal order by 1, 2`,
  functions: `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_functiondef(p.oid) as definition, p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${SCHEMAS} and p.prokind in ('f', 'p') order by 1, 2, 3`,
  types: `select n.nspname, t.typname, t.typtype, (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels
            from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname in ${SCHEMAS} and t.typtype in ('e', 'd') order by 1, 2`,
};

async function schemaOf(client: pg.Client): Promise<Record<string, string[]>> {
  const sections: Record<string, string[]> = {};
  for (const [section, text] of Object.entries(SCHEMA_SECTIONS)) {
    const { rows } = await client.query<Record<string, unknown>>(text);
    sections[section] = rows.map((row) => JSON.stringify(row));
  }
  return sections;
}

describe('the chain applied from a database at 0073', () => {
  let built: Built;
  beforeEach(async () => {
    built = await builtBefore(FIRST_NEW);
  });
  afterEach(async () => {
    await built.done();
  });

  // Break caught: a run that cannot continue from the history main already has, which is what every environment that exists is: the files from 0074 on are
  // applied in one run, and the database ends up as a database made from nothing in one go.
  it('applies 0074 to the last, once, and ends as a database built from nothing', async () => {
    const result = await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) });

    expect(result.applied).toBe(COMMITTED - FIRST_NEW);
    // The run says how long it took and how long it held the keys (the stall of the application), and took them at the first attempt: nothing was in its way.
    expect(result.keyAttempts).toBe(1);
    expect(result.keysHeldMs).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(result.keysHeldMs);
    const current = await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) });
    expect(current).toMatchObject({ applied: 0, keysHeldMs: 0, keyAttempts: 0 });
    expect((await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) })).applied).toBe(0);
    // The whole schema, not only the functions (run 5, Stage 1.5): a migration that left a table, a column, an index, a policy, a grant or a trigger different from what
    // the files build in one go would not have been seen by a comparison of the functions.
    const fromNothing = await createTestDatabase();
    try {
      const now = await schemaOf(built.admin);
      const then = await withClient(fromNothing.urlFor('postgres'), (client) => schemaOf(client));
      for (const [section, rows] of Object.entries(then)) {
        expect(now[section], `the ${section} of the database that was upgraded`).toEqual(rows);
      }
      // A comparison of nothing with nothing passes: every section holds what a schema of this size holds.
      expect(then.tables?.length).toBeGreaterThan(35);
      expect(then.columns?.length).toBeGreaterThan(400);
      expect(then.indexes?.length).toBeGreaterThan(100);
      expect(then.policies?.length).toBeGreaterThan(150);
      expect(then.grants?.length).toBeGreaterThan(250);
      expect(then.triggers?.length).toBeGreaterThan(40);
      expect(then.functions?.length).toBeGreaterThan(80);
      expect(then.constraints?.length).toBeGreaterThan(400);
    } finally {
      await fromNothing.drop();
    }
  }, 120_000);

  // Break caught (run 5, Stage 1.3): a run that waits for its keys with no bound of its own (behind a transaction that never ends, and with the whole application waiting behind
  // the run), or that gives up with the driver's words and leaves a transaction open. Here a transaction of the application holds a key the run needs (shared) and does not
  // end: the run tries twice, each time for the length of its wait, says in words why it gave up, and applies nothing; the same run goes through once the transaction is gone.
  it('gives up with a clear message when a transaction of the application holds a key it needs, applies nothing, and goes through once it is gone', async () => {
    const application: pg.Client = clientFor(built.target.urlFor('postgres'));
    await application.connect();
    const key = bundleLockKey(SEEDED_BUNDLE);
    try {
      await application.query('begin');
      await application.query(
        `select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_BUNDLE)}, ${String(key)})`,
      );

      const failure = await runMigrations({
        url: built.target.urlFor(MIGRATION_ROLE),
        keyWait: { waitMs: 300, attempts: 2, pauseMs: 20 },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MigrationKeyWaitError);
      expect((failure as MigrationKeyWaitError).message).toContain('2 attempts of 300 ms');
      expect((failure as MigrationKeyWaitError).message).toContain('Nothing was applied');
      // It says how long it waited in all (run 6, Stage 1.1): two attempts of 300 ms, each ended by the server's own lock timeout, and the pause between them; the message and
      // the figure are the same time, to a tenth of a second.
      const waited = failure as MigrationKeyWaitError;
      expect(waited.waitedMs).toBeGreaterThanOrEqual(600);
      expect(waited.message).toContain(
        `after waiting ${(waited.waitedMs / 1000).toFixed(1)} s in all`,
      );
      expect(
        await scalar<string>(built.admin, 'select count(*) from drizzle.__drizzle_migrations'),
      ).toBe(String(FIRST_NEW));
      // Nothing of the run is left behind: no session of the migrator, so no transaction and no key.
      expect(
        await scalar<string>(
          built.admin,
          `select count(*) from pg_stat_activity where datname = current_database() and application_name = 'melarc-migrate'`,
        ),
      ).toBe('0');

      await application.query('commit');
      const result = await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) });
      expect(result.applied).toBe(COMMITTED - FIRST_NEW);
    } finally {
      await application.query('rollback').catch(() => undefined);
      await application.end();
    }
  }, 120_000);

  // Break caught (run 6, Stage 1.1): an attempt that waits as long as the application's own lock timeout, or longer. The run is a waiting exclusive request, and a sign-in or a
  // mutation that asks for the same key (shared) behind it queues behind it. Here a transaction of the application holds the key and does not end, the run waits for it with the
  // wait it has by default (1.5 s, shorter than the application's lock timeout of 2 s), a request of the application then asks for the key under that lock timeout and queues
  // behind the run: when the attempt ends and the run gives up it is served, where an attempt of ten seconds (run 5) would have let its own lock timeout refuse it first.
  it("lets a request of the application that queued behind the run's wait through when the attempt ends, before its own lock timeout", async () => {
    const holder: pg.Client = clientFor(built.target.urlFor('postgres'));
    const queued: pg.Client = clientFor(built.target.urlFor('postgres'));
    await holder.connect();
    await queued.connect();
    const key = bundleLockKey(SEEDED_BUNDLE);
    const waitingForTheKey = (who: string) =>
      scalar<string>(
        built.admin,
        `select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where a.datname = current_database() and l.locktype = 'advisory' and not l.granted and ${who}`,
      );
    let run: ReturnType<typeof runMigrations> | undefined;
    try {
      await holder.query('begin');
      await holder.query(
        `select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_BUNDLE)}, ${String(key)})`,
      );

      run = runMigrations({ url: built.target.urlFor(MIGRATION_ROLE), keyWait: { attempts: 1 } });
      const ended = run.catch((error: unknown) => error);
      await until(
        async () => (await waitingForTheKey("a.application_name = 'melarc-migrate'")) === '1',
        'the run to wait for the key',
      );

      // The application's own request, under the application's own lock timeout (its default, 2 s), queues behind the run.
      await queued.query('begin');
      await queued.query("set local lock_timeout = '2000ms'");
      const asked = performance.now();
      const outcome = queued
        .query(`select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_BUNDLE)}, ${String(key)})`)
        .then(
          () => 'served',
          (error: unknown) => `refused (${(error as { code?: string }).code ?? 'no code'})`,
        );
      await until(
        async () => (await waitingForTheKey("a.application_name <> 'melarc-migrate'")) === '1',
        'the request of the application to queue behind the run',
      );

      expect(await ended).toBeInstanceOf(MigrationKeyWaitError);
      expect(await outcome).toBe('served');
      expect(performance.now() - asked).toBeLessThan(2_000);
    } finally {
      await queued.query('rollback').catch(() => undefined);
      await holder.query('rollback').catch(() => undefined);
      await queued.end();
      await holder.end();
      await run?.catch(() => undefined);
    }
  }, 120_000);

  // Break caught: the deadlock. An application transaction that holds a policy key (shared) and then writes a table is the order the application always takes;
  // the run holds that table (an index build, a table lock) in an earlier file and asks for the key in a later one. The transaction here takes the key, waits
  // until the run is either waiting for it or holding the table, then asks for the table: with the keys first the run is the one waiting, the transaction takes
  // its table and commits, and the run goes on; with the keys in the files the two wait for each other and the server ends one of them.
  it.each([
    [
      'a bundle key and the table an earlier index build holds',
      { klass: AUTH_POLICY_BUNDLE, key: bundleLockKey(SEEDED_BUNDLE) },
      'pickup_request',
      'ShareLock',
    ],
    [
      'a fixed-policy key and the ledger an earlier table lock holds',
      { klass: AUTH_POLICY_FIXED, key: fixedLockKey('VENDOR') },
      'audit_event',
      'AccessExclusiveLock',
    ],
  ])(
    'does not deadlock with an application transaction that holds %s',
    async (_which, key, table, mode) => {
      const application: pg.Client = clientFor(built.target.urlFor('postgres'));
      await application.connect();
      let run: ReturnType<typeof runMigrations> | undefined;
      try {
        await application.query('begin');
        await application.query(
          `select pg_advisory_xact_lock_shared(${String(key.klass)}, ${String(key.key)})`,
        );

        run = runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) });
        run.catch(() => undefined);
        await until(
          async () =>
            await scalar<boolean>(
              built.admin,
              `select exists (
                 select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                  where a.datname = current_database() and a.application_name = 'melarc-migrate'
                    and ((l.locktype = 'advisory' and not l.granted)
                      or (l.locktype = 'relation' and l.granted and l.mode = '${mode}'
                          and l.relation = '${table}'::regclass)))`,
            ),
          'the run to wait for the key or hold the table',
        );
        await application.query(`lock table ${table} in row exclusive mode`);
        await application.query('commit');

        const result = await run;
        expect(result.applied).toBe(COMMITTED - FIRST_NEW);
      } finally {
        await application.query('rollback').catch(() => undefined);
        await application.end();
        await run?.catch(() => undefined);
      }
    },
    120_000,
  );
});

describe('a run whose files take a key it was not told of', () => {
  let folder: string;
  let built: Built;
  beforeEach(async () => {
    built = await builtBefore(FIRST_NEW);
    folder = historyBefore(FIRST_NEW);
  });
  afterEach(async () => {
    rmSync(folder, { recursive: true, force: true });
    await built.done();
  });

  /** The history to 0073 and one more migration, with the statements given. */
  function withNewMigration(sql: string): void {
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = journal.entries.at(-1);
    journal.entries.push({
      idx: FIRST_NEW,
      version: '7',
      when: (last?.when ?? 0) + 1,
      tag: '0074_a_new_one',
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(join(folder, '0074_a_new_one.sql'), sql);
  }

  const tableExists = () =>
    scalar<boolean>(built.admin, "select to_regclass('public.a_new_table') is not null");

  // Break caught: a key named by a variable, which the runner cannot take first, applied all the same: the file would take it in the middle of the run, after the
  // table locks of the files before it. The run is refused before anything is applied.
  it('is refused before anything is applied when a file names a key it cannot say', async () => {
    withNewMigration(
      `CREATE TABLE public.a_new_table (id integer);--> statement-breakpoint\nDO $new$ DECLARE b uuid := gen_random_uuid(); BEGIN PERFORM melarc.lock_policy_keys(ARRAY[b]::uuid[], ARRAY[]::text[]); END $new$;`,
    );

    const failure = await runMigrations({
      url: built.target.urlFor(MIGRATION_ROLE),
      folder,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationLockOrderError);
    expect(await tableExists()).toBe(false);
  }, 120_000);

  // Break caught (run 5, Stage 1.5): the reader failing open. A file whose chunk begins with a function being defined was skipped whole, and a call after it in the same
  // chunk (or one written with a quoted name) was never seen: the file took its key in the middle of the run. The run is refused before anything is applied, with the name
  // of the file. Each form has its own unit test in policy-keys.test.ts; this is the wiring in the real runner.
  it.each([
    [
      'a function being defined and a call in one chunk',
      `CREATE TABLE public.a_new_table (id integer);--> statement-breakpoint\nCREATE FUNCTION public.a_new_function() RETURNS void LANGUAGE sql AS $f$ SELECT 1 $f$; DO $new$ BEGIN PERFORM melarc.lock_policy_keys(ARRAY['${SEEDED_BUNDLE}', gen_random_uuid()]::uuid[], ARRAY[]::text[]); END $new$;`,
    ],
    [
      'a call written with a quoted name',
      `CREATE TABLE public.a_new_table (id integer);--> statement-breakpoint\nDO $new$ BEGIN PERFORM "melarc"."lock_policy_keys"(ARRAY['${SEEDED_BUNDLE}']::uuid[], ARRAY[]::text[]); END $new$;`,
    ],
  ])(
    'is refused before anything is applied, with the name of the file, for %s',
    async (_form, sql) => {
      withNewMigration(sql);

      const failure = await runMigrations({
        url: built.target.urlFor(MIGRATION_ROLE),
        folder,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MigrationLockOrderError);
      expect((failure as MigrationLockOrderError).message).toContain('0074_a_new_one: ');
      expect(await tableExists()).toBe(false);
      expect(
        await scalar<string>(built.admin, 'select count(*) from drizzle.__drizzle_migrations'),
      ).toBe(String(FIRST_NEW));
    },
    120_000,
  );

  // Break caught: a key taken in a way the reader cannot see (the function's name built at run time, so that the text never says it), so that the run's first statements
  // did not take it. The run notices after the file that it took a key it had not taken first, and takes everything back. (This used to be written with a quoted schema;
  // the reader refuses that form up front now, and the check after the file is what remains for the forms nothing can read.)
  it('takes everything back when a file takes a key the run had not taken first', async () => {
    withNewMigration(
      `CREATE TABLE public.a_new_table (id integer);--> statement-breakpoint\nDO $new$ BEGIN EXECUTE format('select %I.%I(%L::uuid)', 'melarc', 'lock_policy_' || 'bundle', '${SEEDED_BUNDLE}'); END $new$;`,
    );

    const failure = await runMigrations({
      url: built.target.urlFor(MIGRATION_ROLE),
      folder,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationLockOrderError);
    expect(await tableExists()).toBe(false);
    expect(
      await scalar<string>(built.admin, 'select count(*) from drizzle.__drizzle_migrations'),
    ).toBe(String(FIRST_NEW));
  }, 120_000);
});
