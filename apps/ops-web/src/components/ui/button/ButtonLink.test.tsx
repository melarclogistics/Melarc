import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ButtonLink } from './ButtonLink';

function setup(element: React.ReactElement) {
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/admin/staff/new', element: <p>The new profile page</p> },
    ],
    { initialEntries: ['/'] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, user: userEvent.setup() };
}

describe('ButtonLink', () => {
  // Break caught: navigation made with a <button>, which is not a link: no address, no open-in-a-new-tab, a different role.
  it('is a real link with an address, drawn as a button', () => {
    setup(<ButtonLink to="/admin/staff/new">Add a staff profile</ButtonLink>);

    const link = screen.getByRole('link', { name: 'Add a staff profile' });
    expect(link).toHaveAttribute('href', '/admin/staff/new');
    expect(link).toHaveClass('ui-button', 'ui-button--primary');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is drawn as a secondary button when asked', () => {
    setup(
      <ButtonLink to="/admin/staff/new" variant="secondary">
        Back
      </ButtonLink>,
    );

    expect(screen.getByRole('link', { name: 'Back' })).toHaveClass('ui-button--secondary');
  });

  // Break caught: a link that cannot be followed from the keyboard, or that reloads the page.
  it('is followed from the keyboard without reloading the page', async () => {
    const { user, router } = setup(
      <ButtonLink to="/admin/staff/new">Add a staff profile</ButtonLink>,
    );

    await user.tab();
    expect(screen.getByRole('link', { name: 'Add a staff profile' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(router.state.location.pathname).toBe('/admin/staff/new');
    expect(await screen.findByText('The new profile page')).toBeVisible();
  });

  it('takes a query in its address', () => {
    setup(<ButtonLink to="/admin/staff?view=waiting">Review the queue</ButtonLink>);

    expect(screen.getByRole('link', { name: 'Review the queue' })).toHaveAttribute(
      'href',
      '/admin/staff?view=waiting',
    );
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = setup(<ButtonLink to="/admin/staff/new">Add a staff profile</ButtonLink>);

    expect(await wcagViolations(container)).toEqual([]);
  });
});
