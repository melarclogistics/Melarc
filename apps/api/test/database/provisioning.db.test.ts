import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { readLocalPostgres } from '../../src/tools/database/local-env.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  DISPOSABLE_MARKER,
  dropDisposableDatabase,
  listTestDatabases,
  OWNER_ROLE,
  provisionRoles,
  type LocalAdmin,
} from '../../src/tools/database/provisioning.js';
import { MIGRATION_ROLE, UnsafeTargetError } from '../../src/tools/database/safety.js';
import { clientFor, scalar, withClient } from './support/test-database.js';

const settings = readLocalPostgres();
const ROLES = [OWNER_ROLE, MIGRATION_ROLE, API_RUNTIME_ROLE];
const suffix = () => randomBytes(4).toString('hex');

let admin: LocalAdmin;

beforeAll(async () => {
  admin = await connectLocalAdmin(settings);
  await provisionRoles(admin, settings);
});

// Whatever a test did to the shared roles, they are put back for the next file.
afterAll(async () => {
  await provisionRoles(admin, settings);
  await admin.close();
});

const adminUrl = (database = 'postgres') =>
  buildDatabaseUrl({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database,
  });

/** The SQLSTATE a login attempt is refused with, or `connected`. The refusal is the result. */
async function loginOutcome(
  user: string,
  password: string,
  database = 'postgres',
): Promise<string> {
  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    return 'connected';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe('the cluster', () => {
  // Break caught: a server that trusts some connections without a password. Every claim that the three
  // roles have distinct credentials rests on the server asking for them; with a trust rule, a wrong
  // password would be accepted and no role test below would mean anything.
  it('asks every connection for a password and stores them as SCRAM', async () => {
    await withClient(adminUrl(), async (client) => {
      expect(await scalar(client, 'show password_encryption')).toBe('scram-sha-256');
      const trusted = await scalar<string>(
        client,
        "select count(*) from pg_hba_file_rules where auth_method = 'trust'",
      );
      expect(Number(trusted)).toBe(0);
    });
  });
});

describe('provisionRoles', () => {
  // Break caught: a role created with a privilege it must not have, or a login role that is not one.
  it('creates the owner without login and the other two with login, none privileged', async () => {
    const { rows } = await admin.client.query(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
         from pg_roles where rolname = any($1) order by rolname`,
      [ROLES],
    );
    const none = {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolreplication: false,
    };
    expect(rows).toEqual([
      { rolname: API_RUNTIME_ROLE, rolcanlogin: true, ...none },
      { rolname: MIGRATION_ROLE, rolcanlogin: true, ...none },
      { rolname: OWNER_ROLE, rolcanlogin: false, ...none },
    ]);
  });

  // Break caught: the runtime role being able to become the owner, which is the owner's power over every
  // table and policy; and the migration role being unable to, which would leave its objects owned by it.
  it('lets the migration role act as the owner, and gives the runtime role no membership at all', async () => {
    const { rows } = await admin.client.query(
      `select granted.rolname as granted, member.rolname as member,
              m.inherit_option, m.set_option, m.admin_option
         from pg_auth_members m
         join pg_roles granted on granted.oid = m.roleid
         join pg_roles member on member.oid = m.member
        where member.rolname = any($1) or granted.rolname = any($1)
        order by member.rolname`,
      [ROLES],
    );
    expect(rows).toEqual([
      {
        granted: OWNER_ROLE,
        member: MIGRATION_ROLE,
        inherit_option: true,
        set_option: true,
        admin_option: false,
      },
    ]);
  });

  // Break caught: distinct credentials that are not distinct, or that are not checked. Each login role
  // gets in with its own password and with no other role's, and the owner cannot log in at all (GBT-J14).
  it('authenticates each login role with its own password only, and refuses the owner', async () => {
    expect(await loginOutcome(MIGRATION_ROLE, settings.migrationPassword)).toBe('connected');
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.runtimePassword)).toBe('connected');

    expect(await loginOutcome(MIGRATION_ROLE, settings.runtimePassword)).toBe('28P01');
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.migrationPassword)).toBe('28P01');
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.adminPassword)).toBe('28P01');

    // The owner has no password and no login. Which of the two codes the server reports first does not
    // matter; that it is refused with a server error, for every password it could be given, does. (An empty
    // password is not tried: the client library refuses that itself, so it says nothing about the server.
    // That the server accepts no connection without a password is the pg_hba test above.)
    for (const password of [settings.migrationPassword, settings.runtimePassword]) {
      expect(['28000', '28P01']).toContain(await loginOutcome(OWNER_ROLE, password));
    }
  });

  // Break caught: a repeat that fails, duplicates a role, or leaves the roles different.
  it('is safe to repeat, and safe to run twice at once', async () => {
    await provisionRoles(admin, settings);
    await Promise.all(
      [1, 2, 3].map(async () => {
        const other = await connectLocalAdmin(settings);
        try {
          await provisionRoles(other, settings);
        } finally {
          await other.close();
        }
      }),
    );
    const count = await scalar<string>(
      admin.client,
      'select count(*) from pg_roles where rolname = any($1)',
      [ROLES],
    );
    expect(Number(count)).toBe(3);
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.runtimePassword)).toBe('connected');
  });

  // Break caught: provisioning that only creates, so a role that was loosened by hand stays loosened.
  it('puts a role that drifted back to the intended shape', async () => {
    await admin.client.query(`alter role ${API_RUNTIME_ROLE} createdb createrole bypassrls`);
    await admin.client.query(`grant ${OWNER_ROLE} to ${API_RUNTIME_ROLE}`);

    await provisionRoles(admin, settings);

    const { rows } = await admin.client.query(
      `select rolcreatedb, rolcreaterole, rolbypassrls,
              pg_has_role($1, $2, 'MEMBER') as member_of_owner
         from pg_roles where rolname = $1`,
      [API_RUNTIME_ROLE, OWNER_ROLE],
    );
    expect(rows).toEqual([
      { rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, member_of_owner: false },
    ]);
  });

  // Break caught: a password that cannot be changed, so a leaked credential cannot be rotated away.
  it('rotates a password when the settings change, and the old one stops working', async () => {
    const rotated = `rotated-${suffix()}`;
    try {
      await provisionRoles(admin, { ...settings, runtimePassword: rotated });
      expect(await loginOutcome(API_RUNTIME_ROLE, rotated)).toBe('connected');
      expect(await loginOutcome(API_RUNTIME_ROLE, settings.runtimePassword)).toBe('28P01');
    } finally {
      await provisionRoles(admin, settings);
    }
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.runtimePassword)).toBe('connected');
  });
});

describe('disposable databases', () => {
  const created: string[] = [];
  const unmarked: string[] = [];

  afterAll(async () => {
    for (const name of created) await dropDisposableDatabase(admin, name).catch(() => undefined);
    for (const name of unmarked) {
      await admin.client.query(`drop database if exists "${name}" with (force)`);
    }
  });

  async function make(prefix = 'melarc_test_'): Promise<string> {
    const name = `${prefix}${suffix()}`;
    await createDisposableDatabase(admin, name);
    created.push(name);
    return name;
  }

  const exists = async (name: string) =>
    Number(
      await scalar<string>(admin.client, 'select count(*) from pg_database where datname = $1', [
        name,
      ]),
    ) === 1;

  // Break caught: a database owned by the wrong role, unmarked (so it can never be dropped), or open to
  // everyone. Only the migration and the runtime roles may connect; a stranger is refused (assert the
  // refusal, not the ACL).
  it('creates a database owned by the owner, marked, and open to the two login roles only', async () => {
    const name = await make();

    const { rows } = await admin.client.query(
      `select pg_get_userbyid(d.datdba) as owner,
              shobj_description(d.oid, 'pg_database') as marker,
              d.datacl is not null as has_explicit_acl,
              (select count(*) from aclexplode(d.datacl) a where a.grantee = 0)::int as public_entries
         from pg_database d where d.datname = $1`,
      [name],
    );
    expect(rows).toEqual([
      { owner: OWNER_ROLE, marker: DISPOSABLE_MARKER, has_explicit_acl: true, public_entries: 0 },
    ]);

    expect(await loginOutcome(MIGRATION_ROLE, settings.migrationPassword, name)).toBe('connected');
    expect(await loginOutcome(API_RUNTIME_ROLE, settings.runtimePassword, name)).toBe('connected');

    const stranger = `melarc_stranger_${suffix()}`;
    const password = `pw-${suffix()}`;
    await admin.client.query(`create role ${stranger} login password '${password}'`);
    try {
      expect(await loginOutcome(stranger, password, name)).toBe('42501');
    } finally {
      await admin.client.query(`drop role ${stranger}`);
    }
  });

  // Break caught: a repeat that fails or that recreates the database and loses its contents.
  it('is safe to repeat for a database it made, and leaves its contents alone', async () => {
    const name = await make();
    await withClient(adminUrl(name), (client) => client.query('create table kept (id int)'));

    await createDisposableDatabase(admin, name);

    const tables = await withClient(adminUrl(name), (client) =>
      scalar<string>(client, "select count(*) from pg_tables where tablename = 'kept'"),
    );
    expect(Number(tables)).toBe(1);
  });

  // Break caught: adopting, and later dropping, a database that someone else made and named like a test one.
  it('refuses to adopt, to drop, or to list a database it did not make', async () => {
    const name = `melarc_test_unmarked${suffix()}`;
    await admin.client.query(`create database "${name}"`);
    unmarked.push(name);

    await expect(createDisposableDatabase(admin, name)).rejects.toThrow(UnsafeTargetError);
    await expect(dropDisposableDatabase(admin, name)).rejects.toThrow(UnsafeTargetError);
    await expect(dropDisposableDatabase(admin, name, { disconnect: false })).rejects.toThrow(
      UnsafeTargetError,
    );
    expect((await listTestDatabases(admin)).map((database) => database.name)).not.toContain(name);

    expect(await exists(name)).toBe(true);
  });

  // Break caught: a drop that refuses (or stalls) while something is connected, so teardown fails exactly
  // when a test left a connection open.
  it('drops a database even while a session is connected to it', async () => {
    const name = await make();
    const session = clientFor(adminUrl(name));
    session.on('error', () => undefined);
    await session.connect();
    try {
      await dropDisposableDatabase(admin, name);
      expect(await exists(name)).toBe(false);
    } finally {
      await session.end().catch(() => undefined);
    }
  });

  // Break caught: a drop of the cluster's own databases. The refusal is checked on the server's side too:
  // all three are still there afterwards.
  it.each(['postgres', 'template0', 'template1'])(
    'refuses to drop %s and leaves it in place',
    async (name) => {
      await expect(dropDisposableDatabase(admin, name)).rejects.toThrow(UnsafeTargetError);
      expect(await exists(name)).toBe(true);
    },
  );

  // Break caught (audit F07): a listing that removes what it lists, or that hides a database with sessions.
  // It reports every marked test database with the sessions connected to it, and changes nothing.
  it('lists the test databases and their sessions, and removes none of them', async () => {
    const idle = await make();
    const busy = await make();
    const session = clientFor(adminUrl(busy));
    await session.connect();
    try {
      const listed = await listTestDatabases(admin);

      expect(listed.find((database) => database.name === idle)).toEqual({
        name: idle,
        sessions: 0,
      });
      expect(listed.find((database) => database.name === busy)?.sessions).toBeGreaterThanOrEqual(1);
      expect(await exists(idle)).toBe(true);
      expect(await exists(busy)).toBe(true);
    } finally {
      await session.end();
    }
  });

  // Break caught (audit F07): the listing offering the development database for removal. A development
  // database carries the same marker (db:reset may drop it) but is never a leftover of a test run, so the
  // command that cleans up after test runs does not list it, and so a person is never led to name it.
  it('lists test databases only, not the marked development databases', async () => {
    const test = await make();
    const development = await make('melarc_dev_');

    const names = (await listTestDatabases(admin)).map((database) => database.name);

    expect(names).toContain(test);
    expect(names).not.toContain(development);
    expect(await exists(development)).toBe(true);
  });

  // Break caught (audit F07): a deliberate drop of a database that another run is using ending that run's
  // connection, or racing it. Without `disconnect` the server itself refuses, the database stays, and the
  // session that was connected is still alive.
  it('drops a database nobody is connected to, and refuses one with a session, leaving the session alive', async () => {
    const idle = await make();
    const busy = await make();
    const session = clientFor(adminUrl(busy));
    await session.connect();
    try {
      await dropDisposableDatabase(admin, idle, { disconnect: false });
      await expect(dropDisposableDatabase(admin, busy, { disconnect: false })).rejects.toThrow(
        /sessions are connected/,
      );

      expect(await exists(idle)).toBe(false);
      expect(await exists(busy)).toBe(true);
      expect((await session.query('select 1 as alive')).rows).toEqual([{ alive: 1 }]);
    } finally {
      await session.end();
    }
    await dropDisposableDatabase(admin, busy, { disconnect: false });
    expect(await exists(busy)).toBe(false);
  });
});

describe('the administrator connection', () => {
  // Break caught: the administrator connection being usable for the work the tools refuse, because it
  // was built without the local-only check. It cannot be built for a host that is not this machine.
  it('cannot be opened for a server that is not on this machine', async () => {
    await expect(connectLocalAdmin({ ...settings, host: 'db.internal' })).rejects.toThrow(
      UnsafeTargetError,
    );
  });
});
