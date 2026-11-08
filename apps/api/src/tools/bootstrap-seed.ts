import { CliUsageError, runCli } from './database/cli.js';
import { runBootstrapSeed, SEED_USAGE } from './bootstrap/bootstrap-command.js';
import { bootstrapDependencies } from './bootstrap/bootstrap-runtime.js';
import { BootstrapInputError } from './bootstrap/bootstrap-vocabulary.js';

/**
 * Makes the two bootstrap administrators of an empty environment and the custody bundle of each (S0.30;
 * MIGRATION_AND_SEEDING.md section 3.2), as the provisioning login. It refuses a database whose staff table holds an identity. The
 * environment variables and the rules are in `bootstrap/bootstrap-command.ts`; **it is a process an operator starts: no API operation
 * or screen can invoke it**.
 *
 * usage: node dist/tools/bootstrap-seed.js --custodian "Full Name <work@email>" --custodian "Full Name <work@email>"
 */
await runCli(async () => {
  try {
    await runBootstrapSeed(
      process.argv.slice(2),
      process.env,
      (line) => {
        process.stdout.write(`${line}\n`);
      },
      bootstrapDependencies(),
    );
  } catch (error) {
    // A mistake in the arguments says how to use the command; every other failure speaks for itself.
    if (error instanceof BootstrapInputError)
      throw new CliUsageError(`${error.message}. ${SEED_USAGE}`);
    throw error;
  }
});
