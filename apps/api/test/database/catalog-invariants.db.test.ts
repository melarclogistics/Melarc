import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import {
  PROVISIONING_ROLE,
  WORKER_CREDENTIAL_DELIVERY_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { CATALOG_CHECKS, catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { lintMigrationSql } from '../../src/tools/database/migration-lint.js';
import { OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { CONTEXT_FIXTURE_SQL, FIXTURE_SQL } from './support/rls-fixture.js';
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
      // The posture of the technical logins (S0.5; SECURITY_DESIGN.md §14.6): what the API's readiness check asks of its own
      // login, asked of each login and of the worker's capability role from the catalogue.
      [
        'a worker login that can create in a schema',
        `grant create on schema melarc to ${WORKER_RUNTIME_ROLE};`,
        /role melarc_worker_runtime is not a safe runtime identity: can_create_in_schema/,
      ],
      [
        'a runtime login that can create in the database',
        `grant create on database %DATABASE% to ${API_RUNTIME_ROLE};`,
        /role melarc_api_runtime is not a safe runtime identity: can_create_in_database/,
      ],
      [
        'a provisioning login that owns a schema',
        `create schema probe_owned authorization ${PROVISIONING_ROLE};`,
        /role melarc_provisioning is not a safe runtime identity: owns_schema/,
      ],
      [
        'a worker login that is a member of the migration identity',
        `grant ${MIGRATION_ROLE} to ${WORKER_RUNTIME_ROLE};`,
        /role melarc_worker_runtime is not a safe runtime identity: member_of_unsafe_role/,
      ],
      [
        'a provisioning login with a privileged attribute',
        `alter role ${PROVISIONING_ROLE} createrole;`,
        /role melarc_provisioning is not a safe runtime identity: rolcreaterole/,
      ],
      [
        'a worker capability role that holds a power',
        `alter role ${WORKER_CREDENTIAL_DELIVERY_ROLE} bypassrls;`,
        /role melarc_worker_cap_credential_delivery is not a safe runtime identity: rolbypassrls/,
      ],
      [
        'a worker capability role that can log in',
        `alter role ${WORKER_CREDENTIAL_DELIVERY_ROLE} login;`,
        /role melarc_worker_cap_credential_delivery can log in; it is a grant set/,
      ],
      [
        'a technical role that does not exist',
        // A role by that name that does not exist, in a transaction that is rolled back. It is renamed and not dropped: `drop role` is
        // refused while any other database on the server holds a privilege granted to the role, which a leftover test database of a
        // run that was killed does (the gate of 12 October 2026 met it), and that has nothing to do with what is checked here.
        `alter role ${WORKER_CREDENTIAL_DELIVERY_ROLE} rename to melarc_absent_probe_role;`,
        /role melarc_worker_cap_credential_delivery does not exist/,
      ],
      // Privileges reachable by switching role (review of S0.4 and S0.5): a membership granted WITH INHERIT FALSE, SET TRUE gives
      // the login nothing as it stands and everything the role holds once it has switched into it.
      [
        'a worker login that can switch into a role that can create in a schema',
        `create role probe_set_grant nologin;
         grant create on schema melarc to probe_set_grant;
         grant probe_set_grant to ${WORKER_RUNTIME_ROLE} with inherit false, set true;`,
        /role melarc_worker_runtime is not a safe runtime identity: can_create_in_schema/,
      ],
      [
        'a runtime login that can switch into a role that can create in the database',
        `create role probe_set_database nologin;
         grant create on database %DATABASE% to probe_set_database;
         grant probe_set_database to ${API_RUNTIME_ROLE} with inherit false, set true;`,
        /role melarc_api_runtime is not a safe runtime identity: can_create_in_database/,
      ],
      [
        'a provisioning login that can switch into a role that can execute a SECURITY DEFINER function',
        `create role probe_set_definer nologin;
         create function public.set_definer() returns int language sql security definer
           set search_path = pg_catalog as 'select 1';
         alter function public.set_definer() owner to ${OWNER_ROLE};
         revoke all on function public.set_definer() from public;
         grant execute on function public.set_definer() to probe_set_definer;
         grant probe_set_definer to ${PROVISIONING_ROLE} with inherit false, set true;`,
        /role melarc_provisioning is not a safe runtime identity: can_execute_definer/,
      ],
      [
        'a worker login that reaches a role that can create in a schema through another',
        `create role probe_set_mid nologin;
         create role probe_set_leaf nologin;
         grant create on schema melarc to probe_set_leaf;
         grant probe_set_leaf to probe_set_mid with inherit false, set true;
         grant probe_set_mid to ${WORKER_RUNTIME_ROLE} with inherit false, set true;`,
        /role melarc_worker_runtime is not a safe runtime identity: can_create_in_schema/,
      ],
      // GBT-E7. The blanket policy the design replaces: a SYSTEM arm that opens the table to every task.
      [
        'a policy whose SYSTEM branch names no capability',
        `create table public.system_open (id int); alter table public.system_open owner to ${OWNER_ROLE};
         alter table public.system_open enable row level security; alter table public.system_open force row level security;
         create policy blanket on public.system_open
           using (case melarc.principal_type() when 'SYSTEM' then true else false end);`,
        /policy blanket on public\.system_open: a SYSTEM arm does not require a positive capability test/,
      ],
      [
        'a policy that ORs SYSTEM into another branch',
        `create table public.system_or (id int, hub_id uuid); alter table public.system_or owner to ${OWNER_ROLE};
         alter table public.system_or enable row level security; alter table public.system_or force row level security;
         create policy widened on public.system_or
           using (hub_id = any (melarc.authorized_hub_ids()) or melarc.principal_type() = 'SYSTEM')
           with check (hub_id = any (melarc.authorized_hub_ids()));`,
        /policy widened on public\.system_or: names SYSTEM outside a WHEN arm/,
      ],
      // A capability test that is not mandatory (review of S0.4 and S0.5): the three predicates reproduced as accepted, as
      // the database holds them, and an ELSE that admits everyone else. The same policy shape in the supported form is
      // accepted by the test after this list.
      [
        'a policy whose SYSTEM arm negates the capability test',
        `create table public.system_not (id int); alter table public.system_not owner to ${OWNER_ROLE};
         alter table public.system_not enable row level security; alter table public.system_not force row level security;
         create policy negated on public.system_not
           using (case melarc.principal_type() when 'SYSTEM' then not (melarc.task_capability() = 'seed') else false end);`,
        /policy negated on public\.system_not: a SYSTEM arm does not require a positive capability test/,
      ],
      [
        'a policy whose SYSTEM arm ORs the capability test with true',
        `create table public.system_true (id int); alter table public.system_true owner to ${OWNER_ROLE};
         alter table public.system_true enable row level security; alter table public.system_true force row level security;
         create policy anyone on public.system_true
           using (case melarc.principal_type() when 'SYSTEM' then (melarc.task_capability() = 'seed' or true) and true else false end);`,
        /policy anyone on public\.system_true: a SYSTEM arm does not require a positive capability test/,
      ],
      // The second review: AND binds tighter than OR, so the capability test inside `(test AND false OR true)` is not mandatory.
      // The database prints it back with the parentheses of its own grouping; it must be refused in that form too.
      [
        'a policy whose capability test sits inside a disjunction that is true anyway',
        `create table public.system_disjunct (id int); alter table public.system_disjunct owner to ${OWNER_ROLE};
         alter table public.system_disjunct enable row level security; alter table public.system_disjunct force row level security;
         create policy disjunct on public.system_disjunct
           using (case melarc.principal_type() when 'SYSTEM' then (melarc.task_capability() = 'seed' and false or true) and true else false end);`,
        /policy disjunct on public\.system_disjunct: a SYSTEM arm does not require a positive capability test/,
      ],
      [
        'a policy whose disjunction is grouped in nested parentheses',
        `create table public.system_nested (id int); alter table public.system_nested owner to ${OWNER_ROLE};
         alter table public.system_nested enable row level security; alter table public.system_nested force row level security;
         create policy nested on public.system_nested
           using (case melarc.principal_type() when 'SYSTEM' then ((((melarc.task_capability() = 'seed' and false) or true))) and ((true)) else false end);`,
        /policy nested on public\.system_nested: a SYSTEM arm does not require a positive capability test/,
      ],
      [
        'a policy whose disjunction is in WITH CHECK only',
        `create table public.system_check (id int); alter table public.system_check owner to ${OWNER_ROLE};
         alter table public.system_check enable row level security; alter table public.system_check force row level security;
         create policy check_only on public.system_check
           using (case melarc.principal_type() when 'SYSTEM' then melarc.task_capability() = 'seed' else false end)
           with check (case melarc.principal_type() when 'SYSTEM' then (melarc.task_capability() = 'seed' and false or true) and true else false end);`,
        /policy check_only on public\.system_check: a SYSTEM arm does not require a positive capability test/,
      ],
      [
        'a policy whose principal CASE is ORed with true',
        `create table public.system_case_or (id int); alter table public.system_case_or owner to ${OWNER_ROLE};
         alter table public.system_case_or enable row level security; alter table public.system_case_or force row level security;
         create policy everyone on public.system_case_or
           using ((case melarc.principal_type() when 'SYSTEM' then melarc.task_capability() = 'seed' else false end) or true);`,
        /policy everyone on public\.system_case_or: names SYSTEM outside a WHEN arm/,
      ],
      // The scope probe predicate is read-only (review of S0.4 and S0.5): in a policy for anything but SELECT it decides which
      // rows an UPDATE or a DELETE may touch, and lets a record of another hub be moved or removed.
      [
        'a policy for ALL that carries the scope probe predicate',
        `create table public.probe_all (id uuid, responsible_hub_id uuid); alter table public.probe_all owner to ${OWNER_ROLE};
         alter table public.probe_all enable row level security; alter table public.probe_all force row level security;
         create policy leaky_all on public.probe_all
           using (responsible_hub_id = any (melarc.authorized_hub_ids()) or id = melarc.scope_probe_id());`,
        /policy leaky_all on public\.probe_all: the scope probe predicate \(melarc\.scope_probe_id\(\)\) belongs in a policy FOR SELECT only/,
      ],
      [
        'a policy for UPDATE that carries the scope probe predicate',
        `create table public.probe_update (id uuid); alter table public.probe_update owner to ${OWNER_ROLE};
         alter table public.probe_update enable row level security; alter table public.probe_update force row level security;
         create policy leaky_update on public.probe_update for update using (id = melarc.scope_probe_id());`,
        /policy leaky_update on public\.probe_update: the scope probe predicate .* belongs in a policy FOR SELECT only/,
      ],
      [
        'a policy whose principal CASE has an ELSE that admits everyone',
        `create table public.system_else (id int); alter table public.system_else owner to ${OWNER_ROLE};
         alter table public.system_else enable row level security; alter table public.system_else force row level security;
         create policy open_else on public.system_else
           using (case melarc.principal_type() when 'STAFF' then false else true end);`,
        /policy open_else on public\.system_else: the ELSE of the principal CASE must be false/,
      ],
      // F03: an expression that is not the principal CASE is a finding whether or not it names SYSTEM. Each of the first three
      // names no SYSTEM, admits a SYSTEM context under any capability, and used to pass.
      [
        'a policy that is the literal true',
        `create table public.open_true (id int); alter table public.open_true owner to ${OWNER_ROLE};
         alter table public.open_true enable row level security; alter table public.open_true force row level security;
         create policy everyone on public.open_true using (true);`,
        /policy everyone on public\.open_true: is not a supported policy expression/,
      ],
      [
        'a policy that excludes one principal type and admits the rest',
        `create table public.open_not_vendor (id int); alter table public.open_not_vendor owner to ${OWNER_ROLE};
         alter table public.open_not_vendor enable row level security; alter table public.open_not_vendor force row level security;
         create policy not_vendor on public.open_not_vendor using (melarc.principal_type() <> 'VENDOR');`,
        /policy not_vendor on public\.open_not_vendor: is not a supported policy expression/,
      ],
      [
        'a policy that excludes a list of principal types and admits the rest',
        `create table public.open_not_in (id int); alter table public.open_not_in owner to ${OWNER_ROLE};
         alter table public.open_not_in enable row level security; alter table public.open_not_in force row level security;
         create policy not_in on public.open_not_in using (melarc.principal_type() not in ('VENDOR', 'RIDER'));`,
        /policy not_in on public\.open_not_in: is not a supported policy expression/,
      ],
      [
        'a policy whose WITH CHECK is unsupported beside a USING that is the principal CASE',
        `create table public.open_check (id int); alter table public.open_check owner to ${OWNER_ROLE};
         alter table public.open_check enable row level security; alter table public.open_check force row level security;
         create policy check_open on public.open_check for update
           using (case melarc.principal_type() when 'STAFF' then true else false end)
           with check (melarc.principal_type() <> 'VENDOR');`,
        /policy check_open on public\.open_check: is not a supported policy expression/,
      ],
      [
        'a second permissive policy beside a safe one',
        `create table public.open_second (id int); alter table public.open_second owner to ${OWNER_ROLE};
         alter table public.open_second enable row level security; alter table public.open_second force row level security;
         create policy safe on public.open_second using (case melarc.principal_type() when 'STAFF' then true else false end);
         create policy extra on public.open_second for select using (true);`,
        /policy extra on public\.open_second: is not a supported policy expression/,
      ],
      [
        'a policy with an arm for NONE, which is what a missing context reads as',
        `create table public.open_none (id int); alter table public.open_none owner to ${OWNER_ROLE};
         alter table public.open_none enable row level security; alter table public.open_none force row level security;
         create policy none_arm on public.open_none using (case melarc.principal_type() when 'NONE' then true else false end);`,
        /policy none_arm on public\.open_none: the principal CASE has an arm for 'NONE', which is not a principal type/,
      ],
      [
        'a scope probe policy without the staff guard',
        `create table public.probe_open (id uuid); alter table public.probe_open owner to ${OWNER_ROLE};
         alter table public.probe_open enable row level security; alter table public.probe_open force row level security;
         create policy probe_any on public.probe_open for select using (id = melarc.scope_probe_id());`,
        /policy probe_any on public\.probe_open: is not a supported policy expression/,
      ],
      [
        'a scope probe policy whose guard admits every type but one',
        `create table public.probe_not (id uuid); alter table public.probe_not owner to ${OWNER_ROLE};
         alter table public.probe_not enable row level security; alter table public.probe_not force row level security;
         create policy probe_not_vendor on public.probe_not for select
           using (melarc.principal_type() <> 'VENDOR' and id = melarc.scope_probe_id());`,
        /policy probe_not_vendor on public\.probe_not: is not a supported policy expression/,
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

  // Control for the precedence cases above: a mandatory capability test beside a parenthesized OR that has nothing to do with it is
  // the supported structure, as the database prints it back, and is not a finding. Without this the checker could pass every
  // case above by refusing any arm that contains an OR.
  it('accepts a mandatory capability test beside an unrelated parenthesized OR, as the database prints it', async () => {
    const found = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      try {
        await client.query(
          `create table public.system_mandatory (id int, a int, b int); alter table public.system_mandatory owner to ${OWNER_ROLE};
           alter table public.system_mandatory enable row level security; alter table public.system_mandatory force row level security;
           create policy mandatory on public.system_mandatory
             using (case melarc.principal_type() when 'SYSTEM' then melarc.task_capability() = 'seed' and (a is null or b is null) else false end)
             with check (case melarc.principal_type() when 'SYSTEM' then (a is null or b is null) and melarc.task_capability() = 'seed' else false end);`,
        );
        const printed = await client.query<{ expr: string }>(
          "select pg_get_expr(polqual, polrelid) as expr from pg_policy where polname = 'mandatory'",
        );
        expect(printed.rows[0]?.expr).toMatch(/OR/);
        return await catalogViolations(client);
      } finally {
        await client.query('rollback');
      }
    });
    expect(found).toEqual([]);
  });

  // Control for the cases above: a grant-set role that holds table grants and no power is not a finding however it is granted.
  // This is the configuration of the delivery worker (S0.18 puts its capability role, which holds the delivery job's grants, in
  // front of it), so the checks that reach through memberships do not refuse the intended design.
  it.each([
    ['inherited', 'with inherit true, set false'],
    ['switched into', 'with inherit false, set true'],
    ['both', 'with inherit true, set true'],
  ])('accept the worker capability role granted to the worker login, %s', async (_how, options) => {
    const found = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      try {
        await client.query(
          `grant ${WORKER_CREDENTIAL_DELIVERY_ROLE} to ${WORKER_RUNTIME_ROLE} ${options}`,
        );
        return await catalogViolations(client);
      } finally {
        await client.query('rollback');
      }
    });
    expect(found).toEqual([]);
  });

  // Break caught: the check refusing the shape the design prescribes. The fixture policies of the SecurityContext v2
  // tests pass: the principal CASE with SYSTEM arms that each name one capability, and the scope probe policy FOR SELECT.
  it('accept the SYSTEM arms of the context fixture, read as pg_get_expr prints them', async () => {
    // The fixture is written as a migration would be, and the lint reads it the same way: the probe policy is FOR SELECT.
    expect(lintMigrationSql(FIXTURE_SQL)).toEqual([]);
    expect(lintMigrationSql(CONTEXT_FIXTURE_SQL)).toEqual([]);
    const found = await withClient(database.urlFor('postgres'), async (client) => {
      await client.query('begin');
      try {
        await client.query(FIXTURE_SQL);
        await client.query(CONTEXT_FIXTURE_SQL);
        const printed = await client.query<{ expr: string }>(
          "select pg_get_expr(polqual, polrelid) as expr from pg_policy where polname = 'system_records_scope'",
        );
        expect(String(printed.rows[0]?.expr)).toMatch(/WHEN 'SYSTEM'::text THEN/);
        return await catalogViolations(client);
      } finally {
        await client.query('rollback');
      }
    });
    expect(found).toEqual([]);
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
        'CREATE POLICY widgets_by_hub ON public."widgets" USING (CASE melarc.principal_type() WHEN \'STAFF\' THEN hub_id = ANY (melarc.authorized_hub_ids()) ELSE false END);',
        'GRANT SELECT, INSERT, UPDATE ON public."widgets" TO melarc_api_runtime;',
      ].join(`\n--> statement-breakpoint\n`);
      writeFileSync(join(folder, '0002_widgets.sql'), sqlText);
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
        tag: '0002_widgets',
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
