import type { SourceFile } from './platform-boundary.js';

/**
 * Checks of source text that keep the database's door narrow (SECURITY_DESIGN.md §14.1; plan task S0.4). Each takes the
 * source files as `{ path, text }` with paths relative to `src/`, and reports one line per breach. They read text, so
 * they hold against code that is written plainly and say so: a value built at run time is invisible to them, and what
 * stops a label from being asserted by code that already runs as the API is the grant set, not this.
 */

const isProduction = (file: SourceFile): boolean =>
  !file.path.endsWith('.test.ts') && !file.path.startsWith('test-support/');

/** `taskCapability: '<literal>'`, in a string, a double-quoted string or a template with no substitution. */
const CAPABILITY_LITERAL = /\btaskCapability\s*:\s*(['"`])([^'"`\n]*)\1/g;

/**
 * A context under a SYSTEM capability is opened only where the access matrix says (registry §5.2, "opened only by").
 * Every production `taskCapability: '<name>'` must be in a file under one of the directories listed for that capability,
 * and must name a capability of the closed list.
 */
export function findCapabilityOpenerViolations(
  files: readonly SourceFile[],
  access: Readonly<Record<string, { readonly openedUnder: readonly string[] }>>,
): string[] {
  const violations: string[] = [];
  for (const file of files.filter(isProduction)) {
    for (const match of file.text.matchAll(CAPABILITY_LITERAL)) {
      const name = match[2] ?? '';
      const entry = Object.hasOwn(access, name) ? access[name] : undefined;
      if (entry === undefined) {
        violations.push(
          `${file.path} opens the capability '${name}', which is not in the closed list`,
        );
      } else if (!entry.openedUnder.some((directory) => file.path.startsWith(directory))) {
        violations.push(
          `${file.path} opens the capability '${name}', which the access matrix allows only under ${entry.openedUnder.join(', ')}`,
        );
      }
    }
  }
  return violations;
}

const SCOPE_PROBE_SETTING = /(['"])(?:melarc\.)?scope_probe_id\1/g;
const SCOPE_PROBE_FILE = 'platform/database/scope-probe.ts';

/**
 * `melarc.scope_probe_id` is set by `existingRecordHub` and by nothing else (§14.1b). The name, quoted, appears in no
 * production file but the one that holds that function.
 */
export function findScopeProbeWriterViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files.filter(isProduction)) {
    if (file.path === SCOPE_PROBE_FILE) continue;
    for (const match of file.text.matchAll(SCOPE_PROBE_SETTING)) {
      violations.push(
        `${file.path} names the setting '${match[0].slice(1, -1)}'; only ${SCOPE_PROBE_FILE} may write it`,
      );
    }
  }
  return violations;
}

const DRIVER_OR_POOL =
  /(?:\bfrom\s*|\bimport\s*\(\s*)['"](?:pg|drizzle-orm\/node-postgres(?:\/[a-z-]+)?)['"]|\bDATABASE_POOL\b/;

/**
 * The pool and the driver stay behind `DatabaseService`: the context-free `db` handle and `transaction()` are closed, so
 * every protected query runs under a validated context (S0.4c). A production file outside `platform/database/` and the
 * command-line tools that imports `pg` or `drizzle-orm/node-postgres`, or injects `DATABASE_POOL`, is a second door.
 */
export function findDatabaseDoorViolations(files: readonly SourceFile[]): string[] {
  const allowed = (file: SourceFile): boolean =>
    !isProduction(file) ||
    file.path.startsWith('platform/database/') ||
    file.path.startsWith('tools/') ||
    file.path === 'platform/platform.tokens.ts';
  return files
    .filter((file) => !allowed(file) && DRIVER_OR_POOL.test(file.text))
    .map(
      (file) =>
        `${file.path} reaches PostgreSQL other than through DatabaseService (pg, drizzle-orm/node-postgres or DATABASE_POOL)`,
    );
}

const HANDLE_BINDER = /\bbindTransactionHandle\b/;

/**
 * The files that may make a `TransactionHandle`: the binder itself, the unit of work, the coordinator of policy-locked operations
 * (it opens the transaction its steps run in, so it hands them the handle), and the limiter's own short transaction.
 */
export const HANDLE_BINDER_FILES: readonly string[] = [
  'platform/database/transaction-handle.ts',
  'platform/database/postgres.unit-of-work.adapter.ts',
  'platform/database/policy-lock/coordinate.ts',
  'platform/limiter/postgres.rate-limiter.adapter.ts',
];

/**
 * Only the unit of work makes the handle that port operations take (S0.1: "only the unit-of-work adapter can make one"; plan
 * obligation OB-99). A handle stands for a transaction under the context the database service applied; an adapter that bound its
 * own would be a second door into a transaction it did not open. A production file that names `bindTransactionHandle` outside the
 * listed files is a breach. (The limiter binds one inside its own short transaction, to read the limit of a bucket through the
 * settings reader, and no other adapter does.)
 */
export function findHandleBinderViolations(
  files: readonly SourceFile[],
  allowed: readonly string[] = HANDLE_BINDER_FILES,
): string[] {
  return files
    .filter(
      (file) => isProduction(file) && !allowed.includes(file.path) && HANDLE_BINDER.test(file.text),
    )
    .map(
      (file) =>
        `${file.path} makes a transaction handle; only ${allowed.join(', ')} may (bindTransactionHandle)`,
    );
}
