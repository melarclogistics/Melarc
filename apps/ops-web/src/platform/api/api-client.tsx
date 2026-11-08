import { createBrowserApiClient, type BrowserApiClient } from '@melarc/api-client/browser';
import { createContext, useContext, useState, type ReactNode } from 'react';

import type { SessionBoundary } from '../session/session-boundary';

/** The type of the one API client. The code that sends a request takes it from here, so that the browser transport is imported in as few places as can be. */
export type ApiClient = BrowserApiClient;

const ApiClientContext = createContext<BrowserApiClient | undefined>(undefined);

/**
 * The one API client of this application instance, created once. It is the browser transport of the
 * generated client: this origin's /api/v1, the session cookie, the CSRF header on state-changing requests.
 * Features take it from here with `useApiClient` and never build their own.
 *
 * It is the client **scoped by the session boundary**: every call it makes, from a query, a mutation or a screen that calls it
 * directly, is judged against the session that was current when the call was sent. There is no unscoped client to take.
 */
export function ApiClientProvider({
  boundary,
  children,
}: {
  readonly boundary: SessionBoundary;
  readonly children: ReactNode;
}) {
  const [client] = useState(() => boundary.scope(createBrowserApiClient()));
  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}

export function useApiClient(): BrowserApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined)
    throw new Error('useApiClient must be used inside an ApiClientProvider.');
  return client;
}
