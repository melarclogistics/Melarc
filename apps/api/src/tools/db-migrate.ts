import { postgresUrlProblem } from '../platform/database/postgres-url.js';
import { CliUsageError, runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import { buildDatabaseUrl } from './database/provisioning.js';
import { runMigrations } from './database/run-migrations.js';
import { MIGRATION_ROLE } from './database/safety.js';

/**
 * Applies the migrations in apps/api/migrations as the migration identity.
 *
 * With DATABASE_MIGRATION_URL set it migrates that database, which is how a deployment runs it. Without
 * it, it migrates the local development database with the local migration credentials. The API itself
 * never reads DATABASE_MIGRATION_URL and refuses to start if it is present.
 *
 * usage: node dist/tools/db-migrate.js
 */
await runCli(async () => {
  const given = process.env.DATABASE_MIGRATION_URL;
  let url: string;
  if (given === undefined || given === '') {
    const local = readLocalPostgres();
    url = buildDatabaseUrl({
      host: local.host,
      port: local.port,
      user: MIGRATION_ROLE,
      password: local.migrationPassword,
      database: 'melarc_dev',
    });
  } else {
    // Fixed text from the parser: it names the setting and what is wrong, never what the value held.
    const problem = postgresUrlProblem(given);
    if (problem !== undefined) throw new CliUsageError(`DATABASE_MIGRATION_URL ${problem}`);
    url = given;
  }

  const { applied } = await runMigrations({ url });
  process.stdout.write(
    applied === 0
      ? 'database is up to date, nothing applied\n'
      : `applied ${String(applied)} migration${applied === 1 ? '' : 's'}\n`,
  );
});
