import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Link } from './Link';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderWithLink(to = '/next') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <Link to={to}>Go to the next page</Link>
            <Where />
          </>
        ),
      },
      { path: '/next', element: <Where /> },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('Link', () => {
  // Break caught: navigation built from something that is not a link, so it has no URL, no context menu and no
  // "open in a new tab", and a screen reader does not announce it as a link.
  it('is a real link with an address and its text as its name', () => {
    renderWithLink();

    const link = screen.getByRole('link', { name: 'Go to the next page' });
    expect(link).toHaveAttribute('href', '/next');
    expect(link).toHaveClass('ui-link');
  });

  // Break caught: a link that reloads the page, or that cannot be followed from the keyboard.
  it('is reached by Tab and followed by Enter without reloading the page', async () => {
    const user = userEvent.setup();
    renderWithLink();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Go to the next page' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('where')).toHaveTextContent('/next');
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = renderWithLink();

    expect(await wcagViolations(container)).toEqual([]);
  });
});
