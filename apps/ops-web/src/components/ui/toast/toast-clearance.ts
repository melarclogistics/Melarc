import { useLayoutEffect, type RefObject } from 'react';

/** The custom property on the page's root that holds how far up from the bottom of the window the toasts must stand (`toast.css`, `Toast.tsx`). */
export const TOAST_CLEARANCE_PROPERTY = '--ui-toast-clearance';

/**
 * A control that sticks to the bottom of the window (a page's submit bar, a bar of acts) tells the toasts where it is, so that a toast never covers it (task R5.2, M11). Under
 * 600px a toast stands at the bottom of the window, across it; with a bar there, it stands above the bar. The element gives how far its top is from the bottom of the window,
 * kept as the window and the page change (its size, the scroll, the window's size), and takes the clearance back when it goes. It changes nothing on the element and draws
 * nothing. One bar at a time: a second takes over, and the first, going, takes the value away, so a page with two sticky bars at once names the one that matters.
 */
export function useToastClearance(element: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const target = element.current;
    if (target === null) return;
    const root = document.documentElement;
    const publish = (): void => {
      const standingAbove = Math.max(0, window.innerHeight - target.getBoundingClientRect().top);
      root.style.setProperty(TOAST_CLEARANCE_PROPERTY, `${String(standingAbove)}px`);
    };
    publish();
    const resizing =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    resizing?.observe(target);
    window.addEventListener('resize', publish);
    window.addEventListener('scroll', publish, { passive: true });
    return () => {
      resizing?.disconnect();
      window.removeEventListener('resize', publish);
      window.removeEventListener('scroll', publish);
      root.style.removeProperty(TOAST_CLEARANCE_PROPERTY);
    };
  }, [element]);
}
