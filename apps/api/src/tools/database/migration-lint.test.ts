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
