/**
 * The database tests whose assertions are wall-clock time (a read that must end after about 3 seconds, a hub's read that must answer in milliseconds with 200,000 rows
 * in it, a budget plus the disposal bound). They need a machine to themselves and are the ones a loaded runner makes fail for a reason that is not the code's, so CI runs
 * them on a push to main, in the nightly run and in a manual run, **never on a pull request** (task CI.2, the Product Owner's decision of 7 November 2026): the job of
 * a pull request sets `MELARC_SKIP_TIMING_TESTS=1`, and `vitest.config.ts` leaves these files out of the `database-alone` project then. Everywhere else, the gate and a
 * developer's run included, the variable is not set and they run.
 *
 * The list is held to the files themselves (`src/database-test-isolation.test.ts`): a file in `test/database/alone/` whose first line says its bounds are wall-clock
 * time is in it, and nothing else is, so a new timing test cannot be left running on a pull request, and no file is left out of one for another reason.
 */
export const SKIP_TIMING_VARIABLE = 'MELARC_SKIP_TIMING_TESTS';

export const TIMING_SENSITIVE_TESTS: readonly string[] = [
  'test/database/alone/bootstrap-command.db.test.ts',
  'test/database/alone/credential-delivery-job.db.test.ts',
  'test/database/alone/execution-budget.db.test.ts',
  'test/database/alone/hub-filter-timing.db.test.ts',
  'test/database/alone/queue-summary-timeout.db.test.ts',
  'test/database/alone/record-lookup-timeout.db.test.ts',
  'test/database/alone/request-pipeline.db.test.ts',
  'test/database/alone/retention-cleanup.db.test.ts',
];

/** Whether this run leaves the timing-sensitive tests out: only when the variable is exactly `1`. */
export function skipsTimingTests(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[SKIP_TIMING_VARIABLE] === '1';
}
