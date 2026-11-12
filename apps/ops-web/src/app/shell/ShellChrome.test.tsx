import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useActiveHub } from '../../platform/hub/active-hub';
import { THEME_STORAGE_KEY } from '../../platform/theme/theme-choice';
import { BUNDLE_KEY_SETS } from '../../test-support/bundle-key-sets';
import {
  errorResponse,
  installFakeApi,
  signedInApi,
  type FakeApi,
} from '../../test-support/fake-api';
import { renderApp } from '../../test-support/render-app';
import { sessionFixture } from '../../test-support/session-fixture';
import { stubViewport } from '../../test-support/viewport';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from '../navigation/route-registry';

/**
 * The shell's chrome as a person meets it: the sidebar at each size, the sheet of a narrow screen, the hub switcher and what follows from a hub
 * chosen, and the theme. (The palette has its own file.) Only the network is replaced; the providers, the router, the frame and the shell are the
 * real ones. What only a real browser can show (the stylesheet's own sizes, the layers, what is under what) is proved in `shell.spec.ts`.
 */
let api: FakeApi;
let viewport: ReturnType<typeof stubViewport> | undefined;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  viewport?.restore();
  viewport = undefined;
  expect(api.unhandled).toEqual([]);
  api.restore();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const ACCRA = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };

/** What a page under the shell shows of the hub chosen: the one place a screen reads it. */
function HubProbe() {
  return <p data-testid="hub">{useActiveHub() ?? 'all'}</p>;
}

const page = (name: string, extra?: React.ReactNode) => (
  <>
    <h1 tabIndex={-1}>{name}</h1>
    {extra}
  </>
);

const REGISTRY: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('My work', <HubProbe />),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'My work', icon: 'my-work', order: 0 },
  },
  {
    path: '/admin/staff',
    element: page('Staff'),
    access: { permission: 'staff.read' },
    menu: { place: 'sidebar', group: 'people', label: 'Staff', icon: 'staff', order: 0 },
  },
  {
    path: '/pickup-requests/new',
    element: page('Book a pickup'),
    access: { permission: 'pickup.request.create' },
    menu: { place: 'create', label: 'Book a pickup', icon: 'book-pickup', order: 0 },
  },
];

function open(
  options: {
    hubs?: readonly { id: string; display_name: string }[];
    path?: string;
    handlers?: Parameters<typeof installFakeApi>[0];
  } = {},
) {
  api = installFakeApi({
    ...signedInApi(
      sessionFixture({
        permissions: [...BUNDLE_KEY_SETS['Senior Ops']],
        principal_display_name: 'Ama Mensah',
        authorized_hubs: [...(options.hubs ?? [ACCRA])],
      }),
    ),
    ...options.handlers,
  });
  return renderApp(options.path ?? '/', [], REGISTRY);
}

/** The `hub_id` of each read of the queue summary so far, in order: `null` where none was sent. */
const summaryHubs = () =>
  api.requests
    .filter((request) => new URL(request.url).pathname === '/api/v1/ops/queue-summary')
    .map((request) => new URL(request.url).searchParams.get('hub_id'));
const summaryReads = () => summaryHubs().length;
const sidebar = () => screen.getByRole('complementary', { name: 'Main menu' });
const bar = () => screen.getByRole('banner');

describe('the sidebar at each size', () => {
  // Break caught: a desktop that opens on the rail, or a sidebar without its lockup.
  it('is the full sidebar from 1280px: the lockup, the names, and a button that collapses it', async () => {
    viewport = stubViewport('wide');
    open();
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(sidebar()).toHaveAttribute('data-rail', 'false');
    expect(within(sidebar()).getByRole('img', { name: 'Melarc Logistics' })).toBeVisible();
    expect(within(sidebar()).getByRole('button', { name: 'Collapse menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // Break caught: the rail below 1280px not being the default (the sidebar would take 248px of a 768px window).
  it('is the rail below 1280px, with the names kept and a button that expands it', async () => {
    viewport = stubViewport('medium');
    open();
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(sidebar()).toHaveAttribute('data-rail', 'true');
    expect(within(sidebar()).queryByRole('img', { name: 'Melarc Logistics' })).toBeNull();
    expect(screen.getByRole('link', { name: 'My work' })).toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'Expand menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // Break caught: the person's choice undone by a re-render, kept in the browser (nothing is stored but the theme), or lost on a change of page.
  it('collapses and expands on demand, keeps the choice across pages, and stores nothing', async () => {
    viewport = stubViewport('wide');
    const { user } = open();
    await screen.findByRole('navigation', { name: 'Primary' });

    await user.click(within(sidebar()).getByRole('button', { name: 'Collapse menu' }));
    expect(sidebar()).toHaveAttribute('data-rail', 'true');

    await user.click(screen.getByRole('link', { name: 'Staff' }));
    await screen.findByRole('heading', { level: 1, name: 'Staff' });
    expect(sidebar()).toHaveAttribute('data-rail', 'true');

    await user.click(within(sidebar()).getByRole('button', { name: 'Expand menu' }));
    expect(sidebar()).toHaveAttribute('data-rail', 'false');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('lets a person who expanded the rail on a tablet keep it expanded', async () => {
    viewport = stubViewport('medium');
    const { user } = open();
    await screen.findByRole('navigation', { name: 'Primary' });

    await user.click(within(sidebar()).getByRole('button', { name: 'Expand menu' }));

    expect(sidebar()).toHaveAttribute('data-rail', 'false');
    expect(within(sidebar()).getByRole('img', { name: 'Melarc Logistics' })).toBeVisible();
  });

  // Break caught: the sidebar docked on a phone (it would take the screen), or no way to the menu.
  it('is a sheet on a narrow screen: no docked sidebar, and the top bar’s button opens it', async () => {
    viewport = stubViewport('narrow');
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(screen.queryByRole('complementary', { name: 'Main menu' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    const opener = within(bar()).getByRole('button', { name: 'Open menu' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');

    await user.click(opener);

    const sheet = await screen.findByRole('dialog', { name: 'Main menu' });
    expect(within(sheet).getByRole('navigation', { name: 'Primary' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open menu', hidden: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // Break caught: a sheet left open over the page it was used to go to, or focus left on the button over the new page's heading.
  it('closes the sheet when a link of it is followed, and leaves focus on the new page’s heading', async () => {
    viewport = stubViewport('narrow');
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await user.click(within(bar()).getByRole('button', { name: 'Open menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Main menu' });

    await user.click(within(sheet).getByRole('link', { name: 'Staff' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Staff' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  // Break caught: a sheet left open over the page when the link followed is the entry of the page the person is already on (the closing keyed on a
  // change of path, and a visit to the same address changes none): the person pressed a link and nothing happened. Focus goes back to the button that
  // opened the sheet, as it does when the sheet is dismissed, since no new page took it.
  it('closes the sheet when the link followed is the entry of the page the person is on', async () => {
    viewport = stubViewport('narrow');
    const { user } = open({ path: '/admin/staff' });
    await screen.findByRole('heading', { level: 1, name: 'Staff' });
    const opener = within(bar()).getByRole('button', { name: 'Open menu' });
    await user.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Main menu' });

    await user.click(within(sheet).getByRole('link', { name: 'Staff' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  // Break caught: a sheet left open over a list that has just changed under it, when the link followed leads to the page the person is on with its
  // filters taken off (the same path with another query: the closing keyed on the path alone).
  it('closes the sheet when the link followed leads to the same page with another query', async () => {
    viewport = stubViewport('narrow');
    const { user, router } = open({ path: '/admin/staff?view=all' });
    await screen.findByRole('heading', { level: 1, name: 'Staff' });
    await user.click(within(bar()).getByRole('button', { name: 'Open menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Main menu' });

    await user.click(within(sheet).getByRole('link', { name: 'Staff' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  // Break caught: a sheet that Escape does not close, or that closes with focus dropped on the page (a keyboard user starts again from the top).
  it('closes the sheet with Escape and returns focus to the button that opened it', async () => {
    viewport = stubViewport('narrow');
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    const opener = within(bar()).getByRole('button', { name: 'Open menu' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Main menu' });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
  });

  // Break caught: a sheet left open when the window grows (a rotated tablet) with no way to close what is no longer a sheet.
  it('closes the sheet when the window grows past the narrow size', async () => {
    viewport = stubViewport('narrow');
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await user.click(within(bar()).getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('dialog', { name: 'Main menu' });

    act(() => {
      viewport?.resize('wide');
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sidebar()).toHaveAttribute('data-rail', 'false');
  });

  // Break caught: the theme control drawn twice on a phone, where the top bar has no room (the account menu has the choice).
  it('keeps the theme control out of the top bar on a narrow screen, and in the account menu', async () => {
    viewport = stubViewport('narrow');
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(within(bar()).queryByRole('button', { name: /^Theme:/ })).toBeNull();
    await user.click(within(bar()).getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
  });
});

describe('the hub switcher in the shell', () => {
  // Break caught: a switcher drawn for a session with one hub (a control with nothing to choose), or no name of where the person acts.
  it('names the hub of a session that has one, with nothing to choose', async () => {
    open({ hubs: [ACCRA] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(within(bar()).queryByRole('button', { name: /^Hub:/ })).toBeNull();
    expect(within(bar()).getByText('Accra Hub')).toBeVisible();
    expect(screen.getByTestId('hub')).toHaveTextContent('all');
  });

  // Break caught: a session that reaches two hubs starting on one: the other hub's work would be hidden from the menu's counts and from My work.
  it('starts a session that lists several hubs on All hubs, and lists them', async () => {
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    const switcher = within(bar()).getByRole('button', { name: 'Hub: All hubs' });
    expect(screen.getByTestId('hub')).toHaveTextContent('all');
    await user.click(switcher);

    expect(
      within(await screen.findByRole('menu'))
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['All hubs', 'Accra Hub', 'Kumasi Hub']);
  });

  // Break caught: the choice not reaching the one place a screen reads it, or All hubs not taking it back.
  it('sets the hub a screen reads when a hub is chosen, and clears it for All hubs', async () => {
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    await user.click(within(bar()).getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    expect(screen.getByTestId('hub')).toHaveTextContent(KUMASI.id);
    expect(within(bar()).getByRole('button', { name: 'Hub: Kumasi Hub' })).toBeVisible();

    await user.click(within(bar()).getByRole('button', { name: 'Hub: Kumasi Hub' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));
    expect(screen.getByTestId('hub')).toHaveTextContent('all');
  });

  // Break caught: the counts of the menu and My work left as they were when the person changes hub, or asked for another hub than the one chosen:
  // they follow the switcher (task C3: the summary takes the hub, and the choice is part of what is asked; `AC-HUBF-09`, and the read on a change of
  // hub of `AC-QSUM-09`).
  it('asks the queue summary for the hub chosen, and again only when the hub is another', async () => {
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await waitFor(() => {
      expect(summaryReads()).toBe(1);
    });
    expect(summaryHubs()).toEqual([null]);

    await user.click(within(bar()).getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Accra Hub' }));
    await waitFor(() => {
      expect(summaryReads()).toBe(2);
    });
    expect(summaryHubs()).toEqual([null, ACCRA.id]);

    await user.click(within(bar()).getByRole('button', { name: 'Hub: Accra Hub' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Accra Hub' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(summaryReads()).toBe(2);
  });

  // Break caught: the hub chosen kept in the browser: a hub is not what the portal stores.
  it('keeps the choice in memory only', async () => {
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    await user.click(within(bar()).getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });

  // Break caught: the choice following a person to another page of the shell being lost, or sent anywhere: it lasts as long as the session.
  it('lasts across the pages of the shell', async () => {
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await user.click(within(bar()).getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    await user.click(screen.getByRole('link', { name: 'Staff' }));
    await screen.findByRole('heading', { level: 1, name: 'Staff' });
    await user.click(screen.getByRole('link', { name: 'My work' }));

    expect(await screen.findByTestId('hub')).toHaveTextContent(KUMASI.id);
  });
});

describe('the New menu in the shell', () => {
  // Break caught: a create action offered without the key of its page, or the New button drawn for a session that may create nothing.
  it('lists the create pages the session holds the keys of, and goes to one', async () => {
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    await user.click(within(bar()).getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Book a pickup' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Book a pickup' })).toBeVisible();
    // The frame moved focus to the heading, and the menu did not take it back.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Book a pickup' })).toHaveFocus();
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('draws no New button for a session that holds no create key', async () => {
    api = installFakeApi(signedInApi(sessionFixture({ permissions: ['staff.read'] })));
    renderApp('/', [], REGISTRY);
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(within(bar()).queryByRole('button', { name: 'New' })).toBeNull();
  });
});

describe('the theme in the shell', () => {
  // Break caught: a choice that changes the page and is not kept (a reload shows the other theme), or kept and not shown.
  it('puts a chosen theme on the root and keeps it, and System takes both away', async () => {
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await user.click(within(bar()).getByRole('button', { name: 'Theme: System' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(within(bar()).getByRole('button', { name: 'Theme: Dark' })).toBeVisible();

    await user.click(within(bar()).getByRole('button', { name: 'Theme: Dark' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'System' }));

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage).toHaveLength(0);
  });

  // Break caught: the two controls of the theme (the top bar's and the account menu's) disagreeing about what is chosen.
  it('is the same choice in the account menu as in the top bar', async () => {
    const { user } = open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    await user.click(within(bar()).getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(within(bar()).getByRole('button', { name: 'Theme: Light' })).toBeVisible();
    await user.click(within(bar()).getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  // Break caught: a stored choice not applied when the shell opens in a browser where the pre-paint script did not run.
  it('shows a stored choice of theme in the control when the page opens with one', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    document.documentElement.dataset.theme = 'dark';
    open();
    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(within(bar()).getByRole('button', { name: 'Theme: Dark' })).toBeVisible();
  });
});

describe('the shell does not break what is not its own', () => {
  // Break caught: the summary asked for again by the shell's own re-renders (a hub, a theme, a size): the session's 120 requests a minute.
  it('reads the summary once for a page that opens, whatever the person does with the chrome', async () => {
    viewport = stubViewport('wide');
    const { user } = open({ hubs: [ACCRA, KUMASI] });
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await waitFor(() => {
      expect(summaryReads()).toBe(1);
    });

    await user.click(within(sidebar()).getByRole('button', { name: 'Collapse menu' }));
    await user.click(within(bar()).getByRole('button', { name: 'Theme: System' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(summaryReads()).toBe(1);
  });

  it('shows a page the shell cannot read the summary for with no count and a working menu', async () => {
    open({ handlers: { 'GET /ops/queue-summary': () => errorResponse(500, 'INTERNAL_ERROR') } });
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(screen.getByRole('link', { name: 'My work' })).toBeVisible();
    expect(
      screen.getByRole('navigation', { name: 'Primary' }).querySelector('.ui-count-badge'),
    ).toBeNull();
  });
});
