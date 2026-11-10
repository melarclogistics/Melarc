import { act, render, screen } from '@testing-library/react';
import { Suspense, use } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore } from '../session/session-store';
import { useTransientSecret, type TransientSecret } from './use-transient-secret';

/**
 * A secret is gone **when the person navigates**, and that is when the router moves, not when the page it leads to has been drawn. A page that is slow to appear (a slow machine, a chunk that is
 * still on its way, an engine under load) keeps the old one on the screen while it is awaited, with its secret on it, and a Back in that time would show it again: found by the run of the
 * browser tests in WebKit on 9 November 2026 (riders.spec.ts, "is gone on navigation, and does not return with the back button"), where the code came back after the Back.
 */
const SECRET = 'otpauth://totp/Melarc:test?secret=SENTINELSENTINEL22';

/** A page that is never ready: while it is awaited the router has moved and the page the person left is still what is drawn. */
function NeverReady(): null {
  use(new Promise<never>(() => undefined));
  return null;
}

function Holder({
  onReady,
  release = true,
}: {
  readonly onReady: (secret: TransientSecret<string>) => void;
  readonly release?: boolean;
}) {
  const secret = useTransientSecret<string>({ releaseWhenRouterMoves: release });
  onReady(secret);
  return (
    <p>
      {secret.status}: {secret.value ?? '-'}
    </p>
  );
}

function setup(routes: (onReady: (secret: TransientSecret<string>) => void) => RouteObject[]) {
  let current: TransientSecret<string> | undefined;
  const router = createMemoryRouter(
    routes((secret) => {
      current = secret;
    }),
    { initialEntries: ['/a'] },
  );
  const store = new SessionStore();
  store.signedIn(sessionFixture());
  render(
    <SessionProvider store={store}>
      <Suspense fallback={<p>Loading</p>}>
        <RouterProvider router={router} />
      </Suspense>
    </SessionProvider>,
  );
  const secret = (): TransientSecret<string> => {
    if (current === undefined) throw new Error('not rendered');
    return current;
  };
  return { router, secret };
}

describe('useTransientSecret: a navigation that has begun', () => {
  // Break caught: the secret let go of only once the next page has been drawn, so that it stays on the screen, and comes back with the Back button, for as long as that page is awaited.
  it('lets go of the secret as soon as the router moves, though the page it leads to has not appeared', async () => {
    const { router, secret } = setup((onReady) => [
      { path: '/a', element: <Holder onReady={onReady} /> },
      { path: '/b', element: <NeverReady /> },
    ]);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });
    expect(screen.getByText(`held: ${SECRET}`)).toBeInTheDocument();

    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });

    // The router is at the new page; the old one is still what is drawn, and it no longer holds the secret.
    expect(router.state.location.pathname).toBe('/b');
    expect(screen.getByText('none: -')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SENTINEL');
  });

  // Break caught: the early release made the default, so that a screen which sends the person away when its secret is gone (the sign-in's second step, whose challenge is the secret, sends them
  // back to the first step) did so over the navigation the person made, while it was still mounted (SignInMfaPage.test: "does not sign the person in when they have gone to another page").
  it('does not let go early unless the screen asks for it: the secret stays until the page that held it is replaced', async () => {
    const { router, secret } = setup((onReady) => [
      { path: '/a', element: <Holder onReady={onReady} release={false} /> },
      { path: '/b', element: <NeverReady /> },
    ]);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe('/b');
    expect(screen.getByText(`held: ${SECRET}`)).toBeInTheDocument();
  });

  // Break caught: the fix that lets go on every router event, so that a change of the address's search, which the screen did not scope to, takes a secret away that it should keep.
  it('keeps the secret through a move that the screen scoped out, and lets go of it through one that it did not', async () => {
    let current: TransientSecret<string> | undefined;
    const router = createMemoryRouter(
      [
        {
          path: '/a',
          element: (
            <ScopedHolder
              onReady={(secret) => {
                current = secret;
              }}
            />
          ),
        },
        { path: '/b', element: <NeverReady /> },
      ],
      { initialEntries: ['/a?view=one'] },
    );
    const store = new SessionStore();
    store.signedIn(sessionFixture());
    render(
      <SessionProvider store={store}>
        <Suspense fallback={<p>Loading</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </SessionProvider>,
    );
    const secret = (): TransientSecret<string> => {
      if (current === undefined) throw new Error('not rendered');
      return current;
    };
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });

    // The scope is the path: the search changes and the secret stays.
    await act(async () => {
      void router.navigate('/a?view=two');
      await Promise.resolve();
    });
    expect(screen.getByText(`held: ${SECRET}`)).toBeInTheDocument();

    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });
    expect(screen.getByText('none: -')).toBeInTheDocument();
  });
});

/** A screen that scopes the secret to the path of the address alone. */
function ScopedHolder({
  onReady,
}: {
  readonly onReady: (secret: TransientSecret<string>) => void;
}) {
  const secret = useTransientSecret<string>({
    scope: (location) => location.pathname,
    releaseWhenRouterMoves: true,
  });
  onReady(secret);
  return (
    <p>
      {secret.status}: {secret.value ?? '-'}
    </p>
  );
}
