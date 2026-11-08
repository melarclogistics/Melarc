import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { EmptyState, type EmptyStateProps } from './EmptyState';

describe('EmptyState', () => {
  // Break caught: an empty list shown as a blank or as an error. "None waiting" is the goal state of a queue, so it reads as
  // good news, with a heading and the reason in words (DESIGN_SYSTEM section 19).
  it('says what is empty and why, in a heading and a sentence', () => {
    render(
      <EmptyState kind="none" heading="Nothing is waiting">
        No identity is waiting for approval.
      </EmptyState>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Nothing is waiting' })).toBeVisible();
    expect(screen.getByText('No identity is waiting for approval.')).toBeVisible();
  });

  // Break caught: *none exist* and *the filter hides them* looking alike, which sends Ops hunting for a bug (ops-portal.md section 7).
  it('tells nothing existing from a filter that hides everything', () => {
    const { container, rerender } = render(
      <EmptyState kind="none" heading="Nothing is waiting">
        None.
      </EmptyState>,
    );
    expect(container.querySelector('.ui-empty-state--none')).not.toBeNull();
    expect(container.querySelector('.ui-empty-state--filtered')).toBeNull();

    rerender(
      <EmptyState
        kind="filtered"
        heading="No match"
        action={<Button type="button">Clear the filters</Button>}
      >
        Nothing matches the filters you chose.
      </EmptyState>,
    );

    expect(container.querySelector('.ui-empty-state--filtered')).not.toBeNull();
    expect(container.querySelector('.ui-empty-state--none')).toBeNull();
  });

  // Break caught: a filtered list with no way out. The only useful thing to do with a filter that hides everything is to remove it.
  it('requires a way out of a filter that hides everything, and none for a list with nothing in it', async () => {
    const clear = vi.fn();
    const user = userEvent.setup();
    // @ts-expect-error a filtered empty state without an action is a dead end
    const deadEnd: EmptyStateProps = { kind: 'filtered', heading: 'No match', children: 'None.' };
    expect(deadEnd.kind).toBe('filtered');
    render(
      <EmptyState
        kind="filtered"
        heading="No match, with a way out"
        action={
          <Button type="button" onClick={clear}>
            Clear the filters
          </Button>
        }
      >
        Nothing matches the filters you chose.
      </EmptyState>,
    );
    render(
      <EmptyState kind="none" heading="Nothing is waiting, no action">
        None.
      </EmptyState>,
    );

    await user.click(screen.getByRole('button', { name: 'Clear the filters' }));

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('shows the action after the explanation', () => {
    render(
      <EmptyState
        kind="none"
        heading="No staff yet"
        action={<a href="/admin/staff/new">Create one</a>}
      >
        No staff identity exists.
      </EmptyState>,
    );

    const action = screen.getByRole('link', { name: 'Create one' });
    const explanation = screen.getByText('No staff identity exists.');
    expect(
      explanation.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Break caught: an empty result that appears after the person acted (a filter) and is never announced, or one that is part of
  // a page that loads and is announced twice.
  it('is announced politely only when it appears because of something that just happened', () => {
    const { rerender } = render(
      <EmptyState kind="none" heading="Nothing is waiting">
        None.
      </EmptyState>,
    );
    expect(screen.queryByRole('status')).toBeNull();

    rerender(
      <EmptyState kind="none" heading="Nothing is waiting" announce>
        None.
      </EmptyState>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Nothing is waiting');
  });

  it('takes the heading level the page gives it, so the outline stays in order', () => {
    render(
      <EmptyState kind="none" heading="Nothing is waiting" headingLevel={3}>
        None.
      </EmptyState>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Nothing is waiting' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <EmptyState kind="none" heading="Nothing is waiting" announce>
          None.
        </EmptyState>
        <EmptyState
          kind="filtered"
          heading="No match"
          action={<Button type="button">Clear</Button>}
        >
          Nothing matches.
        </EmptyState>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
