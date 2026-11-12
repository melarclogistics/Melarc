import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Sidebar, type SidebarProps } from './Sidebar';
import type { SidebarAccount, SidebarGroup } from './sidebar-types';

const GROUPS: SidebarGroup[] = [
  {
    id: 'today',
    label: 'Today',
    entries: [
      { to: '/', label: 'My work', icon: 'my-work' },
      {
        to: '/approvals',
        label: 'Decisions',
        icon: 'exception-approvals',
        badge: { count: 3, meaning: 'waiting for approval' },
      },
    ],
  },
  {
    id: 'people',
    label: 'People and access',
    entries: [
      {
        to: '/admin/staff',
        label: 'Staff',
        icon: 'staff',
        badge: { count: 0, meaning: 'waiting for approval' },
      },
      { to: '/admin/sessions', label: 'Sessions', icon: 'sessions' },
    ],
  },
];
const ACCOUNT: SidebarAccount = { name: 'Ama Mensah', detail: 'Accra Hub' };

function renderSidebar(props: Partial<SidebarProps> & { path?: string } = {}) {
  const { path = '/', ...rest } = props;
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <Sidebar
            groups={GROUPS}
            account={ACCOUNT}
            rail={false}
            placement="docked"
            {...(rest.placement === 'sheet' ? {} : { onToggleRail: () => undefined })}
            {...rest}
          />
        ),
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, user: userEvent.setup() };
}

describe('Sidebar: what it holds', () => {
  // Break caught: a sidebar that is not a landmark of its own (the skip link and a screen reader's list of regions would not find it), or one that
  // shows the entries without their pictures, or whose pictures are announced beside the names that say the same.
  it('is a main-menu landmark holding the primary navigation, each entry an icon and a name', () => {
    renderSidebar();

    const aside = screen.getByRole('complementary', { name: 'Main menu' });
    const nav = within(aside).getByRole('navigation', { name: 'Primary' });
    for (const entry of GROUPS.flatMap((group) => group.entries)) {
      const link = within(nav).getByRole('link', { name: new RegExp(`^${entry.label}`) });
      expect(link).toHaveAttribute('href', entry.to);
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // Break caught: groups drawn as one run of entries (no headings), or headings that add to the page's outline of headings (a screen reader user
  // would find "Today" and "Pickups" among the headings of the page they are reading).
  it('has a group for each heading it is given, each a list that the heading names, and adds no heading to the page', () => {
    renderSidebar();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('list', { name: 'Today' })).toBeInTheDocument();
    expect(within(nav).getByRole('list', { name: 'People and access' })).toBeInTheDocument();
    expect(
      within(within(nav).getByRole('list', { name: 'Today' }))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['My work', 'Decisions 33 waiting for approval']);
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('marks the current entry for assistive technology, and only one', () => {
    renderSidebar({ path: '/admin/staff/abc' });

    expect(screen.getByRole('link', { name: /^Staff/ })).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });

  // Break caught: the all-white lockup missing from the sidebar's head, drawn as a link (the logo identifies and is never a link), or given
  // a name twice.
  it('draws the all-white lockup at its head, named once and not a link', () => {
    renderSidebar();

    const aside = screen.getByRole('complementary', { name: 'Main menu' });
    const logo = within(aside).getByRole('img', { name: 'Melarc Logistics' });
    expect(logo.getAttribute('src')).toMatch(/melarc-logo-dark.*\.svg/);
    expect(logo.closest('a')).toBeNull();
    expect(within(aside).getAllByRole('img')).toHaveLength(1);
  });

  // Break caught: a count drawn for an entry that was given none, or one that is told to a screen reader without what it counts.
  it('draws a count only beside an entry that was given one, with what it counts in the name of the entry', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Decisions 3 waiting for approval' })).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'My work' }).querySelector('.ui-count-badge'),
    ).toBeNull();
    // A 0 that was read is drawn, quietly, and is still a figure.
    const staff = screen.getByRole('link', { name: 'Staff 0 waiting for approval' });
    expect(staff.querySelector('.ui-count-badge')).toHaveAttribute('data-quiet', 'true');
  });

  // Break caught: "null" or an empty foot for a person with no display name, or a second line invented for a session that lists no hub.
  it('says who is signed in and where they act in its foot, and only that', () => {
    renderSidebar();

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Ama Mensah')).toBeVisible();
    expect(within(card).getByText('Accra Hub')).toBeVisible();
    expect(card.querySelector('.ui-sidebar__avatar')).toHaveTextContent('AM');
    expect(card.querySelector('.ui-sidebar__avatar')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says only that the person is signed in when the session gives no name, and omits a line it does not have', () => {
    renderSidebar({ account: { name: null, detail: null } });

    const card = screen.getByRole('group', { name: 'Your account' });
    expect(within(card).getByText('Signed in')).toBeVisible();
    expect(card.querySelector('.ui-sidebar__detail')).toBeNull();
    expect(card.querySelector('.ui-sidebar__avatar svg')).not.toBeNull();
    expect(card).not.toHaveTextContent(/null|undefined/);
  });

  // Break caught: a sidebar that draws a sign-out control (it is in the account menu now) or a navigation with nothing in it.
  it('has no sign-out control, and draws no navigation when it has no entry', () => {
    renderSidebar({ groups: [] });

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderSidebar();

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('Sidebar: expanded and as the rail', () => {
  // Break caught: a toggle that does not say which way it goes or whether the sidebar is expanded.
  it('has a button that collapses it, expanded, and one that expands it, as the rail, each saying which it is', async () => {
    const onToggleRail = vi.fn();
    const first = renderSidebar({ onToggleRail });
    const collapse = screen.getByRole('button', { name: 'Collapse menu' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await first.user.click(collapse);
    expect(onToggleRail).toHaveBeenCalledTimes(1);
    first.unmount();

    renderSidebar({ rail: true, onToggleRail });
    const expand = screen.getByRole('button', { name: 'Expand menu' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveAttribute('aria-controls', screen.getByRole('navigation').id);
  });

  // Break caught: the rail dropping the names of the entries (an entry that is only a picture to a screen reader), or keeping the lockup
  // that is too wide for it.
  it('keeps the name of every entry on the rail, and draws the mark and not the lockup', () => {
    renderSidebar({ rail: true });

    const aside = screen.getByRole('complementary', { name: 'Main menu' });
    expect(aside).toHaveAttribute('data-rail', 'true');
    expect(screen.getByRole('link', { name: 'My work' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Decisions/ })).toBeInTheDocument();
    expect(within(aside).queryByRole('img', { name: 'Melarc Logistics' })).toBeNull();
    expect(aside.querySelector('.ui-brand-lockup__mark img')).toHaveAttribute(
      'src',
      '/favicon.svg',
    );
    // The product is still named, for a screen reader, in text.
    expect(within(aside).getByText('Melarc Logistics')).toBeInTheDocument();
  });

  // Break caught: a rail whose entries have no tooltip: an icon that has to be guessed.
  it('shows the name of an entry in a tooltip when the rail’s entry has focus', async () => {
    renderSidebar({ rail: true });

    screen.getByRole('link', { name: 'My work' }).focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('My work');
  });

  it('shows the count with the name in the tooltip of an entry that has one', async () => {
    renderSidebar({ rail: true });

    screen.getByRole('link', { name: /^Decisions/ }).focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Decisions: 3 waiting for approval',
    );
  });

  // Break caught: a count written one way in the badge ("1,234") and another in the tooltip ("1234"): one figure, one way of writing it.
  it('writes a count in the tooltip as the badge does, grouped by thousands', async () => {
    renderSidebar({
      rail: true,
      groups: [
        {
          id: 'pickups',
          label: 'Pickups',
          entries: [
            {
              to: '/pickup-requests',
              label: 'Requests',
              icon: 'pickup-requests',
              badge: { count: 1234, meaning: 'waiting for confirmation' },
            },
          ],
        },
      ],
    });

    screen.getByRole('link', { name: 'Requests 1,234 waiting for confirmation' }).focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Requests: 1,234 waiting for confirmation',
    );
  });

  it('is not given tooltips when it is expanded: the names are drawn', () => {
    renderSidebar({ rail: false });

    screen.getByRole('link', { name: 'My work' }).focus();

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('has no WCAG violations that can be checked without a layout engine as the rail', async () => {
    const { container } = renderSidebar({ rail: true });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('Sidebar: as the content of a sheet', () => {
  // Break caught: a landmark inside a dialog that already names itself (two "Main menu" regions), or a toggle of the rail in a sheet, which has
  // no rail, or no way out that the sheet gave.
  it('is not a landmark of its own, has no toggle of the rail, and holds the control the sheet gives to close it', () => {
    renderSidebar({
      placement: 'sheet',
      closeControl: <button type="button">Close menu</button>,
    });

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: /Collapse menu|Expand menu/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close menu' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });
});
