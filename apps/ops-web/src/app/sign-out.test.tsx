import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useSessionStore } from '../platform/session/session-context';
import type { SessionStore } from '../platform/session/session-store';
import { errorResponse, installFakeApi, signedInApi, type FakeApi } from '../test-support/fake-api';
import { describeInterfaceStates, OFFLINE_NOT_APPLICABLE } from '../test-support/interface-states';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from './navigation/route-registry';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const SENTINEL = 'Sentinel Person 7f3a';
const SENTINEL_KEY = ['sentinel'];

let client: QueryClient | undefined;
let store: SessionStore | undefined;

/** A signed-in page that holds the person's data in the query cache, the way a real screen does, and hands the test the cache and the store. */
function Holder() {
  client = useQueryClient();
  store = useSessionStore();
  useQuery({
    queryKey: SENTINEL_KEY,
    queryFn: () => Promise.resolve(SENTINEL),
    staleTime: Infinity,
  });
  return (
    <>
      <h1 tabIndex={-1}>Melarc Ops Portal</h1>
      <p>Signed in as {SENTINEL}.</p>
    </>
  );
}

const REGISTRY: readonly SignedInRoute[] = [
  {
    path: '/',
    element: <Holder />,
    access: ANY_SIGNED_IN_SESSION,
    menu: { label: 'Home', icon: 'staff', area: 'overview', order: 0 },
  },
];

const signInStandIn = [{ path: 'sign-in', element: <h1 tabIndex={-1}>Sign-in stand-in</h1> }];

const SIGN_OUT = '/auth/session';

function open(handlers: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  client = undefined;
  store = undefined;
  api = installFakeApi({
    ...signedInApi(sessionFixture({ principal_display_name: SENTINEL })),
    ...handlers,
  });
  return renderApp('/', signInStandIn, REGISTRY);
}

const signOutButton = () => screen.findByRole('button', { name: 'Sign out' });
const calls = () => api.requests.filter((request) => request.method === 'DELETE');

/** The person is gone: the screen, the cache and the store hold nothing of them. */
function expectNobodyLeft() {
  expect(document.body.textContent).not.toContain(SENTINEL);
  expect(client?.getQueryCache().getAll()).toEqual([]);
  expect(store?.getState()).toEqual({ status: 'signed-out' });
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
}

describe('signing out: it is done', () => {
  // Break caught: a sign-out that clears the screen and leaves the person's data in the cache, for the next person on the browser.
  it('ends the session on the server, clears the cache and the store, and goes to sign-in', async () => {
    const { user, router } = open({
      [`DELETE ${SIGN_OUT}`]: () => new Response(null, { status: 204 }),
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    await waitFor(() => {
      expect(client?.getQueryData(SENTINEL_KEY)).toBe(SENTINEL);
    });

    await user.click(await signOutButton());

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.url).toMatch(/\/api\/v1\/auth\/session$/);
    expectNobodyLeft();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  // Break caught: "the session had already ended" shown to the person as a failure of signing out. They wanted to be out, and they are
  // (surfaces/ops-portal.md section 7): it reads as done. The boundary ends the session once, on this answer, and the sign-out must not end it again.
  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])(
    'reads %s as done: the session had already ended',
    async (code) => {
      const { user } = open({ [`DELETE ${SIGN_OUT}`]: () => errorResponse(401, code) });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
      expectNobodyLeft();
      expect(document.body.textContent).not.toMatch(/did not finish|try again|SESSION_/i);
      expect(
        api.requests.filter(
          (request) => request.url.endsWith('/auth/session') && request.method === 'GET',
        ),
      ).toHaveLength(1);
    },
  );

  it('does not show the landing again on the way: the guard sends the person on to sign-in', async () => {
    const { user, router } = open({
      [`DELETE ${SIGN_OUT}`]: () => new Response(null, { status: 204 }),
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    const visited: string[] = [];
    router.subscribe((state) => visited.push(state.location.pathname));

    await user.click(await signOutButton());
    await screen.findByRole('heading', { name: 'Sign-in stand-in' });

    expect(visited.at(-1)).toBe('/sign-in');
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('signing out: it did not finish', () => {
  // Break caught: telling the person they are signed out while the session may be live: the next person at the keyboard would be
  // using their session. A sign-out that did not finish says so, keeps them signed in and offers to try again.
  it.each([
    ['a refused CSRF check', () => errorResponse(403, 'CSRF_VALIDATION_FAILED')],
    ['a server fault', () => errorResponse(500, 'INTERNAL_ERROR')],
    ['no connection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])(
    'leaves the person signed in, says so, and offers to try again, after %s',
    async (_label, answer) => {
      const { user } = open({ [`DELETE ${SIGN_OUT}`]: answer });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Sign-out did not finish, so you are still signed in.');
      expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
      expect(screen.getByText(`Signed in as ${SENTINEL}.`)).toBeVisible();
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      expect(client?.getQueryData(SENTINEL_KEY)).toBe(SENTINEL);
      expect(store?.getState().status).toBe('signed-in');
      expect(document.body.textContent).not.toMatch(
        /you (have|are) (been )?signed out|Diagnostic text|Failed to fetch/i,
      );
    },
  );

  it('signs out when the person tries again and the second try is answered', async () => {
    let answers = 0;
    const { user } = open({
      [`DELETE ${SIGN_OUT}`]: () => {
        answers += 1;
        return answers === 1
          ? errorResponse(503, 'SETTING_MISSING')
          : new Response(null, { status: 204 });
      },
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    await user.click(await signOutButton());
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(calls()).toHaveLength(2);
    expectNobodyLeft();
  });

  it('can be tried again with the sign-out control itself', async () => {
    let answers = 0;
    const { user } = open({
      [`DELETE ${SIGN_OUT}`]: () => {
        answers += 1;
        return answers === 1
          ? errorResponse(503, 'SETTING_MISSING')
          : new Response(null, { status: 204 });
      },
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    await user.click(await signOutButton());
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
  });

  it('keeps focus on the control, so a keyboard user is not dropped', async () => {
    const { user } = open({ [`DELETE ${SIGN_OUT}`]: () => errorResponse(500, 'INTERNAL_ERROR') });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    const button = await signOutButton();
    button.focus();

    await user.keyboard('{Enter}');
    await screen.findByRole('alert');

    expect(button).toHaveFocus();
  });
});

describe('signing out: once', () => {
  // Break caught: a double click, or Enter held down, sending two sign-outs. The second would be answered SESSION_INVALID and
  // could end the next session's work.
  it('sends one request however often it is pressed while it is under way, and shows itself busy', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = open({
      [`DELETE ${SIGN_OUT}`]: async () => {
        await held;
        return new Response(null, { status: 204 });
      },
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    const button = await signOutButton();

    await user.dblClick(button);
    await user.click(button);

    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(calls()).toHaveLength(1);
    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(calls()).toHaveLength(1);
  });

  // Break caught: the answer of a sign-out sent for one session ending, or failing, another. The session was replaced while the request
  // was in flight: the answer is for a session that has gone, and the person now signed in is left alone.
  it('leaves a session that replaced the one it was sent for alone', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = open({
      [`DELETE ${SIGN_OUT}`]: async () => {
        await held;
        return new Response(null, { status: 204 });
      },
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    await user.click(await signOutButton());

    act(() => {
      store?.end();
      store?.signedIn(
        sessionFixture({ principal_display_name: 'Another Person', permissions: [] }),
      );
    });
    await act(async () => {
      release();
      await held;
      await Promise.resolve();
    });

    expect(store?.getState().status).toBe('signed-in');
    expect(screen.queryByRole('heading', { name: 'Sign-in stand-in' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('signing out: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine, while pending and after a failure', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, container } = open({
      [`DELETE ${SIGN_OUT}`]: async () => {
        await held;
        return errorResponse(500, 'INTERNAL_ERROR');
      },
    });
    await screen.findByText(`Signed in as ${SENTINEL}.`);
    await user.click(await signOutButton());
    expect(await wcagViolations(container)).toEqual([]);

    await act(async () => {
      release();
      await held;
    });
    await screen.findByRole('alert');
    expect(await wcagViolations(container)).toEqual([]);
  });
});

describeInterfaceStates('The sign-out control', {
  loading: {
    test: async () => {
      const { user } = open({
        [`DELETE ${SIGN_OUT}`]: () => new Promise<Response>(() => undefined),
      });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute('aria-busy', 'true');
    },
  },
  empty: { inapplicable: 'A button has no list to be empty; it is a single act.' },
  'validation error': {
    inapplicable: 'Signing out takes no input, so there is nothing to validate.',
  },
  error: {
    test: async () => {
      const { user } = open({ [`DELETE ${SIGN_OUT}`]: () => errorResponse(500, 'INTERNAL_ERROR') });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      expect(await screen.findByRole('alert')).toHaveTextContent(/did not finish/);
    },
  },
  retry: {
    test: async () => {
      const { user } = open({ [`DELETE ${SIGN_OUT}`]: () => errorResponse(500, 'INTERNAL_ERROR') });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The act is idempotent and has no version to conflict on; an answer to a session that has been replaced is dropped, which has its own test above.',
  },
  success: {
    test: async () => {
      const { user } = open({ [`DELETE ${SIGN_OUT}`]: () => new Response(null, { status: 204 }) });
      await screen.findByText(`Signed in as ${SENTINEL}.`);

      await user.click(await signOutButton());

      expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'Every signed-in session may sign out; it needs no permission key (operation signOut: x-permission self).',
  },
});
