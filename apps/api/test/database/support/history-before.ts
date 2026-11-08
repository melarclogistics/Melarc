import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';

import { MIGRATIONS_FOLDER, runMigrations } from '../../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../../src/tools/database/safety.js';
import { HUB_A } from './rls-fixture.js';
import { clientFor, createTestDatabase, type TestDatabase } from './test-database.js';

/**
 * A database built the way a persistent one was **before** a migration: the history up to it applied by the real runner. The tests of an upgrade
 * check use it, because a clean install proves nothing about the path an existing database takes (the check, the record, the reconciliation or the
 * decision, and only then the migration).
 */
/** A private copy of the migrations folder holding the history before `from`, to apply first. */
export function historyBefore(from: number): string {
  const copy = mkdtempSync(join(tmpdir(), 'melarc-history-'));
  cpSync(MIGRATIONS_FOLDER, copy, { recursive: true });
  for (const name of readdirSync(copy)) {
    if (name.endsWith('.sql') && Number(name.slice(0, 4)) >= from) rmSync(join(copy, name));
  }
  for (const name of readdirSync(join(copy, 'meta'))) {
    if (name.endsWith('_snapshot.json') && Number(name.slice(0, 4)) >= from) {
      rmSync(join(copy, 'meta', name));
    }
  }
  const journalPath = join(copy, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < from);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return copy;
}

export interface Built {
  readonly target: TestDatabase;
  readonly admin: pg.Client;
  readonly folder: string;
  done(): Promise<void>;
}

/** A database with the history before `from` applied and the cluster administrator connected to it. */
export async function builtBefore(from: number): Promise<Built> {
  const target = await createTestDatabase({ migrate: false });
  const folder = historyBefore(from);
  const admin = clientFor(target.urlFor('postgres'));
  try {
    await runMigrations({ url: target.urlFor(MIGRATION_ROLE), folder });
    await admin.connect();
    await admin.query(`insert into hub (id, name) values ('${HUB_A}', 'Hub A')`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    rmSync(folder, { recursive: true, force: true });
    await target.drop();
    throw error;
  }
  return {
    target,
    admin,
    folder,
    done: async () => {
      await admin.end();
      rmSync(folder, { recursive: true, force: true });
      await target.drop();
    },
  };
}
