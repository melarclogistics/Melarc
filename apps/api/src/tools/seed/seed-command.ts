import { APP_ENVS } from '../../platform/config/config-settings.js';
import { parsePostgresUrl, postgresUrlProblem } from '../../platform/database/postgres-url.js';
import {
  runSeed,
  type SeedPlan,
  type SeedReport,
} from '../../platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../platform/database/technical-roles.js';
import { CliUsageError } from '../database/cli.js';
import { readLocalPostgres } from '../database/local-env.js';
import { localLoginPassword } from '../database/local-logins.js';
import { buildDatabaseUrl } from '../database/provisioning.js';
import { assertLocalHost } from '../database/safety.js';
import { assertFixturesAllowed, fixturePlan } from '../fixtures/fixtures.js';
import { referenceSeedPlan } from './reference-seed.js';
import { openSeedTarget, type SeedTarget } from './seed-runtime.js';

/**
 * The `db:seed` command (S0.9; MIGRATION_AND_SEEDING.md sections 4 and 5.1). It runs the seed helper as the provisioning login, the
 * one identity that holds the grants of the `seed` capability, and nothing else.
 *
 * - `db:seed` writes the reference data (`reference-seed.ts`) into an empty database. It refuses a database that has any of it.
 * - `db:seed --fixtures` writes the test-only fixtures (`tools/fixtures`) and refuses in production, before it connects.
 *
 * **Which database.** `DATABASE_SEED_URL` names it, as `DATABASE_MIGRATION_URL` names the migration target: a deployment gives the
 * provisioning login's connection there, and the user must be the provisioning login. Both variables are forbidden in the API's
 * environment (`load-config.ts`). Without it the command seeds the local development database with the local provisioning
 * credentials (`localLoginPassword`), which exist for a cluster on this machine only. **Which environment.** `APP_ENV` says
 * whether this is local, staging or production; it is required with a URL that was given (a deployed database is never assumed to
 * be local), and the local default is refused when `APP_ENV` names a deployed environment. The command never writes the URL, a
 * password or a row.
 */

export interface SeedCommandDependencies {
  /** The local provisioning login's URL. Called only when no `DATABASE_SEED_URL` was given. */
  readonly localUrl: () => string;
  readonly open: (url: string) => SeedTarget;
  readonly runSeed: (database: SeedTarget['database'], plan: SeedPlan) => Promise<SeedReport>;
}

/**
 * The provisioning login on the development database of this machine, from the local settings (the password is derived from the
 * administrator's, `localLoginPassword`). It refuses a server that is not on this machine: the default is local or it is not used.
 */
export function localProvisioningUrl(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envFile?: string;
  } = {},
): string {
  const local = readLocalPostgres(options);
  assertLocalHost(local.host);
  return buildDatabaseUrl({
    host: local.host,
    port: local.port,
    user: PROVISIONING_ROLE,
    password: localLoginPassword(local.adminPassword, PROVISIONING_ROLE),
    database: 'melarc_dev',
  });
}

const DEFAULTS: SeedCommandDependencies = {
  localUrl: () => localProvisioningUrl(),
  open: openSeedTarget,
  runSeed,
};

const USAGE = 'usage: db:seed [--fixtures]';

function parseArguments(argv: readonly string[]): { fixtures: boolean } {
  if (argv.length === 0) return { fixtures: false };
  if (argv.length === 1 && argv[0] === '--fixtures') return { fixtures: true };
  throw new CliUsageError(`unexpected arguments. ${USAGE}`);
}

/** The environment and the URL of a run, judged together; nothing is opened here. */
function resolveTarget(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: SeedCommandDependencies,
): { appEnv: (typeof APP_ENVS)[number]; url: string } {
  const given = env.DATABASE_SEED_URL ?? '';
  const named = env.APP_ENV ?? '';

  if (given === '') {
    // The local default is a database on this machine, so the environment can only be local.
    if (named !== '' && named !== 'local') {
      throw new CliUsageError(
        'APP_ENV names a deployed environment, and the local development database is not one: set DATABASE_SEED_URL for that environment, or unset APP_ENV',
      );
    }
    return { appEnv: 'local', url: dependencies.localUrl() };
  }

  // A deployed database is never assumed to be local: the environment is named, and it is one of the known three.
  const appEnv = (APP_ENVS as readonly string[]).includes(named)
    ? (named as (typeof APP_ENVS)[number])
    : undefined;
  if (appEnv === undefined) {
    throw new CliUsageError(
      `APP_ENV must be set with DATABASE_SEED_URL, to one of: ${APP_ENVS.join(', ')}`,
    );
  }
  // Fixed text from the parser: it names the setting and what is wrong, never what the value held.
  const problem = postgresUrlProblem(given);
  if (problem !== undefined) throw new CliUsageError(`DATABASE_SEED_URL ${problem}`);
  if (parsePostgresUrl(given)?.user !== PROVISIONING_ROLE) {
    throw new CliUsageError(
      'DATABASE_SEED_URL must name the provisioning login: the seed runs as it, and no other identity holds its grants',
    );
  }
  return { appEnv, url: given };
}

/**
 * Runs the command. `write` receives one line per table seeded. Rejects, with nothing kept, on a usage mistake, a refusal of the
 * environment, a database that is not empty, or a database failure; the connection is closed on every path that opened one.
 */
export async function runSeedCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
  dependencies: SeedCommandDependencies = DEFAULTS,
): Promise<void> {
  const { fixtures } = parseArguments(argv);
  const { appEnv, url } = resolveTarget(env, dependencies);
  // Before anything is opened: production has no way to reach the fixtures.
  if (fixtures) assertFixturesAllowed(appEnv);

  const target = dependencies.open(url);
  try {
    const report = await dependencies.runSeed(
      target.database,
      fixtures ? fixturePlan() : referenceSeedPlan(),
    );
    for (const [table, rows] of Object.entries(report)) {
      write(`seeded ${table}: ${String(rows)} ${rows === 1 ? 'row' : 'rows'}`);
    }
  } finally {
    // What the run found is what is reported: a pool that would not close must not hide it (and rows already committed stay).
    await target.close().catch(() => undefined);
  }
}
