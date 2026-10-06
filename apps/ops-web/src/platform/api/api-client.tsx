import { createBrowserApiClient, type BrowserApiClient } from '@melarc/api-client/browser';
import { createContext, useContext, useState, type ReactNode } from 'react';

const ApiClientContext = createContext<BrowserApiClient | undefined>(undefined);

/**
 * The one API client of this application instance, created once. It is the browser transport of the
 * generated client: this origin's /api/v1, the session cookie, the CSRF header on state-changing requests.
 * Features take it from here with `useApiClient` and never build their own.
 */
export function ApiClientProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createBrowserApiClient());
  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}

export function useApiClient(): BrowserApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined)
    throw new Error('useApiClient must be used inside an ApiClientProvider.');
  return client;
}
