import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkAgainstApplied,
  MigrationHistoryError,
  readMigrationFolder,
  type FolderMigration,
} from './migration-history.js';
import { MIGRATIONS_FOLDER } from './run-migrations.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A migration folder in a temporary directory: a journal of the given entries and a file for each named one. */
function folderWith(
  entries: { tag: string; when: number }[],
  files: Record<string, string> = Object.fromEntries(
    entries.map((entry) => [`${entry.tag}.sql`, `SELECT '${entry.tag}';`]),
  ),
  journal: string = JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
): string {
  const folder = mkdtempSync(join(tmpdir(), 'melarc-history-'));
  folders.push(folder);
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, 'meta', '_journal.json'), journal);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
}

describe('readMigrationFolder', () => {
  // Control for everything below: the folder the application really ships has no problem.
  it('finds nothing wrong with the committed migrations', () => {
    const folder = readMigrationFolder(MIGRATIONS_FOLDER);

    expect(folder.problems).toEqual([]);
    expect(folder.migrations.length).toBeGreaterThan(0);
  });

  it('reads each migration under the number the journal table will store', () => {
    const folder = readMigrationFolder(
      folderWith([
        { tag: '0000_a', when: 1000 },
        { tag: '0001_b', when: 2000 },
      ]),
    );

    expect(folder.problems).toEqual([]);
    expect(folder.migrations.map(({ tag, when }) => [tag, when])).toEqual([
      ['0000_a', 1000],
      ['0001_b', 2000],
    ]);
    expect(folder.migrations[0]?.hashes).toContain(sha256("SELECT '0000_a';"));
  });

  // Break caught: a migration whose `when` is not later than the one before it. Which of two such migrations the
  // migrator applies depends on which ran first, and the other is skipped for ever.
  it.each([
    ['equal to', 1000],
    ['earlier than', 999],
  ])('refuses a when that is %s the one before it', (_label, second) => {
    const folder = readMigrationFolder(
      folderWith([
        { tag: '0000_a', when: 1000 },
        { tag: '0001_b', when: second },
      ]),
    );

    expect(folder.problems).toEqual([expect.stringContaining('0001_b has a when')]);
  });

  // Break caught: a journal entry whose file is not there, which the migrator reports only when it gets to it.
  it('names a journal entry that has no file', () => {
    const folder = readMigrationFolder(folderWith([{ tag: '0000_a', when: 1000 }], {}));

    expect(folder.problems).toEqual(['0000_a.sql is in the journal and is not in the folder']);
  });

  // Break caught: a file in the folder that the journal does not name, which is never run and is not noticed.
  it('names a migration file that is not in the journal', () => {
    const folder = readMigrationFolder(
      folderWith([{ tag: '0000_a', when: 1000 }], {
        '0000_a.sql': 'SELECT 1;',
        '0001_forgotten.sql': 'SELECT 2;',
      }),
    );

    expect(folder.problems).toEqual([
      '0001_forgotten.sql is in the folder and is not in the journal, so it would never run',
    ]);
  });

  it('names a tag that is in the journal twice', () => {
    const folder = readMigrationFolder(
      folderWith([
        { tag: '0000_a', when: 1000 },
        { tag: '0000_a', when: 2000 },
      ]),
    );

    expect(folder.problems).toContain('0000_a is in the journal more than once');
  });

  // Break caught: a journal that cannot be read being taken for an empty history, so every migration looks new.
  it.each([
    ['not JSON', '{not json'],
    ['without entries', '{"version":"7"}'],
  ])('refuses a journal that is %s', (_label, journal) => {
    const folder = readMigrationFolder(folderWith([], {}, journal));

    expect(folder.problems).toHaveLength(1);
    expect(folder.migrations).toEqual([]);
  });

  it('refuses an entry with no usable tag or when', () => {
    const folder = readMigrationFolder(
      folderWith(
        [],
        {},
        JSON.stringify({ entries: [{ tag: '../escape', when: 1 }, { tag: 'ok' }, null] }),
      ),
    );

    expect(folder.problems).toEqual([
      'journal entry 0 has no usable tag and when',
      'journal entry 1 has no usable tag and when',
      'journal entry 2 has no usable tag and when',
    ]);
  });

  it('refuses a folder with no journal', () => {
    const folder = mkdtempSync(join(tmpdir(), 'melarc-history-'));
    folders.push(folder);

    expect(readMigrationFolder(folder).problems).toEqual(['meta/_journal.json is missing']);
  });

  // Break caught: a working copy checked out with Windows line endings being taken for an edited migration: the
  // journal table holds the hash of the text that ran, which was the text with Unix line endings.
  it('accepts the hash of the Unix text for a file that has Windows line endings', () => {
    const unix = 'CREATE TABLE a (\n  id integer\n);\n';
    const [migration] = readMigrationFolder(
      folderWith([{ tag: '0000_a', when: 1000 }], { '0000_a.sql': unix.replaceAll('\n', '\r\n') }),
    ).migrations;

    expect(migration?.hashes).toContain(sha256(unix));
  });

  it('accepts the hash of the text with either line ending', () => {
    const text = 'CREATE TABLE a (\n  id integer\n);\n';
    const [migration] = readMigrationFolder(
      folderWith([{ tag: '0000_a', when: 1000 }], { '0000_a.sql': text }),
    ).migrations;

    expect(migration?.hashes).toEqual(
      expect.arrayContaining([sha256(text), sha256(text.replaceAll('\n', '\r\n'))]),
    );
  });
});

const A: FolderMigration = { tag: '0000_a', when: 1000, hashes: ['hash-a'] };
const B: FolderMigration = { tag: '0001_b', when: 2000, hashes: ['hash-b'] };

describe('checkAgainstApplied', () => {
  it('agrees when the database holds a prefix of the folder', () => {
    expect(checkAgainstApplied([A, B], [])).toEqual([]);
    expect(checkAgainstApplied([A, B], [{ hash: 'hash-a', createdAt: '1000' }])).toEqual([]);
    expect(
      checkAgainstApplied(
        [A, B],
        [
          { hash: 'hash-a', createdAt: '1000' },
          { hash: 'hash-b', createdAt: 2000 },
        ],
      ),
    ).toEqual([]);
  });

  // Break caught: a migration that was edited after it ran. The database has the old text and the repository the
  // new, and nothing says so until a table is not what the reviewed migration made it.
  it('names a migration whose text is not the text that was applied', () => {
    expect(checkAgainstApplied([A, B], [{ hash: 'something-else', createdAt: '1000' }])).toEqual([
      '0000_a was edited after it ran: its text is not what was applied',
    ]);
  });

  // Break caught: a migration deleted or renamed after it ran.
  it('names a migration that ran and is not in the folder any more', () => {
    expect(checkAgainstApplied([B], [{ hash: 'hash-a', createdAt: '1000' }])).toEqual([
      'a migration that ran (journal when 1000) is not in the folder any more',
    ]);
  });

  // Break caught: the migrator's silent skip. A migration whose `when` is earlier than the latest applied one is
  // never run, whatever its file says, because the migrator compares it with the latest and with nothing else.
  it('names a migration that has not run and is older than one that has', () => {
    const late: FolderMigration = { tag: '0001_late', when: 500, hashes: ['hash-late'] };

    expect(checkAgainstApplied([A, late, B], [{ hash: 'hash-b', createdAt: '2000' }])).toEqual([
      '0000_a has not run and is older than one that has, so the migrator would skip it for ever',
      '0001_late has not run and is older than one that has, so the migrator would skip it for ever',
    ]);
  });

  it('does not name a migration that is newer than every one that ran', () => {
    expect(checkAgainstApplied([A, B], [{ hash: 'hash-a', createdAt: '1000' }])).toEqual([]);
  });

  it('carries no text of any migration', () => {
    const error = new MigrationHistoryError(['0000_a was edited after it ran']);

    expect(error.message).toContain('0000_a was edited after it ran');
    expect(error.name).toBe('MigrationHistoryError');
  });
});
