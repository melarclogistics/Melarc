import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What drizzle's migrator leaves unchecked, and what a deployment must not leave unchecked.
 *
 * `migrate()` applies the migrations of the folder whose `when` is later than the latest one in the journal table,
 * and nothing else. So a migration written with an earlier `when` than one already applied (two branches merged,
 * a clock that ran slow) is skipped without a word, and an applied migration whose file was edited afterwards
 * is never noticed: the database holds one history and the repository another. Both are found out in production,
 * as a table that is not there or a constraint that is not the one that was reviewed.
 *
 * This reads the folder the way the migrator does (`meta/_journal.json` and a `<tag>.sql` for each entry) and
 * compares it with the journal table, and says what does not agree. It reads no SQL beyond hashing it, and no
 * message below carries any of it.
 */

export interface FolderMigration {
  readonly tag: string;
  /** The journal's `when`: the number the journal table stores as `created_at`. */
  readonly when: number;
  /** The hashes the journal table may hold for this file: its text as it is, and with either line ending. */
  readonly hashes: readonly string[];
}

export interface AppliedMigration {
  readonly hash: string;
  /** `created_at`; `pg` returns a bigint as text. */
  readonly createdAt: string | number;
}

export interface MigrationFolder {
  readonly migrations: readonly FolderMigration[];
  readonly problems: readonly string[];
}

export class MigrationHistoryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The migration history does not agree:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
    this.name = 'MigrationHistoryError';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * drizzle stores the hash of the file as it was read. A working copy that was checked out with another line
 * ending is the same migration, so all three spellings of the text are accepted.
 */
function acceptedHashes(text: string): string[] {
  const lf = text.replaceAll('\r\n', '\n');
  return [...new Set([sha256(text), sha256(lf), sha256(lf.replaceAll('\n', '\r\n'))])];
}

interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

function readJournal(folder: string): { entries: JournalEntry[]; problems: string[] } {
  const path = join(folder, 'meta', '_journal.json');
  if (!existsSync(path)) return { entries: [], problems: ['meta/_journal.json is missing'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { entries: [], problems: ['meta/_journal.json is not valid JSON'] };
  }
  const list = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list))
    return { entries: [], problems: ['meta/_journal.json has no entries list'] };

  const entries: JournalEntry[] = [];
  const problems: string[] = [];
  for (const [index, entry] of list.entries()) {
    const { tag, when } = (entry ?? {}) as { tag?: unknown; when?: unknown };
    if (typeof tag !== 'string' || !/^[\w-]+$/.test(tag) || typeof when !== 'number') {
      problems.push(`journal entry ${String(index)} has no usable tag and when`);
    } else entries.push({ tag, when });
  }
  return { entries, problems };
}

/** Reads the folder and reports what is wrong with it alone, before any database is looked at. */
export function readMigrationFolder(folder: string): MigrationFolder {
  const { entries, problems } = readJournal(folder);
  const migrations: FolderMigration[] = [];

  const tags = new Set<string>();
  let previous: JournalEntry | undefined;
  for (const entry of entries) {
    if (tags.has(entry.tag)) problems.push(`${entry.tag} is in the journal more than once`);
    tags.add(entry.tag);
    // The journal's order is the order the migrations run in, and `when` is what tells applied from new.
    if (previous !== undefined && entry.when <= previous.when) {
      problems.push(
        `${entry.tag} has a when (${String(entry.when)}) that is not later than ${previous.tag}'s (${String(previous.when)})`,
      );
    }
    previous = entry;

    const file = join(folder, `${entry.tag}.sql`);
    if (!existsSync(file)) {
      problems.push(`${entry.tag}.sql is in the journal and is not in the folder`);
      continue;
    }
    migrations.push({
      tag: entry.tag,
      when: entry.when,
      hashes: acceptedHashes(readFileSync(file, 'utf8')),
    });
  }

  for (const name of readdirSync(folder)
    .filter((file) => file.endsWith('.sql'))
    .toSorted()) {
    if (!tags.has(name.slice(0, -'.sql'.length))) {
      problems.push(`${name} is in the folder and is not in the journal, so it would never run`);
    }
  }
  return { migrations, problems };
}

/**
 * What is wrong between the folder and the journal table. An applied migration must still be in the folder, with
 * the text it ran with; and a migration that has not run must be later than every one that has.
 */
export function checkAgainstApplied(
  migrations: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): string[] {
  const problems: string[] = [];
  const byWhen = new Map(migrations.map((migration) => [migration.when, migration]));
  const appliedWhens = new Set<number>();
  let latest = Number.NEGATIVE_INFINITY;

  for (const row of applied) {
    const createdAt = Number(row.createdAt);
    appliedWhens.add(createdAt);
    latest = Math.max(latest, createdAt);
    const known = byWhen.get(createdAt);
    if (known === undefined) {
      problems.push(
        `a migration that ran (journal when ${String(createdAt)}) is not in the folder any more`,
      );
    } else if (!known.hashes.includes(row.hash)) {
      problems.push(`${known.tag} was edited after it ran: its text is not what was applied`);
    }
  }

  for (const migration of migrations) {
    if (!appliedWhens.has(migration.when) && migration.when < latest) {
      problems.push(
        `${migration.tag} has not run and is older than one that has, so the migrator would skip it for ever`,
      );
    }
  }
  return problems;
}
