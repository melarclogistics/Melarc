import { PROVISIONING_ROLE } from './technical-roles.js';

/**
 * What a runtime login may not be or hold (SECURITY_DESIGN.md §14.6, "What the API's posture check inspects"), asked of
 * the catalogue. One query serves the readiness check of the connected login (`DatabaseService.check`) and the catalogue
 * check of the named logins (`catalog-invariants.ts`), so the two cannot come to disagree about what is unsafe.
 *
 * A flag is a fact that makes row-level security bypassable or removable by the login, or makes the context it reads not
 * the application's to decide:
 *
 * - the attributes `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` and `rolreplication`;
 * - membership of a predefined `pg_*` role (`has_predefined_role`), or of any role that has an attribute above or can log
 *   in (`member_of_unsafe_role`); a grant-set role such as a worker capability is neither;
 * - a `melarc.*` setting stored on the role or the database (`has_stored_context`), which would be a context no
 *   transaction set;
 * - owning the database, an object (table, view, sequence, index), a schema or a function, directly or through
 *   membership (`owns_database`, `owns_objects`, `owns_schema`, `owns_function`): an owner can alter or drop a policy or
 *   replace an accessor;
 * - `CREATE` on the database or on any schema, however granted (`can_create_in_database`, `can_create_in_schema`): what
 *   it creates, it would own;
 * - `EXECUTE` on a `SECURITY DEFINER` function that an approved migration did not grant it (`can_execute_definer`): such
 *   a function runs with its owner's powers. `APPROVED_DEFINER_EXECUTE` lists the grants a reviewed migration made, per
 *   role, as `schema.function`; adding to it is a reviewed change.
 *
 * A privilege counts when the login holds it, when it inherits it, **and when it can acquire it by becoming a role it is a
 * member of**. A membership granted `WITH INHERIT FALSE, SET TRUE` gives the member none of the role's privileges as they
 * stand (`has_schema_privilege(login, ...)` is false) and lets it `SET ROLE` to the role and have all of them. So the three
 * privilege flags above, like the ownership flags, are asked of every role the login is a member of, directly or through
 * others (`pg_has_role(login, role, 'MEMBER')`, which is true whatever the INHERIT and SET options): a grant-set role that holds
 * no such privilege (the worker's capability role) is not a finding however the membership is granted, and one that holds
 * any of them is, however the membership is granted. This is deliberately wider than what a login can reach today: a
 * membership with neither option reaches nothing yet, and is refused all the same, because a later `GRANT ... SET` would
 * silently change that.
 *
 * The query returns booleans, and a flag that is not exactly `false` is unsafe: an inspection that did not say is not a
 * clean bill.
 */
export const POSTURE_FLAGS = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
  'has_predefined_role',
  'member_of_unsafe_role',
  'has_stored_context',
  'owns_database',
  'owns_objects',
  'owns_schema',
  'owns_function',
  'can_create_in_database',
  'can_create_in_schema',
  'can_execute_definer',
] as const;

export type PostureFlag = (typeof POSTURE_FLAGS)[number];

/**
 * The `SECURITY DEFINER` functions each role may execute, as `schema.function`, because a reviewed migration granted it. Today that
 * is the provisioning login and the two seed functions of migration 0005 (the initialization of the reference data, once, and the
 * test-only reason fixtures): they are the only way that login writes the reference tables, and it holds no privilege on the tables.
 * The API runtime and the workers are on no line, so EXECUTE on either function, or on any other definer, is a finding for them.
 */
export const APPROVED_DEFINER_EXECUTE: Readonly<Record<string, readonly string[]>> = {
  [PROVISIONING_ROLE]: ['melarc.initialize_reference_data', 'melarc.add_reason_fixtures'],
};

/** Schemas that are the server's own and not ours to inspect. */
const OUR_SCHEMA = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;

/**
 * `$1` is the role's name, or null for the connected login; `$2` is `APPROVED_DEFINER_EXECUTE` as JSON. Owning includes
 * owning through membership: a role that is a member of the owner has the owner's powers (it can alter or drop a table's
 * policies), so `pg_has_role(.., 'MEMBER')` is used, which is true for the role itself and for any role it belongs to,
 * directly or indirectly.
 */
export const ROLE_POSTURE_SQL = `
  SELECT r.rolname AS role,
         r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
         EXISTS (SELECT 1 FROM pg_roles p
                  WHERE p.rolname LIKE 'pg\\_%' AND p.rolname <> 'pg_database_owner'
                    AND pg_has_role(r.oid, p.oid, 'MEMBER')) AS has_predefined_role,
         EXISTS (SELECT 1 FROM pg_roles m
                  WHERE m.oid <> r.oid AND m.rolname NOT LIKE 'pg\\_%'
                    AND pg_has_role(r.oid, m.oid, 'MEMBER')
                    AND (m.rolsuper OR m.rolbypassrls OR m.rolcreatedb OR m.rolcreaterole
                         OR m.rolreplication OR m.rolcanlogin)) AS member_of_unsafe_role,
         EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) AS setting
                  WHERE s.setrole IN (r.oid, 0)
                    AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                    AND setting LIKE 'melarc.%') AS has_stored_context,
         EXISTS (SELECT 1 FROM pg_database d
                  WHERE d.datname = current_database()
                    AND pg_has_role(r.oid, d.datdba, 'MEMBER')) AS owns_database,
         EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE pg_has_role(r.oid, c.relowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_objects,
         EXISTS (SELECT 1 FROM pg_namespace n
                  WHERE pg_has_role(r.oid, n.nspowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_schema,
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE pg_has_role(r.oid, p.proowner, 'MEMBER') AND ${OUR_SCHEMA}) AS owns_function,
         EXISTS (SELECT 1 FROM pg_roles x
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER')
                    AND has_database_privilege(x.oid, current_database(), 'CREATE')) AS can_create_in_database,
         EXISTS (SELECT 1 FROM pg_roles x CROSS JOIN pg_namespace n
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER') AND ${OUR_SCHEMA}
                    AND has_schema_privilege(x.oid, n.oid, 'CREATE')) AS can_create_in_schema,
         EXISTS (SELECT 1 FROM pg_roles x CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE pg_has_role(r.oid, x.oid, 'MEMBER') AND p.prosecdef AND ${OUR_SCHEMA}
                    AND has_function_privilege(x.oid, p.oid, 'EXECUTE')
                    AND (n.nspname || '.' || p.proname) NOT IN
                        (SELECT jsonb_array_elements_text(coalesce($2::jsonb -> x.rolname, '[]'::jsonb)))) AS can_execute_definer
    FROM pg_roles r
   WHERE r.rolname = coalesce($1::text, current_user)`;

/** The values of the two parameters of {@link ROLE_POSTURE_SQL} for a role, or for the connected login when it is null. */
export const rolePostureParameters = (role: string | null): [string | null, string] => [
  role,
  JSON.stringify(APPROVED_DEFINER_EXECUTE),
];

/** The flags that make the role unsafe, in the order of {@link POSTURE_FLAGS}. */
export function unsafeFlags(posture: Readonly<Record<string, unknown>>): PostureFlag[] {
  return POSTURE_FLAGS.filter((flag) => posture[flag] !== false);
}
