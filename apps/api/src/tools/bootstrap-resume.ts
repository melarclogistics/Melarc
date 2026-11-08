import { CliUsageError, runCli } from './database/cli.js';
import { RESUME_USAGE, runBootstrapResume } from './bootstrap/bootstrap-command.js';
import { bootstrapDependencies } from './bootstrap/bootstrap-runtime.js';
import { BootstrapInputError } from './bootstrap/bootstrap-vocabulary.js';

/**
 * Gives one stranded bootstrap administrator a fresh secret in a custody bundle (S0.30; MIGRATION_AND_SEEDING.md section 3.3a), as the
 * provisioning login: a fresh `MFA_REENROLMENT` where a password is set and no `ACTIVE` factor exists, a new `BOOTSTRAP_SETUP` for a
 * bundle lost before a password was set. The database judges the six conditions under the identity's lock and names the one that
 * refuses. **It is a process an operator starts: no API operation or screen can invoke it.**
 *
 * usage: node dist/tools/bootstrap-resume.js --custodian <work@email>
 */
await runCli(async () => {
  try {
    await runBootstrapResume(
      process.argv.slice(2),
      process.env,
      (line) => {
        process.stdout.write(`${line}\n`);
      },
      bootstrapDependencies(),
    );
  } catch (error) {
    if (error instanceof BootstrapInputError)
      throw new CliUsageError(`${error.message}. ${RESUME_USAGE}`);
    throw error;
  }
});
