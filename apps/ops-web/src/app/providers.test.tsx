import type { BrowserApiClient } from '@melarc/api-client/browser';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApiClient } from '../platform/api/api-client';
import { answerOf } from '../platform/api/api-response';
import { useEndSession, useSession, useSessionStore } from '../platform/session/session-context';
import type { SessionState, SessionStore } from '../platform/session/session-store';
import { errorResponse, installFakeApi, type FakeApi } from '../test-support/fake-api';
import { sessionFixture } from '../test-support/session-fixture';
import { AppProviders } from './providers';

/** Reports the query client the component can see each time it renders. */
function Probe({ onClient }: { readonly onClient: (client: QueryClient) => void }) {
  onClient(useQueryClient());
  return null;
}

describe('AppProviders', () => {
  // Break caught: components finding no query client, which throws the first time one fetches.
  it('gives its descendants a query client', () => {
    const seen: QueryClient[] = [];

    render(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(QueryClient);
  });

  // Break caught: a new client built on every render, which empties the cache whenever anything above
  // it re-renders.
  it('keeps one client for as long as it stays mounted', () => {
    const seen: QueryClient[] = [];
    const { rerender } = render(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    rerender(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  // Break caught: one client shared by every application instance, so cached data from one user's
  // session could be shown to the next.
  it('creates a separate client for each application instance', () => {
    const seen: QueryClient[] = [];

    for (let instance = 0; instance < 2; instance += 1) {
      const { unmount } = render(
        <AppProviders>
          <Probe onClient={(client) => seen.push(client)} />
        </AppProviders>,
      );
      unmount();
    }

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });
});

describe('AppProviders and the end of a session', () => {
  interface Handle {
    readonly queryClient: QueryClient;
    readonly client: BrowserApiClient;
    readonly store: SessionStore;
    readonly session: SessionState;
  }

  /** Hands the test the query client, the API client, the session store and the session the providers made. */
  function Handles({ onHandles }: { readonly onHandles: (handle: Handle) => void }) {
    onHandles({
      queryClient: useQueryClient(),
      client: useApiClient(),
      store: useSessionStore(),
      session: useSession(),
    });
    return null;
  }

  let api: FakeApi;
  beforeEach(() => {
    api = installFakeApi();
  });
  afterEach(() => {
    expect(api.unhandled).toEqual([]);
    api.restore();
  });

  /** Mounts the providers with somebody signed in, and asks the API (through a query) something its handler answers as given. */
  async function askAndMeetTheEnd(
    answer: () => Response,
    navigate?: (to: string) => void,
  ): Promise<{ handle: () => Handle }> {
    api.on('GET /auth/session', answer);
    let latest: Handle | undefined;
    const handle = (): Handle => {
      if (latest === undefined) throw new Error('not rendered');
      return latest;
    };
    render(
      <AppProviders {...(navigate === undefined ? {} : { navigate })}>
        <Handles
          onHandles={(next) => {
            latest = next;
          }}
        />
      </AppProviders>,
    );
    act(() => {
      handle().store.signedIn(sessionFixture());
    });
    handle().queryClient.setQueryData(['cached'], 'the previous person’s data');

    await act(async () => {
      await handle()
        .queryClient.query({
          queryKey: ['x'],
          queryFn: async () => answerOf(await handle().client.GET('/auth/session')).data,
          retry: false,
        })
        .catch(() => undefined);
    });
    return { handle };
  }

  // Break caught: the session ending in the query client and nowhere else, so the page keeps showing the person who
  // was signed in and nothing takes them away (the providers sit above the router, so this wiring is theirs).
  it('forgets who was signed in, clears the cache and takes the person to the landing when a request says the session ended', async () => {
    const navigate = vi.fn();

    const { handle } = await askAndMeetTheEnd(
      () => errorResponse(401, 'SESSION_INVALID'),
      navigate,
    );

    expect(handle().session).toEqual({ status: 'signed-out' });
    expect(handle().queryClient.getQueryData(['cached'])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  // Break caught: a refused permission, or a wrong password, taking the person away from the page they are on.
  it('does nothing for a refusal that is not the end of a session', async () => {
    const navigate = vi.fn();

    const { handle } = await askAndMeetTheEnd(
      () => errorResponse(403, 'PERMISSION_DENIED'),
      navigate,
    );

    expect(navigate).not.toHaveBeenCalled();
    expect(handle().session.status).toBe('signed-in');
    expect(handle().queryClient.getQueryData(['cached'])).toBe('the previous person’s data');
  });

  it('still ends the session when no navigation is given', async () => {
    const { handle } = await askAndMeetTheEnd(() => errorResponse(401, 'SESSION_SUPERSEDED'));

    expect(handle().session).toEqual({ status: 'signed-out' });
  });
});

describe('AppProviders and ending the session from the page (sign-out)', () => {
  interface Ender {
    readonly end: () => void;
    readonly store: SessionStore;
    readonly queryClient: QueryClient;
  }

  function EnderProbe({ onEnder }: { readonly onEnder: (ender: Ender) => void }) {
    onEnder({ end: useEndSession(), store: useSessionStore(), queryClient: useQueryClient() });
    return null;
  }

  function mount(navigate: (to: string) => void) {
    let latest: Ender | undefined;
    render(
      <AppProviders navigate={navigate}>
        <EnderProbe
          onEnder={(next) => {
            latest = next;
          }}
        />
      </AppProviders>,
    );
    return (): Ender => {
      if (latest === undefined) throw new Error('not rendered');
      return latest;
    };
  }

  // Break caught: a sign-out that copies the three effects of the end of a session and so can drift from them, or that does only some of
  // them: the cache must be emptied, the person forgotten and the landing shown, exactly as when the API says the session ended.
  it('has the same three effects as a session the API ended', () => {
    const navigate = vi.fn();
    const ender = mount(navigate);
    act(() => {
      ender().store.signedIn(sessionFixture());
    });
    ender().queryClient.setQueryData(['cached'], 'the previous person’s data');

    act(() => {
      ender().end();
    });

    expect(ender().store.getState()).toEqual({ status: 'signed-out' });
    expect(ender().queryClient.getQueryData(['cached'])).toBeUndefined();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  });

  // Break caught: a second end taking the next person's session, or navigating again. Once a session has ended, ending it is nothing.
  it('does nothing a second time, and nothing when nobody is signed in', () => {
    const navigate = vi.fn();
    const ender = mount(navigate);

    act(() => {
      ender().end();
    });
    expect(navigate).not.toHaveBeenCalled();

    act(() => {
      ender().store.signedIn(sessionFixture());
      ender().end();
      ender().end();
    });

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('is not available outside the providers, and says so', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Orphan() {
      useEndSession();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(/useEndSession/);
    quiet.mockRestore();
  });
});
