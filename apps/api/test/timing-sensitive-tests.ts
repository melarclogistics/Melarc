/**
 * The database tests whose assertions are wall-clock time (a read that must end after about 3 seconds, a hub's read that must answer in milliseconds with 200,000 rows
 * in it, a budget plus the disposal bound). They need a machine to themselves and are the ones a loaded runner makes fail for a reason that is not the code's, so CI runs
 * them in the nightly run and in a manual run, **never on a pull request and never on a push to main** (task CI.2 and run 4, Stage 1, item 5; the Product Owner's decisions
 * of 7 November and of the review of 5edada2): the jobs of a pull request and of a push to main set `MELARC_SKIP_TIMING_TESTS=1`, and `vitest.config.ts` leaves these files
 * out of the `database-alone` project then. Everywhere else, the gate and a developer's run included, the variable is not set and they run.
 *
 * **Only the wall-clock assertions are in these files.** Everything else a file that once held one tested runs on every pull request: the tests that assert no time stayed
 * in the file they were in (`execution-budget.db.test.ts`, `request-pipeline.db.test.ts`, `credential-delivery-job.db.test.ts`, ...), and the test whose claim is the
 * refusal and not its speed has a half of its own that asserts no time (`test/database/record-lookup-slot.db.test.ts`). A test that holds both is in the file beside it
 * named `*.timing.db.test.ts`, where the time bound is asserted again (the functional half is the same scenario without the bound).
 *
 * The list is held to the files themselves (`src/database-test-isolation.test.ts`): a file in `test/database/alone/` whose first line says its bounds are wall-clock
 * time is in it, and nothing else is, so a new timing test cannot be left running on a pull request, and no file is left out of one for another reason.
 */
export const SKIP_TIMING_VARIABLE = 'MELARC_SKIP_TIMING_TESTS';

export const TIMING_SENSITIVE_TESTS: readonly string[] = [
  'test/database/alone/credential-delivery-job.timing.db.test.ts',
  'test/database/alone/execution-budget.timing.db.test.ts',
  'test/database/alone/hub-filter-timing.db.test.ts',
  'test/database/alone/queue-summary-timeout.timing.db.test.ts',
  'test/database/alone/record-lookup-timeout.db.test.ts',
  'test/database/alone/request-pipeline.timing.db.test.ts',
  'test/database/alone/retention-cleanup.timing.db.test.ts',
];

/** Whether this run leaves the timing-sensitive tests out: only when the variable is exactly `1`. */
export function skipsTimingTests(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[SKIP_TIMING_VARIABLE] === '1';
}
