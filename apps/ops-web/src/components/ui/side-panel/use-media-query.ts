import { useSyncExternalStore } from 'react';

/** At this width and below the side panel is a full-screen sheet: the tablet, and the phone (768px is `breakpoint.md`, in rem). */
export const SHEET_QUERY = '(max-width: 48rem)';

/**
 * Whether a media query matches now, and whether that changes while the page is open (the window is resized across a breakpoint). A browser that cannot
 * answer is taken not to match, so the wide layout is the default, and a test can say what the screen is by giving `window.matchMedia` an answer.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
