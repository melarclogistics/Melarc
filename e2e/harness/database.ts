import { execFile } from 'node:child_process';

import pg from 'pg';

import { repositoryPaths } from './paths.ts';

/** A database made for one run, and the two credentials it is reached with. The URLs carry passwords. */
export interface HarnessDatabase {
  readonly name: string;
  readonly migrationUrl: string;
  readonly runtimeUrl: string;
}

export interface NoteRow {
  readonly id: string;
  readonly note: string;
  readonly at: string;
  readonly written_by: string;
}

/** The only shape of name the database command makes and the only one the harness will drop. */
const HARNESS_NAME = /^melarc_test_[0-9a-f]{8}$/;
const POSTGRES_URL = /^postgres(?:ql)?:\/\//;

/**
 * Reads what `e2e-database create` printed: exactly one line of JSON with a name of the right shape and the two
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
  const { database, migrationUrl, runtimeUrl } = parsed;
  if (typeof database !== 'string' || !HARNESS_NAME.test(database)) {
    throw new Error('The database command printed a database name of an unexpected shape.');
  }
  for (const url of [migrationUrl, runtimeUrl]) {
    if (typeof url !== 'string' || !POSTGRES_URL.test(url)) {
      throw new Error(
        'The database command printed a connection string that is not a PostgreSQL URL.',
      );
    }
    refuseConnectionOptions(url);
  }
  return { name: database, migrationUrl: migrationUrl as string, runtimeUrl: runtimeUrl as string };
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

/** What the database command needs from this machine: its PostgreSQL settings, and what Windows needs to run. */
function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('MELARC_PG_') || key === 'SystemRoot') env[key] = value;
  }
  return env;
}

function runDatabaseTool(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [repositoryPaths().databaseTool, ...args],
      { env: commandEnvironment(), timeout: 60_000, windowsHide: true },
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

/** A migrated database of its own, owned by the owner role, with the roles an API needs. */
export async function createDatabase(): Promise<HarnessDatabase> {
  return parseCreated(await runDatabaseTool(['create']));
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

/**
 * The harness's own table, for the technical journey: made by the owner, in a schema of its own, and writable
 * by the runtime role, so that the API's write shows up as `written_by = melarc_api_runtime`. It is not a
 * migration and no product code knows it: the canonical migration history stays exactly what the API ships.
 */
export const HARNESS_SCHEMA_SQL = `
SET ROLE melarc_owner;
CREATE SCHEMA e2e_harness;
CREATE TABLE e2e_harness.notes (
  id uuid PRIMARY KEY,
  note text NOT NULL,
  noted_at timestamptz NOT NULL,
  written_by text NOT NULL DEFAULT current_user
);
GRANT USAGE ON SCHEMA e2e_harness TO melarc_api_runtime;
GRANT SELECT, INSERT ON e2e_harness.notes TO melarc_api_runtime;
RESET ROLE;
`;

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

export async function provisionHarnessSchema(database: HarnessDatabase): Promise<void> {
  await withClient(database.migrationUrl, (client) => client.query(HARNESS_SCHEMA_SQL));
}

/** The rows of the harness table, read as the migration identity (the runtime role is for the API alone). */
export async function readNotes(database: HarnessDatabase): Promise<NoteRow[]> {
  return withClient(database.migrationUrl, async (client) => {
    const result = await client.query<{
      id: string;
      note: string;
      noted_at: Date;
      written_by: string;
    }>('select id, note, noted_at, written_by from e2e_harness.notes order by noted_at, id');
    return result.rows.map((row) => ({
      id: row.id,
      note: row.note,
      at: row.noted_at.toISOString(),
      written_by: row.written_by,
    }));
  });
}
