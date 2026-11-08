import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, signedInApi, type FakeApi } from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';

// The shell is tested as a signed-in person finds it: the landing is behind the session guard (S0.38), so the API says
// who is signed in. Only the network is replaced; the client, the router and the providers are the real ones.
let api: FakeApi;

beforeEach(() => {
  api = installFakeApi(signedInApi(sessionFixture()));
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
});

const landing = () => screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' });
const notFound = () => screen.findByRole('heading', { level: 1, name: 'Page not found' });

describe('the application shell', () => {
  // Break caught: a frame with no landmarks, so a screen reader user cannot jump to the content, or a banner that does
  // not name the product: the logo is the only thing that says "Melarc", so it carries the name (DESIGN_SYSTEM 26.1). This is the
  // neutral frame, which an address that matches no route has (the signed-in screens have a side menu instead, and no banner).
  it('has a banner naming the product, with the logo, and one main landmark', async () => {
    renderApp('/no-such-page');
    await notFound();

    const banner = screen.getByRole('banner');
    const logo = within(banner).getByRole('img', { name: 'Melarc Logistics' });
    expect(logo).toBeVisible();
    expect(logo.getAttribute('src')).toMatch(/melarc-logo-primary.*\.svg/);
    expect(within(banner).getByText('Ops Portal')).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  // Break caught: the logo made a link or a button (it identifies and does not navigate: DESIGN_SYSTEM 25), or given a
  // second name by the page, which a screen reader would then read twice.
  it('does not make the logo a link or announce the name twice', async () => {
    renderApp('/no-such-page');
    await notFound();

    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('link')).toBeNull();
    expect(within(banner).queryByRole('button')).toBeNull();
    expect(within(banner).getAllByRole('img')).toHaveLength(1);
    expect(banner.textContent).toBe('Ops Portal');
  });

  // Break caught: a navigation, user menu or sign-out appearing in the neutral frame. The Ops Portal specification
  // (surfaces/ops-portal.md §7) says pre-authentication pages render "no navigation, no user menu, no data"; the signed-in
  // shell with them (S0.42) is drawn only around the signed-in routes, so an address that matches no route, which cannot know
  // whether a session exists, has none, even for a person who is signed in.
  it('presents no navigation, user menu or sign-out in the neutral frame', async () => {
    renderApp('/no-such-page');
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /sign|log ?(in|out)|account|profile|menu/i }),
    ).toBeNull();
    expect(
      within(screen.getByRole('banner')).queryByRole('link', {
        name: /sign|log ?(in|out)|account|profile/i,
      }),
    ).toBeNull();
  });

  // Break caught: the signed-in landing without the navigation and the sign-out control that every signed-in screen carries
  // (surfaces/ops-portal.md §7, `/`), or with them inside the main content, or with the neutral frame's banner above the menu.
  it('carries the navigation and the sign-out control of the authenticated shell on the landing, in the side menu and not in the page', async () => {
    const { container } = renderApp();
    await landing();

    const menu = screen.getByRole('complementary', { name: 'Main menu' });
    const nav = within(menu).getByRole('navigation', { name: 'Primary' });
    const signOut = within(menu).getByRole('button', { name: 'Sign out' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('main')).not.toContainElement(menu);
    expect(container.querySelector('.app-header')).toBeNull();
    expect(menu).toContainElement(signOut);
  });

  // Break caught: a landing that implies working functionality or fabricated operational data. It says who is signed
  // in, in the session's words, and that nothing is waiting; it has no workflow to offer yet.
  it('is the signed-in landing: who is signed in, and no workflow', async () => {
    renderApp();

    expect(await landing()).toBeVisible();
    // The page says who is signed in, and so does the account card of the menu: the page's words are the ones this is about.
    expect(within(screen.getByRole('main')).getByText('Synthetic Officer')).toBeVisible();
    expect(screen.getByText('Nothing is waiting.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  // Break caught: no page title, or two level-one headings, which confuses navigation by heading.
  it('has one level-one heading and a document title', async () => {
    renderApp();
    await landing();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Melarc Ops Portal');
  });

  // Break caught: the shell calling the API for anything but who is signed in, calling a third party, or keeping
  // anything in the browser. The one request is the session read, to this origin's API; the session itself is an
  // HttpOnly cookie the page cannot see, so nothing about it may be stored in script-readable storage either.
  it('reads who is signed in once, makes no other request and stores nothing in the browser', async () => {
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const { user } = renderApp();
    await landing();

    await user.tab();
    await user.keyboard('{Enter}');

    expect(
      api.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual(['GET /api/v1/auth/session']);
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderApp();
    await landing();
    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('keyboard and focus', () => {
  // Break caught: a keyboard user having to tab through the whole header on every page, or a skip link
  // that is not first, or that does nothing.
  it('makes the skip link the first tab stop, and it moves focus into the main content', async () => {
    const { user } = renderApp();
    await landing();

    await user.tab();
    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  // Break caught: focus left on a link that no longer exists after a client-side navigation, so a
  // screen reader says nothing about the new page (surfaces/ops-portal.md §11: status messages must be
  // announced), or focus stolen on first load.
  it('does not move focus on first load, and moves it to the new page heading after navigation', async () => {
    const { router } = renderApp();
    await landing();
    expect(document.body).toHaveFocus();

    await act(async () => {
      await router.navigate('/no-such-page');
    });

    const heading = await screen.findByRole('heading', { level: 1, name: 'Page not found' });
    expect(heading).toHaveFocus();
  });
});

describe('unknown routes', () => {
  // Break caught: a blank screen, or the home page, for an address that does not exist.
  it('show a page-not-found page with a way home, and set the document title', async () => {
    const { user } = renderApp('/definitely/not/a/page');

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(document.title).toBe('Page not found · Melarc Ops Portal');

    await user.click(screen.getByRole('link', { name: 'Go to the start page' }));
    expect(await landing()).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderApp('/definitely/not/a/page');
    expect(await wcagViolations(container)).toEqual([]);
  });
});

/**
 * A page that fails for as long as a fault is present, like an outage that is fixed later. A flag is
 * used, not a count of attempts, because React itself retries a failed first render once.
 */
const fault = { present: true, renders: 0 };

function FlakyPage() {
  fault.renders += 1;
  if (fault.present) {
    throw new Error('connect failed postgres://melarc:hunter2@db.internal/melarc token=abc123');
  }
  return <h1 tabIndex={-1}>Recovered page</h1>;
}

const flakyRoute = [{ path: 'flaky', element: <FlakyPage /> }];

describe('a page that fails', () => {
  beforeEach(() => {
    fault.present = true;
    fault.renders = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  // Break caught: the diagnostic message (which can carry credentials or personal data) shown to the user.
  // surfaces/ops-portal.md §8: the error state maps a code to copy and "never shows the diagnostic message".
  it('shows an announced, generic message and never the error text', async () => {
    renderApp('/flaky', flakyRoute);

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/hunter2|postgres|abc123|connect failed/);
    expect(document.title).toBe('Something went wrong · Melarc Ops Portal');
  });

  // Break caught: an error screen with no way forward, or one that merges "what happened" and "try
  // again" (surfaces/ops-portal.md §8: retry is an explicit action, distinct from the error itself).
  it('offers an explicit retry that recovers when the fault was transient', async () => {
    const { user } = renderApp('/flaky', flakyRoute);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    fault.present = false;
    await user.click(retry);

    expect(await screen.findByRole('heading', { level: 1, name: 'Recovered page' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: a retry button that does nothing, or one that leaves a blank page or the error text
  // behind when the fault is still there.
  it('tries the page again on retry and shows the same generic message when it fails again', async () => {
    const { user } = renderApp('/flaky', flakyRoute);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    const rendersBefore = fault.renders;

    await user.click(retry);
    await waitFor(() => {
      expect(fault.renders).toBeGreaterThan(rendersBefore);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/hunter2|postgres|abc123|connect failed/);
  });

  // Break caught: a failed page's error message sticking to every page the user goes to next.
  it('shows the next page normally when the user leaves a page that failed', async () => {
    const { router } = renderApp('/flaky', flakyRoute);
    await screen.findByRole('alert');

    await act(async () => {
      await router.navigate('/');
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: the retry button disappearing while it holds focus, which drops a keyboard user back
  // to the top of the document.
  it('keeps keyboard focus on the page content when the retry succeeds', async () => {
    const { user } = renderApp('/flaky', flakyRoute);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    fault.present = false;
    await user.click(retry);
    await screen.findByRole('heading', { level: 1, name: 'Recovered page' });

    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('keeps the frame, so the user still has the skip link and a banner', async () => {
    renderApp('/flaky', flakyRoute);

    await screen.findByRole('alert');
    expect(screen.getByRole('banner')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderApp('/flaky', flakyRoute);

    await screen.findByRole('alert');
    expect(await wcagViolations(container)).toEqual([]);
  });
});
