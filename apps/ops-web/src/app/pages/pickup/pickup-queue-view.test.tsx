import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QUEUE_COLUMNS, QueueCard, type QueueFacts } from './pickup-queue-view';

/** A request as the queue tells it: every fact the six columns hold, made once from the record. */
const FACTS: QueueFacts = {
  id: '7c1f0000-0000-4000-8000-000000000001',
  code: 'ACC-PR-7KQ2MZ',
  href: '/pickup-requests/7c1f0000-0000-4000-8000-000000000001',
  state: 'PENDING',
  sender: 'Demo Fabrics Ltd',
  date: 'Tue 3 Nov 2026',
  address: '14 Demo Lane, Osu',
  hub: 'Accra Central',
  packages: '3 packages',
  bookedAs: 'A vendor’s own packages',
  needs: '',
  confirmable: true,
};

describe('the pickup queue’s columns', () => {
  // Break caught (the Product Owner, 10 November 2026): the queue's lesser columns chosen by anything but his decision: it keeps the request with its sender, the state, the service date and what
  // a request needs, and marks the packages (3) and the pickup address (2) lesser, so that they are what goes first when its box is too narrow and the table never scrolls sideways.
  it('keeps the request, the state, the service date and what a request needs, and marks the packages and the address lesser', () => {
    expect(QUEUE_COLUMNS.map((column) => [column.id, column.priority ?? 1])).toEqual([
      ['request', 1],
      ['state', 1],
      ['date', 1],
      ['where', 2],
      ['packages', 3],
      ['needs', 1],
    ]);
    expect(QUEUE_COLUMNS.find((column) => column.rowHeader === true)?.id).toBe('request');
  });
});

describe('the pickup queue’s card', () => {
  // Break caught: a card that tells less than the row it replaces, so that a request is drawn with less where the table has no room: it holds a fact for every column of the table (the state is
  // its head, the sender its lead, the code the card's heading that the table draws), each a label and its value.
  it('tells every fact of the row, each a label and its value', () => {
    render(<QueueCard facts={FACTS} />);

    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual([
      'Service date',
      'Pickup address / hub',
      'Packages / booking type',
      'Needs',
    ]);
    for (const column of QUEUE_COLUMNS) {
      if (column.rowHeader === true || column.id === 'state') continue;
      expect(terms).toContain(column.header);
    }
    const value = (term: string): HTMLElement => {
      const label = screen.getAllByRole('term').find((candidate) => candidate.textContent === term);
      if (label === undefined) throw new Error('no term ' + term);
      const fact = label.parentElement;
      if (fact === null) throw new Error(`the term ${term} is in no fact`);
      return within(fact).getByRole('definition');
    };
    expect(value('Service date')).toHaveTextContent('Tue 3 Nov 2026');
    expect(value('Pickup address / hub')).toHaveTextContent('14 Demo Lane, OsuAccra Central');
    expect(value('Packages / booking type')).toHaveTextContent('3 packagesA vendor’s own packages');
    expect(value('Needs')).toHaveTextContent('No additional note');
    expect(screen.getByText('Waiting for confirmation')).toBeVisible();
    expect(screen.getByText('Demo Fabrics Ltd')).toBeVisible();
  });

  // Break caught: a control in the card, which is a second way to the same request (the table draws the card's one hit target, the button that opens it).
  it('holds no control', () => {
    render(<QueueCard facts={FACTS} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
