import type pg from 'pg';

import { OWNER_ROLE } from './provisioning.js';

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
 * what a policy decides.
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
  return violations;
}

/** What each check looks for, so a test can prove that each of them can fire. */
export const CATALOG_CHECKS: readonly string[] = CHECKS.map((check) => check.what);
