import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { readLocalPostgres } from '../../src/tools/database/local-env.js';
import { buildDatabaseUrl } from '../../src/tools/database/provisioning.js';
import { E2E_DATABASE, killAll, requireBuild, run } from '../support/api-process.js';
import { clientFor, scalar, withClient } from './support/test-database.js';

/**
 * The command the integrated test harness uses to get a database of its own: a disposable database, owned by
 * the owner role, migrated, with the roles an API needs. Run for real against the local server. Every target
 * is a database this file made; `melarc_dev` is never named.
 */
const settings = readLocalPostgres();
const TOOL_DEADLINE_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;

const toolEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  MELARC_PG_HOST: settings.host,
  MELARC_PG_PORT: String(settings.port),
  MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
  MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
  MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
  ...extra,
});

const tool = (args: string[], extra: Record<string, string> = {}) =>
  run(E2E_DATABASE, toolEnv(extra), args, TOOL_DEADLINE_MS);

const adminUrl = (database: string) =>
  buildDatabaseUrl({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database,
  });

interface Created {
  database: string;
  migrationUrl: string;
  runtimeUrl: string;
}

/** Every database a test made, so cleanup does not depend on the test getting as far as dropping it. */
const made: string[] = [];

async function create(): Promise<Created> {
  const result = await tool(['create']);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const created = JSON.parse(result.stdout) as Created;
  made.push(created.database);
  return created;
}

const exists = (name: string) =>
  withClient(adminUrl('postgres'), (client) =>
    scalar<boolean>(client, 'select exists (select 1 from pg_database where datname = $1)', [name]),
  );

beforeAll(requireBuild);
afterEach(killAll);
afterAll(async () => {
  await withClient(adminUrl('postgres'), async (client) => {
    for (const name of made) await client.query(`drop database if exists "${name}" with (force)`);
  });
});

describe('create', () => {
  // Break caught: a database that exists but cannot be used: no migrations, or credentials that do not
  // work. The harness takes the two URLs from this one line, so each is proven by using it.
  it(
    'makes a migrated disposable database and returns working credentials, as one JSON line',
    async () => {
      const created = await create();

      expect(created.database).toMatch(/^melarc_test_[0-9a-f]{8}$/);
      await withClient(created.migrationUrl, async (client) => {
        expect(await scalar(client, "select to_regnamespace('melarc') is not null")).toBe(true);
      });
      await withClient(created.runtimeUrl, async (client) => {
        expect(await scalar(client, 'select current_user')).toBe(API_RUNTIME_ROLE);
        expect(
          await scalar(
            client,
            'select rolsuper or rolbypassrls or rolcreatedb or rolcreaterole from pg_roles where rolname = current_user',
          ),
        ).toBe(false);
      });
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: two runs given the same database, so parallel or repeated runs share and corrupt state.
  it(
    'gives every run a database of its own',
    async () => {
      const [first, second] = [await create(), await create()];

      expect(first.database).not.toBe(second.database);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a credential leaking into the logs of a run. The URLs are the one place a password is
  // written, on stdout, for the harness to read; nothing else, and nothing on stderr.
  it(
    'writes passwords only inside the two URLs',
    async () => {
      const result = await tool(['create']);
      const created = JSON.parse(result.stdout) as Created;
      made.push(created.database);

      const withoutUrls = result.stdout
        .replace(JSON.stringify(created.migrationUrl), '')
        .replace(JSON.stringify(created.runtimeUrl), '');
      for (const secret of [
        settings.adminPassword,
        settings.migrationPassword,
        settings.runtimePassword,
      ]) {
        expect(withoutUrls).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('drop', () => {
  // Break caught: a database left behind by a run, which is how a machine fills up with test databases.
  it(
    'removes a database it made, including one that is still connected to',
    async () => {
      const created = await create();
      const held = clientFor(created.runtimeUrl);
      // The server ends this connection when the database is dropped, which is what is being proved, so the
      // resulting error event is expected and is not a failure of the test.
      held.on('error', () => undefined);
      await held.connect();
      await held.query('select 1');

      const result = await tool(['drop', created.database]);
      await held.end().catch(() => undefined);

      expect(result.code).toBe(0);
      expect(await exists(created.database)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: the command dropping something it did not make. A database without the marker this
  // tooling writes is somebody's, whatever its name looks like, and is left exactly as it was.
  it(
    'refuses a database that does not carry the disposable marker, and leaves it alone',
    async () => {
      const name = `melarc_test_${randomBytes(4).toString('hex')}`;
      made.push(name);
      await withClient(adminUrl('postgres'), (client) => client.query(`create database "${name}"`));

      const result = await tool(['drop', name]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('marker');
      expect(await exists(name)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a name that is not a test database being acted on. The development database is
  // melarc_dev, and a production-looking name is neither.
  it.each(['postgres', 'melarc_dev', 'melarc_prod', 'melarc_test', 'melarc_test_abcd'])(
    'refuses the name %s, and leaves whatever has it as it was',
    async (name) => {
      const before = await exists(name);

      const result = await tool(['drop', name]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('melarc_test_');
      expect(await exists(name)).toBe(before);
    },
  );

  it('says how to use it when it is given no name or an unknown command', async () => {
    const missing = await tool(['drop']);
    const unknown = await tool(['explode']);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('usage');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('usage');
  });
});

describe('list', () => {
  // Break caught: no way to prove that a run left nothing behind. The harness lists the disposable databases before
  // and after, and a leak is a difference.
  it(
    'names the disposable test databases, including ones it made, and only those',
    async () => {
      const created = await create();
      const unmarked = `melarc_test_${randomBytes(4).toString('hex')}`;
      made.push(unmarked);
      await withClient(adminUrl('postgres'), (client) =>
        client.query(`create database "${unmarked}"`),
      );

      const result = await tool(['list']);

      expect(result.code).toBe(0);
      const { databases } = JSON.parse(result.stdout) as { databases: string[] };
      expect(databases).toContain(created.database);
      expect(databases).not.toContain(unmarked);
      expect(databases.every((name) => /^melarc_test_[0-9a-f]{8}$/.test(name))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('no run removes another run’s database (audit F07)', () => {
  // Break caught: a database that has no connection yet, because its run is between creating it and starting
  // its API, being removed by a command that finds it idle. There is no sweep: the command is gone, so a
  // leftover is removed only by name (db:orphans).
  it(
    'has no sweep command, and refuses to be asked for one without touching any database',
    async () => {
      const idle = await create();

      const result = await tool(['sweep']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('usage');
      expect(result.stderr).not.toContain('sweep');
      expect(await exists(idle.database)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: creating, listing or dropping one run's database disturbing another run's idle one. Each of
  // the commands a run uses leaves a database it did not name exactly as it was.
  it(
    'leaves an idle database alone while others are created, listed and dropped',
    async () => {
      const other = await create();
      const mine = await create();

      const listed = await tool(['list']);
      const dropped = await tool(['drop', mine.database]);
      const another = await create();

      expect(listed.code).toBe(0);
      expect((JSON.parse(listed.stdout) as { databases: string[] }).databases).toContain(
        other.database,
      );
      expect(dropped.code).toBe(0);
      expect(await exists(mine.database)).toBe(false);
      expect(await exists(other.database)).toBe(true);
      expect(await exists(another.database)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('where it will run', () => {
  // Break caught: a database command reaching a server that is not this machine, which is how a shared or
  // production cluster is lost. The refusal comes before any connection.
  it.each(['db.internal', '10.0.0.5'])('refuses the host %s without connecting', async (host) => {
    const result = await tool(['create'], { MELARC_PG_HOST: host });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not on this machine');
    expect(result.stderr).not.toContain('not reachable');
  });

  it.each(['staging', 'production'])('refuses APP_ENV=%s', async (appEnv) => {
    const result = await tool(['create'], { APP_ENV: appEnv });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`APP_ENV=${appEnv}`);
  });
});
