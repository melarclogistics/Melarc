import { execFile } from 'node:child_process';

import pg from 'pg';

import { repositoryPaths } from './paths.ts';

/** A database made for one run, and the credentials it is reached with. The URLs carry passwords. */
export interface HarnessDatabase {
  readonly name: string;
  readonly migrationUrl: string;
  readonly runtimeUrl: string;
  /** The delivery worker's login on this database: it reads the queue and writes the capture sink's messages, and nothing else. */
  readonly workerUrl: string;
}

/** The only shape of name the database command makes and the only one the harness will drop. */
const HARNESS_NAME = /^melarc_test_[0-9a-f]{8}$/;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//;

/**
 * Reads what `e2e-database create` printed: exactly one line of JSON with a name of the right shape and the three
 * URLs. Anything else (a warning in front, two lines, a different name) is refused rather than guessed at.
 */
export function parseCreated(stdout: string): HarnessDatabase {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1)
    throw new Error(`Expected one line from the database command, got ${String(lines.length)}.`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  } catch {
    throw new Error('The database command did not print JSON.');
  }
  const { database, migrationUrl, runtimeUrl, workerUrl } = parsed;
  if (typeof database !== 'string' || !HARNESS_NAME.test(database)) {
    throw new Error('The database command printed a database name of an unexpected shape.');
  }
  for (const url of [migrationUrl, runtimeUrl, workerUrl]) {
    if (typeof url !== 'string' || !POSTGRES_URL.test(url)) {
      throw new Error(
        'The database command printed a connection string that is not a PostgreSQL URL.',
      );
    }
    refuseConnectionOptions(url);
  }
  return {
    name: database,
    migrationUrl: migrationUrl as string,
    runtimeUrl: runtimeUrl as string,
    workerUrl: workerUrl as string,
  };
}

/**
 * A connection string with a query string or a fragment is refused, whatever it holds: the driver acts on a
 * query string (`user`, `host`, `port`, TLS, the session role), so it could connect as someone other than the
 * user the URL names. The message is fixed text and repeats nothing from the URL.
 */
function refuseConnectionOptions(url: string): void {
  if (url.includes('?') || url.includes('#')) {
    throw new Error(
      'A connection string with a query string or fragment is not accepted: connection options are not supported.',
    );
  }
}

/**
 * The settings to connect with, read from the parts of a URL the database command printed. The URL is never
 * handed to the driver as a string, because the driver would read a query string too (see
 * refuseConnectionOptions). The harness reads the URL here on purpose and does not import the API's reader:
 * it depends on nothing inside the API.
 */
export function clientSettings(url: string): pg.ClientConfig {
  refuseConnectionOptions(url);
  const parsed = new URL(url);
  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

/** A connection string safe to write down: the password is hidden, and what cannot be read is not echoed. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '(unreadable URL)';
  }
  if (parsed.password === '') return url;
  parsed.password = '***';
  return parsed.toString();
}

/**
 * What the database command needs from this machine: its PostgreSQL settings, and what Windows needs to run.
 * SystemRoot is read by name, as ManagedProcess does, and not found by comparing the names in the environment:
 * Windows names are not case-sensitive, and a process started from a shell that writes them in capitals
 * (`SYSTEMROOT`) must pass it on all the same.
 */
function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('MELARC_PG_')) env[key] = value;
  }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot !== undefined) env.SystemRoot = systemRoot;
  return env;
}

/** The longest the database command may take, and the longest the bootstrap may: it writes a custody bundle, which costs a Windows run seconds. */
const COMMAND_TIMEOUT_MS = 60_000;
const BOOTSTRAP_TIMEOUT_MS = 330_000;

function runDatabaseTool(
  args: readonly string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [repositoryPaths().databaseTool, ...args],
      { env: commandEnvironment(), timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else
          reject(
            new Error(
              `The database command (${args.join(' ')}) failed: ${stderr.trim() || error.message}`,
            ),
          );
      },
    );
  });
}

/**
 * A migrated database of its own, owned by the owner role, with the roles an API needs and the reference data the real seed writes: an
 * API over a database the seed has not filled is not ready, so the run's stack could never start over one.
 */
export async function createDatabase(): Promise<HarnessDatabase> {
  return parseCreated(await runDatabaseTool(['create', '--seed']));
}

export async function dropDatabase(name: string): Promise<void> {
  if (!HARNESS_NAME.test(name)) throw new Error(`Refusing to drop "${name}".`);
  await runDatabaseTool(['drop', name]);
}

/** Every disposable test database that exists, so a run can show that it left none behind. */
export async function listDatabases(): Promise<string[]> {
  const output = JSON.parse(await runDatabaseTool(['list'])) as { databases: string[] };
  return output.databases;
}

/** Runs `work` on a connection that is always closed, and whose errors do not escape as unhandled events. */
export async function withClient<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ ...clientSettings(url), connectionTimeoutMillis: 5_000 });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function harnessName(name: string, what: string): string {
  if (!HARNESS_NAME.test(name)) throw new Error(`Refusing to ${what} "${name}".`);
  return name;
}

/** One line of JSON, as the database command prints it; anything else is refused rather than guessed at. */
function oneLineOfJson(stdout: string, what: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) {
    throw new Error(
      `Expected one line from the database command (${what}), got ${String(lines.length)}.`,
    );
  }
  try {
    return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  } catch {
    throw new Error(`The database command (${what}) did not print JSON.`);
  }
}

/**
 * Makes the two bootstrap administrators of the run's database with the real `bootstrap:seed`, as an operator runs it (S0.30): the
 * database command starts that process as the provisioning login, and it writes one custody bundle for each custodian into `folder`,
 * which the caller made, outside the checkout and private. A custodian is `Full Name <work@email>`. The bundles hold the setup secrets
 * in clear: `harness/custody.ts` reads them and removes them.
 */
export async function bootstrapAdministrators(
  database: string,
  folder: string,
  custodians: readonly [string, string],
): Promise<void> {
  const printed = oneLineOfJson(
    await runDatabaseTool(
      ['bootstrap', harnessName(database, 'bootstrap'), folder, ...custodians],
      BOOTSTRAP_TIMEOUT_MS,
    ),
    'bootstrap',
  );
  if (printed.bootstrapped !== database) {
    throw new Error('The database command did not say it bootstrapped this database.');
  }
}

/**
 * Writes the demonstration vendor of MIGRATION_AND_SEEDING.md section 4b with the real `db:seed --vendor-fixture`, as an operator runs it
 * (S0.47): an approved organisation at the first seeded hub and one account with a recovery email, and no secret, browser or grant. The
 * journeys of rows 10a and 11 ask the API for its setup link, as an officer would (S0.52).
 */
export async function addVendorFixture(database: string): Promise<void> {
  const printed = oneLineOfJson(
    await runDatabaseTool(['vendor-fixture', harnessName(database, 'vendor-fixture')]),
    'vendor-fixture',
  );
  if (printed.vendorFixture !== database) {
    throw new Error(
      'The database command did not say it wrote the vendor fixture to this database.',
    );
  }
}

/**
 * Writes the demonstration rider of MIGRATION_AND_SEEDING.md section 4a with the real `db:seed --rider-fixture`, as an operator runs it
 * (S0.53): one `ACTIVE` rider at the first seeded hub with no PIN and no device. The journeys of rows 7, 8, 9, 11 and 13 register its
 * handset from the Ops screens (S0.62).
 */
export async function addRiderFixture(database: string): Promise<void> {
  const printed = oneLineOfJson(
    await runDatabaseTool(['rider-fixture', harnessName(database, 'rider-fixture')]),
    'rider-fixture',
  );
  if (printed.riderFixture !== database) {
    throw new Error(
      'The database command did not say it wrote the rider fixture to this database.',
    );
  }
}

/** Runs the real `bootstrap:resume` for one stranded administrator (AC-SLICE-000-93): a fresh bundle in `folder`. */
export async function resumeAdministrator(
  database: string,
  folder: string,
  workEmail: string,
): Promise<void> {
  const printed = oneLineOfJson(
    await runDatabaseTool(
      ['resume', harnessName(database, 'resume'), folder, workEmail],
      BOOTSTRAP_TIMEOUT_MS,
    ),
    'resume',
  );
  if (printed.resumed !== database) {
    throw new Error('The database command did not say it resumed on this database.');
  }
}

/**
 * Lets time pass for something by changing the data (plan section 3, "Time": there is no production time-travel switch): a closed list
 * of arrangements that `e2e-database` holds (`apps/api/src/tools/e2e/arrangements.ts`). Fails when the arrangement changed no row.
 */
export type Arrangement =
  | readonly ['expire-setup-grant', workEmail: string, purpose: string]
  | readonly ['expire-mfa-challenge', workEmail: string]
  | readonly ['idle-session', workEmail: string, minutes: string]
  | readonly ['age-trusted-browsers', workEmail: string, days: string]
  | readonly ['lapse-lock', workEmail: string]
  | readonly ['lapse-rider-challenge-window']
  | readonly ['expire-vendor-setup-grant', accountIdentifier: string];

export async function arrange(database: string, ...arrangement: Arrangement): Promise<number> {
  const [name, ...args] = arrangement;
  const printed = oneLineOfJson(
    await runDatabaseTool(['arrange', harnessName(database, 'arrange'), name, ...args]),
    `arrange ${name}`,
  );
  if (printed.arranged !== name || typeof printed.rows !== 'number') {
    throw new Error(`The database command did not say it arranged ${name}.`);
  }
  return printed.rows;
}

/** What no operation shows, read from the run's database: a closed list in the same module (`factors`, `sessions`, `lock`, ...). */
export type Observation =
  | 'factors'
  | 'sessions'
  | 'setup-grants'
  | 'lock'
  | 'trusted-browsers'
  | 'audit-codes'
  // Named by the vendor account's identifier, and by the rider's phone (S0.62).
  | 'vendor-sessions'
  | 'vendor-lock'
  | 'rider-sessions'
  | 'rider-lock';

export async function observe<Row extends Record<string, unknown>>(
  database: string,
  observation: Observation,
  /** The staff member's work email, the vendor account's identifier, or the rider's phone, as the observation names its identity. */
  key: string,
): Promise<Row[]> {
  const printed = oneLineOfJson(
    await runDatabaseTool(['observe', harnessName(database, 'observe'), observation, key]),
    `observe ${observation}`,
  );
  if (printed.observed !== observation || !Array.isArray(printed.rows)) {
    throw new Error(`The database command did not answer the observation ${observation}.`);
  }
  return printed.rows as Row[];
}
