import pg from 'pg';

import { BudgetClosedError } from '../execution/execution-budget.js';

/**
 * How the database layer names what went wrong with a transaction's time (S0.6; SECURITY_DESIGN.md §14.6), so no caller has to
 * recognise a SQLSTATE and so a lost commit is never described as a failure that rolled back.
 */

export type DeadlineKind = 'lock' | 'statement' | 'idle-in-transaction' | 'transaction';

/** The SQLSTATEs PostgreSQL raises when one of its own time bounds ends the work. */
const KIND_BY_SQLSTATE: Readonly<Record<string, DeadlineKind>> = Object.freeze({
  '55P03': 'lock', // lock_not_available: lock_timeout
  '57014': 'statement', // query_canceled: statement_timeout (or a cancel from outside)
  '25P03': 'idle-in-transaction', // idle_in_transaction_session_timeout
  '25P04': 'transaction', // transaction_timeout
});

/** The database ended the work because one of its own time bounds ran out. The cause is the server's error. */
export class DatabaseDeadlineError extends Error {
  constructor(
    readonly kind: DeadlineKind,
    readonly code: string,
    options: { readonly cause: unknown },
  ) {
    super(`The database ended the work: its ${kind} time ran out`, options);
    this.name = 'DatabaseDeadlineError';
  }
}

/**
 * The connection ended, or the budget ran out, while COMMIT was in flight, or the server's answer to COMMIT was not one that says
 * what happened. Whether the transaction committed is **not known**: the server may have committed before the connection ended,
 * and nothing on this side can tell. The caller must not treat it as a failure that rolled back, and must not retry it unless
 * repeating it is safe whichever happened.
 */
export class CommitOutcomeUnknownError extends Error {
  constructor(
    readonly reason: 'budget-expired' | 'connection-lost' | 'unrecognized-completion',
    options: { readonly cause: unknown },
  ) {
    super(
      reason === 'unrecognized-completion'
        ? 'The transaction may or may not have committed: the server answered the commit with something that does not say which. Do not assume it failed, and repeat it only if repeating it is safe whichever happened.'
        : 'The transaction may or may not have committed: the commit was in flight when the connection ended, and nothing here can tell which. Do not assume it failed, and repeat it only if repeating it is safe whichever happened.',
      options,
    );
    this.name = 'CommitOutcomeUnknownError';
  }
}

/**
 * The server completed COMMIT with the command tag ROLLBACK: the transaction had failed (a statement in it was refused and the
 * work went on), so the server rolled it back and kept nothing. This is a **definite** failure, the opposite of
 * {@link CommitOutcomeUnknownError}: it is known that nothing was committed. The cause is the first statement failure the
 * service saw in the transaction, when it saw one. It reaches the platform as any other unexpected failure does.
 */
export class TransactionRolledBackError extends Error {
  constructor(options: ErrorOptions = {}) {
    super(
      'The transaction was rolled back by the server when it was asked to commit: a statement in it had failed and the work went on. Nothing it did was kept.',
      options,
    );
    this.name = 'TransactionRolledBackError';
  }
}

/**
 * The command tag a statement was completed with (COMMIT, ROLLBACK, SELECT...), as node-postgres reports it in `result.command`
 * for a single statement; `undefined` for anything that is not such a result (no result, a list of results, a result with no tag
 * or an empty one). A caller that needs a particular tag treats `undefined` as not having it.
 */
export function commandTagOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const { command } = result as { command?: unknown };
  return typeof command === 'string' && command !== '' ? command : undefined;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The server's error inside what was thrown. drizzle wraps a driver error and keeps it as the cause. */
export function serverErrorIn(error: unknown): pg.DatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof pg.DatabaseError) return current;
    current = current.cause;
  }
  return undefined;
}

/**
 * The refusal of a finished request inside what was thrown: drizzle wraps whatever the connection object rejected a statement
 * with, so the caller is given the refusal itself and not the failed query that carries it.
 */
export function closedIn(error: unknown): BudgetClosedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof BudgetClosedError) return current;
    current = current.cause;
  }
  return undefined;
}

/** The deadline error for a server error that is one of the time bounds, or `undefined`. */
export function deadlineFrom(
  error: unknown,
  thrown: unknown = error,
): DatabaseDeadlineError | undefined {
  if (thrown instanceof DatabaseDeadlineError) return thrown;
  const server = serverErrorIn(error);
  const code = server?.code;
  const kind = code === undefined ? undefined : KIND_BY_SQLSTATE[code];
  if (code === undefined || kind === undefined) return undefined;
  return new DatabaseDeadlineError(kind, code, { cause: thrown });
}

/**
 * True when the server answered a failed COMMIT with an error: the transaction did not commit (it was rolled back by the
 * server). A FATAL or PANIC error, or no answer at all, is not that: the session went away, and what happened to the commit
 * is unknown.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  const server = serverErrorIn(error);
  return server !== undefined && server.severity !== 'FATAL' && server.severity !== 'PANIC';
}
