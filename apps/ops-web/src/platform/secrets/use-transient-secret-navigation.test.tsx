import { act, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import {
  createMemoryRouter,
  MemoryRouter,
  Outlet,
  RouterProvider,
  type RouteObject,
} from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { NeverReady } from '../../test-support/never-ready';
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

describe('useTransientSecret: asked to let go when the router moves, with no data router (run 7, Stage 2.4)', () => {
  function withoutADataRouter(release: boolean): void {
    const store = new SessionStore();
    store.signedIn(sessionFixture());
    render(
      <SessionProvider store={store}>
        <MemoryRouter initialEntries={['/a']}>
          <Holder
            onReady={() => {
              // Nothing is done with the secret.
            }}
            release={release}
          />
        </MemoryRouter>
      </SessionProvider>,
    );
  }

  // Break caught: the request silently ignored where no data router is present (a test, the showcase, a root that was changed), so that a page that asks for the early release has none in
  // the place where nothing proves it, and a Back could draw the secret again with nothing to say so.
  it('fails loudly, in development and in tests, instead of doing nothing', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => {
        withoutADataRouter(true);
      }).toThrow(/data router/);
    } finally {
      quiet.mockRestore();
    }
  });

  it('is quiet for a screen that did not ask for the early release', () => {
    withoutADataRouter(false);

    expect(screen.getByText('none: -')).toBeInTheDocument();
  });
});

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

describe('useTransientSecret: Back and Forward while the next page is awaited', () => {
  // Break caught (the review of f6cf02b: Back and Forward tests for the early release): the secret on the screen again when the person presses Back, or Forward, in the moment the page they
  // went to has not appeared (the WebKit run of 9 November 2026: the enrolment code came back after the Back button). The router returns to the page that held it, and it holds nothing.
  it('does not bring the secret back with Back, or with Forward', async () => {
    const { router, secret } = setup((onReady) => [
      { path: '/a', element: <Holder onReady={onReady} /> },
      { path: '/b', element: <NeverReady /> },
    ]);
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });
    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });
    expect(screen.getByText('none: -')).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe('/a');
    expect(screen.getByText('none: -')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SENTINEL');

    await act(async () => {
      await router.navigate(1);
    });
    expect(router.state.location.pathname).toBe('/b');
    expect(screen.getByText('none: -')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SENTINEL');
  });
});

/** A layout that holds the secret for the family of addresses under `/a`, as the pre-sign-in layout does, and says whether the page is on its way out. */
function LayoutHolder({
  onReady,
  release = true,
}: {
  readonly onReady: (secret: TransientSecret<string>) => void;
  readonly release?: boolean;
}) {
  const secret = useTransientSecret<string>({
    scope: (location) => (location.pathname.startsWith('/a') ? 'a' : 'elsewhere'),
    releaseWhenRouterMoves: release,
  });
  onReady(secret);
  return (
    <>
      <p>
        {secret.status}: {secret.value ?? '-'} · moved: {String(secret.moved)}
      </p>
      <Outlet />
    </>
  );
}

describe('useTransientSecret: the page that held the secret while it is on its way out', () => {
  const layout = (
    onReady: (secret: TransientSecret<string>) => void,
    release = true,
  ): RouteObject[] => [
    {
      element: <LayoutHolder onReady={onReady} release={release} />,
      children: [
        { path: '/a', element: <p>Page A</p> },
        { path: '/b', element: <NeverReady /> },
        { path: '/c', element: <p>Page C</p> },
      ],
    },
  ];

  // Break caught: a page that cannot tell that it is leaving, and so does what it does when its secret is gone (sends the person back to a first step, or tells them a link is bad) over the
  // navigation they made. `moved` is true from the moment the router leaves the scope until the new location is drawn.
  it('says it is on its way out while the next page is awaited, and not once that page has been drawn', async () => {
    const { router, secret } = setup((onReady) => layout(onReady));
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });
    expect(screen.getByText(`held: ${SECRET} · moved: false`)).toBeInTheDocument();

    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });
    expect(screen.getByText('none: - · moved: true')).toBeInTheDocument();

    await act(async () => {
      await router.navigate('/c');
    });
    expect(await screen.findByText('Page C')).toBeInTheDocument();
    expect(screen.getByText('none: - · moved: false')).toBeInTheDocument();
  });

  // Break caught: a page left stuck on its way out when the person came back to it before the next page appeared (Back), so that it drew nothing at all.
  it('is not on its way out when the router comes back to what is drawn', async () => {
    const { router, secret } = setup((onReady) => layout(onReady));
    await act(async () => {
      await router.navigate('/a');
    });
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });
    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });
    expect(screen.getByText('none: - · moved: true')).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });

    expect(router.state.location.pathname).toBe('/a');
    expect(screen.getByText('none: - · moved: false')).toBeInTheDocument();
  });

  it('is never on its way out for a screen that did not ask for the early release', async () => {
    const { router, secret } = setup((onReady) => layout(onReady, false));
    act(() => {
      secret().hold(secret().begin(), SECRET, 60_000);
    });
    await act(async () => {
      void router.navigate('/b');
      await Promise.resolve();
    });
    expect(screen.getByText(`held: ${SECRET} · moved: false`)).toBeInTheDocument();
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
