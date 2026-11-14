import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client';
import { OperationFailure, answerOf, unexpectedResponse } from '../api/api-response';
import { failureOf } from '../api/idempotency';
import { acquireIntakeLock } from './hub-intake-commands';
import {
  parseIntake,
  parseIntakePage,
  type IntakePageView,
  type IntakeState,
  type IntakeView,
} from './hub-intake-shape';

/**
 * The reads of the receiving screens (S1.35), judged before they are believed (`hub-intake-shape.ts`). As the pickup, manifest and door screens' reads, none is read again on focus or reconnect (every
 * accepted request is activity), and nothing is kept once the screen lets go (`gcTime: 0`), so the version an act takes is always the one just read. A failed read is retried by the person, not by the
 * page. **There is one timer here, and it is the lock's** ({@link useIntakeLock}): a page that is counting keeps its own lock while it is open and visible, and no read is polled.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface IntakeListParams {
  /**
   * The intake state the list is narrowed to by the server (`AWAITING_COUNT` is the awaiting-receive queue); left out is all of them. **The server filters, and the page filters nothing**: a part of a
   * page filtered in the browser would pass for the whole. There is no hub filter on this list: it shows the hubs of the session's grant, each item naming its hub.
   */
  readonly state?: IntakeState;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/** `listHubIntakes` (`hub.read`): the intakes at the hubs of the grant, oldest handover first. An item is told counted or not, and **no list gives a screen a declaration**, counted or not. */
export function useHubIntakes(params: IntakeListParams): UseQueryResult<IntakePageView> {
  const client = useApiClient();
  return useQuery({
    queryKey: ['hub-intake', 'list', params.state ?? null, params.pageToken ?? null] as const,
    enabled: params.enabled ?? true,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/hub-intakes', {
          params: {
            query: {
              ...(params.state === undefined ? {} : { state: params.state }),
              ...(params.pageToken === undefined ? {} : { page_token: params.pageToken }),
            },
          },
        }),
      );
      const page = parseIntakePage(answer.data);
      if (page === undefined) throw unexpectedResponse(answer.status);
      return page;
    },
  });
}

/** An intake as it was read, with the version an act takes on it: the `ETag` exactly as the API sent it. It does not move with the receive lock. */
export interface IntakeRecord {
  readonly intake: IntakeView;
  readonly etag: string;
}

export const intakeKey = (id: string) => ['hub-intake', 'record', id.toLowerCase()] as const;

/** `getHubIntake` (`hub.read`): one intake, **counted or not**, with its `ETag`. An intake that has not been counted has no declaration in it (the shape refuses an answer that has). */
export function useHubIntake(id: string, enabled = true): UseQueryResult<IntakeRecord> {
  const client = useApiClient();
  return useQuery({
    queryKey: intakeKey(id),
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(await client.GET('/hub-intakes/{id}', { params: { path: { id } } }));
      const intake = parseIntake(answer.data);
      if (intake?.id.toLowerCase() !== id.toLowerCase() || answer.etag === undefined) {
        throw unexpectedResponse(answer.status);
      }
      return { intake, etag: answer.etag };
    },
  });
}

/**
 * How often a page that is counting tells the server it is still there. **Provisional**: the idle time after which another receiver may take the lock over is the hub's setting
 * (`intake_lock_idle_ttl_minutes`, fifteen minutes on the launch hub, which the portal has no read of), and a refresh every minute is well inside it. A hub whose idle time is under a minute would
 * see the lock go idle between two refreshes; the setting's launch value is the owner's (OB-S1-93).
 */
export const LOCK_REFRESH_MS = 60_000;

export interface IntakeLock {
  /** The last intake the server answered the lock with: who holds it, as the server sees it now. `undefined` until the first answer. */
  readonly intake: IntakeView | undefined;
  /** The first request is on its way and nothing has answered yet. */
  readonly taking: boolean;
  /** The last request failed (the lock could not be confirmed); the page keeps trying while it is open, except for an answer that says it never will work. */
  readonly failure: unknown;
  /** Asks again now: for the receiver who was told that another holds the lock, which the server grants only once the holder has been idle for the hub's idle time. */
  readonly askAgain: () => Promise<void>;
}

/**
 * The receive lock, kept for as long as the page that needs it is **open and visible** (§22.8; `acquireIntakeLock`): taken when the page opens, refreshed every {@link LOCK_REFRESH_MS} while the document
 * is visible, refreshed at once when it becomes visible again, and left alone while it is hidden or once the page has gone. **The lock is advisory**: this hook never decides anything but what the
 * indicator says, a count is refused only for the intake's facts, and leaving does not release it (it goes idle). A refresh that the API refuses for good (a refusal of authority, an intake that is not
 * there) stops the keeping; a failure that may pass (no answer, a fault, too fast a request) is shown and tried again at the next refresh.
 */
export function useIntakeLock(id: string, enabled: boolean): IntakeLock {
  const client = useApiClient();
  const [intake, setIntake] = useState<IntakeView | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const stopped = useRef(false);

  const take = useCallback(async (): Promise<void> => {
    if (inFlight.current || stopped.current) return;
    inFlight.current = true;
    try {
      const answer = await acquireIntakeLock(client, id);
      if (!alive.current) return;
      setIntake(answer);
      setFailure(undefined);
      // A counted intake has no lock to keep: whoever counted it, the page that was counting is told so and keeps nothing.
      if (answer.count_phase === 'POST_COUNT') stopped.current = true;
    } catch (error) {
      if (!alive.current) return;
      setFailure(error);
      // A refusal of the API (authority, hub, an intake that is not there) will not pass by asking again, but a request that was too fast will.
      const tooFast = error instanceof OperationFailure && error.status === 429;
      if (failureOf(error) === 'refused' && !tooFast) stopped.current = true;
    } finally {
      inFlight.current = false;
    }
  }, [client, id]);

  useEffect(() => {
    alive.current = true;
    stopped.current = false;
    if (!enabled) return undefined;
    // The first request is the page's opening, not a reaction to it: it is sent after this effect has run.
    queueMicrotask(() => {
      void take();
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      timer ??= setInterval(() => {
        void take();
      }, LOCK_REFRESH_MS);
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void take();
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
  }, [enabled, take]);

  // The first request is on its way when the page keeps the lock and nothing has answered it yet.
  const taking = enabled && intake === undefined && failure === undefined;
  return { intake, taking, failure, askAgain: take };
}
