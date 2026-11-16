import { useEffect } from 'react';

/** The custom property the inset is written to, on the document's root: a stylesheet takes it as `var(--keyboard-inset, 0px)`. */
export const KEYBOARD_INSET_PROPERTY = '--keyboard-inset';

/**
 * How much of the bottom of the page the on-screen keyboard covers, in pixels, from what the **visual viewport** says: the part of the page the person can see is shorter than the window by the keyboard
 * (and moved by how far the page is scrolled inside it). A browser with no visual viewport, or one whose keyboard resizes the page itself, reports no inset: nothing covers the page that the page does not already
 * know. It is never negative.
 */
export function keyboardInset(): number {
  // A browser with no visual viewport has none (`null`), and a test document has none to ask for (`undefined`).
  const viewport: VisualViewport | null | undefined = window.visualViewport;
  if (viewport === null || viewport === undefined) return 0;
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * Keeps the inset the keyboard leaves at the foot of the page in a custom property of the root, while the page that asked is open, so that a bar fixed to the foot of the screen (the hub floor's action bar) is lifted
 * above the keyboard and an officer typing a note is never made to close the keyboard to reach the button. It is written with the style object (never an attribute), listens to the visual viewport's `resize`
 * and `scroll` and to nothing else, and takes the property off the root when the page goes.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport: VisualViewport | null | undefined = window.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const root = document.documentElement;
    const write = (): void => {
      root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${String(keyboardInset())}px`);
    };
    write();
    viewport.addEventListener('resize', write);
    viewport.addEventListener('scroll', write);
    return () => {
      viewport.removeEventListener('resize', write);
      viewport.removeEventListener('scroll', write);
      root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    };
  }, []);
}
