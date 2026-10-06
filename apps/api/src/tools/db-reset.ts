import { databaseArgument, runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  dropDisposableDatabase,
  provisionRoles,
} from './database/provisioning.js';
import { runMigrations } from './database/run-migrations.js';
import { assertDisposableName, MIGRATION_ROLE } from './database/safety.js';

/**
 * Drops the local development database, creates it again and migrates it. Destructive, so it refuses
 * before sending anything unless the target is a server on this machine, no deployed environment is in
 * scope, the name is a development or test one, and the database carries the marker this tooling puts on
 * what it creates (see safety.ts and provisioning.ts).
 *
 * usage: node dist/tools/db-reset.js [database]    (default: melarc_dev)
 */
await runCli(async () => {
  const database = databaseArgument(process.argv);
  assertDisposableName(database);
  const settings = readLocalPostgres();
  const admin = await connectLocalAdmin(settings);
  try {
    await dropDisposableDatabase(admin, database);
    await provisionRoles(admin, settings);
    await createDisposableDatabase(admin, database);
  } finally {
    await admin.close();
  }

  const { applied } = await runMigrations({
    url: buildDatabaseUrl({
      host: settings.host,
      port: settings.port,
      user: MIGRATION_ROLE,
      password: settings.migrationPassword,
      database,
    }),
  });
  process.stdout.write(`database ${database} reset; applied ${String(applied)} migration(s)\n`);
});
