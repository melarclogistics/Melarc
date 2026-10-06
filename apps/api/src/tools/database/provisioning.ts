import pg from 'pg';

import { API_RUNTIME_ROLE } from '../../platform/config/load-config.js';
import {
  postgresConnectionSettings,
  PostgresUrlError,
} from '../../platform/database/postgres-url.js';
import type { LocalPostgres } from './local-env.js';
import {
  assertDisposableName,
  assertLocalHost,
  assertNotDeployedEnvironment,
  MIGRATION_ROLE,
  UnsafeTargetError,
} from './safety.js';

/** The NOLOGIN role that owns every database object (SECURITY_DESIGN.md section 14.17a). */
export const OWNER_ROLE = 'melarc_owner';

/** Set as the comment on a database this tooling created. Only a database carrying it can be dropped. */
export const DISPOSABLE_MARKER = 'melarc:disposable';

/** The smallest surface the provisioning code needs from a connection, so refusals can be tested without one. */
export interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** An administrator connection to a server on this machine. Obtained only from {@link connectLocalAdmin}. */
export interface LocalAdmin {
  readonly client: SqlClient;
  readonly host: string;
  close(): Promise<void>;
}

const NO_PRIVILEGES = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

/**
 * The URL for a target, which must read back as exactly the parts it was built from. A part with URL
 * syntax in it (a host such as `127.0.0.1?user=postgres`) would otherwise change what the URL means, and
 * the settings read out of it would not be the target that was asked for. The refusal names no part.
 */
export function buildDatabaseUrl(target: {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const url =
    `postgres://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}` +
    `@${host}:${String(target.port)}/${encodeURIComponent(target.database)}`;

  let read: ReturnType<typeof postgresConnectionSettings> | undefined;
  try {
    read = postgresConnectionSettings(url);
  } catch (error) {
    if (!(error instanceof PostgresUrlError)) throw error;
  }
  if (
    read?.host !== target.host ||
    read.port !== target.port ||
    read.user !== target.user ||
    (read.password ?? '') !== target.password ||
    read.database !== target.database
  ) {
    throw new UnsafeTargetError(
      'refusing to build a database URL: the host, port, user, password and database do not read back as given',
    );
  }
  return url;
}

/**
 * Connects as the cluster administrator, to the `postgres` maintenance database. Refuses before any
 * connection or name lookup when the host is not this machine or a deployed environment is in scope.
 */
export async function connectLocalAdmin(
  settings: LocalPostgres,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalAdmin> {
  assertLocalHost(settings.host);
  assertNotDeployedEnvironment(env);
  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database: 'postgres',
    application_name: 'melarc-db-admin',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  return { client, host: settings.host, close: () => client.end() };
}

/**
 * Runs a statement the server has formatted. Utility statements take no bind parameters, so identifiers
 * and literals are escaped by the server's `format()` with `%I` and `%L`, never by string concatenation.
 */
async function runFormatted(client: SqlClient, template: string, ...args: string[]): Promise<void> {
  const { rows } = await client.query('select format($1::text, variadic $2::text[]) as statement', [
    template,
    args,
  ]);
  await client.query(String(rows[0]?.statement));
}

/** Serialises provisioning across processes: roles are cluster-wide, so parallel test files share them. */
async function withProvisioningLock<T>(client: SqlClient, work: () => Promise<T>): Promise<T> {
  const lock = "hashtextextended('melarc:provisioning', 0)";
  await client.query(`select pg_advisory_lock(${lock})`);
  try {
    return await work();
  } finally {
    await client.query(`select pg_advisory_unlock(${lock})`);
  }
}

async function roleExists(client: SqlClient, name: string): Promise<boolean> {
  const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [name]);
  return rows.length > 0;
}

/**
 * Creates the three roles, or brings existing ones back to the intended shape, and sets their passwords.
 * Safe to repeat. Credentials are distinct: the migration role may create objects and run as the owner;
 * the runtime role owns nothing, bypasses nothing and is not a member of the owner.
 */
export async function provisionRoles(admin: LocalAdmin, settings: LocalPostgres): Promise<void> {
  assertLocalHost(admin.host);
  const { client } = admin;
  await withProvisioningLock(client, async () => {
    const roles = [
      { name: OWNER_ROLE, login: 'NOLOGIN', password: undefined },
      { name: MIGRATION_ROLE, login: 'LOGIN', password: settings.migrationPassword },
      { name: API_RUNTIME_ROLE, login: 'LOGIN', password: settings.runtimePassword },
    ];
    for (const role of roles) {
      const verb = (await roleExists(client, role.name)) ? 'ALTER' : 'CREATE';
      await runFormatted(client, `${verb} ROLE %I WITH ${role.login} ${NO_PRIVILEGES}`, role.name);
      if (role.password !== undefined) {
        await runFormatted(client, 'ALTER ROLE %I WITH PASSWORD %L', role.name, role.password);
      }
    }

    await runFormatted(
      client,
      'GRANT %I TO %I WITH INHERIT TRUE, SET TRUE',
      OWNER_ROLE,
      MIGRATION_ROLE,
    );

    const { rows: memberships } = await client.query(
      `select 1
         from pg_auth_members m
         join pg_roles member on member.oid = m.member
         join pg_roles granted on granted.oid = m.roleid
        where member.rolname = $1 and granted.rolname = $2`,
      [API_RUNTIME_ROLE, OWNER_ROLE],
    );
    if (memberships.length > 0) {
      await runFormatted(client, 'REVOKE %I FROM %I', OWNER_ROLE, API_RUNTIME_ROLE);
    }
  });
}

async function disposableMarker(
  client: SqlClient,
  name: string,
): Promise<{ exists: boolean; marked: boolean }> {
  const { rows } = await client.query(
    `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
    [name],
  );
  const row = rows[0];
  return { exists: row !== undefined, marked: row?.comment === DISPOSABLE_MARKER };
}

/** Shuts a database to every role but the two that may connect to it. Safe to repeat. */
async function restrictConnections(client: SqlClient, name: string): Promise<void> {
  await runFormatted(client, 'REVOKE ALL ON DATABASE %I FROM PUBLIC', name);
  await runFormatted(
    client,
    'GRANT CONNECT ON DATABASE %I TO %I, %I',
    name,
    MIGRATION_ROLE,
    API_RUNTIME_ROLE,
  );
}

/**
 * Creates a development or test database owned by the owner role and marks it disposable. Only the
 * migration and runtime roles may connect. Safe to repeat for a database this tooling already made: that one is
 * shut to everyone else again, in case an earlier run ended before it had done so; refuses one it did not make.
 *
 * CREATE DATABASE cannot be part of a transaction, so a failure after it would leave a database that is not
 * marked, which this tooling would then refuse to adopt for ever, or one that is marked and open to every role.
 * A database that this call created and could not finish is dropped again.
 */
export async function createDisposableDatabase(admin: LocalAdmin, name: string): Promise<void> {
  assertDisposableName(name);
  assertLocalHost(admin.host);
  const { client } = admin;
  await withProvisioningLock(client, async () => {
    const { exists, marked } = await disposableMarker(client, name);
    if (exists && !marked) {
      throw new UnsafeTargetError(
        `database "${name}" already exists and was not created by this tooling, so it is not adopted`,
      );
    }
    if (exists) {
      await restrictConnections(client, name);
      return;
    }
    await runFormatted(client, 'CREATE DATABASE %I OWNER %I TEMPLATE template0', name, OWNER_ROLE);
    try {
      await runFormatted(client, 'COMMENT ON DATABASE %I IS %L', name, DISPOSABLE_MARKER);
      await restrictConnections(client, name);
    } catch (error) {
      // The failure that matters is the one that stopped the creation, not one of the cleanup.
      await runFormatted(client, 'DROP DATABASE IF EXISTS %I WITH (FORCE)', name).catch(
        () => undefined,
      );
      throw error;
    }
  });
}

/** A test database that exists, and how many sessions are connected to it right now. */
export interface TestDatabaseListing {
  readonly name: string;
  readonly sessions: number;
}

/**
 * Every test database on this machine's server that carries the disposable marker, with the number of sessions
 * connected to it. It only reads. It says nothing about whose a database is: no session does not mean abandoned
 * (a run between two steps has none), and the number is a fact about this moment. Nothing is ever deleted
 * because of what this returns; a person chooses what to remove (see the db:orphans command).
 */
export async function listTestDatabases(admin: LocalAdmin): Promise<TestDatabaseListing[]> {
  assertLocalHost(admin.host);
  const { rows } = await admin.client.query(
    `select d.datname as name,
            (select count(*) from pg_stat_activity a where a.datname = d.datname)::int as sessions
       from pg_database d
      where d.datname ~ '^melarc_test_[a-z0-9]{4,32}$'
        and shobj_description(d.oid, 'pg_database') = $1
      order by d.datname`,
    [DISPOSABLE_MARKER],
  );
  return rows.flatMap((row) =>
    typeof row.name === 'string' && typeof row.sessions === 'number'
      ? [{ name: row.name, sessions: row.sessions }]
      : [],
  );
}

/**
 * Drops a disposable database: a local server, a development or test name and the marker, all checked
 * before anything is terminated or dropped. A database that does not exist is not an error.
 *
 * By default it ends the sessions connected to the database and forces the drop: that is what a run does to
 * its own database, which its API or a test may still hold. With `disconnect: false` it ends nobody's session
 * and asks for a plain drop, which the server refuses while any session is connected; that refusal is the
 * server's own and cannot race a connection made a moment later, so it is what removing someone else's
 * database by name uses.
 */
export async function dropDisposableDatabase(
  admin: LocalAdmin,
  name: string,
  options: { readonly disconnect?: boolean } = {},
): Promise<void> {
  assertDisposableName(name);
  assertLocalHost(admin.host);
  const { client } = admin;
  const { exists, marked } = await disposableMarker(client, name);
  if (!exists) return;
  if (!marked) {
    throw new UnsafeTargetError(
      `refusing to drop database "${name}": it does not carry the ${DISPOSABLE_MARKER} marker`,
    );
  }

  if (options.disconnect === false) {
    try {
      await runFormatted(client, 'DROP DATABASE %I', name);
    } catch (error) {
      // 55006: object_in_use. Another session is connected, so the database may belong to a run that is going.
      if ((error as { code?: string }).code === '55006') {
        throw new UnsafeTargetError(
          `refusing to drop database "${name}": sessions are connected to it, so it may belong to a run that is still going`,
        );
      }
      throw error;
    }
    return;
  }

  await client.query(
    'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
    [name],
  );
  await runFormatted(client, 'DROP DATABASE IF EXISTS %I WITH (FORCE)', name);
}
