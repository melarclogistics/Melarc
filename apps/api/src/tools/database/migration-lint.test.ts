import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lintMigrationSql } from './migration-lint.js';

const PROTECTED = `
CREATE TABLE melarc.orders (id uuid PRIMARY KEY);
--> statement-breakpoint
ALTER TABLE melarc.orders OWNER TO melarc_owner;
--> statement-breakpoint
ALTER TABLE melarc.orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE melarc.orders FORCE ROW LEVEL SECURITY;
`;

describe('lintMigrationSql', () => {
  // Break caught: the lint rejecting a migration that does everything required, which would block every
  // product slice's first table.
  it('accepts a table that is owned by melarc_owner with row-level security enabled and forced', () => {
    expect(lintMigrationSql(PROTECTED)).toEqual([]);
  });

  it('accepts a migration that creates no table', () => {
    expect(lintMigrationSql('CREATE SCHEMA melarc AUTHORIZATION melarc_owner;')).toEqual([]);
  });

  // Break caught: a table created without the three statements that make it safe, which would leave it
  // owned by whoever ran the migration and readable around the policies (K2, K3 and K7).
  it.each([
    ['OWNER TO melarc_owner', 'ALTER TABLE melarc.orders OWNER TO melarc_owner;'],
    ['ENABLE ROW LEVEL SECURITY', 'ALTER TABLE melarc.orders ENABLE ROW LEVEL SECURITY;'],
    ['FORCE ROW LEVEL SECURITY', 'ALTER TABLE melarc.orders FORCE ROW LEVEL SECURITY;'],
  ])('refuses a table with no %s', (requirement, statement) => {
    const problems = lintMigrationSql(PROTECTED.replace(statement, ''));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('melarc.orders');
    expect(problems[0]).toContain(requirement);
  });

  // Break caught: the owner statement naming a runtime role, which would let the role the API connects
  // as own its tables and so bypass the policies.
  it('refuses a table owned by any role other than melarc_owner', () => {
    const problems = lintMigrationSql(
      PROTECTED.replace('OWNER TO melarc_owner', 'OWNER TO melarc_api_runtime'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('OWNER TO melarc_owner');
  });

  // Break caught: a statement that is only commented out being counted, so the table ships unprotected.
  it('does not count a commented-out statement', () => {
    const problems = lintMigrationSql(
      PROTECTED.replace(
        'ALTER TABLE melarc.orders FORCE ROW LEVEL SECURITY;',
        '-- ALTER TABLE melarc.orders FORCE ROW LEVEL SECURITY;\n/* ALTER TABLE melarc.orders FORCE ROW LEVEL SECURITY; */',
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('FORCE ROW LEVEL SECURITY');
  });

  // Break caught: matching a table by prefix, so protecting orders_archive appears to protect orders.
  it('does not accept the statements of a similarly named table', () => {
    const problems = lintMigrationSql(
      PROTECTED.replaceAll('melarc.orders', 'melarc.orders_archive').replace(
        'CREATE TABLE melarc.orders_archive',
        'CREATE TABLE melarc.orders (id uuid);\nCREATE TABLE melarc.orders_archive',
      ),
    );
    expect(problems).toHaveLength(3);
    expect(problems.every((problem) => problem.includes('melarc.orders:'))).toBe(true);
  });

  // Break caught: the quoting Drizzle emits, the case-folding of unquoted names and an unqualified name
  // defeating the match, in either direction.
  it('matches a table however it is quoted, cased or qualified', () => {
    const sql = `
      create table if not exists "melarc"."Orders" ("id" uuid);
      ALTER TABLE ONLY "melarc"."Orders" OWNER TO "melarc_owner";
      ALTER TABLE IF EXISTS melarc."Orders" ENABLE ROW LEVEL SECURITY;
      alter table "melarc"."Orders" force row level security;
      CREATE TABLE widgets (id uuid);
      ALTER TABLE public.WIDGETS OWNER TO melarc_owner;
      ALTER TABLE "public"."widgets" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
    `;
    expect(lintMigrationSql(sql)).toEqual([]);
  });

  // Break caught: a table that differs only in letter case treated as the same one.
  it('keeps a quoted name case-sensitive', () => {
    const problems = lintMigrationSql(
      PROTECTED.replace('CREATE TABLE melarc.orders', 'CREATE TABLE melarc."Orders"'),
    );
    expect(problems).toHaveLength(3);
  });

  // Break caught: a temporary table being demanded to carry the production controls.
  it('ignores a temporary table', () => {
    expect(
      lintMigrationSql('CREATE TEMP TABLE scratch (id int); CREATE TEMPORARY TABLE s2 (id int);'),
    ).toEqual([]);
  });

  // Break caught: a later statement quietly turning protection off again.
  it.each(['DISABLE ROW LEVEL SECURITY', 'NO FORCE ROW LEVEL SECURITY'])(
    'refuses a migration that runs %s',
    (statement) => {
      const problems = lintMigrationSql(`${PROTECTED}\nALTER TABLE melarc.orders ${statement};`);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(statement);
    },
  );

  // Break caught: a policy bound to a role. Policies decide on the request context alone, never on which
  // database role connected (SECURITY_DESIGN.md section 14.2).
  it('refuses a policy that names a role', () => {
    const named = `${PROTECTED}\nCREATE POLICY p ON melarc.orders FOR SELECT TO melarc_api_runtime USING (true);`;
    expect(lintMigrationSql(named)).toEqual([expect.stringContaining('policy p')]);
    const unbound = `${PROTECTED}\nCREATE POLICY p ON melarc.orders FOR SELECT USING (to_regclass('x') IS NULL);`;
    expect(lintMigrationSql(unbound)).toEqual([]);
  });
});

describe('lintMigrationSql: reading the SQL as SQL', () => {
  // Break caught: an UNLOGGED table not being seen as a table, so it needs no owner and no row-level security.
  it('sees an UNLOGGED table as a table', () => {
    expect(lintMigrationSql('CREATE UNLOGGED TABLE melarc.scratch (id int);')).toHaveLength(3);
  });

  // Break caught: the comment stripper reading `--` inside a string as a comment, which hid the rest of the line, a
  // statement that switches protection off with it.
  it('does not read a comment inside a string', () => {
    const problems = lintMigrationSql(
      `${PROTECTED}\nINSERT INTO melarc.notes VALUES ('--'); ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY;`,
    );
    expect(problems).toEqual([expect.stringContaining('DISABLE ROW LEVEL SECURITY')]);
  });

  it('does not read a statement inside a comment, nested or not', () => {
    const sql = `${PROTECTED}\n/* a /* b */ ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY; */\n-- ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY;`;
    expect(lintMigrationSql(sql)).toEqual([]);
    const after = `${PROTECTED}\n/* a /* b */ still comment */ ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY;`;
    expect(lintMigrationSql(after)).toEqual([
      expect.stringContaining('DISABLE ROW LEVEL SECURITY'),
    ]);
  });

  // Break caught: an E'...' string ended at an escaped quote, so what follows is read as code, or the other way
  // round, so code that follows a string is read as part of it.
  it('reads the end of an escape string, and of an ordinary one, where PostgreSQL does', () => {
    const escaped = String.raw`${PROTECTED}
INSERT INTO melarc.notes VALUES (E'it\'s -- not a comment'); ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY;`;
    expect(lintMigrationSql(escaped)).toEqual([
      expect.stringContaining('DISABLE ROW LEVEL SECURITY'),
    ]);
    const plain = String.raw`${PROTECTED}
INSERT INTO melarc.notes VALUES ('a\'); ALTER TABLE melarc.orders DISABLE ROW LEVEL SECURITY;`;
    expect(lintMigrationSql(plain)).toEqual([
      expect.stringContaining('DISABLE ROW LEVEL SECURITY'),
    ]);
  });

  // Break caught: a `;` inside a function body ending the statement early, so the statements that follow it are
  // read as belonging to something else, or the body's own statements as the migration's.
  it('does not split a dollar-quoted body at the semicolons in it', () => {
    const sql = `${PROTECTED}
CREATE FUNCTION melarc.f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN PERFORM 1; RETURN 1; END $body$;`;
    expect(lintMigrationSql(sql)).toEqual([]);
  });

  // Break caught: the three requirements asked for as three separate statements only, so a table that is made
  // safe in one ALTER TABLE with several actions looked unprotected.
  it('accepts the owner and both row-level-security actions in one ALTER TABLE', () => {
    const sql = `CREATE TABLE melarc.orders (id uuid);
ALTER TABLE melarc.orders OWNER TO melarc_owner, ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;`;
    expect(lintMigrationSql(sql)).toEqual([]);
  });

  it('reads a comma inside parentheses as part of one action', () => {
    const sql = `${PROTECTED}\nALTER TABLE melarc.orders ADD CONSTRAINT c CHECK (id IS NOT NULL OR id IN ('a', 'b')), ADD COLUMN x int;`;
    expect(lintMigrationSql(sql)).toEqual([]);
  });

  // Break caught: the first owner counting. A table given to someone else after it was handed to the owner role is
  // owned by someone else, and the owner decides who can switch row-level security off.
  it('judges a table by the owner it is left with', () => {
    const problems = lintMigrationSql(`${PROTECTED}\nALTER TABLE melarc.orders OWNER TO postgres;`);
    expect(problems).toEqual([
      expect.stringContaining('table melarc.orders: missing ALTER TABLE ... OWNER TO melarc_owner'),
    ]);
  });

  it('refuses to hand over a table it did not create, too', () => {
    expect(lintMigrationSql('ALTER TABLE melarc.old OWNER TO melarc_api_runtime;')).toEqual([
      'table melarc.old: ALTER TABLE ... OWNER TO melarc_api_runtime (only melarc_owner may own a table)',
    ]);
    expect(lintMigrationSql('ALTER TABLE melarc.old OWNER TO melarc_owner;')).toEqual([]);
  });

  // Break caught: a policy bound to a role by ALTER POLICY after it was created without one.
  it('refuses ALTER POLICY ... TO a role, and allows renaming one', () => {
    expect(
      lintMigrationSql(`${PROTECTED}\nALTER POLICY p ON melarc.orders TO melarc_api_runtime;`),
    ).toEqual([expect.stringContaining('policy p')]);
    expect(lintMigrationSql(`${PROTECTED}\nALTER POLICY p ON melarc.orders RENAME TO q;`)).toEqual(
      [],
    );
    expect(
      lintMigrationSql(
        `${PROTECTED}\nALTER POLICY p ON melarc.orders USING (to_regclass('x') IS NULL);`,
      ),
    ).toEqual([]);
  });

  // Break caught: a privilege opened to everyone, or default privileges that would do it for objects nobody
  // reviewed, or a context setting stored where no transaction can set it.
  it.each([
    ['a grant to PUBLIC', 'GRANT SELECT ON melarc.orders TO PUBLIC;', /PUBLIC/],
    [
      'a grant to PUBLIC among others',
      'GRANT SELECT ON melarc.orders TO melarc_api_runtime, public;',
      /PUBLIC/,
    ],
    [
      'default privileges',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA melarc GRANT SELECT ON TABLES TO melarc_api_runtime;',
      /default privileges/,
    ],
    [
      'a stored context setting',
      "ALTER DATABASE melarc SET melarc.principal_type = 'SYSTEM';",
      /melarc\.\* setting/,
    ],
    [
      'a stored context setting on a role',
      "ALTER ROLE melarc_api_runtime SET melarc.principal_type TO 'SYSTEM';",
      /melarc\.\* setting/,
    ],
  ])('refuses %s', (_label, statement, expected) => {
    const problems = lintMigrationSql(`${PROTECTED}\n${statement}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(expected);
  });

  it('allows a grant to the runtime role', () => {
    expect(
      lintMigrationSql(
        `${PROTECTED}\nGRANT SELECT, INSERT ON melarc.orders TO melarc_api_runtime;`,
      ),
    ).toEqual([]);
  });
});

describe('lintMigrationSql: statements that remove data', () => {
  // Break caught (Product Owner decision, 6 October 2026): a cascade, a truncation or a DELETE grant that nobody chose.
  // Delete behaviour is explicit and never a framework default, and operational data is never hard-deleted by accident.
  // Each of these is refused unless a comment on the statement records why.
  it.each([
    [
      'an inline ON DELETE CASCADE',
      'ALTER TABLE melarc.child ADD COLUMN parent uuid REFERENCES melarc.parent (id) ON DELETE CASCADE;',
    ],
    [
      'an added ON DELETE CASCADE',
      'ALTER TABLE melarc.child ADD CONSTRAINT fk FOREIGN KEY (parent) REFERENCES melarc.parent (id) ON  DELETE\n  CASCADE;',
    ],
    ['a TRUNCATE', 'TRUNCATE melarc.orders;'],
    [
      'a TRUNCATE of several tables',
      'TRUNCATE TABLE melarc.orders, melarc.lines RESTART IDENTITY;',
    ],
    ['a DELETE grant', 'GRANT SELECT, DELETE ON melarc.orders TO melarc_api_runtime;'],
    ['a grant of everything', 'GRANT ALL PRIVILEGES ON melarc.orders TO melarc_api_runtime;'],
    ['a grant of everything, short', 'GRANT ALL ON TABLE melarc.orders TO melarc_api_runtime;'],
    ['a TRUNCATE grant', 'GRANT TRUNCATE ON melarc.orders TO melarc_api_runtime;'],
    [
      'a DELETE grant on every table of a schema',
      'GRANT DELETE ON ALL TABLES IN SCHEMA melarc TO melarc_api_runtime;',
    ],
  ])('refuses %s with no recorded reason', (_label, statement) => {
    const problems = lintMigrationSql(statement);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('allow-delete');
  });

  it.each([
    [
      'a line comment before it',
      '-- allow-delete: purge job, 90-day retention (OPS-RETENTION)\nTRUNCATE melarc.orders;',
    ],
    [
      'a block comment inside it',
      'GRANT DELETE /* allow-delete: draft cleanup */ ON melarc.drafts TO melarc_api_runtime;',
    ],
    [
      'a comment after it in the same statement',
      'ALTER TABLE melarc.child ADD CONSTRAINT fk FOREIGN KEY (parent) REFERENCES melarc.parent (id) ON DELETE CASCADE -- allow-delete: children have no life of their own\n;',
    ],
  ])('accepts it when %s records the reason', (_label, statement) => {
    expect(lintMigrationSql(statement)).toEqual([]);
  });

  // Break caught: the marker with no reason, which records nothing, or a reason that belongs to the previous statement.
  it('does not accept the marker without a reason, or a reason given for another statement', () => {
    expect(lintMigrationSql('-- allow-delete:\nTRUNCATE melarc.orders;')).toHaveLength(1);
    expect(
      lintMigrationSql('-- allow-delete: purge\nSELECT 1;\nTRUNCATE melarc.orders;'),
    ).toHaveLength(1);
  });

  // Break caught: the rule refusing what it must allow, which is every grant and constraint that does not remove data.
  it.each([
    'GRANT SELECT, INSERT, UPDATE ON melarc.orders TO melarc_api_runtime;',
    'GRANT USAGE ON SCHEMA melarc TO melarc_api_runtime;',
    'GRANT EXECUTE ON FUNCTION melarc.principal_type() TO melarc_api_runtime;',
    'ALTER TABLE melarc.child ADD COLUMN parent uuid REFERENCES melarc.parent (id) ON DELETE RESTRICT;',
    'ALTER TABLE melarc.child ADD CONSTRAINT fk FOREIGN KEY (parent) REFERENCES melarc.parent (id);',
    "INSERT INTO melarc.notes VALUES ('ON DELETE CASCADE and TRUNCATE are only words here');",
  ])('allows %s', (statement) => {
    expect(lintMigrationSql(statement)).toEqual([]);
  });
});

describe('the committed migrations', () => {
  const folder = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const files = readdirSync(folder).filter((name) => name.endsWith('.sql'));

  // Break caught: a migration landing in the canonical history that does not satisfy K7.
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the migration lint', (file) => {
    expect(lintMigrationSql(readFileSync(join(folder, file), 'utf8'))).toEqual([]);
  });
});
