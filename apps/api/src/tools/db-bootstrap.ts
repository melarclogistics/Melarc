import { databaseArgument, runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import {
  connectLocalAdmin,
  createDisposableDatabase,
  provisionRoles,
} from './database/provisioning.js';
import { assertDisposableName } from './database/safety.js';

/**
 * Prepares the local PostgreSQL server: the three roles with their own passwords, and a development
 * database owned by the owner role. Safe to repeat. It acts only on this machine (see safety.ts).
 *
 * usage: node dist/tools/db-bootstrap.js [database]    (default: melarc_dev)
 */
await runCli(async () => {
  const database = databaseArgument(process.argv);
  assertDisposableName(database);
  const settings = readLocalPostgres();
  const admin = await connectLocalAdmin(settings);
  try {
    await provisionRoles(admin, settings);
    await createDisposableDatabase(admin, database);
  } finally {
    await admin.close();
  }
  process.stdout.write(`roles provisioned and database ${database} ready\n`);
});
