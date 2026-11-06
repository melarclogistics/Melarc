import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../test-support/wcag';
import { PrimaryNavigation, type NavigationItem } from './PrimaryNavigation';

const ITEMS: NavigationItem[] = [
  { to: '/', label: 'Home', icon: 'overview' },
  { to: '/admin', label: 'Administration', icon: 'staff' },
  { to: '/reports', label: 'Reports', icon: 'sessions' },
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

  // Break caught: an entry with no picture, or one whose picture is read out beside its name ("Staff, Staff"): the icon is decorative and
  // the name is the label (DESIGN_SYSTEM section 24). The same entry has the same picture whatever the address.
  it('draws each entry as an icon that is hidden from assistive technology, and its name', () => {
    renderNavigation(ITEMS);

    for (const item of ITEMS) {
      const link = screen.getByRole('link', { name: item.label });
      const svg = link.querySelector('svg');
      expect(svg, item.label).not.toBeNull();
      expect(svg, item.label).toHaveAttribute('aria-hidden', 'true');
      expect(link, item.label).not.toHaveAttribute('title');
    }
  });

  // Break caught: a collapsed menu whose entries lose their names (an icon alone, with nothing to read), or that repeats them to a screen
  // reader. The label stays in the document; the `title` is for a pointer user.
  it('keeps every name when the menu around it is collapsed, and says it as a tooltip', () => {
    const router = createMemoryRouter(
      [{ path: '*', element: <PrimaryNavigation items={ITEMS} collapsed /> }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    for (const item of ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toHaveAttribute('title', item.label);
    }
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

  // Break caught (S0.44): two entries marked current at once. "Add a staff profile" lies under "Staff", and the profile of a person lies under
  // "Staff" and under nothing else: the entry that is current is the most specific one the address is at or under.
  describe('when one entry lies under another', () => {
    const NESTED: NavigationItem[] = [
      { to: '/', label: 'Home', icon: 'overview' },
      { to: '/admin/staff', label: 'Staff', icon: 'staff' },
      { to: '/admin/staff/new', label: 'Add a staff profile', icon: 'add-staff' },
    ];

    it.each([
      ['/admin/staff', 'Staff'],
      ['/admin/staff/new', 'Add a staff profile'],
      ['/admin/staff/11111111-2222-4333-8444-555555555555', 'Staff'],
      ['/admin/staff/11111111-2222-4333-8444-555555555555/mfa/reset', 'Staff'],
    ])('marks only the most specific entry at %s', (path, current) => {
      renderNavigation(NESTED, path);

      const marked = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);
      expect(marked).toEqual([current]);
    });

    // Break caught: a path that only begins with the same letters taken for a page under the entry.
    it('does not take a longer word for a page under an entry', () => {
      renderNavigation(NESTED, '/admin/staffing');

      expect(
        screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
      ).toHaveLength(0);
    });

    it('marks nothing at a page that is under no entry', () => {
      renderNavigation(NESTED, '/admin/sessions');

      expect(
        screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current')),
      ).toHaveLength(0);
    });
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

describe('PrimaryNavigation: the count beside an entry (task C1)', () => {
  const COUNTED: NavigationItem[] = [
    { to: '/', label: 'Home', icon: 'overview' },
    {
      to: '/admin',
      label: 'Administration',
      icon: 'staff',
      badge: { count: 12, meaning: 'waiting for approval' },
    },
    {
      to: '/reports',
      label: 'Reports',
      icon: 'sessions',
      badge: { count: 0, meaning: 'in progress' },
    },
  ];

  // Break caught: a count drawn beside an entry that has none, or one that is not drawn beside the entry that has one.
  it('draws a count after the label of the entry that has one, and nothing beside the others', () => {
    renderNavigation(COUNTED);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(screen.getByRole('link', { name: /^Home/ })).queryByText('12')).toBeNull();
    expect(nav.querySelectorAll('.ui-count-badge')).toHaveLength(2);
    expect(
      within(screen.getByRole('link', { name: /^Administration/ })).getByText('12', {
        selector: '[aria-hidden]',
      }),
    ).toBeVisible();
  });

  // Break caught: the number heard without what it counts, or twice.
  it('says what the number counts in the name of the entry, once', () => {
    renderNavigation(COUNTED);

    expect(
      screen.getByRole('link', { name: 'Administration 12 waiting for approval' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Reports 0 in progress' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Home' })).toBeVisible();
  });

  // Break caught: a collapsed menu whose tooltip drops the count, or shows a count where there is none.
  it('says the count in the tooltip when the menu is collapsed to its icons, and the name alone when there is none', () => {
    const router = createMemoryRouter([
      { path: '*', element: <PrimaryNavigation items={COUNTED} collapsed /> },
    ]);
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('link', { name: /^Administration/ })).toHaveAttribute(
      'title',
      'Administration: 12 waiting for approval',
    );
    expect(screen.getByRole('link', { name: /^Home/ })).toHaveAttribute('title', 'Home');
  });

  it('has no WCAG 2.1 A or AA violations with counts beside the entries', async () => {
    const { container } = renderNavigation(COUNTED, '/admin');
    expect(await wcagViolations(container)).toEqual([]);
  });
});
