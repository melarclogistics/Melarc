import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

import { ApiClientProvider } from '../platform/api/api-client';
import { HubChoiceScope } from '../platform/hub/active-hub';
import { createQueryClient, endSession } from '../platform/query/query-client';
import { holdOf } from '../platform/query/read-hold';
import { queueSummaryObserver } from '../platform/queue-summary/queue-summary-refresh';
import { SessionBoundary } from '../platform/session/session-boundary';
import { SessionProvider } from '../platform/session/SessionProvider';
import { SessionStore, type SessionView } from '../platform/session/session-store';
import { failWhenAPermissionKeyIsDrawn } from './permission-keys';
import { sessionFixture } from './session-fixture';

export interface ProvidersOptions {
  /** Start with this person signed in (the default is nobody known yet, as at the first load). */
  readonly signedIn?: boolean | SessionView;
  /** The route the component sits at. */
  readonly path?: string;
}

/**
 * A component inside the real providers (query client, session store and boundary, scoped API client) and a router, without the
 * application's frame or routes, and with the store and the query client in hand so a test can end a session or read the cache. Only the
 * network is replaced (`installFakeApi`). What `AppProviders` does when a session ends is done the same way here, apart from the
 * navigation. The test fails if a permission key of the catalogue is drawn, as text or in an attribute, at any moment of it (`permission-keys.ts`).
 */
export function renderWithProviders(ui: ReactElement, options: ProvidersOptions = {}) {
  failWhenAPermissionKeyIsDrawn();
  const store = new SessionStore();
  if (options.signedIn !== undefined && options.signedIn !== false) {
    store.signedIn(options.signedIn === true ? sessionFixture() : options.signedIn);
  }
  const queryClient: QueryClient = createQueryClient();
  const ended: string[] = [];
  const boundary = new SessionBoundary({
    store,
    onEnded: (code) => {
      ended.push(code);
      endSession(queryClient);
      store.end();
    },
    onRateLimited: (askedSeconds) => {
      holdOf(queryClient).hold(askedSeconds);
    },
  });
  // The same reaction to an act that the application has (`AppProviders`): the queue summary is read again after an act that can change a queue.
  const onAct = queueSummaryObserver(queryClient);
  const user = userEvent.setup();
  const wrap = (element: ReactElement) => (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider boundary={boundary} onAct={onAct}>
        <SessionProvider store={store}>
          <HubChoiceScope>
            <MemoryRouter initialEntries={[options.path ?? '/']}>{element}</MemoryRouter>
          </HubChoiceScope>
        </SessionProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
  const view = render(wrap(ui));
  return {
    ...view,
    user,
    store,
    queryClient,
    ended,
    /** Renders another element inside the same providers, as a screen re-renders with other props. */
    rerenderUi: (next: ReactElement) => {
      view.rerender(wrap(next));
    },
  };
}
