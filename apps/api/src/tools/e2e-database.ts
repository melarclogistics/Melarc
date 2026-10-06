import { randomBytes } from 'node:crypto';

import { API_RUNTIME_ROLE } from '../platform/config/load-config.js';
import { CliUsageError, runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
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

/**
 * Gives the integrated test harness (e2e/) a database of its own, and takes it away again. It is a command
 * and not a library so that the harness depends on nothing inside the API: it runs this, reads one line.
 *
 *   create        a disposable database, owned by the owner role, migrated, with the roles an API needs.
 *                 Prints one JSON line: { database, migrationUrl, runtimeUrl }. The URLs carry the
 *                 passwords, which is the only place they are written.
 *   drop <name>   removes a database this command made, connected to or not. A run uses it for its OWN
 *                 database, once it has stopped its processes. It is not how abandoned databases are cleaned
 *                 up: that is db:orphans, which lists first and drops only what a person names.
 *   list          names every disposable test database that exists, so a run can show it left none.
 *                 Prints { databases: [names] }.
 *
 * There is no sweep. A database with no connection may belong to a run that is between two steps, so nothing
 * here removes a database because it looked idle; each run removes only the one it made.
 *
 * It refuses, before anything is sent, a server that is not on this machine and a deployed environment, as
 * every database command does. It is stricter than they are about names: it only ever drops a database whose
 * name is exactly the shape it creates, so the development database is out of its reach.
 *
 * usage: node dist/tools/e2e-database.js create | drop <database> | list
 */
const USAGE = 'usage: node dist/tools/e2e-database.js create | drop <database> | list';

/** The only names this command creates and the only names it will drop. */
const HARNESS_DATABASE = /^melarc_test_[0-9a-f]{8}$/;

await runCli(async () => {
  const [command, name, ...rest] = process.argv.slice(2);
  if (
    rest.length > 0 ||
    !(
      (command === 'create' && name === undefined) ||
      (command === 'drop' && name !== undefined) ||
      (command === 'list' && name === undefined)
    )
  ) {
    throw new CliUsageError(USAGE);
  }

  const settings = readLocalPostgres();
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

    const urlFor = (user: string, password: string) =>
      buildDatabaseUrl({ host: settings.host, port: settings.port, user, password, database });
    const migrationUrl = urlFor(MIGRATION_ROLE, settings.migrationPassword);
    try {
      await runMigrations({ url: migrationUrl });
    } catch (error) {
      // A database that cannot be migrated is of no use to anyone; do not leave it behind.
      await dropDisposableDatabase(admin, database);
      throw error;
    }
    process.stdout.write(
      `${JSON.stringify({
        database,
        migrationUrl,
        runtimeUrl: urlFor(API_RUNTIME_ROLE, settings.runtimePassword),
      })}\n`,
    );
  } finally {
    await admin.close();
  }
});
