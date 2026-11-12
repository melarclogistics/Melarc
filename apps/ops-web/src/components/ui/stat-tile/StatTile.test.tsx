import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { StatTile } from './StatTile';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

/** A browser whose person asked the system for less motion (or did not). */
function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe('StatTile', () => {
  // Break caught: a figure rounded, capped or re-formatted on its way to the screen (12480 must read 12,480, exactly), or the label or caption lost.
  it('draws the label, the figure as the server gave it, and the caption', () => {
    render(<StatTile label="Waiting for confirmation" value={12480} caption="Oldest: 3 hours" />);

    expect(screen.getByText('Waiting for confirmation')).toBeVisible();
    expect(screen.getByText('12,480')).toBeVisible();
    expect(screen.getByText('Oldest: 3 hours')).toBeVisible();
  });

  // Break caught: text the page formatted (an amount) read as a number and written again, so that "GH₵25.50" becomes another figure.
  it('draws text it is given as it is (an amount the page formatted)', () => {
    render(<StatTile label="Estimate" value="GH₵25.50" />);

    expect(screen.getByText('GH₵25.50')).toBeVisible();
  });

  // Break caught: a figure that was never stated drawn as 0 (a queue with nothing, which it is not: nobody knows), the tile's whole risk.
  it('never draws a figure that was not stated as 0: it says it is not available', () => {
    const { container, rerender } = render(<StatTile label="Waiting" />);
    expect(container.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByText('Not available')).toBeInTheDocument();

    rerender(<StatTile label="Waiting" value={null} />);
    expect(container.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  // Break caught: a 0 that the server stated dropped as if it were missing: a queue worked to empty is an answer.
  it('draws a 0 that the server stated', () => {
    render(<StatTile label="Waiting" value={0} />);

    expect(screen.getByText('0')).toBeVisible();
    expect(screen.queryByText('Not available')).toBeNull();
  });

  // Break caught: a loading tile that draws a number (a stand-in or a 0), or does not say it is loading.
  it('draws no figure while it loads and says so', () => {
    const { container } = render(<StatTile label="Waiting" value={12} loading />);

    expect(container.textContent).not.toMatch(/\b12\b|\b0\b/);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading: Waiting');
  });

  describe('counting up', () => {
    // Break caught: a count-up that never ends where the server's figure is, or that gives assistive technology the numbers on the way.
    it('counts from 0 to the figure and ends on it exactly, with the final figure always there for assistive technology', async () => {
      setReducedMotion(false);
      render(<StatTile label="Waiting" value={120} countUp />);

      // The final figure is what is read, from the first moment; the moving one is for the eye.
      expect(screen.getByText('120', { selector: '.ui-visually-hidden' })).toBeInTheDocument();
      const drawn = () =>
        document.querySelector('.ui-stat-tile__value [aria-hidden="true"]')?.textContent;
      expect(drawn()).toBe('0');

      // The motion token's time is 900ms; the clock here is the real one, since Motion drives its frames from the browser's own.
      await waitFor(
        () => {
          expect(drawn()).toBeUndefined();
        },
        { timeout: 4000 },
      );
      expect(screen.getByText('120')).toBeVisible();
    });

    // Break caught: a count-up under reduced motion, which is motion the person asked not to have.
    it('does not count under reduced motion: the figure is there at once', () => {
      setReducedMotion(true);
      render(<StatTile label="Waiting" value={120} countUp />);

      expect(screen.getByText('120')).toBeVisible();
      expect(document.querySelector('.ui-stat-tile__value [aria-hidden="true"]')).toBeNull();
    });

    // Break caught: a tile that counts again whenever the figure changes (a refresh), though the count-up is the first reveal only.
    it('plays once: a later figure is shown at once', async () => {
      setReducedMotion(false);
      const { rerender } = render(<StatTile label="Waiting" value={50} countUp />);
      await waitFor(
        () => {
          expect(document.querySelector('.ui-stat-tile__value [aria-hidden="true"]')).toBeNull();
        },
        { timeout: 4000 },
      );
      expect(screen.getByText('50')).toBeVisible();

      rerender(<StatTile label="Waiting" value={75} countUp />);

      expect(screen.getByText('75')).toBeVisible();
      expect(document.querySelector('.ui-stat-tile__value [aria-hidden="true"]')).toBeNull();
    });

    // Break caught: a count-up on a tile that did not ask for one.
    it('does not count unless it is asked to', () => {
      setReducedMotion(false);
      render(<StatTile label="Waiting" value={120} />);

      expect(screen.getByText('120')).toBeVisible();
      expect(document.querySelector('.ui-stat-tile__value [aria-hidden="true"]')).toBeNull();
    });
  });

  // Break caught: a loading or unavailable tile whose status words, hidden figure or labels fail a rule of WCAG 2.2 that can be seen without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <>
        <StatTile label="Waiting" value={12} caption="Oldest: 3 hours" />
        <StatTile label="Dispatched" />
        <StatTile label="Delivered" loading />
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('StatTile: the region that says it is loading (task R5.2, M10)', () => {
  // Break caught: a region that arrives with its words (the loading line inserted with its role): most screen readers announce a change of a region that was there, not one that appears.
  it('has its region in the page before it loads, and the same one says it is loading', () => {
    const view = render(<StatTile label="Waiting" value={4} />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');

    view.rerender(<StatTile label="Waiting" value={undefined} loading />);

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Loading: Waiting');

    view.rerender(<StatTile label="Waiting" value={4} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('');
  });

  // Break caught: the empty region taking room in the tile (it is a flex child, and the tile's gap is added for it).
  it('keeps the region out of the layout', () => {
    render(<StatTile label="Waiting" value={4} />);

    expect(screen.getByRole('status')).toHaveClass('ui-visually-hidden');
  });
});
