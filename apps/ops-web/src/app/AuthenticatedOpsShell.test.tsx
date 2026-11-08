import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUNDLE_KEY_SETS } from '../test-support/bundle-key-sets';
import { installFakeApi, json, signedInApi, type FakeApi } from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from './navigation/route-registry';

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
    element: page('Melarc Ops Portal'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { label: 'Home', icon: 'overview', area: 'overview', order: 0 },
  },
  {
    path: '/admin/staff',
    element: page('Staff identities'),
    access: { permission: 'staff.read' },
    menu: { label: 'Staff identities', icon: 'staff', area: 'administration', order: 10 },
  },
  {
    path: '/admin/vendors',
    element: page('Vendor accounts'),
    access: { permission: 'vendor.read' },
    menu: { label: 'Vendor accounts', icon: 'sessions', area: 'administration', order: 20 },
  },
];

const signInStandIn = [{ path: 'sign-in', element: <h1 tabIndex={-1}>Sign-in stand-in</h1> }];

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
  // Break caught: a menu inside the main landmark, where the skip link would land on it, or after it, where a keyboard user finds it
  // last. The skip link, then the menu, then the main content is the order of the page.
  it('draws the side menu, with the navigation and the sign-out control, before the main content and outside it', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    const menu = screen.getByRole('complementary', { name: 'Main menu' });
    const main = screen.getByRole('main');
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(skip, menu)).toBe(true);
    expect(follows(menu, main)).toBe(true);
    expect(menu).toContainElement(navigation());
    expect(menu).toContainElement(screen.getByRole('button', { name: 'Sign out' }));
    expect(main).not.toContainElement(menu);
  });

  // Break caught: a signed-in screen that still draws the neutral frame's banner above the menu (the product named twice, the page a
  // website with a header), or the frame left in the sidebar layout when the shell has gone.
  it('is drawn in the frame’s sidebar layout, with no banner, and the frame is neutral again when it leaves', async () => {
    const { container, router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(container.querySelector('.app-frame')).toHaveClass('app-frame--sidebar');
    // No frame banner above the menu. The one banner left is the menu's own slim bar, which the stylesheet shows on a narrow screen alone.
    expect(container.querySelector('.app-header')).toBeNull();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getByRole('banner')).toHaveClass('ui-side-menu__bar');
    expect(screen.getByRole('main')).toHaveClass('app-main--sidebar');

    await act(async () => {
      await router.navigate('/sign-in');
    });

    await screen.findByRole('heading', { name: 'Sign-in stand-in' });
    expect(container.querySelector('.app-frame')).toHaveClass('app-frame--neutral');
    expect(screen.getByRole('banner')).toHaveTextContent('Ops Portal');
  });

  // Break caught: the page behind a menu that slid in over it left reachable, so that Tab walks out of the menu into the page.
  it('makes the page behind the sliding menu inert while it is open, and no longer', async () => {
    const { user } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });
    const main = screen.getByRole('main');
    expect(main).not.toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(main).toHaveAttribute('inert');

    await user.keyboard('{Escape}');
    expect(main).not.toHaveAttribute('inert');
  });

  it('names the current page in the navigation for assistive technology', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Staff identities' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  // Break caught: an account card that prints "null" for a person who has no display name, a hub nobody listed, or a role (the session
  // names none, and a role is never read from it).
  it('says in the account card who is signed in and where they act, and only what the session says', async () => {
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
    expect(screen.getByText('staff.read')).toBeVisible();
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

  // The stylesheet shows the menu button only on a narrow screen and the collapse button only on a wide one, and jsdom applies no
  // stylesheet, so the walk here sees all of them; the real order for each size is walked in a browser (shell.spec.ts).
  it('is walked by Tab in the order of the page: skip link, the menu’s controls, entries, sign-out', async () => {
    const { user } = open(['staff.read']);
    await screen.findByRole('navigation', { name: 'Primary' });

    const stops: string[] = [];
    for (let step = 0; step < 7; step += 1) {
      await user.tab();
      const active = document.activeElement;
      stops.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }

    expect(stops).toEqual([
      'Skip to main content',
      'Open menu',
      'Collapse menu',
      'Close menu',
      'Home',
      'Staff identities',
      'Sign out',
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
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('is not around a page that sits outside the signed-in routes', async () => {
    open(BUNDLE_KEY_SETS['Senior Ops'], '/sign-in');

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('leaves with the person: going to a page outside it takes the navigation away', async () => {
    const { router } = open(BUNDLE_KEY_SETS['Senior Ops']);
    await screen.findByRole('navigation', { name: 'Primary' });

    await act(async () => {
      await router.navigate('/sign-in');
    });

    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();

    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByRole('heading', { name: 'Sign-in stand-in' })).toBeVisible();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('is the real registry’s entries: the screens that are built, for the keys the session holds', async () => {
    api = installFakeApi({
      ...signedInApi(sessionFixture({ permissions: [...BUNDLE_KEY_SETS['Platform Admin']] })),
      // The landing of a person who works the approval queue reads it.
      'GET /staff-identities': () => json(200, { items: [], next_page_token: null }),
    });
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Primary' });

    expect(entries()).toEqual([
      'Overview',
      'Pickup requests',
      'Book a pickup',
      'Exceptions to approve',
      'Messages',
      'Manifests',
      'Build a manifest',
      'Staff',
      'Add a staff profile',
      'Sessions',
      'Vendors',
      'Riders',
      'Trusted browsers',
    ]);
  });
});
