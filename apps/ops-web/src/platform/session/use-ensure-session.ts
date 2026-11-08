import { useCallback, useEffect } from 'react';

import { useApiClient } from '../api/api-client';
import { readCurrentSession } from './read-session';
import { useSession, useSessionStore } from './session-context';
import type { SessionState } from './session-store';

/**
 * The session, read from the API if nobody has asked yet. A page that needs to know who is signed in calls this; a page
 * that does not (the pre-sign-in screens) calls nothing and so puts no request on the wire.
 *
 * It reads once: when the application has not yet been told either way. It does not poll, does not read again when the
 * window regains focus and does not read after the session has ended, because every request the API accepts counts as
 * activity and keeps the session alive (plan section 8, rule 13): an Ops page left unattended must not keep itself
 * signed in. The end of a session is noticed by the next request that needs the API, and by the guards, which react.
 */
export function useEnsureSession(): { readonly state: SessionState; readonly retry: () => void } {
  const store = useSessionStore();
  const client = useApiClient();
  const state = useSession();

  const read = useCallback(() => readCurrentSession(client), [client]);

  useEffect(() => {
    if (store.getState().status === 'loading') void store.load(read);
  }, [store, read]);

  const retry = useCallback(() => {
    void store.load(read);
  }, [store, read]);

  return { state, retry };
}
