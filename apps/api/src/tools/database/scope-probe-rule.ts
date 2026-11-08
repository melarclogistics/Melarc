/**
 * Where the scope-probe predicate may appear in a policy (SECURITY_DESIGN.md §14.4b). The predicate
 * `id = melarc.scope_probe_id()` lets a staff context read one record of another hub for the one statement of the probe.
 * That is a read, and a policy decides more than reads: the clause of a policy for UPDATE is the old-row test of every
 * UPDATE, the clause of a policy for DELETE is the test of every DELETE, and a policy for ALL is both, so the predicate
 * in any of them would let the staff change or remove the record it was only to be told exists. PostgreSQL ORs the
 * permissive policies that apply to a command, so a second policy FOR SELECT that holds the predicate widens a read and
 * no other command, and the ordinary policy keeps judging the rest.
 *
 * The migration lint applies this to the policy a migration creates, and the catalogue check to the policies of the
 * migrated database, by the command they are for.
 */

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';

/** A string literal is data, not the predicate. */
const withoutStrings = (expression: string): string =>
  expression.replaceAll(/'(?:[^']|'')*'/g, "''");

/**
 * What is wrong with a policy's use of the scope probe, or undefined. `command` is the command the policy is for, or
 * undefined when it is not known (an `ALTER POLICY` does not say), which is not read as SELECT.
 */
export function scopeProbePolicyProblem(
  command: PolicyCommand | undefined,
  expressions: readonly (string | null)[],
): string | undefined {
  const mentionsProbe = expressions.some(
    (expression) =>
      expression !== null && /\bmelarc\.scope_probe_id\b/i.test(withoutStrings(expression)),
  );
  if (!mentionsProbe || command === 'select') return undefined;
  return 'the scope probe predicate (melarc.scope_probe_id()) belongs in a policy FOR SELECT only: in a policy for UPDATE, DELETE, INSERT or ALL, or whose command is not shown, it would let a record be changed or removed that was only to be read';
}
