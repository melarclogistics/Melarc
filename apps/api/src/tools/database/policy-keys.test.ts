import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import { policyKeysOfRun, scanPolicyKeys } from './policy-keys.js';
import { MIGRATIONS_FOLDER } from './run-migrations.js';

/**
 * The policy keys a migration names (run 4, Stage 1, item 3). The runner takes every key the migrations of a run name before the run's first statement, so
 * that the migrator never holds a table lock while it waits for a key an application transaction already holds (and that transaction wants the table). What
 * it takes is what the files say, read from their text; these tests hold the reading to the real files and to the shapes a new migration might take.
 */
const BUNDLE_1 = '5eed0001-0000-4000-8000-000000000001';
const BUNDLE_2 = '5eed0001-0000-4000-8000-000000000002';

const locks = (bundles: readonly string[], fixed: readonly string[] = []) =>
  `DO $locks$\nBEGIN\n  PERFORM melarc.lock_policy_keys(\n    ARRAY[${bundles.map((id) => `'${id}'`).join(', ')}]::uuid[],\n    ARRAY[${fixed.map((type) => `'${type}'`).join(', ')}]::text[]\n  );\nEND\n$locks$;`;

describe('what a migration names (scanPolicyKeys)', () => {
  // Break caught: a reader that finds nothing in the text the migrations really use, so that the runner takes no key and the order is left to the files again.
  it('reads the bundles and the fixed policies of a lock_policy_keys call', () => {
    const found = scanPolicyKeys([locks([BUNDLE_2, BUNDLE_1], ['VENDOR', 'RIDER'])]);

    expect(found.bundleIds).toEqual([BUNDLE_2, BUNDLE_1]);
    expect(found.fixedTypes).toEqual(['VENDOR', 'RIDER']);
    expect(found.unresolved).toEqual([]);
  });

  // Break caught: a key counted twice, or two spellings of one identifier counted as two (the lock is on the lower-case text's digest).
  it('names each key once, whatever the case it is written in and however often', () => {
    const found = scanPolicyKeys([
      locks([BUNDLE_1, BUNDLE_1.toUpperCase()], ['RIDER', 'RIDER']),
      locks([BUNDLE_1], ['RIDER']),
    ]);

    expect(found.bundleIds).toEqual([BUNDLE_1]);
    expect(found.fixedTypes).toEqual(['RIDER']);
  });

  // Break caught: a comment that names a key (the headers of 0075 to 0079 say lock_policy_keys over and over) taken for a call, so that the runner takes a key
  // the file never takes; and the reverse, a call written beside a comment that is not seen.
  it('ignores comments: a call that is only described takes nothing, and a call beside a comment is seen', () => {
    const described = scanPolicyKeys([
      `-- PERFORM melarc.lock_policy_keys(ARRAY['${BUNDLE_1}']::uuid[], ARRAY['RIDER']::text[]);\n/* melarc.lock_policy_keys(ARRAY['${BUNDLE_2}']::uuid[], ARRAY[]::text[]) */\nSELECT 1;`,
    ]);
    expect(described.bundleIds).toEqual([]);
    expect(described.fixedTypes).toEqual([]);

    const beside = scanPolicyKeys([
      `DO $x$ BEGIN -- takes the keys first\n  PERFORM melarc.lock_policy_keys(ARRAY['${BUNDLE_1}']::uuid[], ARRAY[]::text[]); /* then */ END $x$;`,
    ]);
    expect(beside.bundleIds).toEqual([BUNDLE_1]);
  });

  // Break caught: a comment marker inside a string (a notice, a label) cutting the rest of the line off, so that a key after it on the same line is lost.
  it('does not take a comment marker inside a quoted string for a comment', () => {
    const found = scanPolicyKeys([
      `DO $x$ BEGIN RAISE NOTICE 'a -- b'; PERFORM melarc.lock_policy_keys(ARRAY['${BUNDLE_1}']::uuid[], ARRAY[]::text[]); END $x$;`,
    ]);

    expect(found.bundleIds).toEqual([BUNDLE_1]);
  });

  // Break caught: the body of a function taken for a call. A definition runs nothing: 0017's functions call lock_policy_bundle with a variable, and 0078 and 0079
  // replace functions that lock the key they are given.
  it('does not read the body of a function being defined', () => {
    const found = scanPolicyKeys([
      `CREATE FUNCTION melarc.lock_policy_keys(bundle_ids uuid[], fixed_types text[]) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM melarc.lock_policy_bundle(each_id); END $$;`,
      `CREATE OR REPLACE FUNCTION melarc.change_fixed_policy(p text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN PERFORM melarc.lock_policy_fixed(p); END $$;`,
    ]);

    expect(found.bundleIds).toEqual([]);
    expect(found.fixedTypes).toEqual([]);
    expect(found.unresolved).toEqual([]);
  });

  // Break caught: the signature of a function in an ALTER, a GRANT, a REVOKE or a DROP read as a call of it (0017 has them for each of the five), so that a file that
  // only says who owns and who may run a function is refused as taking a key by a variable.
  it('does not take a statement about a function for a call of it', () => {
    const found = scanPolicyKeys([
      'ALTER FUNCTION melarc.lock_policy_bundle(uuid) OWNER TO melarc_owner;',
      'REVOKE ALL ON FUNCTION melarc.lock_policy_keys(uuid[], text[]) FROM PUBLIC;',
      'GRANT EXECUTE ON FUNCTION melarc.change_role_bundle(uuid, text, jsonb, text) TO melarc_migration_elevated;',
      'DROP FUNCTION melarc.change_fixed_policy(text, boolean, text);',
    ]);

    expect(found).toEqual({ bundleIds: [], fixedTypes: [], unresolved: [] });
  });

  // Break caught: a key the runner could not know taken in silence (a variable, a query): the file would then take it in the middle of the run, after the table
  // locks of the files before it, which is what the runner is there to prevent. It is said, with the call, and the run is refused.
  it.each([
    ['a variable for a bundle', `ARRAY[some_bundle]::uuid[], ARRAY[]::text[]`],
    ['a query for the bundles', `(SELECT array_agg(id) FROM role_bundle)::uuid[], ARRAY[]::text[]`],
    ['a variable for a fixed policy', `ARRAY[]::uuid[], ARRAY[audience]::text[]`],
  ])('says so when a call names its keys by %s', (_which, args) => {
    const found = scanPolicyKeys([
      `DO $x$ BEGIN PERFORM melarc.lock_policy_keys(${args}); END $x$;`,
    ]);

    expect(found.unresolved).toHaveLength(1);
    expect(found.unresolved[0]).toContain('lock_policy_keys');
  });

  // Break caught: a change of a bundle or of a fixed policy that is not preceded by a lock the runner can read: the primitive takes its own key, which is the lock
  // taken in the middle of the run.
  it('says so when a file changes a bundle, or a fixed policy, and names no key of that kind', () => {
    const bundle = scanPolicyKeys([
      `DO $x$ BEGIN PERFORM melarc.change_role_bundle(some_id, NULL, '[]'::jsonb, 'release#a'); END $x$;`,
    ]);
    expect(bundle.unresolved).toHaveLength(1);
    expect(bundle.unresolved[0]).toContain('change_role_bundle');

    const fixed = scanPolicyKeys([
      locks([BUNDLE_1]),
      `DO $x$ BEGIN PERFORM melarc.change_fixed_policy(audience, false, 'release#b'); END $x$;`,
    ]);
    expect(fixed.unresolved).toHaveLength(1);
    expect(fixed.unresolved[0]).toContain('change_fixed_policy');
  });

  it('accepts a change of a bundle and of a fixed policy that the file has named first', () => {
    const found = scanPolicyKeys([
      locks([BUNDLE_1], ['VENDOR']),
      `DO $x$ BEGIN PERFORM melarc.change_role_bundle(b.id, NULL, '[]'::jsonb, 'release#a'); PERFORM melarc.change_fixed_policy(b.audience, false, 'release#b'); END $x$;`,
    ]);

    expect(found.unresolved).toEqual([]);
  });

  // Break caught: a migration with nothing to do with policy keys made to name some.
  it('finds nothing in a file that has nothing to do with the keys', () => {
    const found = scanPolicyKeys([
      'CREATE TABLE "thing" ("id" uuid PRIMARY KEY);',
      'ALTER TABLE "thing" ADD COLUMN "name" text;',
    ]);

    expect(found).toEqual({ bundleIds: [], fixedTypes: [], unresolved: [] });
  });
});

describe('the real migrations', () => {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const byNumber = (number: number) => {
    const sql = files[number]?.sql;
    if (sql === undefined) throw new Error(`no migration at position ${String(number)}`);
    return scanPolicyKeys(sql);
  };

  // Break caught: a migration whose keys the reader cannot tell. The files that exist are all read, and none leaves a key to the middle of a run.
  it('are all read, and none names a key the runner could not take first', () => {
    expect(files.length).toBeGreaterThan(70);
    const unresolved = files.flatMap((file, index) =>
      scanPolicyKeys(file.sql).unresolved.map((call) => `migration ${String(index)}: ${call}`),
    );

    expect(unresolved).toEqual([]);
  });

  // Break caught: the files that take policy keys read as taking none (a changed shape of the call that the reader no longer sees), which would put the order
  // back in the hands of the files. 0075, 0077 and 0078 name the six seeded bundles; 0079 names both fixed policies; 0043 names all eight.
  it('name the keys the files that lock them take: the six seeded bundles, and both fixed policies', () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => `5eed0001-0000-4000-8000-00000000000${String(n)}`);
    for (const number of [43, 57, 75, 77, 78]) {
      expect(byNumber(number).bundleIds, `migration ${String(number)}`).toEqual(six);
    }
    expect(byNumber(43).fixedTypes.toSorted()).toEqual(['RIDER', 'VENDOR']);
    expect(byNumber(79).bundleIds).toEqual([]);
    expect(byNumber(79).fixedTypes.toSorted()).toEqual(['RIDER', 'VENDOR']);
    expect(byNumber(74)).toEqual({ bundleIds: [], fixedTypes: [], unresolved: [] });
  });

  // Break caught: the run's union left out of a later file, so that the keys of 0075 and 0079 are taken after the index builds of 0074 and 0076 and the table lock
  // of 0078 (the two orders that can deadlock with a Vendor, a Rider or a staff transaction that holds its key and waits for the table).
  it('make the keys of a run that applies 0074 to 0079 the six bundles and both fixed policies', () => {
    const run = policyKeysOfRun(files.slice(74, 80).map((file) => scanPolicyKeys(file.sql)));

    expect(run.bundleIds).toHaveLength(6);
    expect(run.fixedTypes.toSorted()).toEqual(['RIDER', 'VENDOR']);
  });
});

describe('the keys of a run (policyKeysOfRun)', () => {
  it('is the union of the files, each key once, and none for files that name none', () => {
    const run = policyKeysOfRun([
      scanPolicyKeys([locks([BUNDLE_1])]),
      scanPolicyKeys(['SELECT 1;']),
      scanPolicyKeys([locks([BUNDLE_2, BUNDLE_1], ['VENDOR'])]),
    ]);

    expect(run.bundleIds.toSorted()).toEqual([BUNDLE_1, BUNDLE_2]);
    expect(run.fixedTypes).toEqual(['VENDOR']);
    expect(policyKeysOfRun([scanPolicyKeys(['SELECT 1;'])])).toEqual({
      bundleIds: [],
      fixedTypes: [],
    });
  });
});
