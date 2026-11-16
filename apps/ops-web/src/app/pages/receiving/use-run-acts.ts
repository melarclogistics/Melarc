import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useRef } from 'react';

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
import { StaleSessionError } from '../../../platform/session/session-boundary';

/** What a tap came to: nothing to say when it was taken, or the refusal in the table's words. */
export interface TapResult {
  readonly problem?: Problem;
}

export interface RunActs {
  /**
   * A tap on a parcel's photo (`recordParcelArrival`): **the first act on a vendor takes its lock**, the tap is sent, and the API's answer is put into the page that was read (the parcel, the vendor's token and
   * its counts, as the API gave them) so that twelve taps are twelve requests and not twenty-four. **The taps of one vendor go one at a time, in the order they were made**: the answer of a tap carries the
   * vendor's counts at that moment, and two taps in flight could be answered in the other order and leave the page with the older counts. A refusal is answered in words; one that says the vendor is no longer as
   * the officer saw it also reads the run again.
   */
  readonly tap: (intakeId: string, parcelId: string, arrived: boolean) => Promise<TapResult>;
  /** Takes the vendor's lock on the officer's first act on it, for the acts that are not a tap (the finish, an extra, damage). It never fails: the lock is advisory. */
  readonly ensureLock: (intakeId: string) => Promise<void>;
  /** What the lock of a vendor says, or nothing for a vendor the officer has not acted on in this page. */
  readonly lockStatus: (intakeId: string) => LockStatus | undefined;
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
  /** The taps of each vendor, one after the other. */
  const chains = useRef(new Map<string, Promise<unknown>>());
  const { ensure } = locks;

  const tap = useCallback(
    (intakeId: string, parcelId: string, arrived: boolean): Promise<TapResult> => {
      const vendor = intakeId.toLowerCase();
      const job = (chains.current.get(vendor) ?? Promise.resolve()).then(
        async (): Promise<TapResult> => {
          await ensure(intakeId);
          try {
            const answer = await recordParcelArrival(client, parcelId, arrived);
            // A read that began before this tap is answered with the vendor as it was: it is dropped, and the answer of the tap is what the page keeps.
            await queryClient.cancelQueries({ queryKey: runKey(manifestId) });
            queryClient.setQueryData<RunPageView>(runKey(manifestId), (page) =>
              page === undefined ? page : applyParcelAnswer(page, intakeId, answer),
            );
            return {};
          } catch (error) {
            // The answer is for a session that has gone: nothing is said to the person who replaced the one it was for.
            if (error instanceof StaleSessionError) return {};
            const problem = problemOf(error, { operation: 'recordParcelArrival' });
            if (problem.kind === 'conflict') void latest.current();
            return { problem };
          }
        },
      );
      chains.current.set(vendor, job);
      return job;
    },
    [client, queryClient, manifestId, ensure],
  );

  return { tap, ensureLock: ensure, lockStatus: locks.status };
}
