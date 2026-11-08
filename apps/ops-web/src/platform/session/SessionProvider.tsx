import type { ReactNode } from 'react';

import { EndSessionContext, SessionContext } from './session-context';
import type { SessionStore } from './session-store';

/**
 * Makes the session store available to the pages. The store is made by `AppProviders`, which also gives the query client
 * the `onSessionEnded` that ends it, so the two are one thing's two halves and are created together.
 */
export function SessionProvider({
  store,
  end,
  children,
}: {
  readonly store: SessionStore;
  /** Ends the session from the page: what `useEndSession` hands to a sign-out. Without it the page has no way to end the session itself. */
  readonly end?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <SessionContext value={store}>
      <EndSessionContext value={end}>{children}</EndSessionContext>
    </SessionContext>
  );
}
