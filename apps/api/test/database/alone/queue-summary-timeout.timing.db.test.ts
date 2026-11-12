// Runs alone: its bounds (a read that must end after about 3 seconds, not the 4 of the lock wait) are wall-clock time.
// Functional half, which runs on a pull request: queue-summary-timeout.db.test.ts (the failed read made by a cancel, no duration asserted; run 5, Stage 1.2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API, HUB_A, startStaffRoutes, type StaffRoutes } from '../support/staff-routes.js';

/**
 * The bound on a count (`AC-QSUM-13`; the Product Owner's decision of 6 November 2026): every statement of `getQueueSummary` is bounded at
 * three seconds by a `SET LOCAL statement_timeout` in the transaction of its counts. The bound itself against a real PostgreSQL: a count that cannot finish
 * ends the read after three seconds and not after the pool's wait. **Only the bound is here** (run 5, Stage 1.2): that the read ends as the platform's failed read, with
 * its own words and nothing of the statement, and that the next read is whole, is `queue-summary-timeout.db.test.ts`, which a pull request runs.
 */
const SUMMARY = `${API}/ops/queue-summary`;

describe('the operation', () => {
  let routes: StaffRoutes;
  beforeAll(async () => {
    // The configured bounds nest as the configuration requires (lock wait inside statement time inside transaction time, 10 s): the lock wait
    // (4 s) is longer than the summary's own bound (3 s), so that what ends the read is the bound under test, and the pool's statement
    // timeout (6 s) is longer than both.
    routes = await startStaffRoutes({
      env: { DATABASE_STATEMENT_TIMEOUT_MS: '6000', DATABASE_LOCK_TIMEOUT_MS: '4000' },
    });
  }, 240_000);
  afterAll(async () => {
    await routes.stop();
  });

  // Break caught: a summary with no bound of its own, which would hold the connection until the pool's lock wait ends (4 s here), or answer 200 with a wrong count.
  it('ends a count that cannot finish after three seconds, and not after the four of the lock wait', async () => {
    const officer = await routes.opsStaff(HUB_A);
    // The pool's first connection and the session are warm, so that the time measured below is the wait and not the start.
    const first = await officer.client.get(SUMMARY);
    expect(first.status).toBe(200);

    // A lock on the table the counts read, held by another connection: the count waits for it, and the bound is what ends the wait.
    await routes.admin.query('begin');
    let blocked: Awaited<ReturnType<typeof officer.client.get>>;
    let elapsed: number;
    try {
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      const started = performance.now();
      blocked = await officer.client.get(SUMMARY);
      elapsed = performance.now() - started;
    } finally {
      await routes.admin.query('rollback');
    }

    expect(blocked.status).toBe(503);
    // Three seconds, and not the four of the lock wait that ends any other count.
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(3800);
  }, 60_000);
});
