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

/** An ordinary policy expression, for the tests of other rules to hold their policies in: the principal CASE of §14.4. */
const SUPPORTED = "CASE melarc.principal_type() WHEN 'STAFF' THEN true ELSE false END";

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
    const named = `${PROTECTED}\nCREATE POLICY p ON melarc.orders FOR SELECT TO melarc_api_runtime USING (${SUPPORTED});`;
    expect(lintMigrationSql(named)).toEqual([expect.stringContaining('policy p')]);
    const unbound = `${PROTECTED}\nCREATE POLICY p ON melarc.orders FOR SELECT USING (${SUPPORTED});`;
    expect(lintMigrationSql(unbound)).toEqual([]);
  });
});

describe('lintMigrationSql: roles, role grants and SECURITY DEFINER functions (S0.5)', () => {
  // A function written as MIGRATION_AND_SEEDING.md §5.1 asks: SECURITY DEFINER, its own search_path, no PUBLIC, named roles.
  const DEFINER = `CREATE FUNCTION melarc.reveal() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$;
--> statement-breakpoint
ALTER FUNCTION melarc.reveal() OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.reveal() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.reveal() TO melarc_api_runtime;`;

  // Break caught: the lint refusing the shape the design prescribes, which would block the first function that needs it.
  it('accepts a SECURITY DEFINER function that fixes its search_path and grants EXECUTE to a named role only', () => {
    expect(lintMigrationSql(DEFINER)).toEqual([]);
  });

  it('accepts object grants, which are not role grants', () => {
    expect(
      lintMigrationSql(
        `GRANT USAGE ON SCHEMA melarc TO melarc_worker_runtime;
         GRANT EXECUTE ON FUNCTION melarc.principal_type() TO melarc_worker_runtime, melarc_provisioning;
         GRANT SELECT, INSERT ON TABLE melarc.orders TO melarc_api_runtime;
         GRANT CONNECT ON DATABASE melarc TO melarc_api_runtime;`,
      ),
    ).toEqual([]);
  });

  // Break caught: a role created by a migration with nobody having said why. A migration that creates a role is flagged
  // and reviewed (MIGRATION_AND_SEEDING.md §5.1): the reason is on the statement, as for a delete.
  it.each([
    ['CREATE ROLE', 'CREATE ROLE melarc_extra LOGIN;'],
    ['CREATE USER', 'CREATE USER melarc_extra;'],
    ['CREATE GROUP', 'CREATE GROUP melarc_extra;'],
    ['ALTER ROLE', 'ALTER ROLE melarc_api_runtime CREATEDB;'],
    ['ALTER USER', 'ALTER USER melarc_api_runtime WITH BYPASSRLS;'],
    ['ALTER ROLE ... RENAME', 'ALTER ROLE melarc_api_runtime RENAME TO melarc_api;'],
    ['GRANT a role to a role', 'GRANT melarc_owner TO melarc_api_runtime;'],
    ['GRANT several roles', 'GRANT melarc_owner, melarc_migration_elevated TO melarc_api_runtime;'],
    [
      'GRANT a role WITH ADMIN OPTION',
      'GRANT melarc_owner TO melarc_api_runtime WITH ADMIN OPTION;',
    ],
    ['GRANT a predefined role', 'GRANT pg_read_all_data TO melarc_api_runtime;'],
  ])('refuses %s with no recorded reason', (what, statement) => {
    const problems = lintMigrationSql(statement);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no recorded reason');
    expect(problems[0]).toContain('-- allow-role: <reason>');
    expect(problems[0]).toContain(what.split(' ')[0] === 'GRANT' ? 'GRANT' : what.split(' ')[0]);
  });

  // Break caught: the reason being required and never satisfiable, or satisfied by an empty comment.
  it('accepts the same statements with a reason on the statement, and not with an empty one', () => {
    expect(
      lintMigrationSql(
        '-- allow-role: the worker needs its own login for the delivery process (S0.18)\nCREATE ROLE melarc_extra LOGIN;',
      ),
    ).toEqual([]);
    expect(
      lintMigrationSql(
        '-- allow-role: the migration runs as a member of the owner\nGRANT melarc_owner TO melarc_api_runtime;',
      ),
    ).toEqual([]);
    expect(lintMigrationSql('-- allow-role:\nCREATE ROLE melarc_extra LOGIN;')).toHaveLength(1);
  });

  // Break caught: the reason of one statement covering the next one, or a statement hidden in a string.
  it('asks for a reason on each statement, and does not read a statement in a string', () => {
    expect(
      lintMigrationSql(
        '-- allow-role: first\nCREATE ROLE melarc_one;\n--> statement-breakpoint\nCREATE ROLE melarc_two;',
      ),
    ).toHaveLength(1);
    expect(
      lintMigrationSql("COMMENT ON TABLE melarc.orders IS 'CREATE ROLE x; GRANT a TO b';"),
    ).toEqual([]);
  });

  // Break caught: ALTER ROLE ... SET being counted twice, once as a role change and once as the stored context it is.
  it('leaves ALTER ROLE ... SET to the stored-context rule', () => {
    expect(
      lintMigrationSql("ALTER ROLE melarc_api_runtime SET melarc.principal_type TO 'SYSTEM';"),
    ).toEqual([expect.stringContaining('melarc.* setting')]);
    expect(
      lintMigrationSql("ALTER ROLE melarc_api_runtime SET statement_timeout TO '5s';"),
    ).toEqual([]);
  });

  // Break caught: a definer function that runs with its owner's search_path, which anyone who can create an object in an
  // earlier schema of that path can use to make it call their code as the owner.
  it('refuses a SECURITY DEFINER function that does not fix its search_path', () => {
    const problems = lintMigrationSql(DEFINER.replace(' SET search_path = pg_catalog', ''));
    expect(problems).toEqual([expect.stringContaining('does not fix its search_path')]);
    expect(problems[0]).toContain('melarc.reveal');
  });

  // Break caught: a definer function that anyone can execute, or that no named role is granted.
  it('refuses a SECURITY DEFINER function that is not revoked from PUBLIC', () => {
    const problems = lintMigrationSql(
      DEFINER.replace('REVOKE ALL ON FUNCTION melarc.reveal() FROM PUBLIC;', ''),
    );
    expect(problems).toEqual([expect.stringContaining('does not revoke EXECUTE from PUBLIC')]);
  });

  it('refuses a SECURITY DEFINER function that is granted to no named role', () => {
    const problems = lintMigrationSql(
      DEFINER.replace('GRANT EXECUTE ON FUNCTION melarc.reveal() TO melarc_api_runtime;', ''),
    );
    expect(problems).toEqual([expect.stringContaining('grants EXECUTE to no named role')]);
  });

  it('refuses a SECURITY DEFINER function granted to PUBLIC, once, as a grant to PUBLIC', () => {
    const problems = lintMigrationSql(DEFINER.replace('TO melarc_api_runtime', 'TO PUBLIC'));
    expect(problems.some((problem) => problem.includes('grants a privilege to PUBLIC'))).toBe(true);
    expect(problems.some((problem) => problem.includes('grants EXECUTE to no named role'))).toBe(
      true,
    );
  });

  // Break caught: a definer function that builds a statement from what it is given. An argument that becomes SQL runs with
  // the owner's powers.
  it.each([
    ['EXECUTE format', "EXECUTE format('select %I', name)"],
    ['EXECUTE of a string', "EXECUTE 'select ' || name"],
    ['lower case execute', "execute 'select 1'"],
  ])('refuses a SECURITY DEFINER function that uses %s', (_what, statement) => {
    const body = `CREATE FUNCTION melarc.run(name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN ${statement}; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.run(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.run(text) TO melarc_api_runtime;`;
    expect(lintMigrationSql(body)).toEqual([expect.stringContaining('dynamic SQL')]);
  });

  // Break caught: a function that is not a definer being held to the definer's rules, which would stop the accessors.
  it('does not apply the definer rules to a function that runs as its caller', () => {
    expect(
      lintMigrationSql(
        'CREATE FUNCTION melarc.plain() RETURNS int LANGUAGE sql STABLE AS $$ SELECT 1 $$;\nALTER FUNCTION melarc.plain() OWNER TO melarc_owner;',
      ),
    ).toEqual([]);
  });

  // Break caught: a function made a definer after it was created without being one, which skips the search_path the
  // CREATE statement would have had to carry.
  it('refuses ALTER FUNCTION ... SECURITY DEFINER', () => {
    expect(lintMigrationSql('ALTER FUNCTION melarc.plain() SECURITY DEFINER;')).toEqual([
      expect.stringContaining('SECURITY DEFINER only in its CREATE statement'),
    ]);
  });

  // Break caught: CREATE OR REPLACE bypassing the rules the first CREATE had to meet.
  it('holds CREATE OR REPLACE to the same rules', () => {
    const replaced = DEFINER.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace(
      ' SET search_path = pg_catalog',
      '',
    );
    expect(lintMigrationSql(replaced)).toEqual([
      expect.stringContaining('does not fix its search_path'),
    ]);
  });
});

describe('lintMigrationSql: the scope probe predicate is read-only (review of S0.4 and S0.5)', () => {
  const policy = (clauses: string, verb = 'CREATE') =>
    `${PROTECTED}\n${verb} POLICY probe ON melarc.orders ${clauses};`;
  const probe = "melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id()";

  // Break caught: the lint refusing the one policy the predicate is meant to be in.
  it('accepts the predicate in a policy FOR SELECT', () => {
    expect(lintMigrationSql(policy(`FOR SELECT USING (${probe})`))).toEqual([]);
    expect(lintMigrationSql(policy(`AS PERMISSIVE FOR SELECT USING (${probe})`))).toEqual([]);
  });

  // Break caught: the predicate ORed into the ordinary policy (which is for ALL when no command is written), where it
  // would decide which rows an UPDATE or a DELETE may touch and let a record of another hub be moved into one's own.
  it.each([
    [
      'a policy with no command, which is for ALL',
      `USING (hub_id = ANY (melarc.authorized_hub_ids()) OR id = melarc.scope_probe_id())`,
    ],
    [
      'a policy FOR ALL',
      `FOR ALL USING (${probe}) WITH CHECK (hub_id = ANY (melarc.authorized_hub_ids()))`,
    ],
    ['a policy FOR UPDATE', `FOR UPDATE USING (${probe})`],
    ['a policy FOR DELETE', `FOR DELETE USING (${probe})`],
    ['a policy FOR INSERT', `FOR INSERT WITH CHECK (${probe})`],
  ])('refuses the predicate in %s', (_label, clauses) => {
    const problems = lintMigrationSql(policy(clauses));
    // The probe rule says it first. The expression is also not the supported structure outside a policy FOR SELECT, and the
    // structure rule says so too: each rule holds on its own.
    expect(problems[0]).toContain('belongs in a policy FOR SELECT only');
    expect(problems[0]).toContain('policy probe on melarc.orders');
    expect(problems.slice(1).join('\n')).toMatch(/not a supported policy expression/);
  });

  // Break caught: ALTER POLICY, which does not show its command, being the way the predicate gets into an ordinary policy.
  it('refuses the predicate in an ALTER POLICY, which does not show the command', () => {
    const problems = lintMigrationSql(policy(`USING (${probe})`, 'ALTER'));
    expect(problems[0]).toContain('belongs in a policy FOR SELECT only');
    expect(problems.slice(1).join('\n')).toMatch(/not a supported policy expression/);
  });

  it('does not read the name in a comment or a string', () => {
    expect(
      lintMigrationSql(
        `${PROTECTED}\n-- melarc.scope_probe_id() is for SELECT\nCREATE POLICY p ON melarc.orders USING (CASE melarc.principal_type() WHEN 'STAFF' THEN note = 'melarc.scope_probe_id()' ELSE false END);`,
      ),
    ).toEqual([]);
  });

  // Break caught (F03): the exception widened from the scope probe policy to anything that mentions the probe.
  it.each([
    ['the probe with no staff guard', `FOR SELECT USING (id = melarc.scope_probe_id())`],
    [
      'a guard that excludes one type and admits the rest',
      `FOR SELECT USING (melarc.principal_type() <> 'VENDOR' AND id = melarc.scope_probe_id())`,
    ],
    [
      'the guard and the probe ORed',
      `FOR SELECT USING (melarc.principal_type() = 'STAFF' OR id = melarc.scope_probe_id())`,
    ],
    [
      'a third condition',
      `FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id() AND true)`,
    ],
  ])('refuses %s, even in a policy FOR SELECT', (_label, clauses) => {
    const problems = lintMigrationSql(policy(clauses));
    expect(problems).toEqual([expect.stringMatching(/not a supported policy expression/)]);
  });
});

describe('lintMigrationSql: a SYSTEM branch names its capability (GBT-E7)', () => {
  const policy = (clause: string, verb = 'CREATE') =>
    `${PROTECTED}\n${verb} POLICY p ON melarc.orders ${clause};`;
  const using = (expression: string) => `USING (${expression})`;

  // Break caught: the lint refusing the prescribed shape, which would block the seed slice's first table.
  it('accepts a SYSTEM arm that tests one capability, in USING and in WITH CHECK', () => {
    const arm =
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END";
    expect(lintMigrationSql(policy(`${using(arm)} WITH CHECK (${arm})`))).toEqual([]);
  });

  // Break caught: the blanket policy. `SYSTEM` alone, or ORed into a policy, opens the table to every task.
  it.each([
    [
      'a SYSTEM arm with no capability',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN true ELSE false END",
    ],
    [
      'an OR that admits SYSTEM',
      "hub_id = ANY (melarc.authorized_hub_ids()) OR melarc.principal_type() = 'SYSTEM'",
    ],
    [
      'a capability outside the closed list',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'admin' ELSE false END",
    ],
  ])('refuses %s', (_label, expression) => {
    const problems = lintMigrationSql(policy(using(expression)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('policy p on melarc.orders');
  });

  // Break caught: the check reading only USING, so that a WITH CHECK that admits SYSTEM alone lets any task write.
  it('refuses a SYSTEM branch in WITH CHECK that tests no capability', () => {
    const good =
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END";
    const bad = "CASE melarc.principal_type() WHEN 'SYSTEM' THEN true ELSE false END";
    expect(lintMigrationSql(policy(`USING (${good}) WITH CHECK (${bad})`))).toHaveLength(1);
  });

  // Break caught: the three predicates that the review of S0.4 and S0.5 reproduced as accepted: a capability test that is
  // not mandatory. Each is judged as the clause it is, in USING and in WITH CHECK, and each is refused.
  it.each([
    [
      'a negated capability test',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN NOT (melarc.task_capability() = 'seed') ELSE false END",
    ],
    [
      'a disjunction that is true anyway',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN (melarc.task_capability() = 'seed' OR true) AND true ELSE false END",
    ],
    [
      'an OR true around the CASE',
      "(CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE false END) OR true",
    ],
    [
      'an ELSE that admits everyone else',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN melarc.task_capability() = 'seed' ELSE true END",
    ],
    // The second review: AND binds tighter than OR, so nothing inside a disjunction is mandatory. This is true for every
    // capability, and it was accepted.
    [
      'a capability test inside a disjunction that is true anyway',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN (melarc.task_capability() = 'seed' AND false OR true) AND true ELSE false END",
    ],
    [
      'the same with the grouping spelled out in nested parentheses',
      "CASE melarc.principal_type() WHEN 'SYSTEM' THEN ((((melarc.task_capability() = 'seed' AND false) OR true))) AND ((true)) ELSE false END",
    ],
    [
      'the same as pg_get_expr prints it, with the cast and a parenthesis for every operand',
      "CASE melarc.principal_type() WHEN 'SYSTEM'::text THEN ((((melarc.task_capability() = 'seed'::text) AND false) OR true) AND true) ELSE false END",
    ],
  ])('refuses %s, in USING and in WITH CHECK', (_label, expression) => {
    expect(lintMigrationSql(policy(using(expression)))).toHaveLength(1);
    expect(lintMigrationSql(policy(`WITH CHECK (${expression})`))).toHaveLength(1);
    expect(
      lintMigrationSql(policy(`${using(expression)} WITH CHECK (${expression})`)),
    ).toHaveLength(2);
  });

  // The line is not "no OR in the arm": a capability test that is mandatory, next to a parenthesized OR that has nothing to do
  // with it, is the supported structure and is accepted, in USING and in WITH CHECK, in either order.
  it.each([
    ["melarc.task_capability() = 'seed' AND (a IS NULL OR b IS NULL)"],
    ["(a IS NULL OR b IS NULL) AND melarc.task_capability() = 'seed'"],
    ["((melarc.task_capability() = 'seed'::text) AND ((a IS NULL) OR (b IS NULL)))"],
  ])('accepts a mandatory capability test beside an unrelated OR: %s', (body) => {
    const expression = `CASE melarc.principal_type() WHEN 'SYSTEM' THEN ${body} ELSE false END`;
    expect(lintMigrationSql(policy(`${using(expression)} WITH CHECK (${expression})`))).toEqual([]);
  });

  // Break caught: an ELSE that admits a SYSTEM context no arm names, in a policy that never writes SYSTEM at all.
  it('refuses an ELSE true in the principal CASE of a policy that does not name SYSTEM', () => {
    const open = "CASE melarc.principal_type() WHEN 'STAFF' THEN hub_id IS NOT NULL ELSE true END";
    expect(lintMigrationSql(policy(using(open)))).toEqual([
      expect.stringContaining('ELSE of the principal CASE'),
    ]);
  });

  // Break caught: ALTER POLICY, which can widen a policy that was created correctly, being let through.
  it('refuses a SYSTEM branch added by ALTER POLICY', () => {
    const widened = policy(using("melarc.principal_type() = 'SYSTEM' OR true"), 'ALTER');
    expect(lintMigrationSql(widened)).toHaveLength(1);
  });

  // Break caught: the word SYSTEM in a string that is data, or in a comment, being read as a branch.
  it('does not read SYSTEM in a comment or in a string that is not part of the policy', () => {
    const sql = `${PROTECTED}
-- the SYSTEM principal is dealt with elsewhere
COMMENT ON TABLE melarc.orders IS 'SYSTEM rows are written by a seed';`;
    expect(lintMigrationSql(sql)).toEqual([]);
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
      lintMigrationSql(`${PROTECTED}\nALTER POLICY p ON melarc.orders USING (${SUPPORTED});`),
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

/**
 * An ordinary policy is the principal CASE, and an expression that is not is refused whether or not it names SYSTEM (correction
 * F03). The first three admit a SYSTEM context under any capability and name no SYSTEM, so the lint used to say nothing.
 */
describe('lintMigrationSql: nothing but the principal CASE (or the scope probe policy) is passed (F03)', () => {
  const policy = (clauses: string, verb = 'CREATE') =>
    `${PROTECTED}\n${verb} POLICY p ON melarc.orders ${clauses};`;
  const UNSUPPORTED = /not a supported policy expression/;

  // Break caught: the reproduction of F03. Each expression is a whole USING or WITH CHECK; each admits SYSTEM and names no SYSTEM.
  it.each([
    ['a literal true', 'true'],
    ['an inequality on the principal type', "melarc.principal_type() <> 'VENDOR'"],
    ['NOT IN a list', "melarc.principal_type() NOT IN ('VENDOR', 'RIDER')"],
  ])(
    'refuses %s as the USING, the WITH CHECK or both clauses of a policy',
    (_label, expression) => {
      const using = lintMigrationSql(policy(`USING (${expression})`));
      expect(using).toEqual([expect.stringMatching(UNSUPPORTED)]);
      expect(using[0]).toContain('policy p on melarc.orders');
      expect(lintMigrationSql(policy(`FOR INSERT WITH CHECK (${expression})`))).toEqual([
        expect.stringMatching(UNSUPPORTED),
      ]);
      expect(
        lintMigrationSql(policy(`USING (${expression}) WITH CHECK (${expression})`)),
      ).toHaveLength(2);
    },
  );

  // Break caught: a policy judged alone, so that a second permissive policy beside a safe one admits what the safe one refuses
  // (PostgreSQL ORs the permissive policies that apply).
  it('refuses a second permissive policy that admits what the first refuses', () => {
    const sql = `${PROTECTED}\nCREATE POLICY safe ON melarc.orders USING (${SUPPORTED});\n--> statement-breakpoint\nCREATE POLICY open ON melarc.orders FOR SELECT USING (true);`;
    const problems = lintMigrationSql(sql);
    expect(problems).toEqual([expect.stringMatching(UNSUPPORTED)]);
    expect(problems[0]).toContain('policy open on melarc.orders');
  });

  // Break caught: ALTER POLICY, which can replace a supported expression with one that admits everyone.
  it('refuses ALTER POLICY that replaces the expression with an unsupported one', () => {
    expect(lintMigrationSql(policy('USING (true)', 'ALTER'))).toEqual([
      expect.stringMatching(UNSUPPORTED),
    ]);
    expect(lintMigrationSql(policy(`USING (${SUPPORTED})`, 'ALTER'))).toEqual([]);
  });

  // Break caught: the supported forms refused, which would block the policy template of the next slice.
  it.each([
    ['one policy for every command', `USING (${SUPPORTED}) WITH CHECK (${SUPPORTED})`],
    ['a policy for SELECT', `FOR SELECT USING (${SUPPORTED})`],
    ['a policy for INSERT', `FOR INSERT WITH CHECK (${SUPPORTED})`],
    ['a policy for UPDATE', `FOR UPDATE USING (${SUPPORTED}) WITH CHECK (${SUPPORTED})`],
    ['a policy for DELETE', `FOR DELETE USING (${SUPPORTED})`],
    [
      'the three human principals and nothing for SYSTEM',
      "USING (CASE melarc.principal_type() WHEN 'STAFF' THEN a WHEN 'VENDOR' THEN b WHEN 'RIDER' THEN c ELSE false END)",
    ],
    [
      'the scope probe policy FOR SELECT',
      "FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id())",
    ],
  ])('accepts %s', (_label, clauses) => {
    expect(lintMigrationSql(policy(clauses))).toEqual([]);
  });

  // Break caught: the arm for the principal that is not one, which admits a context that was never established.
  it('refuses an arm for NONE', () => {
    const problems = lintMigrationSql(
      policy("USING (CASE melarc.principal_type() WHEN 'NONE' THEN true ELSE false END)"),
    );
    expect(problems).toEqual([expect.stringContaining('not a principal type')]);
  });
});

describe('lintMigrationSql: the policy tables change only through the primitive (S0.27)', () => {
  // Break caught: a migration that updates a bundle with a plain statement. Under forced row-level security that changes no row and
  // raises no error, so the revision, the floor and the sessions stay as they were while the migration reports success.
  it.each([
    ['an UPDATE', 'UPDATE role_bundle SET revision = revision + 1;'],
    ['an UPDATE of a quoted, qualified table', `UPDATE public."role_bundle_grant" SET tier = 'P';`],
    ['an UPDATE ONLY', 'UPDATE ONLY fixed_permission_policy SET revision = 2;'],
    ['an INSERT', `INSERT INTO fixed_permission_policy (principal_type) VALUES ('VENDOR');`],
    ['a DELETE', 'DELETE FROM public.role_bundle_grant WHERE true;'],
    ['a TRUNCATE', 'TRUNCATE role_bundle_grant;'],
    [
      'a MERGE',
      'MERGE INTO role_bundle USING (SELECT 1) AS s ON false WHEN NOT MATCHED THEN DO NOTHING;',
    ],
    ['an UPDATE in a DO block', `DO $$ BEGIN UPDATE role_bundle SET name = 'x'; END $$;`],
    ['an UPDATE after a WITH', `WITH g AS (SELECT 1) UPDATE role_bundle SET name = 'y';`],
  ])('refuses %s of a policy table, and names the primitive', (_label, statement) => {
    const problems = lintMigrationSql(statement);
    expect(problems.some((problem) => problem.includes('melarc.change_role_bundle'))).toBe(true);
    expect(problems.some((problem) => problem.includes('melarc.change_fixed_policy'))).toBe(true);
  });

  it('accepts the call of the primitive, which is a SELECT', () => {
    expect(
      lintMigrationSql(
        `SELECT melarc.change_role_bundle('5eed0001-0000-4000-8000-000000000001', NULL, '[]'::jsonb, 'release-1');`,
      ),
    ).toEqual([]);
    expect(
      lintMigrationSql(`SELECT melarc.change_fixed_policy('VENDOR', true, 'release-1');`),
    ).toEqual([]);
  });

  // Break caught: the rule matching names that merely begin like a policy table, a statement on another table, a mention in a string or
  // a comment, or the body of a function (a definer function is its own review).
  it.each([
    ['a table whose name begins like one', 'UPDATE role_bundle_grant_archive SET tier = null;'],
    ['a table whose name ends like one', 'UPDATE old_role_bundle SET revision = 2;'],
    ['another table', 'UPDATE staff_identity SET full_name = full_name;'],
    ['a string that names one', `SELECT 'UPDATE role_bundle SET revision = 2';`],
    ['a comment that names one', '-- UPDATE role_bundle SET revision = 2;\nSELECT 1;'],
    [
      'the body of a function',
      `CREATE FUNCTION melarc.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE role_bundle SET name = name; END $$;`,
    ],
    [
      'an ON CONFLICT DO UPDATE of another table',
      'INSERT INTO hub (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1;',
    ],
  ])('does not refuse %s', (_label, statement) => {
    expect(
      lintMigrationSql(statement).filter((problem) => problem.includes('policy table')),
    ).toEqual([]);
  });

  // Break caught: the reason accepted when empty, or not on the statement it excuses.
  it('accepts the statement with a reason on it, and not with an empty one or one on another statement', () => {
    expect(
      lintMigrationSql(
        '-- allow-policy-dml: backfills display_order, which is not authorization content\nUPDATE role_bundle SET revision = revision;',
      ),
    ).toEqual([]);
    expect(
      lintMigrationSql('-- allow-policy-dml:\nUPDATE role_bundle SET revision = revision;'),
    ).toHaveLength(1);
    expect(
      lintMigrationSql(
        '-- allow-policy-dml: first\nUPDATE role_bundle SET a = 1;\n--> statement-breakpoint\nUPDATE role_bundle SET b = 2;',
      ),
    ).toHaveLength(1);
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
