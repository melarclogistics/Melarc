import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../auth/clock/system.clock.adapter.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { RETENTION_BATCH_SIZE } from '../delivery-parameters.js';
import { RetentionCleanup } from './retention-cleanup.js';

const clock = new SystemClock();

interface Rig {
  readonly cleanup: RetentionCleanup;
  readonly contexts: SecurityContext[];
  readonly statements: string[];
}

/**
 * A database whose transactions run the work against a fake that answers each statement with a count of rows (and, for the first, how
 * many of them were jobs a lease was still on), and fail as scripted.
 */
function rig(
  counts: readonly number[],
  failing: ReadonlySet<number> = new Set(),
  batchSize?: number,
  leased = 0,
): Rig {
  const contexts: SecurityContext[] = [];
  const statements: string[] = [];
  let call = 0;
  const database = {
    transactionWithContext: <T>(
      context: SecurityContext,
      work: (tx: {
        execute: (query: unknown) => Promise<{ rowCount: number; rows: { was_leased: boolean }[] }>;
      }) => Promise<T>,
    ): Promise<T> => {
      const mine = call;
      call += 1;
      contexts.push(context);
      if (failing.has(mine)) return Promise.reject(new Error(`step ${String(mine)} failed`));
      return work({
        execute: (query) => {
          statements.push(JSON.stringify(query));
          const rowCount = counts[mine] ?? 0;
          return Promise.resolve({
            rowCount,
            rows: Array.from({ length: rowCount }, (_, index) => ({ was_leased: index < leased })),
          });
        },
      });
    },
  };
  return {
    cleanup: new RetentionCleanup({
      database: database as never,
      clock,
      ...(batchSize === undefined ? {} : { batchSize }),
    }),
    contexts,
    statements,
  };
}

describe('the retention cleanup, apart from the database (S0.19)', () => {
  // Break caught: a cleanup run under another capability, another principal, or a context that is not a system one: it erases credential
  // material, and the grants it holds are those of one capability.
  it('runs each kind in a transaction of its own, as the delivery worker’s system context', async () => {
    const { cleanup, contexts } = rig([3, 4]);

    const report = await cleanup.runOnce();

    expect(report).toEqual({ jobsExpired: 3, replayErased: 4, leasesExpired: 0, more: false });
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context).toMatchObject({
        principalType: 'SYSTEM',
        surface: 'SYSTEM',
        taskCapability: 'credential_delivery',
        principalId: '64656c69-7665-4000-8000-000000000001',
      });
    }
    expect(contexts[0]?.correlationId).not.toBe(contexts[1]?.correlationId);
  });

  // Break caught: a failure of the first kind stopping the second (a stuck job sweep starving the erase of sealed replays, which hold
  // secrets), or being swallowed so that the worker never says anything is wrong.
  it('attempts both kinds when the first fails, and then raises the first failure', async () => {
    const { cleanup, contexts } = rig([0, 5], new Set([0]));

    await expect(cleanup.runOnce()).rejects.toThrow('step 0 failed');

    expect(contexts).toHaveLength(2);
  });

  it('raises the failure of the second kind too, when only it fails', async () => {
    const { cleanup, contexts } = rig([5, 0], new Set([1]));

    await expect(cleanup.runOnce()).rejects.toThrow('step 1 failed');

    expect(contexts).toHaveLength(2);
  });

  it('raises the first failure when both fail', async () => {
    const { cleanup } = rig([0, 0], new Set([0, 1]));

    await expect(cleanup.runOnce()).rejects.toThrow('step 0 failed');
  });

  // Break caught: a job whose lease ended with no outcome, which a crashed or stalled worker left, expired without anyone being told: it is
  // the third condition of the credential delivery alert (OBSERVABILITY_AND_RECOVERY.md §3), and the takeover that counts it never comes.
  it('counts the jobs it expired that a lease had ended on, apart from those that were only waiting', async () => {
    const { cleanup } = rig([5, 2], new Set(), undefined, 2);

    const report = await cleanup.runOnce();

    expect(report).toMatchObject({ jobsExpired: 5, leasesExpired: 2, replayErased: 2 });
  });

  // Break caught: `more` said when a batch was not full (a run that never ends) or not said when one was (a backlog left for a minute).
  it.each([
    [[0, 0], false],
    [[RETENTION_BATCH_SIZE - 1, RETENTION_BATCH_SIZE - 1], false],
    [[RETENTION_BATCH_SIZE, 0], true],
    [[0, RETENTION_BATCH_SIZE], true],
  ] as const)('says there is more when a batch of rows %j was full: %s', async (counts, more) => {
    const { cleanup } = rig(counts);

    expect((await cleanup.runOnce()).more).toBe(more);
  });

  // Break caught: a batch that is not a whole number of rows, which would mean an unbounded or an empty run.
  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses a batch of %s', (batch) => {
    expect(() => rig([], new Set(), batch)).toThrow(RangeError);
  });
});
