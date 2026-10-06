import { CliUsageError } from './cli.js';
import {
  dropDisposableDatabase,
  listTestDatabases,
  type LocalAdmin,
  type TestDatabaseListing,
} from './provisioning.js';
import { assertLocalHost, assertTestDatabaseName, UnsafeTargetError } from './safety.js';

export const ORPHANS_USAGE =
  'usage: node dist/tools/db-orphans.js [--drop <database> [<database> ...] [--disconnect]]';

export interface OrphanArguments {
  /** The databases to remove, each named by a person; empty means only list. */
  readonly drop: readonly string[];
  /** End the sessions connected to the databases named, instead of refusing them. */
  readonly disconnect: boolean;
}

/**
 * Reads the command line. With no argument it lists. A database is removed only when it is named after
 * `--drop`; there is no "all", no "idle" and no pattern, so what is deleted is always what a person typed.
 */
export function parseOrphanArguments(argv: readonly string[]): OrphanArguments {
  if (argv.length === 0) return { drop: [], disconnect: false };
  if (argv[0] !== '--drop') throw new CliUsageError(ORPHANS_USAGE);

  const names: string[] = [];
  let disconnect = false;
  for (const argument of argv.slice(1)) {
    if (argument === '--disconnect') disconnect = true;
    else if (argument.startsWith('-') || argument === '') throw new CliUsageError(ORPHANS_USAGE);
    else if (!names.includes(argument)) names.push(argument);
  }
  if (names.length === 0) throw new CliUsageError(ORPHANS_USAGE);
  return { drop: names, disconnect };
}

const sessionsText = (sessions: number): string =>
  sessions === 0
    ? 'no session connected'
    : `${String(sessions)} session${sessions === 1 ? '' : 's'} connected`;

/** The listing a person reads before choosing what to remove. It states facts and decides nothing. */
export function formatListing(databases: readonly TestDatabaseListing[]): string {
  if (databases.length === 0)
    return 'No test databases exist on this machine’s PostgreSQL server.\n';
  const width = Math.max(...databases.map((database) => database.name.length));
  return [
    'Test databases on this machine’s PostgreSQL server. Nothing was changed.',
    ...databases.map(
      (database) => `  ${database.name.padEnd(width)}  ${sessionsText(database.sessions)}`,
    ),
    '',
    'A database with no session may still belong to a run that is between steps, and one with sessions may be',
    'abandoned by a run whose process is still hanging on. Remove only the ones you know are not in use:',
    '  --drop <database> [<database> ...]   a database with sessions is refused unless you add --disconnect',
    '',
  ].join('\n');
}

export interface RemovalResult {
  readonly dropped: readonly string[];
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Removes the databases a person named, each revalidated here: a local server, a test database name, and a
 * database the server lists as carrying the disposable marker (the drop checks the marker again itself).
 * Every name is checked before any database is touched. Unless `disconnect` is set, a database with a session
 * connected is refused by the server and left alone; no session is ended on anyone's behalf.
 */
export async function removeNamed(
  admin: LocalAdmin,
  names: readonly string[],
  options: { readonly disconnect: boolean },
): Promise<RemovalResult> {
  assertLocalHost(admin.host);
  for (const name of names) assertTestDatabaseName(name);

  const listed = new Set((await listTestDatabases(admin)).map((database) => database.name));
  for (const name of names) {
    if (!listed.has(name)) {
      throw new UnsafeTargetError(
        `refusing to drop "${name}": the server does not list it as a test database carrying the disposable marker`,
      );
    }
  }

  const dropped: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const name of names) {
    try {
      await dropDisposableDatabase(admin, name, { disconnect: options.disconnect });
      dropped.push(name);
    } catch (error) {
      if (!(error instanceof UnsafeTargetError)) throw error;
      refused.push({ name, reason: error.message });
    }
  }
  return { dropped, refused };
}
