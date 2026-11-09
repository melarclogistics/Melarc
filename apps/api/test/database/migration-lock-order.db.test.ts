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
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
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
    expect((await runMigrations({ url: built.target.urlFor(MIGRATION_ROLE) })).applied).toBe(0);
    const fingerprint = `select md5(coalesce(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, ''), ';' order by p.proname), ''))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'melarc'`;
    const fromNothing = await createTestDatabase();
    try {
      const now = await scalar(built.admin, fingerprint);
      const then = await withClient(fromNothing.urlFor('postgres'), (client) =>
        scalar(client, fingerprint),
      );
      expect(now).toBe(then);
    } finally {
      await fromNothing.drop();
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

  // Break caught: a key taken in a way the reader cannot see (the schema in quotes), so that the run's first statements did not take it. The run notices that the
  // file took a key it had not taken first, and takes everything back.
  it('takes everything back when a file takes a key the run had not taken first', async () => {
    withNewMigration(
      `CREATE TABLE public.a_new_table (id integer);--> statement-breakpoint\nDO $new$ BEGIN PERFORM "melarc"."lock_policy_bundle"('${SEEDED_BUNDLE}'); END $new$;`,
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
