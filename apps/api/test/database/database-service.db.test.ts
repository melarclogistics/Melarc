import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { createPool } from '../../src/platform/database/database.module.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import { buildDatabaseUrl, OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { applyFixture, staffContext } from './support/rls-fixture.js';
import {
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  // The fixture table is owned by the owner role: with it, "owns an object" has something to be true of.
  await applyFixture(database);
});

afterAll(async () => {
  await database.drop();
});

const suffix = () => randomBytes(4).toString('hex');

interface Built {
  readonly service: DatabaseService;
  readonly pool: pg.Pool;
  readonly logs: CapturedLogs;
  readonly shutdown: ShutdownRegistry;
  readonly readiness: ReadinessRegistry;
}

function build(url: string, poolMax = 1): Built {
  const pool = createPool({ url, poolMax, deadlines: INERT_DEADLINES });
  const logs = new CapturedLogs();
  const shutdown = new ShutdownRegistry();
  const readiness = new ReadinessRegistry();
  return {
    service: new DatabaseService(pool, logs.logger, shutdown, readiness),
    pool,
    logs,
    shutdown,
    readiness,
  };
}

async function eventually(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('readiness against the real server', () => {
  // Break caught: a check that does not reach the database, or one that rejects the identity it is
  // meant to accept.
  it('is ready as the runtime role', async () => {
    const { service, readiness, shutdown } = build(database.urlFor(API_RUNTIME_ROLE));
    try {
      await expect(service.check()).resolves.toBeUndefined();
      expect(await readiness.failing()).toEqual([]);
    } finally {
      await shutdown.closeAll();
    }
  });

  // Break caught: a wrong credential reported as ready, or reported with the credential in it.
  it('is not ready with a wrong password, and names no secret', async () => {
    const wrong = database
      .urlFor(API_RUNTIME_ROLE)
      .replace(database.settings.runtimePassword, 'wrong-pw');
    const { readiness, shutdown, logs } = build(wrong);
    try {
      expect(await readiness.failing()).toEqual(['database']);
      expect(logs.text()).not.toContain('wrong-pw');
      expect(logs.text()).not.toContain(database.settings.runtimePassword);
    } finally {
      await shutdown.closeAll();
    }
  });
});

/** What a probe role needs done to the cluster, and how to undo it. */
interface Setup {
  readonly apply?: string;
  readonly undo?: string;
}

describe('a connection that is not a safe runtime identity', () => {
  /** A login role with one extra attribute, allowed to connect to this database and to read the schema. */
  async function roleWith(attributes: string, memberOfOwner = false, setup: Setup = {}) {
    const name = `melarc_probe_${suffix()}`;
    const password = `pw-${suffix()}`;
    const fill = (statement: string) =>
      statement.replaceAll('%ROLE%', name).replaceAll('%DATABASE%', `"${database.name}"`);
    await withClient(database.urlFor('postgres'), async (client) => {
      await client.query(`create role ${name} login ${attributes} password '${password}'`);
      await client.query(`grant connect on database "${database.name}" to ${name}`);
      if (memberOfOwner) await client.query(`grant ${OWNER_ROLE} to ${name}`);
      if (setup.apply !== undefined) await client.query(fill(setup.apply));
    });
    const url = buildDatabaseUrl({
      host: database.settings.host,
      port: database.settings.port,
      user: name,
      password,
      database: database.name,
    });
    return {
      name,
      url,
      drop: () =>
        withClient(database.urlFor('postgres'), async (client) => {
          // What the probe stored on the database is undone, or every test after it would find it there.
          if (setup.undo !== undefined) await client.query(fill(setup.undo));
          await client.query(`drop owned by ${name}`);
          await client.query(`drop role ${name}`);
        }),
    };
  }

  // Break caught: a runtime connection with any power that makes row-level security bypassable or
  // removable being accepted as ready (SECURITY_DESIGN.md section 14.6). Each is a role the server will
  // really let connect; the check has to refuse it, and say which kind it was.
  it.each<[string, string, boolean, string, Setup?]>([
    ['a superuser', 'superuser', false, 'rolsuper'],
    ['a role that bypasses row-level security', 'bypassrls', false, 'rolbypassrls'],
    ['a role that can create databases', 'createdb', false, 'rolcreatedb'],
    ['a role that can create roles', 'createrole', false, 'rolcreaterole'],
    ['a role that is a member of the owner', '', true, 'owns_database'],
    ['a role that can replicate', 'replication', false, 'rolreplication'],
    [
      'a role that is a member of a predefined role',
      '',
      false,
      'has_predefined_role',
      { apply: 'grant pg_read_all_data to %ROLE%' },
    ],
    [
      'a role with a security context stored on it',
      '',
      false,
      'has_stored_context',
      { apply: "alter role %ROLE% set melarc.principal_type = 'SYSTEM'" },
    ],
    [
      'a role in a database with a security context stored on it',
      '',
      false,
      'has_stored_context',
      {
        apply: "alter database %DATABASE% set melarc.principal_type = 'SYSTEM'",
        undo: 'alter database %DATABASE% reset melarc.principal_type',
      },
    ],
    // The posture checks of S0.5 (SECURITY_DESIGN.md §14.6, GBT-J16): each is something the role has been given, and the
    // check names it. The role is dropped with `drop owned by`, which removes what it was given or came to own.
    [
      'a role with CREATE on a schema',
      '',
      false,
      'can_create_in_schema',
      { apply: 'grant create on schema melarc to %ROLE%' },
    ],
    [
      'a role with CREATE on the database',
      '',
      false,
      'can_create_in_database',
      { apply: 'grant create on database %DATABASE% to %ROLE%' },
    ],
    [
      'a role that owns a schema',
      '',
      false,
      'owns_schema',
      { apply: 'create schema probe_schema_%ROLE% authorization %ROLE%' },
    ],
    [
      'a role that owns a function',
      '',
      false,
      'owns_function',
      {
        apply: `grant create on schema public to %ROLE%;
                create function public.probe_fn_%ROLE%() returns int language sql as 'select 1';
                alter function public.probe_fn_%ROLE%() owner to %ROLE%;`,
      },
    ],
    [
      'a role that is a member of a role with a power',
      '',
      false,
      'member_of_unsafe_role',
      {
        apply: 'create role %ROLE%_helper nologin createrole; grant %ROLE%_helper to %ROLE%;',
        undo: 'drop role %ROLE%_helper',
      },
    ],
    [
      'a role that is a member of a role that can log in',
      '',
      false,
      'member_of_unsafe_role',
      {
        apply: 'create role %ROLE%_login login; grant %ROLE%_login to %ROLE%;',
        undo: 'drop role %ROLE%_login',
      },
    ],
    [
      'a role that can execute a SECURITY DEFINER function it was not granted by a reviewed migration',
      '',
      false,
      'can_execute_definer',
      {
        apply: `create function public.probe_definer_%ROLE%() returns int language sql security definer
                  set search_path = pg_catalog as 'select 1';
                revoke all on function public.probe_definer_%ROLE%() from public;
                grant execute on function public.probe_definer_%ROLE%() to %ROLE%;`,
        undo: 'drop function public.probe_definer_%ROLE%()',
      },
    ],
    // Privileges reachable by switching role (review of S0.4 and S0.5). A membership granted WITH INHERIT FALSE, SET TRUE gives
    // the member none of the role's privileges as they stand, and lets it become the role with SET ROLE and have them all.
    // Each case is a login that holds nothing itself and can switch into a role that holds the privilege; the role is a
    // plain NOLOGIN grant set with no attribute, so only the reachable privilege can make it unsafe.
    [
      'a role that can switch into a role that can create in a schema',
      '',
      false,
      'can_create_in_schema',
      {
        apply: `create role %ROLE%_grant nologin;
                grant create on schema public to %ROLE%_grant;
                grant %ROLE%_grant to %ROLE% with inherit false, set true;`,
        undo: 'drop owned by %ROLE%_grant; drop role %ROLE%_grant',
      },
    ],
    [
      'a role that can switch into a role that can create in the database',
      '',
      false,
      'can_create_in_database',
      {
        apply: `create role %ROLE%_grant nologin;
                grant create on database %DATABASE% to %ROLE%_grant;
                grant %ROLE%_grant to %ROLE% with inherit false, set true;`,
        undo: 'drop owned by %ROLE%_grant; drop role %ROLE%_grant',
      },
    ],
    [
      'a role that can switch into a role that can execute a SECURITY DEFINER function',
      '',
      false,
      'can_execute_definer',
      {
        apply: `create role %ROLE%_grant nologin;
                create function public.probe_set_%ROLE%() returns int language sql security definer
                  set search_path = pg_catalog as 'select 1';
                revoke all on function public.probe_set_%ROLE%() from public;
                grant execute on function public.probe_set_%ROLE%() to %ROLE%_grant;
                grant %ROLE%_grant to %ROLE% with inherit false, set true;`,
        undo: 'drop function public.probe_set_%ROLE%(); drop owned by %ROLE%_grant; drop role %ROLE%_grant',
      },
    ],
    [
      'a role that reaches a role that can create in a schema through another, switching at each step',
      '',
      false,
      'can_create_in_schema',
      {
        apply: `create role %ROLE%_mid nologin;
                create role %ROLE%_leaf nologin;
                grant create on schema public to %ROLE%_leaf;
                grant %ROLE%_leaf to %ROLE%_mid with inherit false, set true;
                grant %ROLE%_mid to %ROLE% with inherit false, set true;`,
        undo: 'drop owned by %ROLE%_leaf; drop role %ROLE%_leaf; drop role %ROLE%_mid',
      },
    ],
    [
      'a role that inherits a role that can create in a schema through one that it can only switch into',
      '',
      false,
      'can_create_in_schema',
      {
        apply: `create role %ROLE%_mid nologin;
                create role %ROLE%_leaf nologin;
                grant create on schema public to %ROLE%_leaf;
                grant %ROLE%_leaf to %ROLE%_mid with inherit true, set false;
                grant %ROLE%_mid to %ROLE% with inherit false, set true;`,
        undo: 'drop owned by %ROLE%_leaf; drop role %ROLE%_leaf; drop role %ROLE%_mid',
      },
    ],
  ])('refuses %s', async (_label, attributes, memberOfOwner, flag, setup) => {
    const probe = await roleWith(attributes, memberOfOwner, setup);
    const { service, logs, shutdown } = build(probe.url);
    try {
      await expect(service.check()).rejects.toThrow('not a safe runtime identity');

      const record = logs
        .records()
        .find((r) => r.msg === 'database role is not a safe runtime identity');
      expect(record).toMatchObject({ role: probe.name });
      expect(record?.flags).toContain(flag);
      expect(logs.text()).not.toContain(probe.url);
    } finally {
      await shutdown.closeAll();
      await probe.drop();
    }
  });

  // The route is real, which is why the checks above are not pedantry: a login with a membership that it does not inherit
  // cannot create a table, and the same login can once it has switched into the role. The posture check refuses it either way.
  it('is refused for a privilege it can only reach by switching role, which it really can', async () => {
    const probe = await roleWith('', false, {
      apply: `create role %ROLE%_grant nologin;
              grant create on schema public to %ROLE%_grant;
              grant %ROLE%_grant to %ROLE% with inherit false, set true;`,
      undo: 'drop owned by %ROLE%_grant; drop role %ROLE%_grant',
    });
    const { service, logs, shutdown } = build(probe.url);
    try {
      // Asked first, before the login has made anything: once it has created a table as the other role, owning it would be a
      // finding of its own and would hide whether the privilege was seen.
      await expect(service.check()).rejects.toThrow('not a safe runtime identity');
      expect(
        logs.records().find((r) => r.msg === 'database role is not a safe runtime identity')?.flags,
      ).toEqual(['can_create_in_schema']);

      await withClient(probe.url, async (client) => {
        expect(await sqlState(client, 'create table public.reached (id int)')).toBe('42501');
        await client.query(`set role ${probe.name}_grant`);
        expect(await sqlState(client, 'create table public.reached (id int)')).toBeUndefined();
      });
    } finally {
      await shutdown.closeAll();
      await probe.drop();
    }
  });

  // Control: a grant-set role that holds nothing is not a finding, however the membership is granted. Without this the
  // checks above could pass by refusing every login that can switch into any role.
  it.each([
    ['inherited', 'with inherit true, set false'],
    ['switched into', 'with inherit false, set true'],
    ['both', 'with inherit true, set true'],
  ])('accepts a login that has a harmless grant-set role, %s', async (_how, options) => {
    const probe = await roleWith('', false, {
      apply: `create role %ROLE%_harmless nologin;
              grant %ROLE%_harmless to %ROLE% ${options};`,
      undo: 'drop role %ROLE%_harmless',
    });
    const { service, shutdown } = build(probe.url);
    try {
      await expect(service.check()).resolves.toBeUndefined();
    } finally {
      await shutdown.closeAll();
      await probe.drop();
    }
  });

  // Break caught: the migration identity being accepted as the API's connection. It is a member of the
  // owner, so it can alter every table and policy; the API must refuse to run as it even if the URL
  // check in the configuration were bypassed.
  it('refuses the migration identity', async () => {
    const { service, logs, shutdown } = build(database.urlFor(MIGRATION_ROLE));
    try {
      await expect(service.check()).rejects.toThrow('not a safe runtime identity');
      expect(
        logs.records().find((r) => r.msg === 'database role is not a safe runtime identity'),
      ).toMatchObject({
        role: MIGRATION_ROLE,
      });
    } finally {
      await shutdown.closeAll();
    }
  });

  // Break caught: the cluster administrator being accepted.
  it('refuses the cluster administrator', async () => {
    const { service, shutdown } = build(database.urlFor('postgres'));
    try {
      await expect(service.check()).rejects.toThrow('not a safe runtime identity');
    } finally {
      await shutdown.closeAll();
    }
  });
});

describe('an idle connection that the server ends', () => {
  // Break caught: an idle connection failing with no listener, which is an uncaught exception that ends
  // the process; or its error being logged with the connection string; or the pool not recovering.
  it('is logged without the connection details, and the pool carries on', async () => {
    const { service, logs, shutdown } = build(database.urlFor(API_RUNTIME_ROLE));
    try {
      await service.check();
      await withClient(database.urlFor('postgres'), (client) =>
        client.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and datname = $2',
          [API_RUNTIME_ROLE, database.name],
        ),
      );

      await eventually(
        () => logs.records().some((r) => r.msg === 'idle database client error'),
        'the idle client error to be logged',
      );

      const text = logs.text();
      expect(text).not.toContain(database.settings.runtimePassword);
      expect(text).not.toContain('postgres://');
      await expect(service.check()).resolves.toBeUndefined();
    } finally {
      await shutdown.closeAll();
    }
  });
});

describe('a connection that the server ends during a transaction', () => {
  // Break caught: a client checked out for a transaction having no error listener (the pool removes its own at
  // checkout). A restart, a failover or a terminated backend then raised an uncaught exception, which the API's
  // fault handler turns into the end of the process. The transaction must fail alone, and the pool must go on.
  it.each([
    ['between two statements', 'between'],
    ['while a statement is running', 'during'],
  ] as const)('fails only that transaction when it happens %s', async (_when, moment) => {
    const { service, logs, shutdown } = build(database.urlFor(API_RUNTIME_ROLE), 2);
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      const terminate = (pid: unknown) =>
        withClient(database.urlFor('postgres'), (client) =>
          client.query('select pg_terminate_backend($1)', [pid]),
        );

      await expect(
        service.transactionWithContext(staffContext([]), async (tx) => {
          const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]?.pid;
          expect(pid).toEqual(expect.any(Number));
          if (moment === 'between') {
            await terminate(pid);
            await new Promise((resolve) => setTimeout(resolve, 300));
            await tx.execute(sql`select 1`);
          } else {
            setTimeout(() => void terminate(pid), 200);
            await tx.execute(sql`select pg_sleep(5)`);
          }
        }),
      ).rejects.toThrow();

      // An error event that nobody handled arrives on a later tick.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(uncaught).toEqual([]);
      await expect(service.check()).resolves.toBeUndefined();
      expect(logs.text()).not.toContain(database.settings.runtimePassword);
    } finally {
      process.off('uncaughtException', record);
      await shutdown.closeAll();
    }
  });
});

describe('shutdown', () => {
  // Break caught: a pool that is "closed" in the registry while the server still holds its connections,
  // which is how a deploy leaks connections until the server refuses new ones.
  it('releases every connection the pool held', async () => {
    const { service, pool, shutdown } = build(database.urlFor(API_RUNTIME_ROLE), 3);
    await Promise.all([service.check(), service.check(), service.check()]);
    const sessions = () =>
      withClient(database.urlFor('postgres'), async (client) =>
        Number(
          await scalar<string>(
            client,
            'select count(*) from pg_stat_activity where usename = $1 and datname = $2',
            [API_RUNTIME_ROLE, database.name],
          ),
        ),
      );
    expect(await sessions()).toBeGreaterThan(0);

    const closed = await shutdown.closeAll();

    expect(closed.closed).toEqual(['database-pool']);
    expect(pool.ended).toBe(true);
    // The server notices a closed connection a moment after the client closes it.
    const deadline = Date.now() + 5_000;
    let remaining = await sessions();
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = await sessions();
    }
    expect(remaining).toBe(0);
  });
});
