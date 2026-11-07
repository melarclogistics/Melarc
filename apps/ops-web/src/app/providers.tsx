import { QueryClientProvider, QueryErrorResetBoundary } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiClientProvider } from '../platform/api/api-client';
import { HubChoiceScope } from '../platform/hub/active-hub';
import { createQueryClient, endSession } from '../platform/query/query-client';
import { holdOf } from '../platform/query/read-hold';
import { queueSummaryObserver } from '../platform/queue-summary/queue-summary-refresh';
import { LANDING_PATH } from '../platform/session/paths';
import { SessionBoundary } from '../platform/session/session-boundary';
import { SessionProvider } from '../platform/session/SessionProvider';
import { SessionStore } from '../platform/session/session-store';

/** The `termination_reason` the API records for a session that its owner ended (contracts/openapi.yaml, `signOut`). */
const SIGNED_OUT = 'SIGNED_OUT';

export interface AppProvidersProps {
  readonly children: ReactNode;
  /**
   * Takes the person to an address, replacing the page they are on. The router lives below these providers, so it is
   * handed in: the router of an application instance does not change, and this is read once.
   */
  readonly navigate?: (to: string) => void;
}

/**
 * Application-wide providers. One query client, one session store, one session boundary and one API client per application
 * instance, created once, and made together because a session ending is one event with three effects: the store forgets who
 * was signed in, the query client forgets what they were shown (`endSession`), and the person goes to the landing, whose
 * guard sends them on to sign-in with nothing that says why (surfaces/ops-portal.md section 7).
 *
 * The boundary is where the event is noticed, for every call the page makes (`SessionBoundary`): the API client is scoped by
 * it, so a query, a mutation and a screen's direct call (a secret is fetched that way) end the session alike, and an answer to
 * a request sent for a session that has gone does not end the next one. It is also where a `429` is noticed, by the same rule: the
 * client's hold keeps the automatic reads still for the wait the API asked for (`platform/query/read-hold.ts`).
 */
export function AppProviders({ children, navigate }: AppProvidersProps) {
  const [session] = useState(() => new SessionStore());
  const [queryClient] = useState(() => createQueryClient());
  // What the portal does when an act of its own is answered with success: read the queue summary again if the act can change a queue.
  const [onAct] = useState(() => queueSummaryObserver(queryClient));
  const [boundary] = useState(
    () =>
      new SessionBoundary({
        store: session,
        onEnded: () => {
          endSession(queryClient);
          session.end();
          navigate?.(LANDING_PATH);
        },
        // A request that was too fast (`429`): the page holds its automatic reads for the wait the API asked for (A2 of the audit).
        onRateLimited: (askedSeconds) => {
          holdOf(queryClient).hold(askedSeconds);
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {/* The error page resets the queries that failed into it: it and the pages must share one boundary. */}
      <QueryErrorResetBoundary>
        <ApiClientProvider boundary={boundary} onAct={onAct}>
          <SessionProvider
            store={session}
            end={() => {
              boundary.end(SIGNED_OUT);
            }}
          >
            {/* The choice of hub lives here, above the router and inside the session: it survives a visit to a page outside the shell. */}
            <HubChoiceScope>{children}</HubChoiceScope>
          </SessionProvider>
        </ApiClientProvider>
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}
