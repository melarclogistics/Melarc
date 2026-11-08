import { beforeEach, onTestFailed } from 'vitest';

import {
  clearEveryWatch,
  describeFailures,
  everyWatchedFailure,
} from '../../../src/test-support/failure-evidence.js';

/**
 * Set up for every file of the database project (`vitest.config.ts`): a test that fails prints the evidence of each server error that a
 * client of the integration kit saw while it ran: the request id, the status, the code and the application's own sanitized lines for
 * that request (no credential, token, seed, cookie, bound value or stack: `src/test-support/failure-evidence.ts`). A `500` of a test
 * is then a failure with a reason, in whichever file it happens (the closeout of 22 October 2026, C03). A test that passes prints
 * nothing, however many server errors it provoked on purpose.
 */
beforeEach(() => {
  clearEveryWatch();
  onTestFailed(() => {
    const seen = everyWatchedFailure();
    if (seen.length > 0) console.error(describeFailures(seen));
  });
});
