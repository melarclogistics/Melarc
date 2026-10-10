import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { createPool } from '../../src/platform/database/database.module.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import {
  PROVISIONING_ROLE,
  WORKER_CREDENTIAL_DELIVERY_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import { OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  applyContextFixture,
  applyFixture,
  seedContextRecords,
  seedNotes,
} from './support/rls-fixture.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type Login,
  type TestDatabase,
} from './support/test-database.js';

/** SQLSTATE 42501: insufficient_privilege. */
const REFUSED = '42501';

const LOGINS = [API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE, PROVISIONING_ROLE] as const;
type RuntimeLogin = (typeof LOGINS)[number] & Login;

const ACCESSORS = [
  'melarc.principal_type()',
  'melarc.hub_scope_mode()',
  'melarc.authorized_hub_ids()',
  'melarc.current_vendor_organization_id()',
  'melarc.current_rider_id()',
  'melarc.task_capability()',
  'melarc.scope_probe_id()',
  'melarc.current_principal_id()',
] as const;

let database: TestDatabase;
const connected = new Map<RuntimeLogin, pg.Client>();

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  await seedNotes(database);
  await seedContextRecords(database);
  for (const login of LOGINS) {
    const client = clientFor(database.urlFor(login), { connectionTimeoutMillis: 5_000 });
    await client.connect();
    connected.set(login, client);
  }
});

afterAll(async () => {
  for (const client of connected.values()) await client.end();
  await database.drop();
});

const as = (login: RuntimeLogin): pg.Client => {
  const client = connected.get(login);
  if (client === undefined) throw new Error(`no connection for ${login}`);
  return client;
};

/**
 * The attempts of SECURITY_DESIGN.md section 14.6 and the Family J rows that apply to every runtime-class login,
 * executed as each actual login: what counts is what the database refuses, not what a role's attributes say it should.
 */
describe.each(LOGINS)('the login %s', (login) => {
  // GBT-J16. Break caught: the posture check refusing a login that is configured as designed, which would stop the
  // process it is for from starting; or being run against nothing. Each login passes the check of its own readiness, as
  // itself, with the grants the migrations gave it (the refusal of a login that is not is tested with probe roles).
  it('passes the posture check of its own readiness', async () => {
    const shutdown = new ShutdownRegistry();
    const service = new DatabaseService(
      createPool({ url: database.urlFor(login), poolMax: 1, deadlines: INERT_DEADLINES }),
      new CapturedLogs().logger,
      shutdown,
      new ReadinessRegistry(),
    );
    try {
      await expect(service.check()).resolves.toBeUndefined();
    } finally {
      await shutdown.closeAll();
    }
  });

  // Control for everything below: the login connects as itself, and can use the accessors every policy reads. Without
  // it, a login that could do nothing at all would pass every refusal.
  it('connects as itself and can use every accessor of the security context', async () => {
    const client = as(login);
    expect(await scalar(client, 'select current_user')).toBe(login);
    for (const accessor of ACCESSORS) {
      expect(await sqlState(client, `select ${accessor}`)).toBeUndefined();
    }
    expect(await scalar(client, 'select melarc.principal_type()')).toBe('NONE');
    expect(await scalar(client, 'select melarc.task_capability()')).toBe('NONE');
  });

  // Break caught: the login being a privileged one: a superuser, a bypass of row-level security, a creator of
  // databases or roles, a member of the owner or the migration identity, or an owner itself (GBT-J1, J3, J4).
  it('is not the database owner, a superuser, a bypass role or a member of any role', async () => {
    const { rows } = await as(login).query(
      `select r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
              pg_has_role(current_user, $1, 'MEMBER') as member_of_owner,
              pg_has_role(current_user, $2, 'MEMBER') as member_of_migration,
              (select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships,
              (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as database_owner,
              (select count(*) from pg_class where relowner = r.oid)::int as owned_relations,
              (select count(*) from pg_proc where proowner = r.oid)::int as owned_functions,
              (select count(*) from pg_namespace where nspowner = r.oid)::int as owned_schemas,
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
        memberships: 0,
        database_owner: OWNER_ROLE,
        owned_relations: 0,
        owned_functions: 0,
        owned_schemas: 0,
        is_superuser: 'off',
      },
    ]);
  });

  // Break caught: any way for the login to change a table, a schema or an accessor function, or to create what it would
  // then own (GBT-J1 and J16). Replacing an accessor would let it choose what every policy believes the context to be.
  it.each([
    ['ALTER TABLE', 'alter table rls_fixture.notes add column extra integer'],
    ['DISABLE ROW LEVEL SECURITY', 'alter table rls_fixture.notes disable row level security'],
    ['DROP TABLE', 'drop table rls_fixture.notes'],
    ['TRUNCATE', 'truncate rls_fixture.notes'],
    ['CREATE TABLE in the fixture schema', 'create table rls_fixture.extra (id integer)'],
    ['CREATE TABLE in public', 'create table public.extra (id integer)'],
    ['CREATE TABLE in melarc', 'create table melarc.extra (id integer)'],
    ['CREATE SCHEMA', 'create schema extra'],
    [
      'CREATE FUNCTION in public',
      "create function public.f() returns int language sql as 'select 1'",
    ],
    [
      'CREATE FUNCTION in melarc',
      "create function melarc.f() returns int language sql as 'select 1'",
    ],
    // The databases are shut to PUBLIC, so TEMPORARY is not a privilege of a login either.
    ['CREATE TEMP TABLE', 'create temp table scratch (id int)'],
    [
      'CREATE OR REPLACE of an accessor',
      "create or replace function melarc.principal_type() returns text language sql as $$ select 'STAFF' $$",
    ],
    [
      'CREATE OR REPLACE of the task capability accessor',
      "create or replace function melarc.task_capability() returns text language sql as $$ select 'seed' $$",
    ],
    ['DROP of an accessor', 'drop function melarc.scope_probe_id()'],
  ])('refuses %s (GBT-J1, J16)', async (_label, statement) => {
    expect(await sqlState(as(login), statement)).toBe(REFUSED);
  });

  // Break caught: the login editing the policies that restrict it (GBT-J2).
  it.each([
    ['CREATE POLICY', 'create policy extra on rls_fixture.notes using (true)'],
    ['ALTER POLICY', 'alter policy notes_scope on rls_fixture.notes using (true)'],
    ['DROP POLICY', 'drop policy notes_scope on rls_fixture.notes'],
  ])('refuses %s (GBT-J2)', async (_label, statement) => {
    expect(await sqlState(as(login), statement)).toBe(REFUSED);
  });

  // Break caught: the login becoming the owner, the migration identity or the administrator by any route (GBT-J3,
  // J12, J13, K5, K6 and J17). The elevated credential does not work for a running process.
  it.each([
    ['ALTER TABLE OWNER TO itself', (l: string) => `alter table rls_fixture.notes owner to ${l}`],
    ['SET ROLE to the owner (GBT-J13)', () => `set role ${OWNER_ROLE}`],
    [
      'SET ROLE to the migration identity (GBT-J12, K5, K6, J17)',
      () => `set role ${MIGRATION_ROLE}`,
    ],
    ['SET SESSION AUTHORIZATION to the owner', () => `set session authorization ${OWNER_ROLE}`],
    [
      'SET SESSION AUTHORIZATION to the migration identity',
      () => `set session authorization ${MIGRATION_ROLE}`,
    ],
    ['SET SESSION AUTHORIZATION to the administrator', () => 'set session authorization postgres'],
    ...LOGINS.filter((other) => other !== login).map(
      (other) =>
        [`SET ROLE to the ${other} login`, () => `set role ${other}`] as [string, () => string],
    ),
  ] as [string, (login: string) => string][])('refuses %s', async (_label, statement) => {
    expect(await sqlState(as(login), statement(login))).toBe(REFUSED);
    expect(await scalar(as(login), 'select current_user')).toBe(login);
  });

  // Break caught: the login widening its own authority or another's (GBT-J4 and J5).
  it.each([
    ['ALTER ROLE BYPASSRLS (GBT-J4)', (l: string) => `alter role ${l} bypassrls`],
    ['ALTER ROLE SUPERUSER', (l: string) => `alter role ${l} superuser`],
    ['ALTER ROLE CREATEDB', (l: string) => `alter role ${l} createdb`],
    ['ALTER ROLE CREATEROLE', (l: string) => `alter role ${l} createrole`],
    ['CREATE ROLE', () => 'create role intruder login'],
    ['CREATE DATABASE', () => 'create database intruder'],
    ['GRANT the owner to itself (GBT-J5)', (l: string) => `grant ${OWNER_ROLE} to ${l}`],
    [
      'GRANT the migration role to itself (GBT-J5)',
      (l: string) => `grant ${MIGRATION_ROLE} to ${l}`,
    ],
    [
      'GRANT a worker capability to itself (GBT-Y9)',
      (l: string) => `grant ${WORKER_CREDENTIAL_DELIVERY_ROLE} to ${l}`,
    ],
    ['GRANT a role to another role (GBT-J5)', (l: string) => `grant ${l} to ${MIGRATION_ROLE}`],
    ['ALTER SYSTEM', () => "alter system set log_statement = 'all'"],
  ] as [string, (login: string) => string][])('refuses %s', async (_label, statement) => {
    expect(await sqlState(as(login), statement(login))).toBe(REFUSED);
  });

  // Break caught: the login reading what holds credentials or what is not its to read.
  it.each([
    ['the password hashes', 'select rolpassword from pg_authid limit 1'],
    ['the migration journal', 'select * from drizzle.__drizzle_migrations'],
    ['a server file', "select pg_read_file('postgresql.conf')"],
    ['a program', "copy (select 1) to program 'echo x'"],
  ])('refuses to read %s', async (_label, statement) => {
    expect(await sqlState(as(login), statement)).toBe(REFUSED);
  });

  // Break caught: the one session setting that turns row-level security off for a role that may set it. PostgreSQL
  // does not let `row_security = off` skip a policy for a role without BYPASSRLS: it raises, and this asserts that.
  it('cannot bypass row-level security with row_security = off', async () => {
    const client = as(login);
    try {
      await client.query('set row_security = off');
      expect(await sqlState(client, 'select * from rls_fixture.notes')).toBe(REFUSED);
    } finally {
      await client.query('reset row_security');
    }
  });
});

/**
 * GBT-Y5, Y9 and the base identity: the worker base and the provisioning identity hold no protected-business-table
 * grant of their own. The API runtime holds grants on the fixtures (it stands for the application); these two hold
 * none, so a read is refused by the grant before any policy can answer, whatever context a caller sets.
 */
describe.each([WORKER_RUNTIME_ROLE, PROVISIONING_ROLE] as const)(
  'the login %s alone holds no business-table grant',
  (login) => {
    const TABLES = ['notes', 'hub_records', 'owned_records', 'system_records', 'seeded_records'];

    // GBT-Y5. Break caught: a default grant of the base identity that reads every table, or a table the migration
    // granted to it. With no context at all, and with a context a caller sets by hand, the read is refused.
    it.each(TABLES)(
      'is refused a read of %s, with a context set by hand or without one (GBT-Y5)',
      async (table) => {
        const client = as(login);
        expect(await sqlState(client, `select * from rls_fixture.${table}`)).toBe(REFUSED);
        try {
          await client.query("select set_config('melarc.principal_type', 'SYSTEM', false)");
          await client.query(
            "select set_config('melarc.task_capability', 'authentication', false)",
          );
          expect(await sqlState(client, `select * from rls_fixture.${table}`)).toBe(REFUSED);
          expect(
            await sqlState(client, `insert into rls_fixture.${table} (body) values ('x')`),
          ).toBe(REFUSED);
        } finally {
          await client.query('reset melarc.principal_type');
          await client.query('reset melarc.task_capability');
        }
      },
    );

    // GBT-Y9. Break caught: a capability acquired at run time. It is granted to a process by whoever starts it, not
    // requested by the process, so the base identity cannot become the capability role by any statement.
    it('cannot acquire the credential-delivery capability (GBT-Y9)', async () => {
      const client = as(login);
      expect(await sqlState(client, `set role ${WORKER_CREDENTIAL_DELIVERY_ROLE}`)).toBe(REFUSED);
      expect(await sqlState(client, `grant ${WORKER_CREDENTIAL_DELIVERY_ROLE} to ${login}`)).toBe(
        REFUSED,
      );
      expect(await scalar(client, 'select current_user')).toBe(login);
    });
  },
);

describe('the worker capability role', () => {
  // Break caught: the capability role being a login, owning something, or holding a grant before a task needs one.
  // It is a grant set: nothing logs in as it, nobody is a member of it by default, and nothing is granted to it yet.
  it('is a grant set that holds nothing and that nobody has been given', async () => {
    const facts = await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `select r.rolcanlogin,
                (select count(*) from pg_auth_members m where m.roleid = r.oid or m.member = r.oid)::int as memberships,
                (select count(*) from pg_class where relowner = r.oid)::int as owned,
                (select count(*) from pg_class c cross join lateral aclexplode(c.relacl) a where a.grantee = r.oid)::int as table_grants,
                (select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a where a.grantee = r.oid)::int as schema_grants,
                (select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a where a.grantee = r.oid)::int as function_grants
           from pg_roles r where r.rolname = $1`,
        [WORKER_CREDENTIAL_DELIVERY_ROLE],
      );
      return rows;
    });
    expect(facts).toEqual([
      {
        rolcanlogin: false,
        memberships: 0,
        owned: 0,
        table_grants: 0,
        schema_grants: 0,
        function_grants: 0,
      },
    ]);
  });
});
