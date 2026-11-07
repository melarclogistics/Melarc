import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useMotion } from './use-motion';

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  document.documentElement.removeAttribute('style');
});

/** A browser whose person asked the system for less motion (or did not), and that tells the page when they change their mind. */
function stubReducedMotion(initial: boolean): { readonly set: (reduced: boolean) => void } {
  let reduced = initial;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return reduced && query.includes('prefers-reduced-motion');
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    }),
  });
  return {
    set: (next) => {
      reduced = next;
      for (const listener of listeners) listener();
    },
  };
}

function Probe() {
  const motion = useMotion();
  return (
    <output data-testid="probe">
      {JSON.stringify({
        reduced: motion.reduced,
        slow: motion.transition('slow'),
        exit: motion.transition('normal', 'exit'),
      })}
    </output>
  );
}

const read = (): {
  reduced: boolean;
  slow: Record<string, unknown>;
  exit: Record<string, unknown>;
} =>
  JSON.parse(screen.getByTestId('probe').textContent) as {
    reduced: boolean;
    slow: Record<string, unknown>;
    exit: Record<string, unknown>;
  };

describe('useMotion', () => {
  // Break caught: a duration or an easing written in the code instead of read from the motion tokens, so that the numbers drift from tokens.css
  // (the stylesheet-less fallback of a test is held equal to the file by test/motion-tokens.test.ts).
  it('gives the durations and easings of the tokens', () => {
    stubReducedMotion(false);
    render(<Probe />);

    expect(read()).toEqual({
      reduced: false,
      slow: { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] },
      exit: { duration: 0.2, ease: [0.4, 0, 1, 1] },
    });
  });

  // Break caught: the token read once at load, so that a theme or a media rule that changes it is not followed by what moves in JavaScript.
  it('reads the token from the page when it is used', () => {
    stubReducedMotion(false);
    document.documentElement.style.setProperty('--motion-slow', '500ms');
    document.documentElement.style.setProperty(
      '--motion-ease-enter',
      'cubic-bezier(0.1, 0.2, 0.3, 0.4)',
    );
    render(<Probe />);

    expect(read().slow).toEqual({ duration: 0.5, ease: [0.1, 0.2, 0.3, 0.4] });
  });

  // Break caught: motion under reduced motion: every transition is instant, with no easing to wait on.
  it('is instant when the person asked for less motion', () => {
    stubReducedMotion(true);
    render(<Probe />);

    expect(read()).toEqual({ reduced: true, slow: { duration: 0 }, exit: { duration: 0 } });
  });

  // Break caught: the preference read once, so that a person who changes it while the page is open keeps the old behaviour until they reload.
  it('follows the preference while the page is open', () => {
    const preference = stubReducedMotion(false);
    render(<Probe />);
    expect(read().reduced).toBe(false);

    act(() => {
      preference.set(true);
    });
    expect(read()).toEqual({ reduced: true, slow: { duration: 0 }, exit: { duration: 0 } });

    act(() => {
      preference.set(false);
    });
    expect(read().reduced).toBe(false);
  });

  // Break caught: a browser that cannot say taken to want no motion (or to throw): the page must still draw.
  it('allows motion in a browser that cannot say', () => {
    render(<Probe />);

    expect(read().reduced).toBe(false);
  });
});
