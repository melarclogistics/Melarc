import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { LoadingIndicator } from '../loading/LoadingIndicator';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  // Break caught: a placeholder that a screen reader reads, or that looks like content to one. It is decoration: the words that say
  // the page is loading are the loading indicator's, and it is always beside one.
  it('is decoration: hidden from assistive technology, with no text and no role', () => {
    const { container } = render(<Skeleton />);

    const root = container.firstElementChild;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root?.textContent).toBe('');
    expect(root).not.toHaveAttribute('role');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws as many lines as the layout it stands for has', () => {
    const { container, rerender } = render(<Skeleton />);
    const defaults = container.querySelectorAll('.ui-skeleton__line').length;
    expect(defaults).toBeGreaterThan(0);

    rerender(<Skeleton lines={5} />);

    expect(container.querySelectorAll('.ui-skeleton__line')).toHaveLength(5);
  });

  // Break caught: a count that is zero, negative or enormous. A bad number is a defect of the page, and a page of a million
  // placeholders is a fault of its own.
  it.each([0, -1, 1.5, Number.NaN, 1000])('refuses %s lines', (lines) => {
    // React reports the error it is about to throw; the test is about the throw.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Skeleton lines={lines} />)).toThrow(RangeError);
  });

  it('leaves the loading words to the loading indicator, which it sits beside', () => {
    render(
      <>
        <LoadingIndicator label="Loading the staff list…" />
        <Skeleton lines={3} />
      </>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading the staff list…');
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <LoadingIndicator />
        <Skeleton lines={4} />
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
