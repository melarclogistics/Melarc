import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUNDLE_KEY_SETS } from '../test-support/bundle-key-sets';
import { installFakeApi, json, signedInApi, type FakeApi } from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';
import { dismissToast, showToast } from '../components/ui/toast/Toast';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from './navigation/route-registry';
import { cannotText } from '../platform/problem/capability-words';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const page = (name: string) => (
  <>
    <h1 tabIndex={-1}>{name}</h1>
    <p>The {name} page</p>
  </>
);

/** Routes that exist only in these tests, with the permission each needs. None is a route of the product. */
const REGISTRY: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('My work'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'Home', icon: 'my-work', order: 0 },
  },
  {
    path: '/admin/staff',
    element: page('Staff identities'),
    access: { permission: 'staff.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Staff identities',
      icon: 'staff',
      order: 0,
    },
  },
  {
    path: '/admin/vendors',
    element: page('Vendor accounts'),
    access: { permission: 'vendor.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Vendor accounts',
      icon: 'sessions',
      order: 1,
    },
  },
];

const signInStandIn = [{ path: 'sign-in', element: <h1 tabIndex={-1}>Sign-in stand-in</h1> }];

/** The places toasts are drawn: Sonner's one region, named "Notifications". */
const toasters = (): NodeListOf<Element> =>
  document.querySelectorAll('section[aria-label^="Notifications"]');

function open(permissions: readonly string[] | undefined, path = '/', routes = REGISTRY) {
  api = installFakeApi(
    signedInApi(
      sessionFixture(
        permissions === undefined ? { permissions: undefined } : { permissions: [...permissions] },
      ),
    ),
  );
  return renderApp(path, signInStandIn, routes);
}

const navigation = () => screen.getByRole('navigation', { name: 'Primary' });
const entries = () =>
  within(navigation())
    .getAllByRole('link')
    .map((link) => link.textContent);

beforeEach(() => {
  api = installFakeApi();
});

describe('the authenticated Ops shell: what it holds', () => {
  // Break caught: a sidebar inside the main landmark, where the skip link would land on it, or after it, where a keyboard user finds it last; a top
  // bar that is not the banner, or is drawn after the page. The skip link, then the sidebar, then the top bar, then the main content is the order.
  it('draws the sidebar and the top bar before the main content and outside it, in the order of the page', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    const sidebar = screen.getByRole('complementary', { name: 'Main menu' });
    const bar = screen.getByRole('banner');
    const main = screen.getByRole('main');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(skip, sidebar)).toBe(true);
    expect(follows(sidebar, bar)).toBe(true);
    expect(follows(bar, main)).toBe(true);
    expect(sidebar).toContainElement(navigation());
    expect(main).not.toContainElement(sidebar);
    expect(main).not.toContainElement(bar);
    expect(bar).not.toContainElement(navigation());
  });

  // Break caught: no toaster in the frame, so that a toast a screen raises is never seen, or two of them, so that every toast is shown twice. The frame draws the one
  // toaster of the application, at the bottom right, and it is still the one after the person has gone to another page of the shell.
  it('draws the one toaster of the application, bottom right, and a toast that is raised is shown once', async () => {
    const { router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(toasters()).toHaveLength(1);
    // It is drawn into the body, outside the main landmark: a sheet that hides the page from assistive technology would otherwise leave the whole of main exposed (a live region is
    // never hidden, and neither is what holds it).
    const region = screen.getByRole('region', { name: /^Notifications/ });
    expect(region.parentElement).toBe(document.body);
    expect(screen.getByRole('main')).not.toContainElement(region);

    act(() => {
      showToast({ tone: 'success', message: 'Request ACC-PR-7KQ2MZ booked.' });
    });
    expect(await screen.findAllByText('Request ACC-PR-7KQ2MZ booked.')).toHaveLength(1);
    const list = document.querySelector('[data-sonner-toaster]');
    expect(list).toHaveAttribute('data-y-position', 'bottom');
    expect(list).toHaveAttribute('data-x-position', 'right');

    await act(async () => {
      await router.navigate('/admin/staff');
    });
    await screen.findByRole('heading', { name: 'Staff identities' });
    expect(toasters()).toHaveLength(1);
    expect(screen.getAllByText('Request ACC-PR-7KQ2MZ booked.')).toHaveLength(1);
    act(() => {
      dismissToast();
    });
  });

  // Break caught: the sign-out control missing from a signed-in screen: it lives in the account menu of the top bar, which every screen carries.
  it('carries the account menu on every signed-in screen, and in it the sign-out', async () => {
    const { user } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Account menu' }),
    );

    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  // Break caught: a signed-in screen that still draws the neutral frame's banner above the menu (the product named twice, the page a
  // website with a header), or the frame left in the sidebar layout when the shell has gone.
  it('is drawn in the frame’s sidebar layout, with the top bar as its one banner, and the frame is neutral again when it leaves', async () => {
    const { container, router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(container.querySelector('.app-frame')).toHaveClass('app-frame--sidebar');
    // No frame banner (the logo and the name): the one banner is the top bar.
    expect(container.querySelector('.app-header')).toBeNull();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getByRole('banner')).toHaveClass('ui-topbar');
    expect(screen.getByRole('main')).toHaveClass('app-main--sidebar');

    await act(async () => {
      await router.navigate('/sign-in');
    });

    await screen.findByRole('heading', { name: 'Sign-in stand-in' });
    expect(container.querySelector('.app-frame')).toHaveClass('app-frame--neutral');
    expect(screen.getByRole('banner')).toHaveTextContent('Ops Portal');
    expect(container.querySelector('.ui-topbar')).toBeNull();
    expect(container.querySelector('.ui-sidebar')).toBeNull();
  });

  it('names the current page in the navigation for assistive technology', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Staff identities' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  // Break caught: a foot that prints "null" for a person who has no display name, a hub nobody listed, or a role (the session names none, and a
  // role is never read from it).
  it('says in the foot of the sidebar who is signed in and where they act, and only what the session says', async () => {
    api = installFakeApi(
      signedInApi(
        sessionFixture({
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [
            { id: 'b0b0b0b0-0000-4000-8000-00000000000a', display_name: 'Accra Hub' },
          ],
          permissions: [...BUNDLE_KEY_SETS['Senior Ops']],
        }),
      ),
    );
    renderApp('/', signInStandIn, REGISTRY);
    await screen.findByRole('navigation', { name: 'Primary' });

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Ama Mensah')).toBeVisible();
    expect(within(card).getByText('Accra Hub')).toBeVisible();
    expect(card.textContent).not.toMatch(/Platform Admin|Senior Ops|Ops Staff/);
  });

  it('says how many hubs when there are several, and only "Signed in" for a person with no name and no hub', async () => {
    api = installFakeApi(
      signedInApi(
        sessionFixture({
          principal_display_name: 'Kofi Boateng',
          authorized_hubs: [
            { id: 'b0b0b0b0-0000-4000-8000-00000000000a', display_name: 'Accra Hub' },
            { id: 'b0b0b0b0-0000-4000-8000-00000000000b', display_name: 'Kumasi Hub' },
          ],
          permissions: [...BUNDLE_KEY_SETS['Senior Ops']],
        }),
      ),
    );
    const first = renderApp('/', signInStandIn, REGISTRY);
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(
      within(screen.getByRole('group', { name: 'Your account' })).getByText('2 hubs'),
    ).toBeVisible();
    first.unmount();
    api.restore();

    api = installFakeApi(
      signedInApi(
        sessionFixture({
          principal_display_name: null,
          authorized_hubs: [],
          permissions: [...BUNDLE_KEY_SETS['Senior Ops']],
        }),
      ),
    );
    renderApp('/', signInStandIn, REGISTRY);
    await screen.findByRole('navigation', { name: 'Primary' });

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Signed in')).toBeVisible();
    expect(card.textContent).not.toMatch(/null|undefined|hub/i);
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = open(BUNDLE_KEY_SETS['Platform Admin']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('the authenticated Ops shell: the entries come from the keys the session holds', () => {
  // Break caught: a menu built from a role name instead of keys. A session that holds only staff.read sees the staff entry and not the
  // vendors one, whoever it is.
  it('shows the entries of the keys the session holds, and only those', async () => {
    open(['staff.read']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(entries()).toEqual(['Home', 'Staff identities']);
  });

  it.each([
    ['Ops Staff', ['Home', 'Vendor accounts']],
    ['Senior Ops', ['Home', 'Staff identities', 'Vendor accounts']],
    ['Platform Admin', ['Home', 'Staff identities', 'Vendor accounts']],
    ['Finance/Reconciliation', ['Home', 'Vendor accounts']],
  ] as const)('shows %s the entries its keys allow', async (bundle, expected) => {
    open(BUNDLE_KEY_SETS[bundle]);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(entries()).toEqual(expected);
  });

  it('shows a session that lists no permissions only the entries that need none', async () => {
    open(undefined);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(entries()).toEqual(['Home']);
  });

  // Break caught: hiding an entry taken for enforcement. A route the key does not allow is still reachable by its address, and the page
  // refuses it, naming the permission.
  it('refuses a page by its address when the key is missing, with no entry for it', async () => {
    open(['vendor.read'], '/admin/staff');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(screen.getByText(cannotText('staff.read'))).toBeVisible();
    expect(entries()).toEqual(['Home', 'Vendor accounts']);
  });

  it('goes to a page from the navigation, marks it, and moves focus to its heading', async () => {
    const { user } = open(['staff.read']);
    await screen.findByRole('navigation', { name: 'Primary' });

    await user.click(screen.getByRole('link', { name: 'Staff identities' }));

    const heading = await screen.findByRole('heading', { level: 1, name: 'Staff identities' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(screen.getByRole('link', { name: 'Staff identities' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  // The stylesheet decides nothing about the order here (jsdom applies none): the order of the document is the order of the keyboard. The real
  // order, at each size, is walked in a browser (shell.spec.ts).
  it('is walked by Tab in the order of the page: skip link, the sidebar, then the top bar', async () => {
    const { user } = open(['staff.read']);
    await screen.findByRole('navigation', { name: 'Primary' });

    // A stop is named as an assistive technology names it: by its label, or by its text without what is hidden from it (a picture, a key hint).
    const nameOf = (element: Element | null): string => {
      if (element === null) return '';
      const label = element.getAttribute('aria-label');
      if (label !== null) return label;
      const copy = element.cloneNode(true) as Element;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return copy.textContent.trim();
    };
    const stops: string[] = [];
    for (let step = 0; step < 7; step += 1) {
      await user.tab();
      stops.push(nameOf(document.activeElement));
    }

    expect(stops).toEqual([
      'Skip to main content',
      'Collapse menu',
      'Home',
      'Staff identities',
      'Search a code, name or phone',
      'Theme: System',
      'Account menu',
    ]);
  });
});

describe('the authenticated Ops shell: where it is not', () => {
  // Break caught: the shell around a page that is not a signed-in page. An address that matches no route belongs to none; it cannot
  // know whether a session exists, so it uses the neutral frame.
  it('is not around an unknown address, even for a person who is signed in', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops'], '/no-such-page');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('is not around a page that sits outside the signed-in routes', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops'], '/sign-in');

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  // Break caught: a toaster drawn for a person who is not signed in (nothing there raises a toast), or a toaster that stays when the person leaves the shell and the
  // next screen draws another.
  it('has no toaster where it is not, and takes its toaster with it', async () => {
    const { router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(toasters()).toHaveLength(1);

    await act(async () => {
      await router.navigate('/sign-in');
    });

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(toasters()).toHaveLength(0);
  });

  // Break caught: the showcase, which mounts a toaster of its own, drawn inside the frame that has one, so that its toasts are shown twice. The showcase's routes are
  // beside the shell and not under it, so exactly one toaster is drawn there; and a second one mounted anywhere draws nothing (Toast.test.tsx), so that this holds
  // whoever is added to the route tree.
  it('is not around the showcase, which has its own toaster: one toaster there, and a toast is shown once', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops'], '/__showcase/kit/menus');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Kit showcase' }, { timeout: 10_000 }),
    ).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(toasters()).toHaveLength(1);
    act(() => {
      showToast({ tone: 'info', message: 'Raised on the showcase.' });
    });
    expect(await screen.findAllByText('Raised on the showcase.')).toHaveLength(1);
    act(() => {
      dismissToast();
    });
  });

  it('leaves with the person: going to a page outside it takes the navigation away', async () => {
    const { router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    await act(async () => {
      await router.navigate('/sign-in');
    });

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  // Break caught: a menu or a sign-out control shown to somebody the API has not yet said is signed in, even for a moment.
  it('shows nothing of itself while the session is being asked about, or when nobody is signed in', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api = installFakeApi({
      'GET /auth/session': async () => {
        await held;
        return new Response(
          JSON.stringify({ code: 'SESSION_INVALID', message: 'x', request_id: 'r' }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });
    renderApp('/', signInStandIn, REGISTRY);

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();

    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('is the real registry’s entries: the screens that are built, in the groups of the hub’s day, for the keys the session holds', async () => {
    api = installFakeApi({
      ...signedInApi(sessionFixture({ permissions: [...BUNDLE_KEY_SETS['Platform Admin']] })),
      // The page of a person who works the approval queue reads it.
      'GET /staff-identities': () => json(200, { items: [], next_page_token: null }),
    });
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Primary' });

    const groups = within(navigation())
      .getAllByRole('list')
      .map((list) => [
        list.getAttribute('aria-label') ??
          document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent,
        within(list)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ]);
    expect(groups).toEqual([
      ['Today', ['My work', 'Decisions']],
      ['Pickups', ['Requests', 'Pickup runs']],
      ['People and access', ['Staff', 'Riders', 'Vendors', 'Sessions']],
      ['System', ['Message log']],
    ]);
  });
});

describe('the authenticated Ops shell: its toasts across sessions (task R5.2, H2)', () => {
  // Break caught: a toast with an action (which has no end of its own) shown again by the next shell: Sonner keeps its toasts in one store for the page, and shows every
  // active one to a toaster that mounts later, so what one person was told appears to the next. The shell's toaster takes the toasts with it when it goes.
  it('does not show to the next person a toast raised for the last one', async () => {
    const { router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });
    act(() => {
      showToast({
        tone: 'success',
        message: 'Request ACC-PR-7KQ2MZ confirmed.',
        action: { label: 'Open', onClick: () => undefined },
      });
    });
    expect(await screen.findByText('Request ACC-PR-7KQ2MZ confirmed.')).toBeVisible();

    // The person leaves the shell (the session ends); the next signs in and the shell is drawn again, with a toaster of its own.
    await act(async () => {
      await router.navigate('/sign-in');
    });
    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    await act(async () => {
      await router.navigate('/');
    });
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(toasters()).toHaveLength(1);
    expect(screen.queryByText('Request ACC-PR-7KQ2MZ confirmed.')).toBeNull();
  });
});
