import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { CountBadge } from './CountBadge';

describe('CountBadge', () => {
  // Break caught: the figure changed on its way to the screen: capped, rounded, or given as words.
  it('draws the figure it is given, and does not cap it', () => {
    render(<CountBadge count={7} meaning="waiting" />);
    expect(screen.getByText('7', { selector: '[aria-hidden="true"]' })).toBeVisible();

    render(<CountBadge count={12480} meaning="waiting" />);
    expect(screen.getByText('12,480', { selector: '[aria-hidden="true"]' })).toBeVisible();
  });

  // Break caught: a screen reader saying the number twice, or the number without what it counts.
  it('gives assistive technology the whole phrase once, and the drawn number to nobody', () => {
    const { container } = render(<CountBadge count={5} meaning="waiting for confirmation" />);

    const badge = container.querySelector('.ui-count-badge');
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe('5');
    expect(screen.getByText('5 waiting for confirmation')).toBeInTheDocument();
    // What is exposed is the phrase and not the bare number.
    expect(badge?.textContent).toBe('55 waiting for confirmation');
    expect(badge?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  // Break caught: the number hidden from assistive technology on a line that says nothing of what it counts.
  it('exposes the number itself when there are no words with it', () => {
    const { container } = render(<CountBadge count={3} />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  // Break caught: a count of nothing drawn like a count of work, or dropped as if it were missing.
  it('draws a 0 that was read, quietly, and still draws it', () => {
    const { container } = render(<CountBadge count={0} meaning="waiting" />);

    const badge = container.querySelector('.ui-count-badge');
    expect(badge).toHaveAttribute('data-quiet', 'true');
    expect(screen.getByText('0', { selector: '[aria-hidden="true"]' })).toBeVisible();
    expect(screen.getByText('0 waiting')).toBeInTheDocument();
  });

  it('is not quiet when there is work', () => {
    const { container } = render(<CountBadge count={1} meaning="waiting" />);
    expect(container.querySelector('.ui-count-badge')).not.toHaveAttribute('data-quiet');
  });

  // Break caught: the ground the badge is drawn on lost, so that the styling for the dark menu is applied on the page or the other way round.
  it('is drawn for the page unless it is told it is on the menu', () => {
    const page = render(<CountBadge count={2} meaning="waiting" />);
    expect(page.container.querySelector('.ui-count-badge')).toHaveAttribute('data-surface', 'page');
    page.unmount();

    const shell = render(<CountBadge count={2} meaning="waiting" surface="shell" />);
    expect(shell.container.querySelector('.ui-count-badge')).toHaveAttribute(
      'data-surface',
      'shell',
    );
  });

  // Break caught: a badge made by the primitive but not through it: the design system's badge is the one a count is.
  it('is the badge primitive, restyled through the tokens', () => {
    const { container } = render(<CountBadge count={2} meaning="waiting" />);
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('ui-count-badge');
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <ul>
        <li>
          Pickup requests <CountBadge count={5} meaning="waiting for confirmation" />
        </li>
        <li>
          Staff <CountBadge count={0} meaning="waiting for approval" surface="shell" />
        </li>
      </ul>,
    );
    expect(await wcagViolations(container)).toEqual([]);
  });
});
