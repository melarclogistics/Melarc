import { createContext, useContext, useSyncExternalStore } from 'react';

import type { SessionState, SessionStore } from './session-store';

export const SessionContext = createContext<SessionStore | undefined>(undefined);

/** Ends the session that is current, with the same effects as an end the API reported. Provided by `AppProviders`; see `useEndSession`. */
export const EndSessionContext = createContext<(() => void) | undefined>(undefined);

/** The session store of this application instance. Only the session hooks and the sign-in and sign-out flows use it. */
export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (store === undefined) throw new Error('useSession must be used inside a SessionProvider.');
  return store;
}

/**
 * The one action that ends the session from the page (sign-out): the cache is cleared, the person forgotten and the landing shown, by the same
 * event that an answer of `SESSION_INVALID` raises, so the two cannot drift apart. It does nothing when nobody is signed in or when the session
 * has already ended, so a sign-out that is answered after the boundary ended the session does not end it twice.
 */
export function useEndSession(): () => void {
  const end = useContext(EndSessionContext);
  if (end === undefined) throw new Error('useEndSession must be used inside AppProviders.');
  return end;
}

/** Who is signed in, now, and again whenever it changes. Nothing is read from the network by calling this. */
export function useSession(): SessionState {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
