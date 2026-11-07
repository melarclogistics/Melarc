import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { EmptyStateV2, type EmptyStateV2Props } from './EmptyStateV2';

describe('EmptyStateV2', () => {
  // Break caught: a state that is not a heading, a line and an action in that order, or a title that is not announced as the heading it is.
  it('is a heading, one line and the action, in that order', () => {
    const { container } = render(
      <EmptyStateV2
        variant="empty"
        title="No pickup requests yet"
        action={<button type="button">Create a pickup request</button>}
      >
        Requests from vendors appear here as they come in.
      </EmptyStateV2>,
    );

    const heading = screen.getByRole('heading', { name: 'No pickup requests yet', level: 2 });
    const line = screen.getByText('Requests from vendors appear here as they come in.');
    const action = screen.getByRole('button', { name: 'Create a pickup request' });
    expect(heading.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(line.compareDocumentPosition(action)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  // Break caught: the three kinds of nothing drawn alike (the whole point is that they are told apart), or the kind lost from the element the stylesheet selects on.
  it.each([
    ['empty', 'No pickup requests yet'],
    ['all-clear', 'Nothing is waiting'],
  ] as const)('marks the %s variant on the element', (variant, title) => {
    const { container } = render(
      <EmptyStateV2 variant={variant} title={title}>
        One line.
      </EmptyStateV2>,
    );

    expect(container.firstElementChild).toHaveAttribute('data-variant', variant);
    expect(container.firstElementChild).toHaveClass(`ui-empty-v2--${variant}`);
  });

  it('marks the filtered-empty variant on the element', () => {
    const { container } = render(
      <EmptyStateV2
        variant="filtered-empty"
        title="No pickup requests match"
        action={<button type="button">Clear filters</button>}
      >
        Nothing matches the filters you chose.
      </EmptyStateV2>,
    );

    expect(container.firstElementChild).toHaveAttribute('data-variant', 'filtered-empty');
  });

  // Break caught: the 10px crimson square read out as a thing (it is the brand's mark of a place, and decoration), or not drawn at all.
  it('draws the crimson square as decoration', () => {
    const { container } = render(
      <EmptyStateV2 variant="all-clear" title="Nothing is waiting">
        Every request has been dealt with.
      </EmptyStateV2>,
    );

    const motif = container.querySelector('.ui-empty-v2__motif');
    expect(motif).not.toBeNull();
    expect(motif).toHaveAttribute('aria-hidden', 'true');
    expect(motif?.textContent).toBe('');
  });

  // Break caught: an action that is drawn as an empty box when there is none, so that a state with nothing to do is laid out with a gap where a button would be.
  it('draws no room for an action when there is none', () => {
    const { container } = render(
      <EmptyStateV2 variant="empty" title="No staff yet">
        People you add appear here.
      </EmptyStateV2>,
    );

    expect(container.querySelector('.ui-empty-v2__action')).toBeNull();
  });

  // Break caught: a filtered-empty state without the way to take the filter off. It is required by the type, so that a screen cannot leave Ops with a filter and no way out.
  it('requires the way out of a filter, at compile time', () => {
    const withoutWayOut = {
      variant: 'filtered-empty',
      title: 'No pickup requests match',
      children: 'Nothing matches.',
    } as const;
    // @ts-expect-error a filtered-empty state has to offer the way to take the filter off
    const incomplete: EmptyStateV2Props = withoutWayOut;

    expect(incomplete.variant).toBe('filtered-empty');
  });

  // Break caught: the level of the heading fixed at 2, so that a state inside a card breaks the order of the page's headings.
  it.each([2, 3, 4] as const)('draws its title as a level %i heading when told to', (level) => {
    render(
      <EmptyStateV2 variant="empty" title="No pickup requests yet" headingLevel={level}>
        One line.
      </EmptyStateV2>,
    );

    expect(screen.getByRole('heading', { level })).toHaveTextContent('No pickup requests yet');
  });

  // Break caught: a result that appears under a filter and is not announced (a screen reader user changes a filter and hears nothing), or one announced every time it is drawn.
  it('announces itself politely only when told it appeared because of something that happened', () => {
    const quiet = render(
      <EmptyStateV2 variant="empty" title="No staff yet">
        One line.
      </EmptyStateV2>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    quiet.unmount();

    render(
      <EmptyStateV2
        variant="filtered-empty"
        title="No staff match"
        announce
        action={<button type="button">Clear filters</button>}
      >
        One line.
      </EmptyStateV2>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No staff match');
  });

  // Break caught: example rows or a stand-in figure drawn to make the state look full: the component draws what it is given and nothing else.
  it('draws only the words it is given', () => {
    const { container } = render(
      <EmptyStateV2 variant="all-clear" title="Nothing is waiting">
        Every request has been dealt with.
      </EmptyStateV2>,
    );

    expect(container.textContent).toBe('Nothing is waitingEvery request has been dealt with.');
    expect(container.querySelector('table, li, img, svg')).toBeNull();
  });

  // Break caught: a name, a role or a relationship the automated checks see is wrong in any of the three kinds.
  it('has no automated WCAG violation in any of the three kinds', async () => {
    const { container } = render(
      <div>
        <EmptyStateV2
          variant="empty"
          title="No pickup requests yet"
          action={<button type="button">Create a pickup request</button>}
        >
          Requests from vendors appear here as they come in.
        </EmptyStateV2>
        <EmptyStateV2
          variant="filtered-empty"
          title="No pickup requests match"
          headingLevel={3}
          announce
          action={<button type="button">Clear filters</button>}
        >
          Nothing matches the filters you chose.
        </EmptyStateV2>
        <EmptyStateV2 variant="all-clear" title="Nothing is waiting" headingLevel={3}>
          Every request has been dealt with.
        </EmptyStateV2>
      </div>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
