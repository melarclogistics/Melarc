import type pg from 'pg';

import { CAPABILITY_ACCESS, type Statement } from '../platform/database/capability-access.js';
import { API_RUNTIME_ROLE } from '../platform/config/load-config.js';
import { PROVISIONING_ROLE, WORKER_RUNTIME_ROLE } from '../platform/database/technical-roles.js';
import { snakeCaseOf, type RegistryRow } from './data-scope-registry.js';

/**
 * The grants of the technical logins against the data scope registry (S0.8; security test matrix Family S and Family K): every
 * table in the database is classified in the registry, and no technical login holds a privilege on one that the registry does
 * not give its identity. It reads the migrated database (`has_table_privilege`, which counts what a login inherits) and the
 * registry; it is test support, and a catalogue check that needed `contracts/` at run time would not run where the API does.
 *
 * What a login may hold on a table is the union of two statements of the registry: the table's *Read identity* and *Write
 * identity* columns (section 4), and the statements the capabilities of that login's identity list for the table (section 5.2, in
 * `capability-access.ts`). Holding less is always allowed: grants arrive with the first operation that writes a table, so a
 * table that only a seed writes is read-only for the API until then.
 */

type Privilege = Statement;
const PRIVILEGES: readonly Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
/**
 * What no row of the registry gives any technical login, on any table: to empty it, to refer to it (a reference takes a key-share
 * lock on the rows it points at), to put a trigger on it, or to lock it in any mode and vacuum or reindex it (`MAINTAIN`,
 * PostgreSQL 17 on). A login holding one of them holds it against every table, the later ones too.
 */
const NEVER_GRANTED = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;

interface Login {
  readonly role: string;
  /** The registry's identity tokens this login may appear as in a "Read identity" or "Write identity" cell. */
  readonly tokens: readonly string[];
  /** The identity of `capability-access.ts` whose capabilities this login may use. */
  readonly identity: 'api' | 'worker' | 'provisioning';
}

export const LOGINS: readonly Login[] = [
  { role: API_RUNTIME_ROLE, tokens: ['api'], identity: 'api' },
  // The base worker holds no protected business table: the capability roles (`worker:<task>`) are grant sets of their own.
  { role: WORKER_RUNTIME_ROLE, tokens: ['worker'], identity: 'worker' },
  { role: PROVISIONING_ROLE, tokens: ['seed', 'bootstrap'], identity: 'provisioning' },
];

/**
 * The tables only a seed writes, until a slice builds an operation that writes them (MIGRATION_AND_SEEDING.md §5.1: "grants arrive
 * with the first operation that writes the table"). The registry's "Write identity" says who will hold DML once such an operation
 * exists; until then the API and the workers read these tables and nothing more. The provisioning login holds **nothing** on them:
 * a seed writes them through the two functions of migration 0005 (`melarc.initialize_reference_data`, once, and
 * `melarc.add_reason_fixtures`), which run as the table owner, so a login that asserts the seed label has no privilege to assert it
 * against (correction F02). The slice that builds the first operation writing a table removes it from this list in the same change.
 *
 * The three policy tables stay on it even then: SECURITY_DESIGN.md §13.10a keeps the runtime at `SELECT` for good, because a
 * row lock needs `UPDATE`; the registry's "Write identity" column for `RoleBundle` and `RoleBundleGrant` lists `api`, which
 * that section contradicts (a finding for the Product Owner in the S0.8 handoff).
 */
export const SEED_ONLY_TABLES: ReadonlySet<string> = new Set([
  'Hub',
  'Setting',
  'ReasonCode',
  'Permission',
  'RoleBundle',
  'RoleBundleGrant',
  'FixedPermissionPolicy',
]);

/** The privileges `login` may hold on `row`'s table. */
export function allowedPrivileges(login: Login, row: RegistryRow): Set<Privilege> {
  const allowed = new Set<Privilege>();
  const reads = login.tokens.some(
    (token) => row.readIdentities.includes(token) || row.writeIdentities.includes(token),
  );
  const writes = login.tokens.some((token) => row.writeIdentities.includes(token));
  if (reads) allowed.add('SELECT');
  if (writes)
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE'] as const) allowed.add(privilege);
  for (const capability of Object.values(CAPABILITY_ACCESS)) {
    if (capability.identity !== login.identity) continue;
    for (const access of capability.tables) {
      if (access.table !== row.table) continue;
      for (const statement of access.statements) allowed.add(statement);
    }
  }
  if (SEED_ONLY_TABLES.has(row.table)) {
    const ceiling: readonly Privilege[] = login.identity === 'provisioning' ? [] : ['SELECT'];
    for (const privilege of allowed) if (!ceiling.includes(privilege)) allowed.delete(privilege);
  }
  return allowed;
}

/** What is wrong with the grants and the classification, one line each; empty when the registry and the database agree. */
export async function registryGrantViolations(
  client: Pick<pg.Client, 'query'>,
  registry: readonly RegistryRow[],
  technicalInventory: readonly string[],
): Promise<string[]> {
  const classified = new Map(registry.map((row) => [snakeCaseOf(row.table), row]));
  const technical = new Set(technicalInventory.map(snakeCaseOf));
  const violations: string[] = [];

  const { rows: tables } = await client.query<{ name: string }>(
    `select c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = 'public'
      order by c.relname`,
  );
  for (const { name } of tables) {
    const row = classified.get(name);
    if (row === undefined) {
      violations.push(
        `table ${name} is not classified in data-scope-registry.md section 4${technical.has(name) ? ' (it is in the technical inventory of section 6, which needs its row in section 4 too)' : ''}`,
      );
      continue;
    }
    for (const login of LOGINS) {
      const allowed = allowedPrivileges(login, row);
      for (const privilege of [...PRIVILEGES, ...NEVER_GRANTED]) {
        const held = await client.query<{ held: boolean }>(
          `select has_table_privilege($1, format('public.%I', $2::text), $3)
               or (case when $3 in ('INSERT', 'UPDATE', 'SELECT', 'REFERENCES')
                        then has_any_column_privilege($1, format('public.%I', $2::text), $3)
                        else false end) as held`,
          [login.role, name, privilege],
        );
        if (held.rows[0]?.held === true && !(allowed as Set<string>).has(privilege)) {
          violations.push(
            `${login.role} holds ${privilege} on ${name}, which the registry does not give it (read: ${row.readIdentities.join(' ')}; write: ${row.writeIdentities.join(' ')})`,
          );
        }
      }
    }
  }
  return violations;
}
