/**
 * Engineering parameters of the execution budget that are not settings (S0.6). They are **development-qualified, not
 * production-qualified** (plan section 3, "Engineering parameters"): chosen here at the first consumer, recorded with the
 * environment they were exercised in (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.6 applied and where it was exercised") and
 * the tests that exercise them, and proposed again for release by S0.65 (benchmark and capacity). They are constants and not
 * environment variables because no deployment has a reason to change one independently of the budget it serves; if S0.65 finds
 * one must be tuned per environment, it becomes a setting then, through `config-settings.ts`.
 */

/**
 * The longest the clean-up after an expiry may take: asking the server to cancel the running statement, and rolling the
 * transaction back. When it has passed the connection is destroyed whether or not either was confirmed, so a caller is told its
 * request failed at most this long after the budget ran out.
 *
 * The same figure is the margin the server's own transaction bound (`transaction_timeout`) is set past the budget, and the bound
 * on the connection that makes the cancel. So the server ends a transaction by itself only when this process could not clean up
 * within this time, and a cancel that cannot connect is given up on at the same moment the clean-up is.
 *
 * Exercised by `test/database/execution-budget.db.test.ts` (a cancel and rollback on a local PostgreSQL complete in tens of
 * milliseconds, so two seconds is generous there) and by `database-deadlines.test.ts` (the bound itself, with the cancel failing
 * and the rollback hanging). A deployment across a network is the case the margin is for: S0.65 proposes the release value.
 */
export const DISPOSAL_BOUND_MS = 2_000;
