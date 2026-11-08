import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { API_RUNTIME_ROLE } from '../platform/config/load-config.js';
import { PROVISIONING_ROLE, WORKER_RUNTIME_ROLE } from '../platform/database/technical-roles.js';
import { CliUsageError, runCli } from './database/cli.js';
import { readLocalPostgres, type LocalPostgres } from './database/local-env.js';
import { localLoginPassword } from './database/local-logins.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  dropDisposableDatabase,
  listTestDatabases,
  provisionRoles,
} from './database/provisioning.js';
import { runMigrations } from './database/run-migrations.js';
import { MIGRATION_ROLE, UnsafeTargetError } from './database/safety.js';
import { arrange, observe } from './e2e/arrangements.js';
import { runSeedCommand } from './seed/seed-command.js';

/**
 * Gives the integrated test harness (e2e/) a database of its own, and takes it away again. It is a command
 * and not a library so that the harness depends on nothing inside the API: it runs this, reads one line.
 *
 *   create        a disposable database, owned by the owner role, migrated, with the roles an API needs.
 *                 Prints one JSON line: { database, migrationUrl, runtimeUrl, workerUrl }. The URLs carry the
 *                 passwords, which is the only place they are written.
 *   create --seed the same, with the reference data written by the real seed (`db:seed`, as the
 *                 provisioning login). An API over a database the seed has not filled is not ready
 *                 (`reference_data_missing`), so the harness asks for this. Without the flag nothing is
 *                 seeded, for whoever seeds for itself: the seed refuses to run twice. Still one line.
 *   drop <name>   removes a database this command made, connected to or not. A run uses it for its OWN
 *                 database, once it has stopped its processes. It is not how abandoned databases are cleaned
 *                 up: that is db:orphans, which lists first and drops only what a person names.
 *   list          names every disposable test database that exists, so a run can show it left none.
 *                 Prints { databases: [names] }.
 *
 * and, on a database this command made, the four things a journey needs that no operation of the application gives (S0.45):
 *
 *   bootstrap <name> <folder> <custodian> <custodian>
 *                 runs the real `bootstrap:seed` (`dist/tools/bootstrap-seed.js`, a process, as an operator starts it) against
 *                 that database as the provisioning login, writing the two custody bundles into `<folder>`, which the caller
 *                 made outside the checkout. A custodian is `Full Name <work@email>`. Prints { bootstrapped: name }.
 *   resume <name> <folder> <work email>
 *                 runs the real `bootstrap:resume` the same way. Prints { resumed: name }.
 *   arrange <name> <arrangement> <argument>...
 *                 one of the closed list in `e2e/arrangements.ts`: lets time pass for a grant, a challenge, a session or a lock,
 *                 by changing the data (there is no production time-travel switch). Fails when it changed no row.
 *   observe <name> <observation> <key>
 *                 one of the closed list in `e2e/arrangements.ts`: reads what no operation shows. Prints { rows }. The key names the
 *                 identity: the staff member's work email, the vendor account's identifier, or the rider's phone, as the observation says.
 *
 * There is no sweep. A database with no connection may belong to a run that is between two steps, so nothing
 * here removes a database because it looked idle; each run removes only the one it made.
 *
 * It refuses, before anything is sent, a server that is not on this machine and a deployed environment, as
 * every database command does. It is stricter than they are about names: it only ever drops a database whose
 * name is exactly the shape it creates, so the development database is out of its reach.
 *
 * usage: node dist/tools/e2e-database.js create [--seed] | drop <database> | list
 *        node dist/tools/e2e-database.js bootstrap <database> <folder> <custodian> <custodian>
 *        node dist/tools/e2e-database.js resume <database> <folder> <work email>
 *        node dist/tools/e2e-database.js arrange <database> <arrangement> <argument>...
 *        node dist/tools/e2e-database.js observe <database> <observation> <key>
 *        node dist/tools/e2e-database.js vendor-fixture <database>
 *        node dist/tools/e2e-database.js rider-fixture <database>
 *
 * `rider-fixture` runs the real `db:seed --rider-fixture` (MIGRATION_AND_SEEDING.md section 4a; S0.53) against a database this tool made,
 * as the provisioning login: the demonstration riders the rider journeys register a device for. It sets no PIN and registers no device.
 *
 * `vendor-fixture` runs the real `db:seed --vendor-fixture` (MIGRATION_AND_SEEDING.md section 4b; S0.47) against a database this tool made,
 * as the provisioning login, as an operator runs it: the demonstration vendor the journeys of rows 10a and 11 recover (S0.52). It writes
 * no secret, no browser and no grant; the journey asks the API for the setup link, as an officer would.
 */
const USAGE =
  'usage: node dist/tools/e2e-database.js create [--seed] | drop <database> | list | bootstrap <database> <folder> <custodian> <custodian> | resume <database> <folder> <work email> | arrange <database> <arrangement> <argument>... | observe <database> <observation> <key> | vendor-fixture <database> | rider-fixture <database>';

/** The only names this command creates and the only names it will drop or act on. */
const HARNESS_DATABASE = /^melarc_test_[0-9a-f]{8}$/;

/** The bootstrap commands write a bundle in the transaction, and on Windows each costs runs of `whoami` and `icacls`. */
const BOOTSTRAP_TIMEOUT_MS = 300_000;

function harnessDatabase(name: string | undefined): string {
  if (name === undefined || !HARNESS_DATABASE.test(name)) {
    throw new UnsafeTargetError(
      `refusing to act on "${name ?? ''}": this command only acts on databases named melarc_test_ followed by 8 hex digits`,
    );
  }
  return name;
}

const urlFor = (settings: LocalPostgres, database: string, user: string, password: string) =>
  buildDatabaseUrl({ host: settings.host, port: settings.port, user, password, database });

/** What a child that is an operator's command is given: the machine's, without the cluster administrator's settings. */
function operatorEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MELARC_PG_')) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs one of the bootstrap commands as the process it is. Its lines are not this tool's output, which is one line of JSON. */
function runOperatorCommand(
  entry: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL(entry, import.meta.url)), ...args],
      { env: operatorEnvironment(env), timeout: BOOTSTRAP_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error === null) resolve();
        else reject(new Error(`${entry} failed: ${stderr.trim() || error.message}`));
      },
    );
  });
}

/** A connection to the database itself, as the cluster administrator: for arranging a row and for reading one. */
async function withAdminOn<T>(
  settings: LocalPostgres,
  database: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database,
    application_name: 'melarc-e2e-arrange',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

await runCli(async () => {
  const [command, name, ...rest] = process.argv.slice(2);
  const known = [
    'create',
    'drop',
    'list',
    'bootstrap',
    'resume',
    'arrange',
    'observe',
    'vendor-fixture',
    'rider-fixture',
  ];
  const seed = command === 'create' && name === '--seed';
  const shapeOk =
    (command === 'create' && rest.length === 0 && (name === undefined || seed)) ||
    (command === 'drop' && name !== undefined && rest.length === 0) ||
    (command === 'list' && name === undefined) ||
    (command === 'bootstrap' && name !== undefined && rest.length === 3) ||
    (command === 'resume' && name !== undefined && rest.length === 2) ||
    (command === 'arrange' && name !== undefined && rest.length >= 1) ||
    (command === 'observe' && name !== undefined && rest.length === 2) ||
    (command === 'vendor-fixture' && name !== undefined && rest.length === 0) ||
    (command === 'rider-fixture' && name !== undefined && rest.length === 0);
  if (command === undefined || !known.includes(command) || !shapeOk) {
    throw new CliUsageError(USAGE);
  }

  const settings = readLocalPostgres();

  // These act on a database that exists, as the administrator of the cluster, and need no connection to the maintenance database.
  if (command === 'arrange' || command === 'observe') {
    const database = harnessDatabase(name);
    const [what = '', ...args] = rest;
    // `connectLocalAdmin` is what refuses a server that is not on this machine and a deployed environment.
    const guard = await connectLocalAdmin(settings);
    await guard.close();
    if (command === 'arrange') {
      const reached = await withAdminOn(settings, database, (client) =>
        arrange(client, what, args),
      );
      process.stdout.write(`${JSON.stringify({ arranged: what, rows: reached })}\n`);
    } else {
      const rows = await withAdminOn(settings, database, (client) => observe(client, what, args));
      process.stdout.write(`${JSON.stringify({ observed: what, rows })}\n`);
    }
    return;
  }

  if (command === 'vendor-fixture') {
    const database = harnessDatabase(name);
    const guard = await connectLocalAdmin(settings);
    await guard.close();
    // The real seed, as an operator runs it; its lines are not this tool's output, which is one line of JSON.
    await runSeedCommand(
      ['--vendor-fixture'],
      {
        APP_ENV: 'local',
        DATABASE_SEED_URL: urlFor(
          settings,
          database,
          PROVISIONING_ROLE,
          localLoginPassword(settings.adminPassword, PROVISIONING_ROLE),
        ),
      },
      () => undefined,
    );
    process.stdout.write(`${JSON.stringify({ vendorFixture: database })}\n`);
    return;
  }

  if (command === 'rider-fixture') {
    const database = harnessDatabase(name);
    const guard = await connectLocalAdmin(settings);
    await guard.close();
    // The real seed, as an operator runs it; its lines are not this tool's output, which is one line of JSON.
    await runSeedCommand(
      ['--rider-fixture'],
      {
        APP_ENV: 'local',
        DATABASE_SEED_URL: urlFor(
          settings,
          database,
          PROVISIONING_ROLE,
          localLoginPassword(settings.adminPassword, PROVISIONING_ROLE),
        ),
      },
      () => undefined,
    );
    process.stdout.write(`${JSON.stringify({ riderFixture: database })}\n`);
    return;
  }

  if (command === 'bootstrap' || command === 'resume') {
    const database = harnessDatabase(name);
    const [folder = '', ...people] = rest;
    const guard = await connectLocalAdmin(settings);
    await guard.close();
    const env = {
      APP_ENV: 'local',
      DATABASE_SEED_URL: urlFor(
        settings,
        database,
        PROVISIONING_ROLE,
        localLoginPassword(settings.adminPassword, PROVISIONING_ROLE),
      ),
      BOOTSTRAP_CUSTODY_DIRECTORY: folder,
    };
    if (command === 'bootstrap') {
      await runOperatorCommand(
        './bootstrap-seed.js',
        people.flatMap((person) => ['--custodian', person]),
        env,
      );
      process.stdout.write(`${JSON.stringify({ bootstrapped: database })}\n`);
    } else {
      await runOperatorCommand('./bootstrap-resume.js', ['--custodian', people[0] ?? ''], env);
      process.stdout.write(`${JSON.stringify({ resumed: database })}\n`);
    }
    return;
  }

  const admin = await connectLocalAdmin(settings);

  try {
    if (command === 'list') {
      const databases = (await listTestDatabases(admin))
        .map((database) => database.name)
        .filter((database) => HARNESS_DATABASE.test(database));
      process.stdout.write(`${JSON.stringify({ databases })}\n`);
      return;
    }

    if (command === 'drop') {
      const database = name ?? '';
      if (!HARNESS_DATABASE.test(database)) {
        throw new UnsafeTargetError(
          `refusing to drop "${database}": this command only drops databases named melarc_test_ followed by 8 hex digits`,
        );
      }
      await dropDisposableDatabase(admin, database);
      process.stdout.write(`${JSON.stringify({ dropped: database })}\n`);
      return;
    }

    const database = `melarc_test_${randomBytes(4).toString('hex')}`;
    await provisionRoles(admin, settings);
    await createDisposableDatabase(admin, database);

    const migrationUrl = urlFor(settings, database, MIGRATION_ROLE, settings.migrationPassword);
    try {
      await runMigrations({ url: migrationUrl });
    } catch (error) {
      // A database that cannot be migrated is of no use to anyone; do not leave it behind.
      await dropDisposableDatabase(admin, database);
      throw error;
    }
    if (seed) {
      try {
        // The real seed, as an operator runs it: the provisioning login names the database. Its lines are not the tool's output,
        // which is one line of JSON that the harness parses, so they are dropped.
        await runSeedCommand(
          [],
          {
            APP_ENV: 'local',
            DATABASE_SEED_URL: urlFor(
              settings,
              database,
              PROVISIONING_ROLE,
              localLoginPassword(settings.adminPassword, PROVISIONING_ROLE),
            ),
          },
          () => undefined,
        );
      } catch (error) {
        // A database that cannot be seeded is of no use to the harness; do not leave it behind.
        await dropDisposableDatabase(admin, database);
        throw error;
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        database,
        migrationUrl,
        runtimeUrl: urlFor(settings, database, API_RUNTIME_ROLE, settings.runtimePassword),
        // The delivery worker's login, derived as `db:seed` derives the provisioning login's: for a cluster on this machine only.
        workerUrl: urlFor(
          settings,
          database,
          WORKER_RUNTIME_ROLE,
          localLoginPassword(settings.adminPassword, WORKER_RUNTIME_ROLE),
        ),
      })}\n`,
    );
  } finally {
    await admin.close();
  }
});
