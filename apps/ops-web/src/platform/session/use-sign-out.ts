import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client';
import { answerOf } from '../api/api-response';
import { problemOf } from '../problem/problem-copy';
import { useEndSession, useSessionStore } from './session-context';

/** Where a sign-out is: not begun (or dropped), under way, or begun and not finished, so that the person is still signed in. */
export type SignOutState = 'idle' | 'pending' | 'failed';

/**
 * Sign-out (surfaces/ops-portal.md section 7, `/`): `signOut` through the scoped client, and then the end of the session by the one action
 * that ends it (`useEndSession`), so that the cache, the person and the screen go the way they go when the API ends a session.
 *
 * - **`204` is done.** So is `SESSION_INVALID` (or `SESSION_SUPERSEDED`): the session had already ended, which is what the person asked for,
 *   so it reads as done and not as a failure. The session boundary has already ended it on that answer, so it is not ended again.
 * - **Anything else leaves the person signed in** and says so (no connection, a fault, `CSRF_VALIDATION_FAILED`): "signed out" is never said
 *   while the session may be live. The act is idempotent, so trying again is always safe.
 * - **One at a time**: a second press while one is under way is ignored.
 * - **An answer for a session that has been replaced** (a `StaleSessionError`, or a session that changed meanwhile) is dropped: it is not
 *   the sign-out of the person now signed in, and it neither ends their session nor tells them of a failure.
 */
export function useSignOut(): {
  readonly signOut: () => Promise<void>;
  readonly state: SignOutState;
} {
  const client = useApiClient();
  const store = useSessionStore();
  const end = useEndSession();
  const [state, setState] = useState<SignOutState>('idle');
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const generation = store.generation;
    setState('pending');

    let outcome: 'done' | 'dropped' | 'failed';
    try {
      answerOf(await client.DELETE('/auth/session'));
      outcome = 'done';
    } catch (error) {
      const problem = problemOf(error, { operation: 'signOut' });
      if (problem.kind === 'session-ended') outcome = 'done';
      else if (problem.kind === 'stale') outcome = 'dropped';
      else outcome = 'failed';
    }
    busy.current = false;

    // Whatever came back, it is for the session it was sent for. If that is no longer the current one, nothing here is about the person
    // who is signed in now.
    if (store.generation !== generation) outcome = 'dropped';
    if (outcome === 'done') end();
    if (alive.current) setState(outcome === 'failed' ? 'failed' : 'idle');
  }, [client, store, end]);

  return { signOut, state };
}
