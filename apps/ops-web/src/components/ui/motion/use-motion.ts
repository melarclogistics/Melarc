import type { Transition } from 'motion/react';
import { useMemo, useSyncExternalStore } from 'react';

import { durationSeconds, easeCurve, type MotionDuration, type MotionEase } from './motion-tokens';

const REDUCED = '(prefers-reduced-motion: reduce)';

const hasMatchMedia = (): boolean => typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

const read = (): boolean => hasMatchMedia() && window.matchMedia(REDUCED).matches;

/** Whether the person asked the system for less motion, and whether it changes while the page is open. A browser that cannot say is taken to allow motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

export interface Motion {
  /** The person asked for less motion: nothing moves, nothing counts up, nothing is laid out again with a glide. */
  readonly reduced: boolean;
  /** A Motion transition on the tokens (a duration and an easing); instant when motion is reduced. */
  readonly transition: (duration: MotionDuration, ease?: MotionEase) => Transition;
}

/**
 * The one way a component of the kit animates with Motion (DESIGN_SYSTEM section 9; COMPONENT_PATTERNS, *Motion*): its durations and easings are the
 * tokens of `tokens.css`, and everything is off when `prefers-reduced-motion: reduce` is set, with the same preference that zeroes the tokens for the
 * stylesheet. A component never writes a duration or an easing of its own.
 */
export function useMotion(): Motion {
  const reduced = usePrefersReducedMotion();
  return useMemo(
    () => ({
      reduced,
      transition: (duration, ease = 'enter') =>
        reduced ? { duration: 0 } : { duration: durationSeconds(duration), ease: easeCurve(ease) },
    }),
    [reduced],
  );
}
