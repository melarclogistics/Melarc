import pg from 'pg';

/**
 * The work-shape tracer (S0.10). A request that is answered the same way for a different reason must also have done the same
 * work: the five outwardly equivalent failure branches of sign-in are compared "in status, body and statement shape", so that what
 * the database was asked cannot tell an unknown email from a wrong password (SECURITY_DESIGN.md section 13.4c, timing and work).
 *
 * This records what one database login sent to the server while some work ran, and reduces each statement to its shape: values
 * (literals and parameters) removed, white space collapsed, case folded, so two runs that differ only in a value compare equal and
 * two that read another table or issue another statement do not. It observes the driver, so it sees what the real service sent
 * and not what the test believes it sent; it changes nothing the driver does. Test support, excluded from the build.
 */

/** The tracer was used wrongly. */
export class WorkShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkShapeError';
  }
}

/** A statement with its values taken out. Names, keywords and structure stay: they are the shape. */
export function normalizeStatement(text: string): string {
  return text
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether two traces did the same work, in the same order. */
export function sameShape(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((statement, at) => statement === right[at]);
}

interface Connected {
  readonly connectionParameters?: { readonly user?: string };
}

/** The part of the driver the recorder wraps: the `query` of a client, which the pool's clients share. */
export interface TraceableDriver {
  query: (this: Connected, ...query: unknown[]) => unknown;
}

let tracing = false;

function textOf(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query === 'object' && query !== null && 'text' in query) {
    const { text } = query;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

/**
 * Runs `work` and returns what it returned and the shapes of the statements sent by connections of `user` meanwhile, in order.
 * One trace at a time (two would restore the driver in the wrong order). The driver is put back when the work ends, whether it
 * returns or throws. `driver` is the object whose `query` is wrapped: the real client's prototype unless a test supplies another.
 */
export async function traceStatements<T>(
  user: string,
  work: () => Promise<T>,
  driver: TraceableDriver = pg.Client.prototype,
): Promise<{ readonly result: T; readonly statements: string[] }> {
  if (tracing) throw new WorkShapeError('A work-shape trace is already running: one at a time');
  tracing = true;
  const statements: string[] = [];
  const original = driver.query;
  driver.query = function (this: Connected, ...query: unknown[]): unknown {
    if (this.connectionParameters?.user === user) {
      const text = textOf(query[0]);
      if (text !== undefined) statements.push(normalizeStatement(text));
    }
    return original.apply(this, query);
  };
  try {
    const result = await work();
    return { result, statements };
  } finally {
    driver.query = original;
    tracing = false;
  }
}
