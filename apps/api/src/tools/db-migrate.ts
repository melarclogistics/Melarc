import { postgresUrlProblem } from '../platform/database/postgres-url.js';
import { CliUsageError, runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import { buildDatabaseUrl } from './database/provisioning.js';
import { applicationLockTimeoutOf, describeRun, runMigrations } from './database/run-migrations.js';
import { MIGRATION_ROLE } from './database/safety.js';

/**
 * Applies the migrations in apps/api/migrations as the migration identity.
 *
 * With DATABASE_MIGRATION_URL set it migrates that database, which is how a deployment runs it. Without
 * it, it migrates the local development database with the local migration credentials. The API itself
 * never reads DATABASE_MIGRATION_URL and refuses to start if it is present.
 *
 * It also reads DATABASE_LOCK_TIMEOUT_MS from its environment, the application's own setting under its own name (2000 when it is not set): the run keeps each
 * attempt to take the policy keys shorter than that, because the application's sign-ins and mutations that queue behind it fail with a retryable 503 once it has passed.
 *
 * usage: node dist/tools/db-migrate.js
 */
await runCli(async () => {
  let applicationLockTimeoutMs: number;
  try {
    applicationLockTimeoutMs = applicationLockTimeoutOf(process.env);
  } catch (error) {
    // Fixed text: it names the setting and what is wrong, never what the value held.
    throw new CliUsageError(
      error instanceof Error ? error.message : 'DATABASE_LOCK_TIMEOUT_MS is unusable',
    );
  }

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

  process.stdout.write(`${describeRun(await runMigrations({ url, applicationLockTimeoutMs }))}\n`);
});
