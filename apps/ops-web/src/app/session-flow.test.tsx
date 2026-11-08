import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApiClient } from '../platform/api/api-client';
import { answerOf } from '../platform/api/api-response';
import {
  errorResponse,
  installFakeApi,
  json,
  signedInApi,
  type FakeApi,
} from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  // A request the test did not expect is a failure of the test, not a quiet one of the application.
  expect(api.unhandled).toEqual([]);
  api.restore();
});

/** Stands in for the sign-in screen, which a later task builds, so these tests do not depend on its absence. */
const signInStandIn = [{ path: 'sign-in', element: <h1 tabIndex={-1}>Sign-in stand-in</h1> }];

/** A page, outside the guard, whose query reaches for the API: the way a session is found to have ended. */
function QueryingPage() {
  const client = useApiClient();
  const result = useQuery({
    queryKey: ['somewhere'],
    queryFn: async () =>
      answerOf(
        await client.GET('/auth/sessions', {
          params: { query: { principal_type: 'STAFF', principal_id: 'x' } },
        }),
      ).data,
    retry: false,
  });
  return <h1 tabIndex={-1}>{result.isPending ? 'Asking' : 'Asked'}</h1>;
}

const queryingRoute = [{ path: 'asks', element: <QueryingPage /> }];

describe('a visit to the landing with nobody signed in', () => {
  // Break caught: the landing (or any signed-in page) shown to somebody the API does not know, even for a moment.
  it('asks who is signed in, shows a loading indicator, then goes to sign-in without ever showing the landing', async () => {
    api.on('GET /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    const { router } = renderApp('/', signInStandIn);

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(screen.queryByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeNull();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign-in stand-in' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(api.requests).toHaveLength(1);
  });

  // Break caught: the guard adding to the history, so the back button returns to a page that only redirects: the person
  // is trapped.
  it('replaces the entry, so that back does not return to the guarded page', async () => {
    api.on('GET /auth/session', () => errorResponse(401, 'SESSION_INVALID'));
    const { router } = renderApp('/', signInStandIn);
    await screen.findByRole('heading', { name: 'Sign-in stand-in' });

    expect(router.state.historyAction).toBe('REPLACE');
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  // Break caught: a `401` with no code, or a code the page does not know, being a fault instead of "not signed in".
  it('goes to sign-in for a 401 whatever it says', async () => {
    api.on('GET /auth/session', () => new Response(null, { status: 401 }));
    const { router } = renderApp('/', signInStandIn);

    await screen.findByRole('heading', { name: 'Sign-in stand-in' });
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  // Break caught: the sign-in screen asking the API who is signed in, which puts a request (and a bit of session
  // activity) on the wire for a person who has no session and has not been asked for one.
  it('puts no request on the wire for a page that does not need the session', async () => {
    renderApp('/sign-in', signInStandIn);

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(api.requests).toHaveLength(0);
  });
});

describe('a visit to the landing with somebody signed in', () => {
  // Break caught: a landing that does not say who is signed in and where, the one thing the specification gives it.
  it('shows who is signed in, their hubs, and that nothing is waiting', async () => {
    api = installFakeApi(
      signedInApi(
        sessionFixture({
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [
            { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Central' },
            { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Tema' },
          ],
        }),
      ),
    );
    renderApp('/');

    const heading = await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });
    expect(heading).toBeVisible();
    expect(document.title).toBe('Melarc Ops Portal');
    // The page says who is signed in, and so does the account card of the menu: the page's words are the ones this is about.
    expect(within(screen.getByRole('main')).getByText('Ama Mensah')).toBeVisible();
    const hubs = screen.getByRole('list', { name: 'Your hubs' });
    expect(
      within(hubs)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Accra Central', 'Tema']);
    // `empty` is a success message, not a blank (surfaces/ops-portal.md section 8).
    expect(screen.getByText('Nothing is waiting.')).toBeVisible();
  });

  // Break caught: a landing that implies working functionality, or fabricated figures, in a build that has none.
  it('shows no table, no form and no number the session did not give', async () => {
    api = installFakeApi(signedInApi(sessionFixture()));
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByText(/application shell only/i)).toBeNull();
  });

  // Break caught: a principal without a name or a hub (the contract allows both) breaking the page or printing "null".
  it('copes with a session that has no display name and no hub', async () => {
    api = installFakeApi(
      signedInApi(sessionFixture({ principal_display_name: null, authorized_hubs: [] })),
    );
    renderApp('/');

    await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });
    expect(document.body.textContent).not.toMatch(/null|undefined/);
    expect(screen.getByText('You are signed in.')).toBeVisible();
    expect(screen.getByText('No hub is listed for your session.')).toBeVisible();
  });

  // Break caught: names from the API being treated as markup. A hub or person's name is the server's text.
  it('shows a name as text, whatever it holds', async () => {
    const hostile = '<img src=x onerror="document.title=1">Eve';
    api = installFakeApi(signedInApi(sessionFixture({ principal_display_name: hostile })));
    const { container } = renderApp('/');

    await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });
    // Twice, as text each time: in the page, and in the account card of the menu.
    const shown = screen.getAllByText(hostile);
    expect(shown).toHaveLength(2);
    for (const name of shown) expect(name).toBeVisible();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  // Break caught: the session being read again and again. Each accepted request counts as activity, so an Ops page that
  // polls keeps a session alive that nobody is using (plan section 8, rule 13). One read at the start, none after.
  it('reads the session once and does not poll, refetch on focus or read again on reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api = installFakeApi(signedInApi(sessionFixture()));
      renderApp('/');
      await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      });

      expect(api.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Break caught: no accessible record of the page change, or focus left on a control that has gone.
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    api = installFakeApi(signedInApi(sessionFixture()));
    const { container } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('a 200 that is not a session (U05 of 23 October 2026)', () => {
  // Break caught: a malformed answer taken for a person and shown as the signed-in landing. It is an answer that is not the API's:
  // nobody is signed in on it, no signed-in content is rendered from it (not even for a moment), and a retry recovers normally.
  it.each([
    ['an empty object', {}],
    ['a malformed hub list', { ...sessionFixture(), authorized_hubs: [{ id: 'x' }] }],
    ['a malformed permission list', { ...sessionFixture(), permissions: ['Staff Read'] }],
    ['a session of another kind of principal', { ...sessionFixture(), principal_type: 'VENDOR' }],
  ])(
    'treats %s as unavailable, renders nothing signed-in, and recovers on retry',
    async (_label, body) => {
      let answers = 0;
      api.on('GET /auth/session', () => {
        answers += 1;
        return answers === 1 ? json(200, body) : json(200, sessionFixture());
      });
      const { router, user } = renderApp('/');

      expect(
        await screen.findByRole('heading', { level: 1, name: 'We could not check your session' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/');
      expect(screen.queryByText('Nothing is waiting.')).toBeNull();
      expect(screen.queryByText('Synthetic Officer')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
      ).toBeVisible();
      expect(within(screen.getByRole('main')).getByText('Synthetic Officer')).toBeVisible();
      expect(api.requests).toHaveLength(2);
    },
  );
});

describe('a visit when the session cannot be checked', () => {
  // Break caught: a dropped connection signing the person out, which loses what they were doing, or a blank page.
  it('says so, keeps the person where they are, and signs in on retry', async () => {
    let answers = 0;
    api.on('GET /auth/session', () => {
      answers += 1;
      return answers === 1 ? errorResponse(503, 'SETTING_MISSING') : json(200, sessionFixture());
    });
    const { router, user } = renderApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not check your session' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    expect(document.body.textContent).not.toMatch(/SETTING_MISSING|Diagnostic text/);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
    ).toBeVisible();
    expect(api.requests).toHaveLength(2);
  });

  it('is the same for a request that never got an answer', async () => {
    api.on('GET /auth/session', () => Promise.reject(new TypeError('Failed to fetch')));
    renderApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not check your session' }),
    ).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    api.on('GET /auth/session', () => errorResponse(503, 'SETTING_MISSING'));
    const { container } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'We could not check your session' });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('a session that ends while the person is on a page', () => {
  // Break caught: the specification's rule that any SESSION_INVALID returns to the landing and then to sign-in, with
  // nothing that says why. A page that is open when the session is ended elsewhere must not stay showing the person's
  // data, and must not strand them on a screen whose requests all fail.
  it('goes to the landing and then to sign-in when a request is answered SESSION_INVALID', async () => {
    api = installFakeApi({
      ...signedInApi(sessionFixture({ principal_display_name: 'Ama Mensah' })),
      'GET /auth/sessions': () => errorResponse(401, 'SESSION_INVALID'),
    });
    const { router } = renderApp('/', [...signInStandIn, ...queryingRoute]);
    await within(screen.getByRole('main')).findByText('Ama Mensah');
    const visited: string[] = [];
    router.subscribe((state) => visited.push(state.location.pathname));

    await act(async () => {
      await router.navigate('/asks');
    });

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(visited).toContain('/');
    expect(visited.indexOf('/')).toBeLessThan(visited.lastIndexOf('/sign-in'));
    expect(document.body.textContent).not.toMatch(/Ama Mensah/);
    expect(document.body.textContent).not.toMatch(/expired|ended|SESSION_INVALID/i);
  });

  // Break caught: the previous person's name or permissions still held after the session ended, for the next person to
  // sign in on that tab to find.
  it('leaves nothing of who was signed in, and a landing visited afterwards asks nobody’s name', async () => {
    api = installFakeApi({
      ...signedInApi(sessionFixture({ principal_display_name: 'Ama Mensah' })),
      'GET /auth/sessions': () => errorResponse(401, 'SESSION_SUPERSEDED'),
    });
    const { router } = renderApp('/', [...signInStandIn, ...queryingRoute]);
    await within(screen.getByRole('main')).findByText('Ama Mensah');

    await act(async () => {
      await router.navigate('/asks');
    });
    await screen.findByRole('heading', { name: 'Sign-in stand-in' });
    await act(async () => {
      await router.navigate('/');
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sign-in');
    });
    expect(document.body.textContent).not.toContain('Ama Mensah');
    // The session had ended: the guard did not go back to the API to ask.
    expect(api.requests.filter((request) => request.url.endsWith('/auth/session'))).toHaveLength(1);
  });

  // Break caught: every refusal being taken for the end of a session.
  it('does not end the session for a refused permission', async () => {
    api = installFakeApi({
      ...signedInApi(sessionFixture({ principal_display_name: 'Ama Mensah' })),
      'GET /auth/sessions': () => errorResponse(403, 'PERMISSION_DENIED'),
    });
    const { router } = renderApp('/', [...signInStandIn, ...queryingRoute]);
    await within(screen.getByRole('main')).findByText('Ama Mensah');

    await act(async () => {
      await router.navigate('/asks');
    });
    await screen.findByRole('heading', { name: 'Asked' });

    expect(router.state.location.pathname).toBe('/asks');
  });
});

describe('focus when a guard holds the page back', () => {
  // Break caught: a keyboard or screen reader user following a link to a guarded page and finding focus on the content
  // container for good. The heading did not exist when the navigation happened (the guard was asking who is signed in),
  // so focus was parked, and it must move to the heading when the page arrives or the page change is never announced.
  it('moves focus to the heading of the page when it arrives after the guard let it in', async () => {
    api = installFakeApi(signedInApi(sessionFixture()));
    const { router } = renderApp('/no-such-page');
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });

    await act(async () => {
      await router.navigate('/');
    });

    const heading = await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  // Break caught: focus dragged back to a heading when the person has already moved on, such as to the skip link.
  it('leaves focus alone when the person moved it before the page arrived', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api = installFakeApi({
      'GET /auth/session': async () => {
        await gate;
        return json(200, sessionFixture());
      },
    });
    const { router, user } = renderApp('/no-such-page');
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });

    await act(async () => {
      await router.navigate('/');
    });
    // Focus was parked on the content while the page was held back; Shift+Tab goes back to the skip link before it.
    await user.tab({ shift: true });
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
    await act(async () => {
      release();
      await gate;
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });

    expect(heading).not.toHaveFocus();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });
});

describe('the signed-in landing and the neutral frame', () => {
  it('keeps the frame’s skip link first and moves focus to the heading when the page changes', async () => {
    api = installFakeApi(signedInApi(sessionFixture()));
    const { router } = renderApp('/', signInStandIn);
    await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });

    await act(async () => {
      await router.navigate('/sign-in');
    });

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toHaveFocus();
  });
});
