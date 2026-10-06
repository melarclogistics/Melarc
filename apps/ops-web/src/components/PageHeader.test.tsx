import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../test-support/wcag';
import { PageHeader } from './PageHeader';
import { Button } from './ui/button/Button';

describe('PageHeader', () => {
  // Break caught: a page title that is not the page's one level-one heading, or that cannot take focus after a
  // navigation, which is how a screen reader is told the page changed (COMPONENT_PATTERNS section 11.3).
  it('is the page one level-one heading, and it can take focus', () => {
    render(<PageHeader title="Pickup requests" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Pickup requests' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('shows the description and the actions when it has them', () => {
    render(
      <PageHeader
        title="Pickup requests"
        description="Requests waiting for a decision."
        actions={<Button type="button">Create request</Button>}
      />,
    );

    expect(screen.getByText('Requests waiting for a decision.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create request' })).toBeVisible();
  });

  // Break caught: an empty actions bar or description left in the page, which screen readers still walk through.
  it('renders neither when it has neither', () => {
    const { container } = render(<PageHeader title="Pickup requests" />);

    expect(container.querySelector('.ui-page-header__actions')).toBeNull();
    expect(container.querySelector('.ui-page-header__description')).toBeNull();
  });

  it('keeps the actions after the title in reading order', () => {
    const { container } = render(
      <PageHeader title="Pickup requests" actions={<Button type="button">Create</Button>} />,
    );

    const header = container.querySelector<HTMLElement>('.ui-page-header');
    expect(header).not.toBeNull();
    if (header === null) return;
    const order = [...header.querySelectorAll('h1, button')].map((element) => element.tagName);
    expect(order).toEqual(['H1', 'BUTTON']);
    expect(within(header).getByRole('button', { name: 'Create' })).toBeVisible();
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <PageHeader
        title="Pickup requests"
        description="Requests waiting for a decision."
        actions={<Button type="button">Create request</Button>}
      />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
