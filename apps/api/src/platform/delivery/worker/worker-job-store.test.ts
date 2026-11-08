import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../auth/clock/system.clock.adapter.js';
import type { LeasedJob, RecordedOutcome } from '../../auth/ports/delivery-queue.port.js';
import { WorkerJobStore } from './worker-job-store.js';

/**
 * What the worker's store sends, read as text: the statements that record an outcome decide things on the database's clock, and a
 * decision that reads that clock twice can disagree with itself (the first reading before a moment, the second after it). The
 * behaviour is shown against a real database in `credential-delivery-job.db.test.ts`; what only the text can show is how many times a
 * statement reads the clock for one decision.
 */

const clock = new SystemClock();
const dialect = new PgDialect();

const LEASED: LeasedJob = {
  job: {
    id: '019a0000-0000-7000-8000-0000000000aa',
    providerDedupeId: 'b6c1f0a2-3d4e-4f5a-8b9c-0d1e2f3a4b5c',
  },
  leaseVersion: 1,
  attempt: 1,
  deferrals: 0,
  kind: 'SETUP_GRANT',
  channel: 'EMAIL',
};

/** The text of the one statement an outcome sends, with the database answering that the job moved to `answer`. */
async function statementFor(
  outcome: RecordedOutcome,
  answer = { state: 'CANCELLED', outcome_class: 'CANCELLED' },
): Promise<string> {
  const sent: string[] = [];
  const store = new WorkerJobStore({
    database: {
      transactionWithContext: <T>(
        _context: unknown,
        work: (tx: { execute: (query: never) => Promise<{ rows: unknown[] }> }) => Promise<T>,
      ): Promise<T> =>
        work({
          execute: (query) => {
            sent.push(dialect.sqlToQuery(query).sql);
            return Promise.resolve({ rows: [answer] });
          },
        }),
    } as never,
    cipher: { open: () => Promise.reject(new Error('not used')) },
    clock,
  });
  await store.recordOutcome(LEASED, outcome);
  expect(sent).toHaveLength(1);
  return sent[0] ?? '';
}

describe('the statements the worker’s store sends (S0.17)', () => {
  // Break caught: a job whose record has ended being marked by two readings of the clock, one on each side of the moment it ended: the
  // state says cancelled and the class says expired, the table refuses the pair, and the outcome is not recorded.
  it('decides whether the credential has ended from one reading of the clock, for the state and the class together', async () => {
    const text = await statementFor({ outcome: 'REDEMPTION_CLOSED' });

    expect(text.match(/expires_at\s*<=\s*clock_timestamp\(\)/g) ?? []).toHaveLength(1);
    // And the one reading is where both the state and the class take it from.
    expect(text).toMatch(/with\s+target\s+as/i);
  });

  // Break caught: the schedule's decision made from one reading for the end and another for the wait that is outside the one
  // statement, which would leave a gap in which the credential ends.
  it('records an outcome that waits or ends in one statement', async () => {
    for (const outcome of [
      { outcome: 'UNKNOWN' },
      { outcome: 'REDEMPTION_UNCONFIRMED' },
      { outcome: 'SCHEDULE_EXHAUSTED' },
    ] as const) {
      const text = await statementFor(outcome, { state: 'RETRYABLE', outcome_class: 'UNKNOWN' });
      expect(text, outcome.outcome).toMatch(/with\s+target\s+as/i);
      expect(text, outcome.outcome).toMatch(/lease_version\s*=/);
    }
  });
});
