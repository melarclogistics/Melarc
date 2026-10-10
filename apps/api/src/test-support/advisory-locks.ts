import type { SourceFile } from './platform-boundary.js';

/**
 * Checks of source text that keep the advisory-lock protocol honest (plan task S0.7; SECURITY_DESIGN.md §13.10a). Each takes
 * the source files as `{ path, text }` with paths relative to `src/`, and reports one line per breach. They read text, so they
 * hold against code that is written plainly: a function name built at run time is invisible to them.
 */

const isProduction = (file: SourceFile): boolean =>
  !file.path.endsWith('.test.ts') && !file.path.startsWith('test-support/');

/**
 * A command-line tool owns the one connection it locks on and ends with it, so the session-level functions are right there (the
 * migrator and the provisioning step serialise whole processes). No pooled connection is involved. That is the only exemption: a
 * tool takes no class of its own for a transaction-scoped lock, and no try-lock.
 */
const isTool = (file: SourceFile): boolean => file.path.startsWith('tools/');

/** Where an advisory lock may be taken: the policy toolkit, whose classes come from one module. */
const ADVISORY_CALLERS = ['platform/database/policy-lock/'];

/** Every advisory function that is not the transaction-scoped lock: the session-level lock and unlock functions. */
const SESSION_LEVEL = /\bpg_advisory_(?!xact_)[a-z_]+/g;
/** A try-lock returns false instead of waiting; in a loop with no bound it spins on the database. */
const TRY_LOCK = /\bpg_try_advisory_[a-z_]+/g;
const TRANSACTION_LOCK = /\bpg_advisory_xact_lock(?:_shared)?\b/g;

/** Comments are prose: a doc comment may name a function to explain why it is not used. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * In production code, advisory locks are the transaction-scoped functions only, and only in `platform/database/policy-lock/`:
 *
 * - the session-level functions (`pg_advisory_lock`, `pg_advisory_unlock`, ...) are refused everywhere but the command-line tools
 *   (see `isTool`): on a pooled connection they outlive the transaction and the request;
 * - `pg_try_advisory_*` is refused everywhere: no bounded use exists; one that does is added to the allow-list with its bound;
 * - `pg_advisory_xact_lock` and `pg_advisory_xact_lock_shared` are refused outside the toolkit, so every class is defined in
 *   `lock-keys.ts`, where a test asserts that no two share a value.
 */
export function findAdvisoryLockViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files.filter(isProduction)) {
    const text = withoutComments(file.text);
    for (const match of isTool(file) ? [] : text.matchAll(SESSION_LEVEL)) {
      violations.push(
        `${file.path} calls the session-level advisory function ${match[0]}; only the transaction-scoped functions are allowed, because a pooled connection would carry the lock past the transaction`,
      );
    }
    for (const match of text.matchAll(TRY_LOCK)) {
      violations.push(
        `${file.path} calls ${match[0]}; a try-lock returns instead of waiting and is refused in application code`,
      );
    }
    if (
      !ADVISORY_CALLERS.some((directory) => file.path.startsWith(directory)) &&
      TRANSACTION_LOCK.test(text)
    ) {
      violations.push(
        `${file.path} calls an advisory lock function; advisory locks live in platform/database/policy-lock/ and take a class from lock-keys.ts`,
      );
    }
    TRANSACTION_LOCK.lastIndex = 0;
  }
  return violations;
}
