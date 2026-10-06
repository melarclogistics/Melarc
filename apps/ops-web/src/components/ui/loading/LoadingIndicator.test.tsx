import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { LoadingIndicator } from './LoadingIndicator';

describe('LoadingIndicator', () => {
  // Break caught: work in progress that only sighted users can tell, or a bare spinner with no words.
  it('says what is happening in words, in a polite status region', () => {
    render(<LoadingIndicator />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading…');
    expect(status).toBeVisible();
  });

  it('says what it was told to say', () => {
    render(<LoadingIndicator label="Loading the pickup request…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading the pickup request…');
  });

  // Break caught: a spinner that is read out as content, so the label is said twice or once as nonsense.
  it('hides the spinner from assistive technology, and can leave it out', () => {
    const { container, rerender } = render(<LoadingIndicator />);
    expect(container.querySelector('.ui-spinner')).toHaveAttribute('aria-hidden', 'true');

    rerender(<LoadingIndicator spinner={false} />);
    expect(container.querySelector('.ui-spinner')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  // Break caught: a loading indicator that implies the work is done.
  it('says nothing that sounds like completion', () => {
    render(<LoadingIndicator />);

    expect(screen.getByRole('status').textContent).not.toMatch(/done|saved|complete|success/i);
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <LoadingIndicator />
        <LoadingIndicator spinner={false} label="Please wait…" />
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
