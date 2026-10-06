import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { CATALOG_CHECKS, catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { lintMigrationSql } from '../../src/tools/database/migration-lint.js';
import { OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

describe('the catalogue invariants', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: true });
  });
  afterAll(async () => {
    await database.drop();
  });

  const violations = () =>
    withClient(database.urlFor('postgres'), (client) => catalogViolations(client));

  // Break caught: a migration that leaves an object the design forbids, however the SQL that made it was written.
  // This is the check that does not read the SQL.
  it('hold for everything the committed migrations created', async () => {
    expect(await violations()).toEqual([]);
  });

  // The proof that each check can fire. Each case makes one thing wrong in the disposable database, as its
  // administrator, and the check must name it. A check that cannot fire passes every migration and means nothing.
  describe('each one finds what it is for', () => {
    const cases: [string, string, RegExp][] = [
      [
        'a table owned by someone else',
        `create table public.not_ours (id int); alter table public.not_ours enable row level security;
         alter table public.not_ours force row level security;`,
        /table public\.not_ours is owned by postgres/,
      ],
      [
        'a table without row-level security',
        `create table public.open_table (id int); alter table public.open_table owner to ${OWNER_ROLE};`,
        /table public\.open_table does not have row-level security enabled and forced/,
      ],
      [
        'a table with row-level security that is not forced',
        `create table public.not_forced (id int); alter table public.not_forced owner to ${OWNER_ROLE};
         alter table public.not_forced enable row level security;`,
        /table public\.not_forced does not have row-level security enabled and forced/,
      ],
      [
        'an unlogged table',
        `create unlogged table public.volatile_table (id int); alter table public.volatile_table owner to ${OWNER_ROLE};
         alter table public.volatile_table enable row level security;
         alter table public.volatile_table force row level security;`,
        /table public\.volatile_table is not a permanent table/,
      ],
      [
        'a policy that names a role',
        `create table public.with_policy (id int); alter table public.with_policy owner to ${OWNER_ROLE};
         alter table public.with_policy enable row level security; alter table public.with_policy force row level security;
         create policy by_role on public.with_policy to ${API_RUNTIME_ROLE} using (true);`,
        /policy by_role on public\.with_policy applies to roles/,
      ],
      [
        'a table that PUBLIC can read',
        `create table public.shared (id int); alter table public.shared owner to ${OWNER_ROLE};
         alter table public.shared enable row level security; alter table public.shared force row level security;
         grant select on public.shared to public;`,
        /PUBLIC holds SELECT on public\.shared/,
      ],
      [
        'a function PUBLIC can execute',
        `create function public.anyone() returns int language sql as 'select 1';
         alter function public.anyone() owner to ${OWNER_ROLE};`,
        /function public\.anyone is executable by PUBLIC/,
      ],
      [
        'a function owned by someone else',
        `create function public.mine() returns int language sql as 'select 1';
         revoke all on function public.mine() from public;`,
        /function public\.mine is owned by postgres/,
      ],
      [
        'a SECURITY DEFINER function with no search_path',
        `create function public.definer() returns int language sql security definer as 'select 1';
         alter function public.definer() owner to ${OWNER_ROLE}; revoke all on function public.definer() from public;`,
        /function public\.definer is SECURITY DEFINER and has no search_path/,
      ],
      [
        'a schema owned by someone else',
        `create schema foreign_schema;`,
        /schema foreign_schema is owned by postgres/,
      ],
      [
        'a schema PUBLIC can create in',
        `create schema open_schema authorization ${OWNER_ROLE}; grant create on schema open_schema to public;`,
        /PUBLIC holds CREATE on schema open_schema/,
      ],
      [
        'default privileges',
        `alter default privileges in schema public grant select on tables to public;`,
        /default privileges are set for role/,
      ],
      [
        'a melarc.* setting stored on the database',
        `alter database %DATABASE% set melarc.principal_type = 'SYSTEM';`,
        /a setting melarc\.principal_type=SYSTEM is stored/,
      ],
      [
        'a sequence owned by someone else',
        `create sequence public.counter;`,
        /sequence public\.counter is owned by postgres/,
      ],
    ];

    it.each(cases)('%s', async (_label, statement, expected) => {
      const found = await withClient(database.urlFor('postgres'), async (client) => {
        const name = await scalar<string>(client, 'select current_database()');
        await client.query('begin');
        try {
          await client.query(statement.replace('%DATABASE%', `"${name}"`));
          return await catalogViolations(client);
        } finally {
          await client.query('rollback');
        }
      });

      expect(found.filter((line) => expected.test(line))).not.toEqual([]);
    });

    // Break caught: a check in the list that no case above exercises, which could then be broken without a test failing.
    it('has a case for every check', () => {
      expect(cases.length).toBeGreaterThanOrEqual(CATALOG_CHECKS.length);
    });
  });

  // Break caught: the first product migration. Everything above is about the foundation's own objects; a table
  // written the way the migration lint asks for, applied through the runner as the migration role, has to pass the
  // lint and the invariants both, or one of them is wrong about what the other accepts.
  it('hold for a table written as the lint requires, applied through the migration runner', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'melarc-product-migration-'));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      const sqlText = [
        'CREATE TABLE public."widgets" ("id" uuid PRIMARY KEY, "hub_id" uuid NOT NULL);',
        'ALTER TABLE public."widgets" OWNER TO melarc_owner;',
        'ALTER TABLE public."widgets" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE public."widgets" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY widgets_by_hub ON public."widgets" USING (hub_id = ANY (melarc.authorized_hub_ids()));',
        'GRANT SELECT, INSERT, UPDATE ON public."widgets" TO melarc_api_runtime;',
      ].join(`\n--> statement-breakpoint\n`);
      writeFileSync(join(folder, '0001_widgets.sql'), sqlText);
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      const last = journal.entries.at(-1);
      if (last === undefined) throw new Error('no migration in the folder');
      journal.entries.push({
        idx: journal.entries.length,
        version: '7',
        when: last.when + 1000,
        tag: '0001_widgets',
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));

      expect(lintMigrationSql(sqlText)).toEqual([]);
      expect((await runMigrations({ url: database.urlFor(MIGRATION_ROLE), folder })).applied).toBe(
        1,
      );

      expect(await violations()).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await withClient(database.urlFor('postgres'), (client) =>
        client.query(
          'drop table if exists public.widgets; delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)',
        ),
      );
    }
  });

  // Break caught: the checks finding things after the rollbacks above, which would mean a case changed the database.
  it('still hold after the cases have run: they changed nothing', async () => {
    expect(await violations()).toEqual([]);
  });
});
