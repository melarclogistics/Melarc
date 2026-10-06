import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../test-support/wcag';
import { PrimaryNavigation, type NavigationItem } from './PrimaryNavigation';

const ITEMS: NavigationItem[] = [
  { to: '/', label: 'Home' },
  { to: '/admin', label: 'Administration' },
  { to: '/reports', label: 'Reports' },
];

/** The navigation inside a real router, next to a main landmark showing which page is current. */
function renderNavigation(items: readonly NavigationItem[], initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <PrimaryNavigation items={items} />
            <main>
              <Outlet />
            </main>
          </>
        ),
        children: [
          { index: true, element: <p>Start page</p> },
          { path: '*', element: <p>Another page</p> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, user: userEvent.setup() };
}

describe('PrimaryNavigation', () => {
  // Break caught: an empty navigation landmark, which a screen reader announces as a place to go that
  // has nowhere to go. The Ops Portal's pre-authentication pages carry no navigation at all.
  it('renders nothing when there is nothing to navigate to', () => {
    const { container } = renderNavigation([]);

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelector('nav, ul')).toBeNull();
  });

  // Break caught: entries missing, reordered, or not real links (so not usable by keyboard or
  // assistive technology).
  it('is a named navigation landmark with one link per entry, in the order given', () => {
    renderNavigation(ITEMS);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Home', 'Administration', 'Reports']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/admin', '/reports']);
  });

  // Break caught: the current page shown by colour alone (surfaces/ops-portal.md §11), or the home
  // entry looking current on every page because "/" is a prefix of every path.
  it('marks only the current page, in a way assistive technology can read', () => {
    renderNavigation(ITEMS, '/admin/staff');

    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Reports' })).not.toHaveAttribute('aria-current');
  });

  it('marks the home entry when the home page is shown', () => {
    renderNavigation(ITEMS, '/');

    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Administration' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  // Break caught: entries that cannot be reached or used without a mouse.
  it('can be walked through with Tab and followed with Enter', async () => {
    const { user, router } = renderNavigation(ITEMS);

    await user.tab();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveFocus();

    await user.tab({ shift: true });
    await user.keyboard('{Enter}');

    expect(router.state.location.pathname).toBe('/admin');
    expect(screen.getByText('Another page')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderNavigation(ITEMS, '/admin');
    expect(await wcagViolations(container)).toEqual([]);
  });
});
