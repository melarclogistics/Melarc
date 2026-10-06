/** A destructive or privileged database command refused to run against this target. */
export class UnsafeTargetError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsafeTargetError';
  }
}

/** The role migrations run as (SECURITY_DESIGN.md §14.17a). */
export const MIGRATION_ROLE = 'melarc_migration_elevated';

/**
 * Databases a development or test run may create and drop: `melarc_dev`, or `melarc_test` with an
 * optional lower-case suffix of 4 to 32 characters. Anything else, a production-looking name included,
 * is refused before a statement is sent.
 */
const DISPOSABLE_DATABASE_NAME = /^melarc_(dev|test)(_[a-z0-9]{4,32})?$/;

/**
 * True only for this machine: `localhost`, a 127.x.y.z address or ::1, matched as a whole. A look-alike
 * such as `localhost.evil.example` is not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return octets?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}

/** A reset or teardown never leaves this machine. */
export function assertLocalHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new UnsafeTargetError(
      'refusing to act on a database server that is not on this machine: reset and teardown commands are local only',
    );
  }
}

export function assertDisposableName(database: string): void {
  if (!DISPOSABLE_DATABASE_NAME.test(database)) {
    throw new UnsafeTargetError(
      `refusing to act on database "${database}": only melarc_dev and melarc_test databases are disposable`,
    );
  }
}

/**
 * The databases a test run makes: `melarc_test_` and a lower-case suffix of 4 to 32 characters. The command
 * that lists and removes abandoned ones accepts these and nothing else. `melarc_dev` is disposable too
 * (db:reset drops it) but is never what a test run leaves behind, so it is not a name this command may take.
 */
const TEST_DATABASE_NAME = /^melarc_test_[a-z0-9]{4,32}$/;

export function assertTestDatabaseName(database: string): void {
  if (!TEST_DATABASE_NAME.test(database)) {
    throw new UnsafeTargetError(
      `refusing to act on database "${database}": only databases named melarc_test_ and a suffix of 4 to 32 lower-case letters or digits are test databases`,
    );
  }
}

/** Migrations create objects, so who runs them decides who owns them: only the migration identity does. */
export function assertMigrationIdentity(user: string): void {
  if (user !== MIGRATION_ROLE) {
    throw new UnsafeTargetError(`migrations run only as ${MIGRATION_ROLE}`);
  }
}

/**
 * A local destructive command runs only where the environment is local, or says nothing. It allows what it knows
 * to be local and refuses everything else: a list of the deployed names would let `Production`, `prod` or a
 * name with a space in it through, which is the kind of mistake this exists for.
 */
export function assertNotDeployedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const appEnv = env.APP_ENV;
  if (appEnv !== undefined && appEnv !== '' && appEnv !== 'local') {
    throw new UnsafeTargetError(
      // Echoed so that the operator sees which value it was, with anything that is not a word character made visible.
      `refusing to run a local database command with APP_ENV=${appEnv.slice(0, 40).replaceAll(/[^\w.-]/g, '?')}: only an unset APP_ENV or local is accepted`,
    );
  }
}
