import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../test-support/wcag';
import type { NavigationItem } from '../PrimaryNavigation';
import { initialsOf, SideMenu, type SideMenuAccount } from './SideMenu';

const ITEMS: NavigationItem[] = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/admin/staff', label: 'Staff', icon: 'staff' },
  { to: '/admin/sessions', label: 'Sessions', icon: 'sessions' },
];
const ACCOUNT: SideMenuAccount = { name: 'Ama Mensah', detail: 'Accra Hub' };

function renderMenu(
  options: {
    items?: readonly NavigationItem[];
    account?: SideMenuAccount;
    signingOut?: boolean;
    onSignOut?: () => void;
    onOpenChange?: (open: boolean) => void;
    path?: string;
  } = {},
) {
  const {
    items = ITEMS,
    account = ACCOUNT,
    signingOut = false,
    onSignOut = () => undefined,
    onOpenChange,
    path = '/',
  } = options;
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <SideMenu
              items={items}
              account={account}
              signingOut={signingOut}
              onSignOut={onSignOut}
              {...(onOpenChange === undefined ? {} : { onOpenChange })}
            />
            <main tabIndex={-1}>The page</main>
          </>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, user: userEvent.setup() };
}

const root = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.ui-side-menu');
  if (element === null) throw new Error('no menu');
  return element;
};

describe('SideMenu: what it holds', () => {
  // Break caught: a menu that is not a navigation landmark of its own, or that shows the entries without their pictures.
  it('is a main-menu landmark holding the primary navigation, each entry an icon and a name', () => {
    renderMenu();

    const aside = screen.getByRole('complementary', { name: 'Main menu' });
    const nav = within(aside).getByRole('navigation', { name: 'Primary' });
    for (const item of ITEMS) {
      const link = within(nav).getByRole('link', { name: item.label });
      expect(link).toHaveAttribute('href', item.to);
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('marks the current entry', () => {
    renderMenu({ path: '/admin/staff/abc' });

    expect(screen.getByRole('link', { name: 'Staff' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  // Break caught: a name that is the product's wordmark redrawn in text, or a mark that is announced when the name beside it says it.
  it('names the product in plain text beside its mark, and the application under it', () => {
    renderMenu();

    const aside = screen.getByRole('complementary', { name: 'Main menu' });
    expect(within(aside).getByText('Melarc Logistics')).toBeVisible();
    expect(within(aside).getByText('Ops Portal')).toBeVisible();
    for (const image of aside.querySelectorAll('img')) expect(image).toHaveAttribute('alt', '');
  });
});

describe('SideMenu: the account card', () => {
  it('shows who is signed in and where they act, with the initials in the avatar', () => {
    renderMenu();

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Ama Mensah')).toBeVisible();
    expect(within(card).getByText('Accra Hub')).toBeVisible();
    expect(card.querySelector('.ui-side-menu__avatar')).toHaveTextContent('AM');
    expect(card.querySelector('.ui-side-menu__avatar')).toHaveAttribute('aria-hidden', 'true');
  });

  // Break caught: "null" or an empty card for a person with no display name, or a second line invented for a session that lists no hub.
  it('says only that the person is signed in when the session gives no name, and omits a line it does not have', () => {
    renderMenu({ account: { name: null, detail: null } });

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Signed in')).toBeVisible();
    expect(card.querySelector('.ui-side-menu__detail')).toBeNull();
    expect(card.querySelector('.ui-side-menu__avatar svg')).not.toBeNull();
    expect(card).not.toHaveTextContent(/null|undefined/);
  });

  it('signs out from an icon button that has a name', async () => {
    const onSignOut = vi.fn();
    const { user } = renderMenu({ onSignOut });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the sign-out button named and inert while a sign-out is under way', async () => {
    const onSignOut = vi.fn();
    const { user } = renderMenu({ onSignOut, signingOut: true });

    const button = screen.getByRole('button', { name: 'Sign out' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);

    expect(onSignOut).not.toHaveBeenCalled();
  });
});

describe('SideMenu: collapsing to a rail of icons (a wide screen)', () => {
  // Break caught: a toggle that does not say what it will do or whether the menu is open, or that drops the entries' names when it collapses.
  it('collapses and expands, saying which in its name and in aria-expanded', async () => {
    const { container, user } = renderMenu();
    const menu = root(container);

    const collapse = screen.getByRole('button', { name: 'Collapse menu' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('data-collapsed', 'false');

    await user.click(collapse);

    const expand = screen.getByRole('button', { name: 'Expand menu' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryByRole('button', { name: 'Collapse menu' })).toBeNull();

    await user.click(expand);

    expect(screen.getByRole('button', { name: 'Collapse menu' })).toBeInTheDocument();
    expect(menu).toHaveAttribute('data-collapsed', 'false');
  });

  it('keeps every entry reachable by its name when collapsed, with the name as its tooltip', async () => {
    const { user } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Collapse menu' }));

    for (const item of ITEMS) {
      const link = screen.getByRole('link', { name: item.label });
      expect(link).toHaveAttribute('title', item.label);
    }
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  // Break caught: a collapsed menu that traps the person: the toggle is the first stop of the menu and the keyboard operates it.
  it('is operated from the keyboard', async () => {
    const { container, user } = renderMenu();

    screen.getByRole('button', { name: 'Collapse menu' }).focus();
    await user.keyboard('{Enter}');

    expect(root(container)).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'Expand menu' })).toHaveFocus();
  });
});

describe('SideMenu: sliding in over the page (a narrow screen)', () => {
  it('opens from the menu button and tells the page behind it to be inert', async () => {
    const onOpenChange = vi.fn();
    const { container, user } = renderMenu({ onOpenChange });
    const open = screen.getByRole('button', { name: 'Open menu' });
    expect(open).toHaveAttribute('aria-expanded', 'false');

    await user.click(open);

    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(root(container)).toHaveAttribute('data-open', 'true');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  // Break caught: focus left on the page behind the menu, so a keyboard user opens it and cannot tell where they are.
  it('puts focus on the way out when it opens', async () => {
    const { user } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveFocus();
  });

  // Break caught: a menu that cannot be dismissed from the keyboard, or that loses the person's place when it closes.
  it('closes on Escape and gives focus back to the menu button', async () => {
    const onOpenChange = vi.fn();
    const { container, user } = renderMenu({ onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    await user.keyboard('{Escape}');

    expect(root(container)).toHaveAttribute('data-open', 'false');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes from its own button and from the scrim, and gives focus back each time', async () => {
    const { container, user } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(root(container)).toHaveAttribute('data-open', 'false');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const scrim = container.querySelector<HTMLElement>('.ui-side-menu__scrim');
    if (scrim === null) throw new Error('the scrim is not drawn while the menu is open');
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    await user.click(scrim);
    expect(root(container)).toHaveAttribute('data-open', 'false');
    expect(container.querySelector('.ui-side-menu__scrim')).toBeNull();
  });

  // Break caught: the menu left open over the page the person has just gone to (and, if a later visit to the same address re-opened it,
  // a menu that comes back by itself).
  it('closes when the person follows a link, and stays closed when the address is visited again', async () => {
    const onOpenChange = vi.fn();
    const { container, user, router } = renderMenu({ onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    await user.click(screen.getByRole('link', { name: 'Staff' }));

    expect(router.state.location.pathname).toBe('/admin/staff');
    expect(root(container)).toHaveAttribute('data-open', 'false');
    await router.navigate('/');
    expect(root(container)).toHaveAttribute('data-open', 'false');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  // Break caught: a page left inert after the menu is gone (the shell leaving, a sign-out), which would leave nothing on the screen usable.
  it('lets the page behind go when the menu is removed while it is open', async () => {
    const onOpenChange = vi.fn();
    const { unmount, user } = renderMenu({ onOpenChange });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    unmount();

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe('initialsOf', () => {
  it.each([
    ['Ama Mensah', 'AM'],
    ['ama mensah', 'AM'],
    ['Kofi', 'K'],
    ['Ama Kofi Mensah', 'AM'],
    ['  Ama   Mensah  ', 'AM'],
    ['élodie dupont', 'ÉD'],
    ['Ama-Esi Mensah', 'AM'],
    ['', ''],
    ['   ', ''],
    ['123 456', ''],
    [null, ''],
  ])('reads %j as %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});

describe('SideMenu: accessibility', () => {
  it('has no accessibility violations, in either state', async () => {
    const { container, user } = renderMenu();

    expect(await wcagViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Collapse menu' }));
    expect(await wcagViolations(container)).toEqual([]);
  });
});
