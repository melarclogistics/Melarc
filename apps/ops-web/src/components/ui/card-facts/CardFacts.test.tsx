import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { StatusBadge, type StatusMap } from '../status-badge/StatusBadge';
import { CardFacts } from './CardFacts';

const MAP: StatusMap<'ACTIVE'> = { ACTIVE: { tone: 'success', label: 'Active' } };

describe('CardFacts', () => {
  // Break caught: a card whose facts are not a list of a label and its value, so that a screen reader reads a run of text; or whose facts come in another order than the screen gave.
  it('draws each fact as a label and its value, as a list of terms, in the order given', () => {
    render(
      <CardFacts
        facts={[
          { label: 'Hub', value: 'Accra Central' },
          { label: 'Service date', value: 'Wed 4 Nov' },
          { label: 'Needs', value: <strong>A cold box</strong> },
        ]}
      />,
    );

    const terms = screen.getAllByRole('term');
    expect(terms.map((term) => term.textContent)).toEqual(['Hub', 'Service date', 'Needs']);
    const values = screen.getAllByRole('definition');
    expect(values.map((value) => value.textContent)).toEqual([
      'Accra Central',
      'Wed 4 Nov',
      'A cold box',
    ]);
    expect(within(values[2] ?? document.body).getByText('A cold box').tagName).toBe('STRONG');
  });

  it('draws what leads the card and its quiet line above the facts, and nothing for what is not given', () => {
    const { container, rerender } = render(
      <CardFacts
        head={<StatusBadge status="ACTIVE" map={MAP} />}
        lead="Demo Fabrics Ltd"
        facts={[{ label: 'Hub', value: 'Accra Central' }]}
      />,
    );

    expect(screen.getByText('Active')).toBeVisible();
    expect(screen.getByText('Demo Fabrics Ltd')).toBeVisible();
    const order = [...container.children].map((child) => child.className);
    expect(order).toEqual(['ui-card-facts__head', 'ui-card-facts__lead', 'ui-card-facts']);

    rerender(<CardFacts facts={[{ label: 'Hub', value: 'Accra Central' }]} />);
    expect(container.querySelector('.ui-card-facts__head')).toBeNull();
    expect(container.querySelector('.ui-card-facts__lead')).toBeNull();
  });

  // Break caught: a facts block that draws a control or a heading of its own: the table draws the card's one hit target, its heading and its act, and a second control in a card is a second way to the same place.
  it('draws no control and no heading of its own', () => {
    const { container } = render(
      <CardFacts
        head={<StatusBadge status="ACTIVE" map={MAP} />}
        facts={[{ label: 'Hub', value: 'Accra Central' }]}
      />,
    );

    expect(
      container.querySelector('a, button, input, select, textarea, h1, h2, h3, h4'),
    ).toBeNull();
  });

  // Break caught: two facts with the same label drawn once (a key that is the label alone), or one dropped.
  it('draws two facts that have the same label, and React has nothing to say of their keys', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <CardFacts
        facts={[
          { label: 'Phone', value: '+233 20 000 0001' },
          { label: 'Phone', value: '+233 20 000 0002' },
        ]}
      />,
    );

    expect(screen.getAllByRole('term')).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <CardFacts
        head={<StatusBadge status="ACTIVE" map={MAP} />}
        lead="kofi@example.test"
        facts={[
          { label: 'Role', value: 'Ops Staff' },
          { label: 'Hub', value: 'Accra Central' },
        ]}
      />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
