import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { useApiClient } from '../../../platform/api/api-client';
import { applyParcelAnswer } from '../../../platform/hub-receiving/apply-parcel-answer';
import { recordParcelArrival } from '../../../platform/hub-receiving/receiving-commands';
import type { RunPageView } from '../../../platform/hub-receiving/receiving-shape';
import {
  useReceivingLocks,
  type LockStatus,
} from '../../../platform/hub-receiving/use-receiving-locks';
import { runKey } from '../../../platform/hub-receiving/use-receiving-queries';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { writeAnswer } from '../../../platform/query/write-answer';
import { StaleSessionError } from '../../../platform/session/session-boundary';

/** What a tap came to: nothing to say when it was taken, or the refusal in the table's words. */
export interface TapResult {
  readonly problem?: Problem;
}

export interface RunActs {
  /**
   * A tap on a parcel's photo (`recordParcelArrival`): **the first act on a vendor takes its lock**, the tap is sent, and the API's answer is put into the page that was read (the parcel, the vendor's token and
   * its counts, as the API gave them) so that twelve taps are twelve requests and not twenty-four. **The taps of the page go one at a time, in the order they were made**: the answer of a tap carries the
   * vendor's counts at that moment, two taps in flight could be answered in the other order and leave the page with the older counts, and each answer is merged into the page as the last one left it, so that
   * a tap on another vendor is never written over. The answer is written through `writeAnswer`, the one door of the portal. A refusal is answered in words; one that says the vendor is no longer as the officer
   * saw it also reads the run again.
   */
  readonly tap: (intakeId: string, parcelId: string, arrived: boolean) => Promise<TapResult>;
  /** Takes the vendor's lock on the officer's first act on it, for the acts that are not a tap (the finish, an extra, damage). It never fails: the lock is advisory. */
  readonly ensureLock: (intakeId: string) => Promise<void>;
  /** What the lock of a vendor says, or nothing for a vendor the officer has not acted on in this page. */
  readonly lockStatus: (intakeId: string) => LockStatus | undefined;
  /**
   * The last tap did not reach the platform (the network, not a refusal), and none has got through since: the page says that what the officer does now is not saved. A tap that is answered, in any way, says the
   * connection is there.
   */
  readonly requestFailed: boolean;
}

/**
 * The acts of the run's page that are not confirmed in a dialog, and the lock they take (S1.35c). The page's read lives in the query cache, so an answer is taken into it there (`applyParcelAnswer`) and
 * any other change of a vendor (finishing it, a condition, a correction) is read again by the page: the lock's refresh asks it to read the run again every minute, so that who holds a vendor's lock is what
 * the API now says.
 */
export function useRunActs(manifestId: string, readAgain: () => unknown): RunActs {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const locks = useReceivingLocks({
    onRefreshed: () => {
      void readAgain();
    },
  });
  const latest = useRef(readAgain);
  useLayoutEffect(() => {
    latest.current = readAgain;
  });
  const [requestFailed, setRequestFailed] = useState(false);
  /** The taps of the page, one after the other. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const { ensure } = locks;

  const tap = useCallback(
    (intakeId: string, parcelId: string, arrived: boolean): Promise<TapResult> => {
      const job = chain.current.then(async (): Promise<TapResult> => {
        await ensure(intakeId);
        try {
          const answer = await recordParcelArrival(client, parcelId, arrived);
          setRequestFailed(false);
          // The answer is merged into the page as it is now and written at once, so that a read that began before this tap (answered with the vendor as it was) is dropped and cannot write over it.
          const page = queryClient.getQueryData<RunPageView>(runKey(manifestId));
          if (page !== undefined) {
            await writeAnswer(
              queryClient,
              runKey(manifestId),
              applyParcelAnswer(page, intakeId, answer),
            );
          }
          return {};
        } catch (error) {
          // The answer is for a session that has gone: nothing is said to the person who replaced the one it was for.
          if (error instanceof StaleSessionError) return {};
          const problem = problemOf(error, { operation: 'recordParcelArrival' });
          // A refusal is an answer, and says the connection is there; a request that never arrived says it is not.
          setRequestFailed(problem.kind === 'unavailable');
          if (problem.kind === 'conflict') void latest.current();
          return { problem };
        }
      });
      chain.current = job;
      return job;
    },
    [client, queryClient, manifestId, ensure],
  );

  return { tap, ensureLock: ensure, lockStatus: locks.status, requestFailed };
}
