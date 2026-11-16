import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client';
import { OperationFailure } from '../api/api-response';
import { failureOf } from '../api/idempotency';
import { acquireReceivingLock } from './receiving-commands';

/**
 * How often a page that is checking parcels in tells the API it is still there. **Provisional** (OB-S1-108): the idle time after which another receiver may take a lock over is the hub's setting
 * (`intake_lock_idle_ttl_minutes`, fifteen minutes on the launch hub, which the portal has no read of), and a refresh every minute is well inside it. It is the one timer of the receiving screens.
 */
export const LOCK_REFRESH_MS = 60_000;

/** `ok`: the last request for the lock was answered. `cannot-check`: it was not (it failed, or the API refused it for good): the page says it cannot check the lock right now and never keeps saying *You*. */
export type LockStatus = 'ok' | 'cannot-check';

export interface ReceivingLocks {
  /**
   * Takes the lock of a vendor on the officer's **first act on it** and does nothing for the next (the page does not take a lock by being opened). It never fails: the lock is advisory, so a lock that could not be
   * taken is a status, and the act goes on. A second call while the first is on its way waits for the same request.
   */
  readonly ensure: (intakeId: string) => Promise<void>;
  /** What the lock of a vendor says, or nothing for a vendor the officer has not acted on in this page. */
  readonly status: (intakeId: string) => LockStatus | undefined;
}

export interface ReceivingLocksOptions {
  /** Called after each refresh that kept the locks (every minute), so that the page can read what the API now says of who holds them. */
  readonly onRefreshed?: () => void;
}

/**
 * The receive locks of the vendors an officer has started on, kept for as long as the page is **open and visible** (§22.8, `acquireIntakeLock`): taken on the first act on a vendor (`ensure`), refreshed every
 * {@link LOCK_REFRESH_MS} while the document is visible, refreshed at once when it becomes visible again, and left alone while it is hidden and once the page has gone. **The lock is advisory**: this hook decides
 * only what the page says about it, and leaving does not release it (it goes idle). A refresh that fails, after a success or not, makes the status `cannot-check` until one is answered; a refusal of the API
 * that will not pass by asking again (authority, an intake that is not there) stops the keeping of that vendor, and a request that was too fast does not.
 */
export function useReceivingLocks(options: ReceivingLocksOptions = {}): ReceivingLocks {
  const client = useApiClient();
  const [statuses, setStatuses] = useState<Readonly<Record<string, LockStatus>>>({});
  const alive = useRef(true);
  /** The vendors started on, and which of them are given up on. */
  const started = useRef(new Map<string, { given_up: boolean }>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const take = useCallback(
    (intakeId: string): Promise<void> => {
      const key = intakeId.toLowerCase();
      const running = inFlight.current.get(key);
      if (running !== undefined) return running;
      const entry = started.current.get(key) ?? { given_up: false };
      started.current.set(key, entry);
      const request = acquireReceivingLock(client, intakeId)
        .then(() => {
          if (alive.current) setStatuses((all) => ({ ...all, [key]: 'ok' }));
        })
        .catch((error: unknown) => {
          // A refusal that will not pass by asking again stops the keeping; a request that was too fast does, and a failure that may pass is tried again at the next refresh.
          const tooFast = error instanceof OperationFailure && error.status === 429;
          if (failureOf(error) === 'refused' && !tooFast) entry.given_up = true;
          if (alive.current) setStatuses((all) => ({ ...all, [key]: 'cannot-check' }));
        })
        .finally(() => {
          inFlight.current.delete(key);
        });
      inFlight.current.set(key, request);
      return request;
    },
    [client],
  );

  const ensure = useCallback(
    (intakeId: string): Promise<void> =>
      started.current.has(intakeId.toLowerCase()) ? Promise.resolve() : take(intakeId),
    [take],
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    const ids = [...started.current.entries()]
      .filter(([, entry]) => !entry.given_up)
      .map(([id]) => id);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => take(id)));
    if (alive.current) latest.current.onRefreshed?.();
  }, [take]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      timer ??= setInterval(() => {
        void refreshAll();
      }, LOCK_REFRESH_MS);
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshAll();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshAll]);

  const status = useCallback(
    (intakeId: string): LockStatus | undefined => statuses[intakeId.toLowerCase()],
    [statuses],
  );
  return { ensure, status };
}
