import type pg from 'pg';

import {
  ROLE_POSTURE_SQL,
  rolePostureParameters,
  unsafeFlags,
} from '../../platform/database/role-posture.js';
import {
  RUNTIME_LOGIN_ROLES,
  WORKER_CREDENTIAL_DELIVERY_ROLE,
} from '../../platform/database/technical-roles.js';
import { OWNER_ROLE } from './provisioning.js';
import { scopeProbePolicyProblem, type PolicyCommand } from './scope-probe-rule.js';
import { systemBranchProblems } from './system-branch.js';

/**
 * What must be true of every object the migrations leave in a database, read from the catalogue and not from the
 * SQL (SECURITY_DESIGN.md sections 14.2 and 14.17a; MIGRATION_AND_SEEDING.md section 5.1).
 *
 * The migration lint reads the text of a migration, and a text check has holes however carefully it is written:
 * an `EXECUTE` that builds a statement, a `DO` block, a later `ALTER` that changes what an earlier one set. This
 * asks the database what it ended up with, so it holds whichever way the migration was written. It is run
 * against a freshly migrated database by the database tests, and it reports; it changes nothing.
 *
 * Not covered, because the design does not say it: who may DELETE or TRUNCATE (each table's own rules), views, and
 * what a policy decides, except that a SYSTEM branch of a policy must name one task capability.
 */

/** Schemas the migrations do not own. `drizzle` holds the journal table the migrator itself creates. */
const NOT_OURS = `n.nspname not in ('pg_catalog', 'information_schema', 'drizzle') and n.nspname not like 'pg\\_%'`;

const CHECKS: readonly { readonly what: string; readonly sql: string }[] = [
  {
    what: 'a table or sequence is not owned by the owner role',
    sql: `select format('%s %I.%I is owned by %s, not %s', case c.relkind when 'S' then 'sequence' else 'table' end,
                 n.nspname, c.relname, pg_get_userbyid(c.relowner), $1::text) as violation
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p', 'S') and ${NOT_OURS}
             and pg_get_userbyid(c.relowner) <> $1::text`,
  },
  {
    what: 'row-level security is not enabled and forced on a table',
    sql: `select format('table %I.%I does not have row-level security enabled and forced', n.nspname, c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and ${NOT_OURS}
             and not (c.relrowsecurity and c.relforcerowsecurity)`,
  },
  {
    what: 'a table is not permanent (UNLOGGED tables are emptied by a crash)',
    sql: `select format('table %I.%I is not a permanent table', n.nspname, c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and ${NOT_OURS} and c.relpersistence <> 'p'`,
  },
  {
    what: 'a policy names a role',
    sql: `select format('policy %I on %I.%I applies to roles, not to every role', p.polname, n.nspname, c.relname)
            from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
           where ${NOT_OURS} and p.polroles <> '{0}'::oid[]`,
  },
  {
    what: 'PUBLIC holds a privilege on a table or sequence',
    sql: `select format('PUBLIC holds %s on %I.%I', a.privilege_type, n.nspname, c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            cross join lateral aclexplode(c.relacl) a
           where c.relkind in ('r', 'p', 'S') and ${NOT_OURS} and a.grantee = 0`,
  },
  {
    what: 'PUBLIC can execute a function, or it has no explicit privileges',
    sql: `select format('function %I.%I is executable by PUBLIC', n.nspname, p.proname)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where ${NOT_OURS}
             and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
  },
  {
    what: 'a function is not owned by the owner role',
    sql: `select format('function %I.%I is owned by %s, not %s', n.nspname, p.proname,
                        pg_get_userbyid(p.proowner), $1::text)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where ${NOT_OURS} and pg_get_userbyid(p.proowner) <> $1::text`,
  },
  {
    what: 'a SECURITY DEFINER function does not fix its search_path',
    sql: `select format('function %I.%I is SECURITY DEFINER and has no search_path of its own', n.nspname, p.proname)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where ${NOT_OURS} and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as setting
                              where setting like 'search_path=%')`,
  },
  {
    what: 'a schema is not owned by the owner role',
    sql: `select format('schema %I is owned by %s, not %s', n.nspname, pg_get_userbyid(n.nspowner), $1::text)
            from pg_namespace n
           where ${NOT_OURS} and n.nspname <> 'public' and pg_get_userbyid(n.nspowner) <> $1::text`,
  },
  {
    what: 'PUBLIC can create objects in a schema',
    sql: `select format('PUBLIC holds CREATE on schema %I', n.nspname)
            from pg_namespace n cross join lateral aclexplode(n.nspacl) a
           where ${NOT_OURS} and a.grantee = 0 and a.privilege_type = 'CREATE'`,
  },
  {
    what: 'default privileges are set',
    sql: `select format('default privileges are set for role %s', pg_get_userbyid(d.defaclrole)) from pg_default_acl d`,
  },
  {
    what: 'a setting named melarc.* is stored on the database or on a role',
    sql: `select format('a setting %s is stored for the database or a role', setting.value)
            from pg_db_role_setting s cross join lateral unnest(s.setconfig) as setting(value)
           where setting.value like 'melarc.%'`,
  },
];

/**
 * `SYSTEM` alone is never a condition (SECURITY_DESIGN.md §14.1; Family E, `GBT-E7`). The expressions are read as
 * `pg_get_expr` prints them, which is what the database holds whichever way the migration wrote the policy, and
 * judged by the rule the migration lint applies to the migration's own text (system-branch.ts).
 */
const SYSTEM_BRANCH_CHECK =
  'a SYSTEM branch of a policy does not require its capability, or the scope probe predicate is in a policy that is not FOR SELECT';

/** `pg_policy.polcmd` as the command a policy is for. */
const POLICY_COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  '*': 'all',
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
};

const POLICY_EXPRESSIONS = `
  select p.polname, n.nspname, c.relname, p.polcmd::text as command,
         pg_get_expr(p.polqual, p.polrelid) as using_expression,
         pg_get_expr(p.polwithcheck, p.polrelid) as check_expression
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where ${NOT_OURS}
   order by n.nspname, c.relname, p.polname`;

/**
 * The technical roles (SECURITY_DESIGN.md §14.6, §14.17): each running login, and the worker's capability role, is asked
 * the question the readiness check asks of its own login, and the roles that are grant sets and not logins cannot log in.
 * A role that is missing is a finding, because provisioning creates every one of them before any migration runs.
 */
const TECHNICAL_ROLE_CHECKS = [
  'a technical role is missing, or a grant-set role can log in',
  'a technical login has a power a runtime identity may not',
] as const;

const GRANT_SET_ROLES = [OWNER_ROLE, WORKER_CREDENTIAL_DELIVERY_ROLE];

interface PolicyExpressions {
  readonly polname: string;
  readonly nspname: string;
  readonly relname: string;
  readonly command: string;
  readonly using_expression: string | null;
  readonly check_expression: string | null;
}

/** What is wrong with the database, one line each; empty when every invariant holds. */
export async function catalogViolations(client: Pick<pg.Client, 'query'>): Promise<string[]> {
  const violations: string[] = [];
  for (const check of CHECKS) {
    const uses = check.sql.includes('$1');
    const { rows } = await client.query<Record<string, string>>(
      check.sql,
      uses ? [OWNER_ROLE] : undefined,
    );
    for (const row of rows) violations.push(Object.values(row)[0] ?? check.what);
  }

  violations.push(...(await technicalRoleViolations(client)));

  const policies = await client.query<PolicyExpressions>(POLICY_EXPRESSIONS);
  for (const policy of policies.rows) {
    const where = `policy ${policy.polname} on ${policy.nspname}.${policy.relname}`;
    for (const expression of [policy.using_expression, policy.check_expression]) {
      for (const problem of systemBranchProblems(expression ?? '')) {
        violations.push(`${where}: ${problem}`);
      }
    }
    // A command this reader does not know is not read as SELECT.
    const probeProblem = scopeProbePolicyProblem(POLICY_COMMANDS[policy.command], [
      policy.using_expression,
      policy.check_expression,
    ]);
    if (probeProblem !== undefined) violations.push(`${where}: ${probeProblem}`);
  }
  return violations;
}

async function technicalRoleViolations(client: Pick<pg.Client, 'query'>): Promise<string[]> {
  const violations: string[] = [];
  const { rows } = await client.query<{ rolname: string; rolcanlogin: boolean }>(
    'select rolname, rolcanlogin from pg_roles where rolname = any($1)',
    [[...GRANT_SET_ROLES, ...RUNTIME_LOGIN_ROLES]],
  );
  const found = new Map(rows.map((row) => [row.rolname, row.rolcanlogin]));
  for (const role of [...GRANT_SET_ROLES, ...RUNTIME_LOGIN_ROLES]) {
    if (!found.has(role)) violations.push(`role ${role} does not exist`);
  }
  for (const role of GRANT_SET_ROLES) {
    if (found.get(role) === true) violations.push(`role ${role} can log in; it is a grant set`);
  }

  for (const role of [...RUNTIME_LOGIN_ROLES, WORKER_CREDENTIAL_DELIVERY_ROLE]) {
    if (!found.has(role)) continue;
    const posture = await client.query<Record<string, unknown>>(
      ROLE_POSTURE_SQL,
      rolePostureParameters(role),
    );
    const row = posture.rows[0];
    if (row === undefined) {
      violations.push(`role ${role} could not be inspected`);
      continue;
    }
    for (const flag of unsafeFlags(row)) {
      violations.push(`role ${role} is not a safe runtime identity: ${flag}`);
    }
  }
  return violations;
}

/** What each check looks for, so a test can prove that each of them can fire. */
export const CATALOG_CHECKS: readonly string[] = [
  ...CHECKS.map((check) => check.what),
  SYSTEM_BRANCH_CHECK,
  ...TECHNICAL_ROLE_CHECKS,
];
