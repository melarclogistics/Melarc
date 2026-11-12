import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, signedInApi, type FakeApi } from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';

/*
 * The logo in the banner of the frame, which the sign-in screens and the neutral pages carry: the primary logo (a black wordmark) on a light ground and
 * the approved all-white lockup on a dark one (BRAND_FOUNDATION 4.7). Which ground applies is decided as tokens.css decides it: the root's `data-theme`
 * when a person has chosen, and otherwise the system's setting. The neutral frame is drawn at an address that matches no route, which asks for no session.
 */
const PRIMARY = /melarc-logo-primary.*\.svg/;
const DARK = /melarc-logo-dark.*\.svg/;

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi(signedInApi(sessionFixture()));
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  Reflect.deleteProperty(window, 'matchMedia');
  api.restore();
  vi.restoreAllMocks();
});

/**
 * A system that is dark or light, as `window.matchMedia` answers: jsdom has none of its own. The list holds what the app reads (`matches` and the
 * event methods). `addListener` and `removeListener`, the pair the type still declares, are left out on purpose: they are deprecated, nothing here
 * calls them, and typescript-eslint 8.72 reports a stub of either (`no-deprecated`).
 */
function systemIs(theme: 'dark' | 'light'): void {
  window.matchMedia = (query: string) =>
    ({
      matches: theme === 'dark' && query.includes('dark'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

async function bannerLogo(): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: 'Page not found' });
  return within(screen.getByRole('banner')).getByRole('img', { name: 'Melarc Logistics' });
}

describe('the logo in the banner of the frame', () => {
  // Break caught: the white lockup drawn on a light ground, where it cannot be seen, or the primary logo drawn when nothing says the ground is dark.
  it('is the primary logo on a light ground, with or without a system that can be asked', async () => {
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(PRIMARY);
  });

  it('is the primary logo when the system is light and nobody has chosen', async () => {
    systemIs('light');
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(PRIMARY);
  });

  // Break caught: the black wordmark drawn on a dark ground (the system's setting), where it vanishes; this is the one the sign-in screen has when a
  // person's computer is set to dark and the portal has not been told otherwise.
  it('is the all-white lockup when the system is dark and nobody has chosen', async () => {
    systemIs('dark');
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(DARK);
  });

  // Break caught: the choice of a person ignored: dark chosen on a light system, and light chosen on a dark one. The choice wins both ways, as it
  // does in tokens.css.
  it('is the all-white lockup when dark is chosen, even on a light system', async () => {
    systemIs('light');
    document.documentElement.dataset.theme = 'dark';
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(DARK);
  });

  it('is the primary logo when light is chosen, even on a dark system', async () => {
    systemIs('dark');
    document.documentElement.dataset.theme = 'light';
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(PRIMARY);
  });

  // Break caught: a logo read once, at the first paint, so that a theme that changes afterwards (the toggle of step R4, or the system at dusk) leaves
  // the wrong one on the page.
  it('follows the theme while the page is open, in both directions', async () => {
    systemIs('light');
    renderApp('/no-such-page');
    expect((await bannerLogo()).getAttribute('src')).toMatch(PRIMARY);

    act(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await waitFor(() => {
      expect(within(screen.getByRole('banner')).getByRole('img').getAttribute('src')).toMatch(DARK);
    });

    act(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await waitFor(() => {
      expect(within(screen.getByRole('banner')).getByRole('img').getAttribute('src')).toMatch(
        PRIMARY,
      );
    });
  });

  // Break caught: both logos drawn and one hidden by a style (a screen reader would still be offered a second image, and a test of the
  // markup could not tell which one is shown): there is one image, with the product's name, in either theme.
  it('is one image that carries the name once, in either theme', async () => {
    systemIs('dark');
    renderApp('/no-such-page');
    await bannerLogo();

    const banner = screen.getByRole('banner');
    expect(within(banner).getAllByRole('img')).toHaveLength(1);
    expect(banner.querySelectorAll('img')).toHaveLength(1);
    expect(within(banner).queryByRole('link')).toBeNull();
  });
});
