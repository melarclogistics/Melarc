import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore } from '../session/session-store';
import { MAX_HOLD_MS } from '../secrets/use-transient-secret';
import { useGrantToken, type GrantToken } from './use-grant-token';

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';

const firstRenders: boolean[] = [];

function Page({ onReady }: { readonly onReady: (grant: GrantToken) => void }) {
  const grant = useGrantToken();
  onReady(grant);
  firstRenders.push(grant.reading);
  return (
    <p>
      {grant.status}: {grant.token ?? '-'}
    </p>
  );
}

function setup(entries: string[], { strict = false }: { strict?: boolean } = {}) {
  let current: GrantToken | undefined;
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  const router = createMemoryRouter(
    [
      {
        path: '/setup/credential',
        element: (
          <Page
            onReady={(grant) => {
              current = grant;
            }}
          />
        ),
      },
      { path: '/sign-in', element: <h1>Sign in</h1> },
      { path: '/', element: <h1>Start</h1> },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  const tree = (
    <SessionProvider store={store}>
      <RouterProvider router={router} />
    </SessionProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return {
    ...view,
    router,
    store,
    grant: () => {
      if (current === undefined) throw new Error('not rendered');
      return current;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGrantToken: reading the link once', () => {
  it('holds the token of the fragment', async () => {
    const { grant } = setup([`/setup/credential#token=${GRANT}`]);

    expect(await screen.findByText(`held: ${GRANT}`)).toBeVisible();
    expect(grant().status).toBe('held');
    expect(grant().token).toBe(GRANT);
  });

  // Break caught (GBT-W16): the token left in the address after it was read, where the next script, extension, screen share or copy of the
  // address would take it.
  it('removes the fragment from the address at once, by replacing the history entry', async () => {
    const { router } = setup(['/', `/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    expect(router.state.location.hash).toBe('');
    expect(router.state.location.pathname).toBe('/setup/credential');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(JSON.stringify(router.state.location)).not.toContain(GRANT);
  });

  // Break caught (GBT-W16): a fragment removed by a new entry, so that the Back button returns to the address that holds the token.
  it('leaves no history entry that holds the token: back then forward finds an address without it', async () => {
    const { router } = setup(['/', `/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);
    const entries: string[] = [];

    await act(async () => {
      await router.navigate(-1);
    });
    entries.push(router.state.location.pathname + router.state.location.hash);
    await act(async () => {
      await router.navigate(1);
    });
    entries.push(router.state.location.pathname + router.state.location.hash);

    expect(entries).toEqual(['/', '/setup/credential']);
  });

  // Break caught: a page with no token acting as if it had one, or a malformed fragment left in the address.
  it.each([
    ['no fragment', '/setup/credential'],
    ['an empty token', '/setup/credential#token='],
    ['another name', '/setup/credential#id=abc'],
    ['two tokens', '/setup/credential#token=a&token=b'],
    ['a token with a control character', '/setup/credential#token=%00'],
  ])('holds nothing for %s', async (_name, entry) => {
    const { grant, router } = setup([entry]);

    expect(await screen.findByText('none: -')).toBeVisible();
    expect(grant().token).toBeUndefined();
    expect(router.state.location.hash).toBe('');
  });

  it('does not touch the history of a page opened without a fragment', async () => {
    const { router } = setup(['/', '/setup/credential']);
    await screen.findByText('none: -');

    expect(router.state.historyAction).toBe('POP');
  });

  // Break caught: development's strict mode (an effect run, undone and run again) leaving the page without the token it read, so every
  // link looks broken on the development server and works in the build.
  it('still holds the token when React runs the effects twice, as the development build does', async () => {
    const { grant, router } = setup([`/setup/credential#token=${GRANT}`], { strict: true });

    expect(await screen.findByText(`held: ${GRANT}`)).toBeVisible();
    expect(grant().token).toBe(GRANT);
    expect(router.state.location.hash).toBe('');
  });

  // Break caught: a token that survives a reload, because it was kept for convenience in a place that outlives the page.
  it('holds nothing when the page is rendered again at the address the fragment was removed from', async () => {
    const first = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);
    const address = first.router.state.location.pathname + first.router.state.location.hash;
    first.unmount();

    setup([address]);

    expect(await screen.findByText('none: -')).toBeVisible();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});

describe('useGrantToken: reading', () => {
  // Break caught: a page that shows "this link cannot be used" for the instant before the fragment has been taken, which is the first render
  // of every good link.
  it('says it is still reading while the fragment is in the address, and stops saying so once it is gone', async () => {
    firstRenders.length = 0;
    const { grant } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    expect(firstRenders[0]).toBe(true);
    expect(grant().reading).toBe(false);
  });

  it('is not reading when there is no fragment', async () => {
    firstRenders.length = 0;
    setup(['/setup/credential']);
    await screen.findByText('none: -');

    expect(firstRenders.every((reading) => !reading)).toBe(true);
  });
});

describe('useGrantToken: letting go', () => {
  it('lets go at once on completion', async () => {
    const { grant } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    act(() => {
      grant().clear();
    });

    expect(grant().status).toBe('none');
    expect(grant().token).toBeUndefined();
    expect(document.body.textContent).not.toContain(GRANT);
  });

  // Break caught: the page's own removal of the fragment counted as the person leaving, which would drop the token it had just read.
  it('keeps the token through its own rewriting of the address', async () => {
    const { grant, router } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    await act(async () => {
      await router.navigate('/setup/credential?again=1', { replace: true });
    });

    expect(grant().token).toBe(GRANT);
  });

  // Break caught: the token still held once the person has gone to another page.
  it('lets go when the person goes to another page, and does not bring it back with the back button', async () => {
    const { router } = setup(['/', `/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    await act(async () => {
      await router.navigate('/sign-in');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(document.body.textContent).not.toContain(GRANT);

    await act(async () => {
      await router.navigate(-1);
    });
    expect(await screen.findByText('none: -')).toBeVisible();
    expect(document.body.textContent).not.toContain(GRANT);
  });

  // Break caught: a token kept past the bound the page holds a secret for, whatever the server would still accept.
  it('lets go when the time a secret may be held is up, and says that it expired', async () => {
    const { grant } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    act(() => {
      vi.advanceTimersByTime(MAX_HOLD_MS);
    });

    expect(grant().status).toBe('expired');
    expect(grant().token).toBeUndefined();
  });

  // Break caught: the page, with the token in it, kept by the browser's back-forward cache and shown again.
  it('lets go when the page is hidden', async () => {
    const { grant } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });

    expect(grant().token).toBeUndefined();
  });

  // Break caught: a token that outlives the session it was read in.
  it('lets go when the session changes', async () => {
    const { grant, store } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    act(() => {
      store.end();
    });

    expect(grant().token).toBeUndefined();
  });
});

describe('useGrantToken: nowhere else', () => {
  it('puts the token in no storage, cookie or address while it is held, and no copy in the history state', async () => {
    const { router } = setup([`/setup/credential#token=${GRANT}`]);
    await screen.findByText(`held: ${GRANT}`);

    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(GRANT);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(GRANT);
    expect(document.cookie).not.toContain(GRANT);
    expect(window.location.href).not.toContain(GRANT);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(GRANT);
    expect(JSON.stringify(router.state)).not.toContain(GRANT);
    expect(document.title).not.toContain(GRANT);
  });
});
