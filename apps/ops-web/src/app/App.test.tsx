import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '../test-support/render-app';
import { wcagViolations } from '../test-support/wcag';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the application shell', () => {
  // Break caught: a shell with no landmarks, so a screen reader user cannot jump to the content.
  it('has a banner naming the product and one main landmark', () => {
    renderApp();

    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Melarc Ops Portal')).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  // Break caught: a navigation, user menu or sign-out appearing before any authentication exists.
  // The Ops Portal specification (surfaces/ops-portal.md §7) says pre-authentication pages render "no
  // navigation, no user menu, no data", and this build has no session at all.
  it('presents no navigation, user menu, sign-out or session data', () => {
    renderApp();

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /sign|log ?(in|out)|account|profile|menu/i }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: /sign|log ?(in|out)|account|profile/i })).toBeNull();
  });

  // Break caught: a landing that implies working functionality or fabricated operational data.
  it('says plainly that it is the application shell and offers no workflow', () => {
    renderApp();

    expect(screen.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    expect(screen.getByText(/application shell only/i)).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  });

  // Break caught: no page title, or two level-one headings, which confuses navigation by heading.
  it('has one level-one heading and a document title', () => {
    renderApp();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Melarc Ops Portal');
  });

  // Break caught: the shell calling the API or a third party, or keeping anything in the browser,
  // before any workflow exists. Nothing may be fabricated, fetched, cached or stored.
  it('makes no network request and stores nothing in the browser', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const { user } = renderApp();

    await user.tab();
    await user.keyboard('{Enter}');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderApp();
    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('keyboard and focus', () => {
  // Break caught: a keyboard user having to tab through the whole header on every page, or a skip link
  // that is not first, or that does nothing.
  it('makes the skip link the first tab stop, and it moves focus into the main content', async () => {
    const { user } = renderApp();

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
    expect(screen.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
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
