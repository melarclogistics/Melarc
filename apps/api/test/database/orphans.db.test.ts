import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readLocalPostgres } from '../../src/tools/database/local-env.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  type LocalAdmin,
} from '../../src/tools/database/provisioning.js';
import { DB_ORPHANS, killAll, requireBuild, run } from '../support/api-process.js';
import { clientFor, scalar, withClient } from './support/test-database.js';
import setup from './support/global-setup.js';

/**
 * Audit F07. The only way a database that a run left behind is removed is a person naming it to db:orphans, and
 * nothing a run does removes another run's database because it looks idle. Everything here is real: the built
 * command against the local server, and the setup that every database test run starts with.
 */
const settings = readLocalPostgres();

const toolEnv = (): Record<string, string> => ({
  MELARC_PG_HOST: settings.host,
  MELARC_PG_PORT: String(settings.port),
  MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
  MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
  MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
});
const orphans = (args: string[] = []) => run(DB_ORPHANS, toolEnv(), args, 30_000);

const adminUrl = (database: string) =>
  buildDatabaseUrl({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database,
  });

let admin: LocalAdmin;
/** Every database a test made, so cleanup does not depend on the test getting as far as dropping it. */
const made: string[] = [];

/** A marked test database, as a run makes one, with nothing connected to it. */
async function idleDatabase(): Promise<string> {
  const name = `melarc_test_${randomBytes(4).toString('hex')}`;
  made.push(name);
  await createDisposableDatabase(admin, name);
  return name;
}

const exists = (name: string) =>
  withClient(adminUrl('postgres'), (client) =>
    scalar<boolean>(client, 'select exists (select 1 from pg_database where datname = $1)', [name]),
  );

beforeAll(async () => {
  requireBuild();
  admin = await connectLocalAdmin(settings);
});
afterEach(killAll);
afterAll(async () => {
  for (const name of made) {
    await admin.client.query(`drop database if exists "${name}" with (force)`);
  }
  await admin.close();
});

describe('the listing, which is the default', () => {
  // Break caught: the default doing anything but looking. Both an idle database and one in use are listed with
  // what the server knows about them, and both are still there afterwards.
  it('lists test databases with their sessions, and removes none', async () => {
    const idle = await idleDatabase();
    const busy = await idleDatabase();
    const session = clientFor(adminUrl(busy));
    await session.connect();
    try {
      const result = await orphans();

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(idle);
      expect(result.stdout).toContain(busy);
      expect(result.stdout).toMatch(/nothing was changed/i);
      expect(await exists(idle)).toBe(true);
      expect(await exists(busy)).toBe(true);
    } finally {
      await session.end();
    }
  });
});

describe('removing a database by name', () => {
  // Break caught: a removal that takes more than it was told to. The idle database named goes, and the idle one
  // next to it, which was not named, stays.
  it('drops the database that was named and no other', async () => {
    const named = await idleDatabase();
    const neighbour = await idleDatabase();

    const result = await orphans(['--drop', named]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`dropped ${named}`);
    expect(await exists(named)).toBe(false);
    expect(await exists(neighbour)).toBe(true);
  });

  // Break caught: a database in use being dropped because a person named it. Without --disconnect it is
  // refused, it stays, and the session connected to it is not ended.
  it('refuses a database with a session connected, and leaves the session alive', async () => {
    const busy = await idleDatabase();
    const session = clientFor(adminUrl(busy));
    await session.connect();
    try {
      const result = await orphans(['--drop', busy]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('sessions are connected');
      expect(await exists(busy)).toBe(true);
      expect((await session.query('select 1 as alive')).rows).toEqual([{ alive: 1 }]);
    } finally {
      await session.end();
    }
  });

  it('drops a database with a session connected only when told to disconnect', async () => {
    const busy = await idleDatabase();
    const session = clientFor(adminUrl(busy));
    session.on('error', () => undefined);
    await session.connect();
    try {
      const result = await orphans(['--drop', busy, '--disconnect']);

      expect(result.code).toBe(0);
      expect(await exists(busy)).toBe(false);
    } finally {
      await session.end().catch(() => undefined);
    }
  });

  // Break caught: a database that merely has a test database's name being removed. Without the marker this
  // tooling writes it is somebody's, and it is left exactly as it was.
  it('refuses a database without the marker, and one that does not exist', async () => {
    const unmarked = `melarc_test_${randomBytes(4).toString('hex')}`;
    made.push(unmarked);
    await admin.client.query(`create database "${unmarked}"`);

    const refused = await orphans(['--drop', unmarked]);
    const missing = await orphans(['--drop', 'melarc_test_ffff0000']);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('marker');
    expect(await exists(unmarked)).toBe(true);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('marker');
  });

  // Break caught: one bad name among good ones leaving the good ones removed: a typo should stop the whole
  // request, not half of it.
  it('removes nothing when any name is refused', async () => {
    const good = await idleDatabase();

    const result = await orphans(['--drop', good, 'melarc_dev']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('only databases named melarc_test_');
    expect(await exists(good)).toBe(true);
  });
});

describe('what other runs do to a database that is idle (audit F07)', () => {
  // Break caught: the start of a database test run removing a database it did not make. This is the exact
  // function every `test:db` run starts with, while another run's database has no connection.
  it('is left alone by the setup of a database test run', async () => {
    const someoneElses = await idleDatabase();

    await setup();

    expect(await exists(someoneElses)).toBe(true);
  });

  it('is left alone by the setup of a database test run, and by listing', async () => {
    const someoneElses = await idleDatabase();

    await setup();
    await orphans();

    expect(await exists(someoneElses)).toBe(true);
    // And it is still there to be found and removed by name.
    expect((await orphans()).stdout).toContain(someoneElses);
  });
});
