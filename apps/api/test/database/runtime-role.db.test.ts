import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { lintMigrationSql } from '../../src/tools/database/migration-lint.js';
import { OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { applyFixture, FIXTURE_SQL, seedNotes, SEEDED_NOTES } from './support/rls-fixture.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/** SQLSTATE 42501: insufficient_privilege. */
const REFUSED = '42501';

let database: TestDatabase;
let runtime: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await seedNotes(database);
  runtime = clientFor(database.urlFor(API_RUNTIME_ROLE));
  await runtime.connect();
});

afterAll(async () => {
  await runtime.end();
  await database.drop();
});

/**
 * The attempts of SECURITY_DESIGN.md section 14.6 and the Family J rows of the security test matrix that
 * apply before any domain table exists. Every one is executed, as the runtime role, against a real server:
 * what counts is what the database refuses, not what the role's attributes say.
 */
describe('the API runtime role', () => {
  // Control for everything below: the role connects and works. Without it, a database that refused every
  // statement for an unrelated reason (a broken connection, a missing schema) would pass every refusal.
  it('connects, and can use the accessors and the granted table', async () => {
    expect(await scalar(runtime, 'select current_user')).toBe(API_RUNTIME_ROLE);
    expect(await scalar(runtime, 'select melarc.principal_type()')).toBe('NONE');
    expect(await sqlState(runtime, 'select count(*) from rls_fixture.notes')).toBeUndefined();
  });

  // Break caught: the connection being a privileged one: a superuser, a bypass of row-level security, a
  // creator of databases or roles, a member of the owner, or an owner itself (GBT-J1 and J3).
  it('is not the database owner, a superuser, a bypass role or a member of the owner', async () => {
    const { rows } = await runtime.query(
      `select r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
              pg_has_role(current_user, $1, 'MEMBER') as member_of_owner,
              pg_has_role(current_user, $2, 'MEMBER') as member_of_migration,
              (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as database_owner,
              (select count(*) from pg_class where relowner = r.oid)::int as owned_relations,
              current_setting('is_superuser') as is_superuser
         from pg_roles r where r.rolname = current_user`,
      [OWNER_ROLE, MIGRATION_ROLE],
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        member_of_owner: false,
        member_of_migration: false,
        database_owner: OWNER_ROLE,
        owned_relations: 0,
        is_superuser: 'off',
      },
    ]);
  });

  // Break caught: any way for the runtime role to change a table, a schema or an accessor function
  // (GBT-J1). Replacing an accessor would let it choose what every policy believes the context to be.
  it.each([
    ['ALTER TABLE', 'alter table rls_fixture.notes add column extra integer'],
    ['DISABLE ROW LEVEL SECURITY', 'alter table rls_fixture.notes disable row level security'],
    ['NO FORCE ROW LEVEL SECURITY', 'alter table rls_fixture.notes no force row level security'],
    ['DROP TABLE', 'drop table rls_fixture.notes'],
    ['TRUNCATE', 'truncate rls_fixture.notes'],
    ['CREATE TABLE in the fixture schema', 'create table rls_fixture.extra (id integer)'],
    ['CREATE TABLE in public', 'create table public.extra (id integer)'],
    ['CREATE TABLE in melarc', 'create table melarc.extra (id integer)'],
    ['CREATE SCHEMA', 'create schema extra'],
    [
      'CREATE OR REPLACE of an accessor',
      "create or replace function melarc.principal_type() returns text language sql as $$ select 'STAFF' $$",
    ],
    ['DROP of an accessor', 'drop function melarc.principal_type()'],
    [
      'an accessor made its own',
      `alter function melarc.principal_type() owner to ${API_RUNTIME_ROLE}`,
    ],
  ])('refuses %s (GBT-J1)', async (_label, statement) => {
    expect(await sqlState(runtime, statement)).toBe(REFUSED);
  });

  // Break caught: the runtime role editing the policies that restrict it (GBT-J2).
  it.each([
    ['CREATE POLICY', 'create policy extra on rls_fixture.notes using (true)'],
    ['ALTER POLICY', 'alter policy notes_scope on rls_fixture.notes using (true)'],
    ['DROP POLICY', 'drop policy notes_scope on rls_fixture.notes'],
  ])('refuses %s (GBT-J2)', async (_label, statement) => {
    expect(await sqlState(runtime, statement)).toBe(REFUSED);
  });

  // Break caught: the runtime role becoming the owner by any route (GBT-J3, J12 and J13).
  it.each([
    ['ALTER TABLE OWNER TO itself', `alter table rls_fixture.notes owner to ${API_RUNTIME_ROLE}`],
    ['SET ROLE to the owner (GBT-J13)', `set role ${OWNER_ROLE}`],
    ['SET ROLE to the migration identity (GBT-J12)', `set role ${MIGRATION_ROLE}`],
    ['SET SESSION AUTHORIZATION to the owner', `set session authorization ${OWNER_ROLE}`],
    ['SET SESSION AUTHORIZATION to the administrator', 'set session authorization postgres'],
  ])('refuses %s', async (_label, statement) => {
    expect(await sqlState(runtime, statement)).toBe(REFUSED);
    expect(await scalar(runtime, 'select current_user')).toBe(API_RUNTIME_ROLE);
  });

  // Break caught: the runtime role widening its own authority (GBT-J4 and J5).
  it.each([
    ['ALTER ROLE BYPASSRLS (GBT-J4)', `alter role ${API_RUNTIME_ROLE} bypassrls`],
    ['ALTER ROLE SUPERUSER', `alter role ${API_RUNTIME_ROLE} superuser`],
    ['ALTER ROLE CREATEDB', `alter role ${API_RUNTIME_ROLE} createdb`],
    ['ALTER ROLE CREATEROLE', `alter role ${API_RUNTIME_ROLE} createrole`],
    ['CREATE ROLE', 'create role intruder login'],
    ['CREATE DATABASE', 'create database intruder'],
    ['GRANT the owner to itself (GBT-J5)', `grant ${OWNER_ROLE} to ${API_RUNTIME_ROLE}`],
    [
      'GRANT the migration role to itself (GBT-J5)',
      `grant ${MIGRATION_ROLE} to ${API_RUNTIME_ROLE}`,
    ],
    ['GRANT a role to another role (GBT-J5)', `grant ${API_RUNTIME_ROLE} to ${MIGRATION_ROLE}`],
    ['ALTER SYSTEM', "alter system set log_statement = 'all'"],
  ])('refuses %s', async (_label, statement) => {
    expect(await sqlState(runtime, statement)).toBe(REFUSED);
  });

  // Break caught: the runtime role reading what holds credentials or what is not its to read.
  it.each([
    ['the password hashes', 'select rolpassword from pg_authid limit 1'],
    ['the migration journal', 'select * from drizzle.__drizzle_migrations'],
    ['a server file', "select pg_read_file('postgresql.conf')"],
    ['a program', "copy (select 1) to program 'echo x'"],
  ])('refuses to read %s', async (_label, statement) => {
    expect(await sqlState(runtime, statement)).toBe(REFUSED);
  });

  // Break caught: the one session setting that turns row-level security off for a role that is allowed to
  // set it. PostgreSQL does not let `row_security = off` skip a policy for a role without BYPASSRLS: it
  // raises instead of returning rows, and this asserts that it does.
  it('cannot bypass row-level security with row_security = off', async () => {
    const visibleToAdmin = await withClient(database.urlFor('postgres'), (client) =>
      scalar<string>(client, 'select count(*) from rls_fixture.notes'),
    );
    expect(Number(visibleToAdmin)).toBe(SEEDED_NOTES.length);

    try {
      await runtime.query('set row_security = off');
      expect(await sqlState(runtime, 'select * from rls_fixture.notes')).toBe(REFUSED);
      expect(
        await sqlState(runtime, 'insert into rls_fixture.notes (hub_id, body) values ($1, $2)', [
          '11111111-1111-4111-8111-111111111111',
          'smuggled',
        ]),
      ).toBe(REFUSED);
    } finally {
      await runtime.query('reset row_security');
    }
  });

  // Break caught: a protected table that returns rows to a connection that has set no context, which is
  // what every request without a principal looks like (fail closed).
  it('sees no row of a protected table when no context is set, though the table has rows', async () => {
    const { rows } = await runtime.query('select * from rls_fixture.notes');
    expect(rows).toEqual([]);
  });

  // Break caught: a protected table whose owner is exempt from its own policy. FORCE ROW LEVEL SECURITY is
  // what makes the owner, and so the migration identity acting as the owner, subject to the policy. With it
  // missing, anyone who can become the owner reads every row, whatever the context.
  it('applies the policy to the owner and to the migration identity acting as it', async () => {
    await withClient(database.urlFor(MIGRATION_ROLE), async (client) => {
      expect(await scalar<string>(client, 'select count(*) from rls_fixture.notes')).toBe('0');
      await client.query(`set role ${OWNER_ROLE}`);
      expect(await scalar(client, 'select current_user')).toBe(OWNER_ROLE);
      expect(await scalar<string>(client, 'select count(*) from rls_fixture.notes')).toBe('0');
    });
  });

  // Break caught: the fixture standing in for a product table while breaking the rules a product table
  // must follow, so the tests above would prove things about a table nobody could write.
  it('uses a fixture that passes the migration lint', () => {
    expect(lintMigrationSql(FIXTURE_SQL)).toEqual([]);
  });

  // Break caught: the refusals above passing while having done what they were refused to do. After all of
  // them, the table, its protection, its owner, its policy and the roles are as they were.
  it('leaves everything exactly as it was after all of those attempts', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query(
        `select pg_get_userbyid(c.relowner) as table_owner,
                c.relrowsecurity as rls_enabled,
                c.relforcerowsecurity as rls_forced,
                (select count(*) from pg_policy where polrelid = c.oid)::int as policies,
                (select count(*) from rls_fixture.notes)::int as rows,
                (select count(*) from pg_attribute where attrelid = c.oid and attnum > 0 and not attisdropped)::int as columns,
                (select pg_get_userbyid(proowner) from pg_proc where proname = 'principal_type') as accessor_owner,
                (select count(*) from pg_namespace where nspname in ('extra'))::int as extra_schemas,
                (select count(*) from pg_roles where rolname in ('intruder'))::int as extra_roles,
                (select count(*) from pg_database where datname = 'intruder')::int as extra_databases,
                (select count(*) from pg_roles where rolname = $1 and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole))::int as runtime_privileged
           from pg_class c where c.oid = 'rls_fixture.notes'::regclass`,
        [API_RUNTIME_ROLE],
      );
      expect(rows).toEqual([
        {
          table_owner: OWNER_ROLE,
          rls_enabled: true,
          rls_forced: true,
          policies: 1,
          rows: SEEDED_NOTES.length,
          columns: 5,
          accessor_owner: OWNER_ROLE,
          extra_schemas: 0,
          extra_roles: 0,
          extra_databases: 0,
          runtime_privileged: 0,
        },
      ]);
    });
  });
});
