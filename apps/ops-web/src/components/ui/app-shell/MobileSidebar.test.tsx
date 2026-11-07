import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { MobileSidebar } from './MobileSidebar';
import type { SidebarGroup } from './sidebar-types';

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
];

function renderSheet(options: { onCloseAutoFocus?: (event: Event) => void } = {}) {
  const onOpenChange = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button">Open menu</button>
        <MobileSidebar
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          groups={GROUPS}
          account={{ name: 'Ama Mensah', detail: 'Accra Hub' }}
          {...(options.onCloseAutoFocus === undefined
            ? {}
            : { onCloseAutoFocus: options.onCloseAutoFocus })}
        />
      </>
    );
  }
  const router = createMemoryRouter([{ path: '*', element: <Harness /> }]);
  const view = render(<RouterProvider router={router} />);
  return { ...view, onOpenChange, user: userEvent.setup() };
}

describe('the sidebar as a sheet', () => {
  // Break caught: a menu that slides in as a plain region (no dialog: focus is not kept in it, the page behind stays reachable), or one with no
  // name.
  it('is a modal dialog named Main menu, holding the primary navigation', () => {
    renderSheet();

    const sheet = screen.getByRole('dialog', { name: 'Main menu' });
    expect(within(sheet).getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'My work' })).toHaveAttribute('href', '/');
    expect(
      within(sheet).getByRole('link', { name: 'Decisions 3 waiting for approval' }),
    ).toBeVisible();
  });

  // Break caught: the full sidebar given a toggle of the rail in a sheet (a sheet has no rail), or drawn as the rail: it is always the full sidebar.
  it('is always the full sidebar: the lockup, the names and no toggle of the rail', () => {
    renderSheet();

    const sheet = screen.getByRole('dialog', { name: 'Main menu' });
    expect(within(sheet).getByRole('img', { name: 'Melarc Logistics' })).toBeVisible();
    expect(within(sheet).queryByRole('button', { name: /Collapse menu|Expand menu/ })).toBeNull();
    expect(sheet.querySelector('.ui-sidebar')).toHaveAttribute('data-rail', 'false');
    expect(sheet.querySelector('.ui-sidebar')).toHaveAttribute('data-placement', 'sheet');
  });

  // Break caught: the way out of the sheet left to the scrim and Escape alone (a keyboard user and a screen reader user need a button that says so).
  it('has a button that says Close menu, and it closes the sheet', async () => {
    const { user, onOpenChange } = renderSheet();

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Close menu' }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught (audit B7, 7 November 2026): a sheet that closes only when the location has changed, so that it stays open over a page that is still
  // loading, or over the entry of the page the person is already on (the click is a click all the same, and the person has acted).
  it('closes at the click on an entry, also on the entry of the page the person is on', async () => {
    const { user, onOpenChange } = renderSheet();

    await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'My work' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: the sheet closed by a click that opens the entry in a new tab (control or command held), where the person is still on the page and
  // may want the menu for the next entry.
  it('stays open for a click with a key held, which opens the entry elsewhere', async () => {
    const { user, onOpenChange } = renderSheet();

    await user.keyboard('{Control>}');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('link', {
        name: 'Decisions 3 waiting for approval',
      }),
    );
    await user.keyboard('{/Control}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeVisible();
  });

  it('closes with Escape', async () => {
    const { user, onOpenChange } = renderSheet();

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: the page behind the sheet reachable by a screen reader (it is hidden from it while the sheet is open), or the sheet opened with
  // focus left behind it: focus goes in, to the first control.
  it('hides the page behind it from assistive technology and takes focus in', () => {
    renderSheet();

    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Open menu', hidden: true })
        .closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  // Break caught: focus taken back to the button that opened the sheet after the person went to a page by it, which takes it from the heading.
  it('lets the shell stop focus from returning to what opened it, through onCloseAutoFocus', async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { user } = renderSheet({ onCloseAutoFocus });

    await user.keyboard('{Escape}');

    await vi.waitFor(() => {
      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    });
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    renderSheet();

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
