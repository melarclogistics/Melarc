import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import {
  MigrationLockOrderError,
  policyKeysOfFiles,
  policyKeysOfRun,
  scanPolicyKeys,
} from './policy-keys.js';
import { BUNDLE_IDS } from '../seed/bundles.js';
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

  // (Run 6, Stage 1.7: this was "accepts a change ... that the file has named first" with a row's fields (`b.id`, `b.audience`) for the keys, which is the very form that is
  // refused now: a bundle another key of the file names is not necessarily the one a variable holds. The claim that is kept: a change of a bundle and of a fixed policy that the
  // file has named is accepted, and the keys it names are the keys that are taken.)
  it('accepts a change of a bundle and of a fixed policy whose keys are literals the file has named first', () => {
    const found = scanPolicyKeys([
      locks([BUNDLE_1], ['VENDOR']),
      `DO $x$ BEGIN PERFORM melarc.change_role_bundle('${BUNDLE_1}', NULL, '[]'::jsonb, 'release#a'); PERFORM melarc.change_fixed_policy('VENDOR', false, 'release#b'); END $x$;`,
    ]);

    expect(found.unresolved).toEqual([]);
    expect(found.bundleIds).toEqual([BUNDLE_1]);
    expect(found.fixedTypes).toEqual(['VENDOR']);
  });

  // The form of 0043 and 0057: a loop over the bundle table gives the change the key of whatever bundle the loop holds. It is accepted because the file names every bundle of the
  // seed and both fixed policies first, so that whatever the variable holds was taken first; with one of them missing it is refused (the forms of the next describe).
  it('accepts a change whose key is a variable when the file names every bundle of the seed and both fixed policies', () => {
    const found = scanPolicyKeys([
      locks(Object.values(BUNDLE_IDS), ['VENDOR', 'RIDER']),
      `DO $x$ DECLARE s record; BEGIN FOR s IN SELECT b.id, b.audience FROM public.role_bundle AS b LOOP PERFORM melarc.change_role_bundle(s.id, NULL, '[]'::jsonb, 'release#a'); PERFORM melarc.change_fixed_policy(s.audience, false, 'release#b'); END LOOP; END $x$;`,
    ]);

    expect(found.unresolved).toEqual([]);
    expect(found.bundleIds).toEqual(Object.values(BUNDLE_IDS));
  });

  // The form of 0075 and 0077: the bundle is a constant that the statement declares with a literal, and the change is given the constant. It is read as that literal, and
  // that bundle is taken first even when the file names no other key.
  it('reads a constant the statement declares with a literal as that literal', () => {
    const found = scanPolicyKeys([
      `DO $x$ DECLARE platform_admin constant uuid := '${BUNDLE_2}'; audience constant text := 'RIDER'; BEGIN PERFORM melarc.change_role_bundle(platform_admin, NULL, '[]'::jsonb, 'release#a'); PERFORM melarc.change_fixed_policy(audience, false, 'release#b'); END $x$;`,
    ]);

    expect(found.unresolved).toEqual([]);
    expect(found.bundleIds).toEqual([BUNDLE_2]);
    expect(found.fixedTypes).toEqual(['RIDER']);
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

/**
 * The reader fails closed (run 5, Stage 1.5). Run 4 said that a use of a key it could not read refuses the run; this holds it to that for the forms in which the old reader
 * saw nothing at all: it took away comments with no knowledge of dollar quotes, of `E''` strings or of quoted identifiers, skipped a whole chunk that began with a function
 * being defined, and read only `melarc.<name>(` in plain letters. A file that mentions a key function in a form the runner cannot place refuses the run with the file's name,
 * before anything is applied; a mention it can place (a comment, a message, a statement about the function's signature) does not.
 */
describe('what the runner cannot place refuses the run, with the name of the file', () => {
  const FILE = '0074_a_new_one';
  const VARIABLE = 'melarc.lock_policy_keys(some_ids, ARRAY[]::text[])';
  const LITERAL = `ARRAY['${BUNDLE_1}']::uuid[], ARRAY[]::text[]`;

  // Break caught: each form below hid the call from the reader that cut comments out with no knowledge of SQL's quoting, or did not match it at all, so that the file
  // took its key in the middle of the run, which only the check after the file would have noticed. Every one is refused now, and says which file.
  const FORMS: readonly (readonly [string, readonly string[], RegExp])[] = [
    [
      'a call after a dollar-quoted string that holds a line comment marker',
      [`DO $x$ BEGIN PERFORM $q$ -- $q$, ${VARIABLE}; END $x$;`],
      /lock_policy_keys\(some_ids/,
    ],
    [
      'a call after a dollar-quoted string that holds a block comment marker',
      [`DO $x$ BEGIN PERFORM $q$ /* $q$, ${VARIABLE}; END $x$;`],
      /lock_policy_keys\(some_ids/,
    ],
    [
      'a call after an E string whose escaped quote hides a comment marker',
      [String.raw`SELECT E'\' -- ', ${VARIABLE};`],
      /lock_policy_keys\(some_ids/,
    ],
    [
      'a function being defined and a call in one chunk',
      [`CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; SELECT ${VARIABLE};`],
      /lock_policy_keys\(some_ids/,
    ],
    [
      'a quoted schema and name',
      [`SELECT "melarc"."lock_policy_keys"(${LITERAL});`],
      /quoted identifier/,
    ],
    ['a quoted name', [`SELECT melarc."lock_policy_keys"(${LITERAL});`], /quoted identifier/],
    [
      'a quoted schema',
      [`SELECT "melarc".lock_policy_keys(${LITERAL});`],
      /qualifier other than an unquoted melarc/,
    ],
    ['an unqualified call', [`SELECT lock_policy_keys(${LITERAL});`], /no melarc\. before it/],
    [
      'a call in another schema',
      [`SELECT public.lock_policy_keys(${LITERAL});`],
      /qualifier other than an unquoted melarc/,
    ],
    [
      'an unqualified change of a bundle',
      [`SELECT change_role_bundle('${BUNDLE_1}', NULL, '[]'::jsonb, 'release#a');`],
      /change_role_bundle is called with no melarc\./,
    ],
    [
      'a name in a string of a statement that executes strings',
      [`DO $x$ BEGIN EXECUTE 'select melarc.lock_policy_keys(' || ids || ')'; END $x$;`],
      /lock_policy_keys is named in a string of a statement that EXECUTEs/,
    ],
    // Run 6, Stage 1.7: four more forms that the reader accepted and resolved wrongly.
    [
      'a variable for the bundle of a change, though the file has named a bundle',
      [
        locks([BUNDLE_1]),
        `DO $x$ BEGIN PERFORM melarc.change_role_bundle(some_id, NULL, '[]'::jsonb, 'release#a'); END $x$;`,
      ],
      /change_role_bundle\(some_id.*the bundle is a variable, and the file does not name every bundle of the seed/,
    ],
    [
      'a row field for the fixed policy of a change, though the file has named a fixed policy',
      [
        locks([], ['VENDOR']),
        `DO $x$ BEGIN PERFORM melarc.change_fixed_policy(b.audience, false, 'release#b'); END $x$;`,
      ],
      /change_fixed_policy\(b\.audience.*the fixed policy is a variable, and the file does not name both fixed policies/,
    ],
    [
      'a variable that is given a literal but is not a constant',
      [
        `DO $x$ DECLARE b uuid := '${BUNDLE_1}'; BEGIN PERFORM melarc.change_role_bundle(b, NULL, '[]'::jsonb, 'release#a'); END $x$;`,
      ],
      /change_role_bundle\(b,.*the bundle is a variable/,
    ],
    [
      'a wrapper function that takes the keys, defined in the file',
      [
        `CREATE FUNCTION public.take_keys() RETURNS void LANGUAGE sql AS $$ SELECT melarc.lock_policy_keys(ARRAY['${BUNDLE_1}']::uuid[], ARRAY[]::text[]) $$;`,
      ],
      /take_keys is defined here and its body names lock_policy_keys/,
    ],
    [
      'a wrapper function that changes a bundle, defined in the file',
      [
        `CREATE OR REPLACE FUNCTION melarc.widen(b uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN melarc.change_role_bundle(b, NULL, '[]'::jsonb, 'release#a'); END $$;`,
      ],
      /widen is defined here and its body names change_role_bundle/,
    ],
    [
      'a wrapper function whose body is a string',
      [
        `CREATE FUNCTION public.w() RETURNS void LANGUAGE sql AS 'select melarc.lock_policy_bundle(''${BUNDLE_1}'')';`,
      ],
      /w is defined here and its body names lock_policy_bundle/,
    ],
    [
      'a name in a string that query_to_xml runs as SQL',
      [`SELECT query_to_xml('select melarc.lock_policy_keys(' || ids || ')', false, false, '');`],
      /lock_policy_keys is named in a string of a statement that runs it as SQL \(query_to_xml\)/,
    ],
    [
      'a name in a string that ts_stat runs as SQL',
      [`SELECT * FROM ts_stat('select melarc.lock_policy_bundle(x)');`],
      /lock_policy_bundle is named in a string of a statement that runs it as SQL \(ts_stat\)/,
    ],
    [
      'a name in a string that dblink_exec runs as SQL',
      [`SELECT dblink_exec('dbname=x', 'select melarc.change_fixed_policy(a, b, c)');`],
      /change_fixed_policy is named in a string of a statement that runs it as SQL \(dblink_exec\)/,
    ],
    [
      'a Unicode-escaped identifier for the function',
      [String.raw`SELECT melarc.U&"lock_policy_\006beys"(${LITERAL});`],
      /Unicode-escaped identifier/,
    ],
    [
      'a Unicode-escaped identifier for the schema',
      [String.raw`SELECT U&"\006delarc".lock_policy_keys(${LITERAL});`],
      /Unicode-escaped identifier/,
    ],
    [
      'a Unicode-escaped string that is executed',
      [String.raw`DO $x$ BEGIN EXECUTE U&'select melarc.lock_policy_\006beys(a)'; END $x$;`],
      /Unicode-escaped string/,
    ],
    [
      'a dollar quote that is never closed',
      [`DO $x$ BEGIN PERFORM ${VARIABLE.replace('some_ids', `ARRAY['${BUNDLE_1}']::uuid[]`)};`],
      /dollar quote \$x\$ that is never closed/,
    ],
    [
      'a string that is never closed',
      [`SELECT 'a message, melarc.lock_policy_keys(${LITERAL});`],
      /a string that is never closed/,
    ],
  ];

  it.each(FORMS)('says so for %s', (_form, sql, words) => {
    const found = scanPolicyKeys(sql);

    expect(found.unresolved.length).toBeGreaterThan(0);
    expect(found.unresolved.join('\n')).toMatch(words);
  });

  it.each(FORMS)('refuses the run, naming the file, for %s', (_form, sql) => {
    const refusal = (() => {
      try {
        return policyKeysOfFiles([
          { tag: '0073_fine', sql: ['SELECT 1;'] },
          { tag: FILE, sql },
        ]);
      } catch (error) {
        return error;
      }
    })();

    expect(refusal).toBeInstanceOf(MigrationLockOrderError);
    expect((refusal as MigrationLockOrderError).message).toContain(`${FILE}: `);
    expect((refusal as MigrationLockOrderError).message).not.toContain('0073_fine');
  });

  // Break caught: a reader so careful that it refuses what the files really contain: the headers of 0043 to 0079 say lock_policy_keys over and over, 0017 and
  // later migrations grant, revoke and comment on the functions, and a message may name one. None of these is a call, so none refuses the run.
  it.each([
    ['a comment', [`-- takes melarc.lock_policy_keys first\nSELECT 1;`]],
    ['a block comment', [`/* lock_policy_keys(a), change_role_bundle(b) */ SELECT 1;`]],
    ['a message', [`DO $x$ BEGIN RAISE NOTICE 'call melarc.lock_policy_keys first'; END $x$;`]],
    [
      'a comment on the function and a grant, in one chunk',
      [
        `COMMENT ON FUNCTION melarc.lock_policy_keys(uuid[], text[]) IS 'takes lock_policy_keys first'; GRANT EXECUTE ON FUNCTION melarc.lock_policy_keys(uuid[], text[]) TO melarc_owner;`,
      ],
    ],
    ['a drop if exists', [`DROP FUNCTION IF EXISTS melarc.lock_policy_keys(uuid[], text[]);`]],
    // (Run 6, Stage 1.7: the body of this function used to name lock_policy_bundle, which is a wrapper and is refused now (the forms above). The claim that is kept: a function
    // defined and the signature of one of the five granted in one chunk are two statements, and the grant is not a call.)
    [
      'a function defined and its signature granted in one chunk',
      [
        `CREATE FUNCTION melarc.x() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; REVOKE ALL ON FUNCTION melarc.lock_policy_bundle(uuid) FROM PUBLIC;`,
      ],
    ],
    [
      'a definition of one of the five, which calls another of them',
      [
        `CREATE OR REPLACE FUNCTION "melarc"."change_role_bundle"(b uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN PERFORM melarc.lock_policy_bundle(b); RETURN NULL; END $$;`,
      ],
    ],
    ['a name in a string of a statement that runs nothing', [`SELECT 'lock_policy_keys';`]],
    ['a US-ASCII look-alike of the escape', [`SELECT 'US&"x"', 'u&';`]],
    [
      'an unqualified signature',
      [`ALTER FUNCTION lock_policy_keys(uuid[], text[]) OWNER TO melarc_owner;`],
    ],
  ])('does not refuse %s', (_what, sql) => {
    expect(scanPolicyKeys(sql).unresolved).toEqual([]);
  });

  // Break caught: the lexer losing a call it used to read, in the shapes the real files use after a string or a comment: a call after a message that holds a comment
  // marker, and one in a body that holds a block comment of its own.
  it('still reads a call that follows a string with a comment marker in it, and a body with its own comments', () => {
    const found = scanPolicyKeys([
      `DO $x$ BEGIN RAISE NOTICE 'a -- b /* c'; /* one */ PERFORM melarc.lock_policy_keys(${LITERAL}); -- two\nEND $x$;`,
      String.raw`SELECT E'it\'s', melarc.lock_policy_keys(ARRAY['${BUNDLE_2}']::uuid[], ARRAY['RIDER']::text[]);`,
    ]);

    expect(found.unresolved).toEqual([]);
    expect(found.bundleIds).toEqual([BUNDLE_1, BUNDLE_2]);
    expect(found.fixedTypes).toEqual(['RIDER']);
  });
});
