import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { AccountMenu, type AccountMenuProps } from './AccountMenu';
import type { ThemeValue } from './theme-options';

const PAGES = [
  { to: '/account/trusted-browsers', label: 'Trusted browsers', icon: 'trusted-browsers' },
] as const;

function Harness(props: Partial<AccountMenuProps> & { onTheme?: (theme: ThemeValue) => void }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ThemeValue>('system');
  return (
    <AccountMenu
      name="Ama Mensah"
      detail="Accra Hub"
      pages={PAGES}
      theme={{
        choice,
        onChoose: (next) => {
          setChoice(next);
          props.onTheme?.(next);
        },
      }}
      signingOut={false}
      onSignOut={() => undefined}
      open={open}
      onOpenChange={setOpen}
      {...props}
    />
  );
}

function renderMenu(props: Parameters<typeof Harness>[0] = {}) {
  const router = createMemoryRouter([{ path: '*', element: <Harness {...props} /> }]);
  const view = render(<RouterProvider router={router} />);
  return { ...view, user: userEvent.setup() };
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Account menu' }));
  return screen.findByRole('menu');
};

describe('the account menu', () => {
  // Break caught: an avatar button with no name (a button that is only initials), or initials read aloud as if they were content.
  it('is an avatar button named Account menu, with the initials hidden from assistive technology', () => {
    renderMenu();

    const button = screen.getByRole('button', { name: 'Account menu' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button.querySelector('.ui-account__avatar')).toHaveTextContent('AM');
    expect(button.querySelector('.ui-account__avatar')).toHaveAttribute('aria-hidden', 'true');
  });

  // Break caught: the person not told who is signed in, a role invented for them (the session names none), or a hub they do not act in.
  it('says who is signed in and where they act, and names no role', async () => {
    const { user } = renderMenu();

    const menu = await open(user);

    expect(within(menu).getByText('Ama Mensah')).toBeVisible();
    expect(within(menu).getByText('Accra Hub')).toBeVisible();
    expect(menu.textContent).not.toMatch(/Platform Admin|Senior Ops|Ops Staff|Role/);
  });

  it('says only that the person is signed in when the session gives no name', async () => {
    const { user } = renderMenu({ name: null, detail: null });

    const menu = await open(user);

    expect(within(menu).getByText('Signed in')).toBeVisible();
    expect(menu).not.toHaveTextContent(/null|undefined/);
  });

  // Break caught: the trusted browsers left out of the menu (the Product Owner moved them here from the sidebar), or a page that is not built
  // offered ("Profile and hubs" has no page, so it is not offered).
  it('offers the personal pages it is given, and no Profile and hubs', async () => {
    const { user } = renderMenu();

    const menu = await open(user);

    const link = within(menu).getByRole('menuitem', { name: 'Trusted browsers' });
    expect(link).toHaveAttribute('href', '/account/trusted-browsers');
    expect(within(menu).queryByRole('menuitem', { name: /Profile/ })).toBeNull();
  });

  // Break caught: the choice of theme missing from the account menu, or one choice marked when another is the person's.
  it('offers System, Light and Dark, marks the chosen one, and tells which was chosen', async () => {
    const onTheme = vi.fn();
    const { user } = renderMenu({ onTheme });

    let menu = await open(user);
    const choices = within(menu).getAllByRole('menuitemradio');
    expect(choices.map((choice) => choice.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Dark' }));
    expect(onTheme).toHaveBeenLastCalledWith('dark');

    menu = await open(user);
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((choice) => choice.getAttribute('aria-checked')),
    ).toEqual(['false', 'false', 'true']);
  });

  // Break caught: a sign-out that closes the menu on selection (the progress goes with it) or that is not there.
  it('signs out from an item, and stays open while it is under way, saying so', async () => {
    const onSignOut = vi.fn();
    const first = renderMenu({ onSignOut });
    const menu = await open(first.user);

    await first.user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
    // Still open: the controlled state is the shell's, and a selection does not close it.
    expect(screen.getByRole('menu')).toBeVisible();
    first.unmount();

    renderMenu({ signingOut: true, onSignOut });
    const busy = await open(userEvent.setup());
    const item = within(busy).getByRole('menuitem', { name: 'Signing out…' });
    expect(item).toHaveAttribute('aria-busy', 'true');
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  // Break caught: a second selection of the sign-out while one is under way sending a second request.
  it('ignores a second selection while a sign-out is under way', async () => {
    const onSignOut = vi.fn();
    const { user } = renderMenu({ signingOut: true, onSignOut });
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitem', { name: 'Signing out…' }));

    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('is operated from the keyboard, and Escape closes it and returns focus to the button', async () => {
    const { user } = renderMenu();
    const button = screen.getByRole('button', { name: 'Account menu' });
    button.focus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeVisible();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('has no WCAG violations that can be checked without a layout engine, closed and open', async () => {
    const { container, user } = renderMenu();
    expect(await wcagViolations(container)).toEqual([]);

    await open(user);
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
