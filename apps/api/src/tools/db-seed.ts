import { runCli } from './database/cli.js';
import { runSeedCommand } from './seed/seed-command.js';

/**
 * Seeds the reference data (S0.9) into an empty database as the provisioning login, or, with --fixtures, the test-only fixtures
 * (never in production). It refuses a database that already holds what it would add. The environment variables and the rules are
 * in `seed/seed-command.ts`.
 *
 * usage: node dist/tools/db-seed.js [--fixtures]
 */
await runCli(() =>
  runSeedCommand(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(`${line}\n`);
  }),
);
