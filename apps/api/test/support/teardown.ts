/**
 * Runs every step of a teardown, in order, even when one of them fails, and throws the first failure once the last step has run.
 *
 * A `beforeAll` that failed part-way leaves some of what it was opening unset, and a step that throws (a pool that cannot end, a process
 * that is already gone) must not be the reason the database, the processes or the other pools are left behind: an orphan database is a
 * cost to the next run, and a pool left open keeps the worker alive. A step may return nothing, for what was never opened.
 */
export async function closeAll(
  steps: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  const first = failures[0];
  if (first === undefined) return;
  throw first instanceof Error
    ? first
    : new Error(
        typeof first === 'string' ? first : 'a teardown step failed with a value that is no error',
      );
}
