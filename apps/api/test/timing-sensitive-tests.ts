/**
 * The database tests whose assertions are wall-clock time (a read that must end after about 3 seconds, a hub's read that must answer in milliseconds with 200,000 rows
 * in it, a budget plus the disposal bound). They need a machine to themselves and are the ones a loaded runner makes fail for a reason that is not the code's, so CI runs
 * them in the nightly run and in a manual run, **never on a pull request and never on a push to main** (task CI.2 and run 4, Stage 1, item 5; the Product Owner's decisions
 * of 7 November and of the review of 5edada2): the jobs of a pull request and of a push to main set `MELARC_SKIP_TIMING_TESTS=1`, and `vitest.config.ts` leaves these files
 * out of the `database-alone` project then. Everywhere else, the gate and a developer's run included, the variable is not set and they run.
 *
 * **Only the wall-clock assertions are in these files, and each has a functional half that a pull request runs** (run 5, Stage 1.2; run 4 had moved ten whole tests here and
 * these notes went on saying that a functional half stayed). The second line of each file names its half, and `src/database-test-isolation.test.ts` holds that the half
 * exists and is not in this list. The half is the same scenario with no duration asserted, and it does not depend on how fast the machine is:
 *
 * - **the clock is the test's:** a `ManualClock` is given to the `DatabaseService` (`execution-budget.db.test.ts`) or to the application through the `clock` port
 *   (`request-pipeline.db.test.ts`, the integration kit), so that a budget expires when the test says so, after the test has seen in the database that the work is where it
 *   means it to be (waiting for a lock, running a statement), or at a gate the test opens. A budget's timer still looks at that clock on real time, and the pipeline's grace
 *   timer is real, so the half waits for them but asserts nothing about how long;
 * - **or the failure is made, not waited for:** a statement held on a lock is cancelled from another connection (`pg_cancel_backend`), which the server reports as its statement
 *   timeout (SQLSTATE 57014), so the platform takes the same path (`queue-summary-timeout.db.test.ts`, `record-lookup-failure.db.test.ts`);
 * - **or the claim was never about speed** and the half asserts no time at all (`credential-delivery-job.db.test.ts`, `retention-cleanup.db.test.ts`,
 *   `record-lookup-slot.db.test.ts`, `hub-filters.db.test.ts`).
 *
 * What a half cannot show is how soon a wait ends, or that the database layer's own failure beats the pipeline's fallback: that is the bound, and it is here.
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
