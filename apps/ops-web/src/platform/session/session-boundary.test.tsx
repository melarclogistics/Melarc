import type { BrowserApiClient } from '@melarc/api-client/browser';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders } from '../../app/providers';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { sessionFixture } from '../../test-support/session-fixture';
import { useApiClient } from '../api/api-client';
import { answerOf } from '../api/api-response';
import { useSessionStore } from './session-context';
import { SessionBoundary, StaleSessionError } from './session-boundary';
import { SessionStore } from './session-store';

/**
 * U03 of the audit of 23 October 2026: the end of a session is one event with one owner, whatever kind of call noticed it, and an answer
 * to a request sent for a session that has gone does not touch the next one. Everything here runs the application's own wiring
 * (`AppProviders`: the real store, boundary, API client and TanStack Query client), with only the network replaced, so that what is
 * pinned is what the application does.
 */

const PERSON_A = sessionFixture({ principal_display_name: 'Person A' });
const PERSON_B = sessionFixture({
  id: '4e5d7c1f-1e9b-4b7f-8a66-2c3a1d0e8f22',
  principal_display_name: 'Person B',
});
const A_DATA = 'DATA-ONLY-PERSON-A-MAY-SEE';

/** A response a test releases when it chooses: the request is in flight until then. */
function gate() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Mounted {
  readonly client: BrowserApiClient;
  readonly store: SessionStore;
  readonly queryClient: QueryClient;
  readonly navigate: ReturnType<typeof vi.fn>;
}

/** The application's providers around whatever the test renders, with what the test needs to reach handed back. */
function mount(children?: React.ReactNode): Mounted {
  const seen: Partial<{
    client: BrowserApiClient;
    store: SessionStore;
    queryClient: QueryClient;
  }> = {};
  const navigate = vi.fn();
  function Probe() {
    seen.client = useApiClient();
    seen.store = useSessionStore();
    seen.queryClient = useQueryClient();
    return children ?? null;
  }
  render(
    <AppProviders navigate={navigate}>
      <Probe />
    </AppProviders>,
  );
  const { client, store, queryClient } = seen;
  if (client === undefined || store === undefined || queryClient === undefined) {
    throw new Error('the providers did not render');
  }
  return { client, store, queryClient, navigate };
}

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
});

describe('a call that is answered with the end of the session', () => {
  // Break caught: the end of a session noticed only by the query cache, so that a call a screen makes by itself (a secret is fetched
  // that way, outside every cache) is answered `SESSION_INVALID` and the page goes on showing the person who is no longer signed in.
  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])(
    'ends the session when a direct call outside any cache is answered %s',
    async (code) => {
      api.on('POST /auth/staff/setup/credential', () => errorResponse(401, code));
      const { client, store, queryClient, navigate } = mount();
      act(() => {
        store.signedIn(PERSON_A);
      });
      queryClient.setQueryData(['cached'], A_DATA);

      const result = await client.POST('/auth/staff/setup/credential', {
        body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
      });

      expect(result.response.status).toBe(401);
      expect(store.getState().status).toBe('signed-out');
      expect(queryClient.getQueryData(['cached'])).toBeUndefined();
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
    },
  );

  // The same event, noticed by the other two kinds of call: it is one event with one owner.
  it('ends the session alike when a query is answered SESSION_INVALID', async () => {
    api.on('GET /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    const { client, store, queryClient, navigate } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });
    queryClient.setQueryData(['cached'], A_DATA);

    // The query that learns of the end is itself cancelled by it (the cache is emptied and what is in flight is cancelled): the person
    // is leaving, so it neither succeeds nor shows an error.
    await expect(
      queryClient.query({
        queryKey: ['who'],
        queryFn: async () => answerOf(await client.GET('/auth/session')).data,
        retry: false,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(store.getState().status).toBe('signed-out');
    expect(queryClient.getQueryData(['cached'])).toBeUndefined();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('ends the session alike when a mutation is answered SESSION_INVALID', async () => {
    api.on('DELETE /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    function Command() {
      const client = useApiClient();
      const command = useMutation({
        mutationFn: async () => answerOf(await client.DELETE('/auth/session')).data,
      });
      return (
        <button
          type="button"
          onClick={() => {
            command.mutate();
          }}
        >
          Send
        </button>
      );
    }
    const { store, queryClient, navigate } = mount(<Command />);
    act(() => {
      store.signedIn(PERSON_A);
    });
    queryClient.setQueryData(['cached'], A_DATA);

    act(() => {
      screen.getByRole('button', { name: 'Send' }).click();
    });

    await waitFor(() => {
      expect(store.getState().status).toBe('signed-out');
    });
    expect(queryClient.getQueryData(['cached'])).toBeUndefined();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/');
  });

  // Break caught: several requests answered together each ending the session, which would run the departure again for every one.
  it('ends it once when several requests are answered with its end together', async () => {
    api.on('POST /auth/staff/setup/credential', () => errorResponse(401, 'SESSION_INVALID'));
    api.on('DELETE /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    const { client, store, navigate } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });

    const outcomes = await Promise.allSettled([
      client.POST('/auth/staff/setup/credential', {
        body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
      }),
      client.DELETE('/auth/session'),
    ]);

    expect(store.getState().status).toBe('signed-out');
    expect(navigate).toHaveBeenCalledTimes(1);
    // The first answer ended it; the other was sent for the session that had just ended and is stale.
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(
      outcomes.some(
        (outcome) => outcome.status === 'rejected' && outcome.reason instanceof StaleSessionError,
      ),
    ).toBe(true);
  });
});

describe('a failure that does not end the session', () => {
  // Break caught: every 401, 403 or fault being taken for the end of a session, which would sign a person out for being refused a
  // permission, for typing a wrong password or for a server that failed.
  it.each([
    ['a refused permission', () => errorResponse(403, 'PERMISSION_DENIED')],
    ['a wrong sign-in', () => errorResponse(401, 'INVALID_CREDENTIALS')],
    ['a refusal with no code', () => json(401, {})],
    ['a validation failure', () => errorResponse(400, 'VALIDATION_FAILED')],
    ['a rule violation', () => errorResponse(422, 'REASON_REQUIRED')],
    ['a server fault', () => errorResponse(500, 'INTERNAL_ERROR')],
    ['a gateway fault with an unknown body', () => new Response('bad gateway', { status: 502 })],
    ['a session code on a success status', () => json(200, { code: 'SESSION_INVALID' })],
  ])('is not the end of the session: %s', async (_label, response) => {
    api.on('POST /auth/staff/setup/credential', response);
    const { client, store, queryClient, navigate } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });
    queryClient.setQueryData(['kept'], 1);

    await client.POST('/auth/staff/setup/credential', {
      body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
    });

    expect(store.getState()).toMatchObject({ status: 'signed-in' });
    expect(queryClient.getQueryData(['kept'])).toBe(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('is not the end of the session when no answer came', async () => {
    api.on('POST /auth/staff/setup/credential', () => {
      throw new TypeError('Failed to fetch');
    });
    const { client, store, navigate } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });

    await expect(
      client.POST('/auth/staff/setup/credential', {
        body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
      }),
    ).rejects.toMatchObject({ kind: 'network' });

    expect(store.getState().status).toBe('signed-in');
    expect(navigate).not.toHaveBeenCalled();
  });

  // Break caught: a 401 that nobody is signed in to lose being treated as the end of a session: the read that asks who is signed in
  // is answered 401 when nobody is, and the page must not be taken away for it.
  it('is not the end of a session when nobody is signed in to lose it', async () => {
    api.on('GET /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    const { client, store, navigate } = mount();
    expect(store.getState().status).toBe('loading');

    const result = await client.GET('/auth/session');

    expect(result.response.status).toBe(401);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('an answer that arrives after the session it was sent for has gone (U03)', () => {
  // Break caught: an error answering person A's request ending person B's session: A's session ends, B signs in, and A's slow request
  // is then answered SESSION_INVALID, which used to end B's.
  it('a late error of person A does not end person B’s session', async () => {
    const slow = gate();
    api.on('GET /auth/session', () => slow.promise);
    api.on('POST /auth/staff/setup/credential', () => errorResponse(401, 'SESSION_INVALID'));
    const { client, store, navigate } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });
    const late = client.GET('/auth/session');
    // Person A's session ends on another request; person B signs in; only then does A's slow request come back.
    await client.POST('/auth/staff/setup/credential', {
      body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
    });
    expect(store.getState().status).toBe('signed-out');
    act(() => {
      store.signedIn(PERSON_B);
    });

    slow.release(errorResponse(401, 'SESSION_INVALID'));

    await expect(late).rejects.toBeInstanceOf(StaleSessionError);
    expect(store.getState()).toMatchObject({
      status: 'signed-in',
      session: { principal_display_name: 'Person B' },
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  // Break caught: a failure of the network, for a session that is gone, reaching a screen of the next one as a fault of its own.
  it('a late failure of the network is not one either', async () => {
    const slow = gate();
    api.on('GET /auth/session', () => slow.promise);
    const { client, store } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });
    const late = client.GET('/auth/session');
    act(() => {
      store.end();
      store.signedIn(PERSON_B);
    });

    void slow.promise.catch(() => undefined);
    slow.release(Promise.reject(new TypeError('Failed to fetch')) as unknown as Response);

    await expect(late).rejects.toBeInstanceOf(StaleSessionError);
    expect(store.getState().status).toBe('signed-in');
  });

  // Break caught: a late success repopulating the next person's cache: the data person A asked for is cached, or shown, for person B.
  it('a late success of person A is not cached, shown or kept for person B', async () => {
    const slow = gate();
    api.on('GET /auth/session', () => slow.promise);
    api.on('POST /auth/staff/setup/credential', () => errorResponse(401, 'SESSION_INVALID'));
    function Screen() {
      const client = useApiClient();
      const query = useQuery({
        queryKey: ['who'],
        queryFn: async () => answerOf(await client.GET('/auth/session')).data,
        retry: false,
      });
      return <p>{query.data === undefined ? query.status : query.data.principal_display_name}</p>;
    }
    const { client, store, queryClient } = mount(<Screen />);
    act(() => {
      store.signedIn(PERSON_A);
    });
    await screen.findByText('pending');
    await client.POST('/auth/staff/setup/credential', {
      body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
    });
    act(() => {
      store.signedIn(PERSON_B);
    });

    slow.release(json(200, { ...PERSON_A, principal_display_name: A_DATA }));
    await act(async () => {
      await slow.promise;
    });

    // The screen was observing a query the end of the session removed: it does not become person A's answer, and shows none of it.
    await waitFor(() => {
      expect(screen.getByText(/^(pending|error)$/)).toBeVisible();
    });
    expect(screen.queryByText('success')).toBeNull();
    expect(document.body.textContent).not.toContain(A_DATA);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain(A_DATA);
  });

  it('a late success of a mutation of person A reaches neither its screen nor the mutation cache', async () => {
    const slow = gate();
    api.on('DELETE /auth/session', () => slow.promise);
    api.on('POST /auth/staff/setup/credential', () => errorResponse(401, 'SESSION_INVALID'));
    function Command() {
      const client = useApiClient();
      const command = useMutation({
        mutationFn: async () => answerOf(await client.DELETE('/auth/session')),
      });
      return (
        <>
          <button
            type="button"
            onClick={() => {
              command.mutate();
            }}
          >
            Send
          </button>
          <p>{command.status}</p>
          <p>{command.isSuccess ? 'delivered' : 'not delivered'}</p>
        </>
      );
    }
    const { client, store, queryClient } = mount(<Command />);
    act(() => {
      store.signedIn(PERSON_A);
    });
    act(() => {
      screen.getByRole('button', { name: 'Send' }).click();
    });
    await screen.findByText('pending');
    await client.POST('/auth/staff/setup/credential', {
      body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
    });
    act(() => {
      store.signedIn(PERSON_B);
    });

    slow.release(new Response(null, { status: 204 }));
    await act(async () => {
      await slow.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('error')).toBeVisible();
    });
    expect(screen.getByText('not delivered')).toBeVisible();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  // Break caught: cancellation assumed to stop every request. Clearing the cache does not cancel a running mutation, and a request that
  // ignores its signal still answers: the refusal does not wait for the signal.
  it('refuses the answer of a request that ignored its cancellation', async () => {
    const slow = gate();
    api.on('GET /auth/session', () => slow.promise);
    const { client, store } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });
    const controller = new AbortController();
    const late = client.GET('/auth/session', { signal: controller.signal });
    act(() => {
      store.end();
    });
    controller.abort();

    slow.release(json(200, PERSON_A));

    // The fake network ignores the signal, as a transport that loses the race with the cancellation does.
    await expect(late).rejects.toBeInstanceOf(StaleSessionError);
  });

  // Break caught: a request sent for the current session being judged stale (the generation read late, so that an answer that follows a
  // sign-in is thrown away).
  it('does not refuse an answer to a request sent for the session that is still the current one', async () => {
    api.on('GET /auth/session', () => json(200, PERSON_A));
    const { client, store } = mount();
    act(() => {
      store.signedIn(PERSON_A);
    });

    const result = await client.GET('/auth/session');

    expect(result.response.status).toBe(200);
    expect(answerOf(result).data.principal_display_name).toBe('Person A');
  });

  // Break caught: the sign-in itself judged stale: it is sent when nobody is signed in and answered before the store is told.
  it('does not refuse the answer of a sign-in, which is sent for no session and answered before the store is told', async () => {
    api.on('POST /auth/staff/setup/credential', () => json(200, { ok: true }));
    const { client, store } = mount();
    expect(store.getState().status).toBe('loading');

    const result = await client.POST('/auth/staff/setup/credential', {
      body: { setup_token: 'synthetic-setup-token', password: 'synthetic-password' },
    });

    expect(result.response.status).toBe(200);
    act(() => {
      store.signedIn(PERSON_A);
    });
    expect(store.getState().status).toBe('signed-in');
  });
});

describe('the scoped client', () => {
  // Break caught: a scoped client with a verb missing, or one that can be added to: the boundary would be skipped by whatever it lacks.
  it('has the verbs of the browser client, and cannot be changed', () => {
    const { client } = mount();

    for (const verb of [
      'GET',
      'PUT',
      'POST',
      'DELETE',
      'OPTIONS',
      'HEAD',
      'PATCH',
      'TRACE',
      'request',
    ]) {
      expect(typeof (client as unknown as Record<string, unknown>)[verb], verb).toBe('function');
    }
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe('ending the session from the page (SessionBoundary.end)', () => {
  function bare() {
    const store = new SessionStore();
    const ended: string[] = [];
    const boundary = new SessionBoundary({
      store,
      onEnded: (code) => {
        ended.push(code);
        store.end();
      },
    });
    return { store, boundary, ended };
  }

  // Break caught: a sign-out that cannot reach the one place the end of a session is handled, and so copies it.
  it('ends the session that is current, with the code it is given, through the same event', () => {
    const { store, boundary, ended } = bare();
    store.signedIn(sessionFixture());

    boundary.end('SIGNED_OUT');

    expect(ended).toEqual(['SIGNED_OUT']);
    expect(store.getState()).toEqual({ status: 'signed-out' });
  });

  // Break caught: ending a session that is not there: the one of whoever signed in next, or nothing at all.
  it('does nothing when nobody is signed in, and nothing a second time', () => {
    const { store, boundary, ended } = bare();

    boundary.end('SIGNED_OUT');
    expect(ended).toEqual([]);

    store.signedIn(sessionFixture());
    boundary.end('SIGNED_OUT');
    boundary.end('SIGNED_OUT');
    expect(ended).toEqual(['SIGNED_OUT']);
  });
});
