import { describe, expect, it } from 'vitest';

import type { TransactionHandle, UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { commitThenRefuse } from './commit-then-refuse.js';

const CONTEXT: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '66666666-6666-4666-8666-666666666666',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'request-1',
};
const HANDLE = Object.freeze({}) as TransactionHandle;

class Refusal extends Error {}

/** A unit of work that records what happens to it, in order: the work, then the commit, or the rollback. */
function recordingUnitOfWork(options: { failCommit?: Error } = {}): {
  unitOfWork: Pick<UnitOfWork, 'run'>;
  log: string[];
} {
  const log: string[] = [];
  return {
    log,
    unitOfWork: {
      run: async <T>(
        context: SecurityContext,
        work: (transaction: TransactionHandle) => Promise<T>,
      ): Promise<T> => {
        log.push(`open ${context.taskCapability ?? 'none'}`);
        try {
          const result = await work(HANDLE);
          if (options.failCommit !== undefined) throw options.failCommit;
          log.push('commit');
          return result;
        } catch (error) {
          log.push('rollback');
          throw error;
        }
      },
    },
  };
}

describe('bookkeeping that survives a refusal (audit.md §2.1; §5.4)', () => {
  // Break caught: the refusal thrown from inside the work, which would roll the bookkeeping back with it.
  it('commits the work first and only then raises the refusal, outside the transaction', async () => {
    const { unitOfWork, log } = recordingUnitOfWork();
    const refusal = new Refusal('wrong password');

    const outcome = commitThenRefuse(unitOfWork, CONTEXT, () => {
      log.push('bookkeeping');
      return Promise.resolve(refusal);
    }).catch((error: unknown) => {
      log.push('refused');
      return error;
    });

    expect(await outcome).toBe(refusal);
    expect(log).toEqual(['open authentication', 'bookkeeping', 'commit', 'refused']);
  });

  // Break caught: the work given the same handle the transaction was opened with, so that the bookkeeping is in that transaction.
  it('gives the work the transaction it ran in', async () => {
    const { unitOfWork } = recordingUnitOfWork();
    let given: TransactionHandle | undefined;

    await commitThenRefuse(unitOfWork, CONTEXT, (transaction) => {
      given = transaction;
      return Promise.resolve(new Refusal('x'));
    }).catch(() => undefined);

    expect(given).toBe(HANDLE);
  });

  // Break caught: a failed bookkeeping hiding behind the refusal, so that a lost counter would look like an ordinary wrong password.
  it('raises the failure of the work, not the refusal, when the bookkeeping fails', async () => {
    const { unitOfWork, log } = recordingUnitOfWork();
    const failure = new Error('the counter could not be written');

    const caught = await commitThenRefuse(unitOfWork, CONTEXT, () => Promise.reject(failure)).catch(
      (error: unknown) => error,
    );

    expect(caught).toBe(failure);
    expect(log).toEqual(['open authentication', 'rollback']);
  });

  // Break caught: a commit that failed being answered as the refusal, which is a lie about what the server holds.
  it('raises the failure of the commit, not the refusal, when the commit fails', async () => {
    const failure = new Error('commit failed');
    const { unitOfWork } = recordingUnitOfWork({ failCommit: failure });

    const caught = await commitThenRefuse(unitOfWork, CONTEXT, () =>
      Promise.resolve(new Refusal('x')),
    ).catch((error: unknown) => error);

    expect(caught).toBe(failure);
  });

  // Break caught: the work returning something that is not an error being thrown as if it were one, or silently dropped.
  it('refuses work that does not give back an error to raise', async () => {
    const { unitOfWork } = recordingUnitOfWork();

    const caught = await commitThenRefuse(unitOfWork, CONTEXT, (() =>
      Promise.resolve('ok')) as never).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TypeError);
  });

  // Break caught: the function ever resolving, which would let a refused request carry on as if it had succeeded.
  it('never resolves', async () => {
    const { unitOfWork } = recordingUnitOfWork();
    let resolved = false;

    await commitThenRefuse(unitOfWork, CONTEXT, () => Promise.resolve(new Refusal('x'))).then(
      () => {
        resolved = true;
      },
      () => undefined,
    );

    expect(resolved).toBe(false);
  });
});
