import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Alert } from './Alert';

describe('Alert', () => {
  // Break caught: a message that exists only as colour. The words, and an icon, carry the meaning.
  it('shows its message and its title as text', () => {
    render(
      <Alert variant="danger" title="Could not save">
        The change was not saved. Try again.
      </Alert>,
    );

    expect(screen.getByText('Could not save')).toBeVisible();
    expect(screen.getByText('The change was not saved. Try again.')).toBeVisible();
  });

  it('has an icon for each variant, hidden from assistive technology, and is understood without it', () => {
    const { container } = render(
      <>
        <Alert variant="danger">The change was not saved.</Alert>
        <Alert variant="success">The change was saved.</Alert>
      </>,
    );

    const icons = container.querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).toHaveAttribute('focusable', 'false');
    }
    expect(container.querySelector('.ui-alert--danger')).not.toBeNull();
    expect(container.querySelector('.ui-alert--success')).not.toBeNull();
  });

  // Break caught: an alert that interrupts a screen reader every time the page renders it, or one that is never
  // announced after it was inserted because of something that happened.
  it('is announced only when it says it was inserted by something that just happened', () => {
    const { rerender } = render(<Alert variant="danger">Static notice.</Alert>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    rerender(
      <Alert variant="danger" announce>
        The change was not saved.
      </Alert>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The change was not saved.');

    rerender(
      <Alert variant="success" announce>
        The change was saved.
      </Alert>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('The change was saved.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: an action pushed into the message, or lost: it is secondary to the message and still reachable.
  it('can carry an action after the message', () => {
    render(
      <Alert variant="danger" action={<a href="/help">Read what to do</a>}>
        The change was not saved.
      </Alert>,
    );

    expect(screen.getByRole('link', { name: 'Read what to do' })).toBeVisible();
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <Alert variant="danger" title="Could not save" announce>
          The change was not saved.
        </Alert>
        <Alert variant="success">The change was saved.</Alert>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
