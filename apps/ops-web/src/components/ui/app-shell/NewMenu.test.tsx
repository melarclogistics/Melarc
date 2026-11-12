import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { NewMenu, type CreateAction } from './NewMenu';

const ACTIONS: CreateAction[] = [
  { to: '/pickup-requests/new', label: 'Book a pickup', icon: 'book-pickup' },
  { to: '/manifests/new', label: 'Build a pickup run', icon: 'build-manifest' },
  { to: '/admin/staff/new', label: 'Add a staff profile', icon: 'add-staff' },
];

function Here() {
  return <p data-testid="here">{useLocation().pathname}</p>;
}

function renderMenu(
  actions: readonly CreateAction[] = ACTIONS,
  onCloseAutoFocus?: (event: Event) => void,
) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <NewMenu
              actions={actions}
              {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
            />
            <Here />
          </>
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, user: userEvent.setup() };
}

describe('the New menu', () => {
  // Break caught: an empty menu offered to a session that may create nothing: a button that opens onto nothing.
  it('draws nothing for a session that may create nothing', () => {
    const { container } = renderMenu([]);

    expect(container.querySelector('button')).toBeNull();
  });

  // Break caught: the crimson button of the portal drawn as another kind (an Ink button: the primary action of a page is Ink and crimson is the
  // brand's, on this button, the logo and the current entry only), or without its plus.
  it('is the crimson New button, with a plus', () => {
    renderMenu();

    const button = screen.getByRole('button', { name: 'New' });
    expect(button).toHaveAttribute('data-variant', 'brand');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
  });

  // Break caught: an action of the registry missing from the menu, or a count drawn beside one (a count is of a queue, worked in its own entry).
  it('lists the actions it is given, each a link to its own page, and draws no count', async () => {
    const { user } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'New' }));

    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => [item.textContent, item.getAttribute('href')])).toEqual([
      ['Book a pickup', '/pickup-requests/new'],
      ['Build a pickup run', '/manifests/new'],
      ['Add a staff profile', '/admin/staff/new'],
    ]);
    expect(menu.querySelector('.ui-count-badge')).toBeNull();
  });

  // Break caught: an item that does not go to its page, or that leaves the menu open over it.
  it('goes to the page of the action that is chosen, and closes', async () => {
    const { user } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Build a pickup run' }));

    expect(screen.getByTestId('here')).toHaveTextContent('/manifests/new');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is operated from the keyboard: Enter opens it, the arrows move and Enter chooses', async () => {
    const { user } = renderMenu();
    const button = screen.getByRole('button', { name: 'New' });
    button.focus();

    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(screen.getByTestId('here')).toHaveTextContent('/manifests/new');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Break caught (review of 7 November 2026): a menu that Escape leaves open, or closes with focus dropped on the page. (The closing Escape of the
  // test before this one met a menu that the choice had already closed, and proved nothing.) Nothing is chosen by it.
  it('closes with Escape, with nothing chosen, and returns focus to its button', async () => {
    const { user } = renderMenu();
    const button = screen.getByRole('button', { name: 'New' });
    button.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await waitFor(() => {
      expect(button).toHaveFocus();
    });
    expect(screen.getByTestId('here')).toHaveTextContent('/');
    expect(screen.getByTestId('here')).not.toHaveTextContent('/manifests');
  });

  // Break caught: focus given back to the button after the person went to a page, which takes it from the heading the frame moved it to.
  it('lets the shell stop focus from returning to the button, through onCloseAutoFocus', async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const { user } = renderMenu(ACTIONS, onCloseAutoFocus);

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Book a pickup' }));

    await vi.waitFor(() => {
      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'New' })).not.toHaveFocus();
  });

  it('has no WCAG violations that can be checked without a layout engine, closed and open', async () => {
    const { container, user } = renderMenu();
    expect(await wcagViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New' }));
    await screen.findByRole('menu');
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
