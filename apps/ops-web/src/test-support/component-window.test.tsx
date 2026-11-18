import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useMotion } from '../components/ui/motion/use-motion';
import { currentViewport } from '../platform/viewport/use-viewport';

function Probe() {
  const motion = useMotion();
  return (
    <output data-testid="probe">
      {JSON.stringify({ reduced: motion.reduced, slow: motion.transition('slow') })}
    </output>
  );
}

/** The window every component test starts with (`test/setup-components.ts`): jsdom has none of its own. */
describe('the window of a component test', () => {
  // Break caught: the default taken away, so that a panel enters with a fade from nothing and a check of "visible" made on its first frame reads it at opacity 0, now and then (MissingParcelsPage, 18 November 2026).
  it('asks for less motion, so that the kit draws its end state at once', () => {
    render(<Probe />);

    expect(JSON.parse(screen.getByTestId('probe').textContent)).toEqual({
      reduced: true,
      slow: { duration: 0 },
    });
  });

  // Break caught: a window that answers every query with a match, which would tell the shell it is a phone and the theme that the system is dark, in every test that does not say otherwise.
  it('is a desktop with no other preference: wide, and no dark scheme', () => {
    expect(currentViewport()).toBe('wide');
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
  });
});
