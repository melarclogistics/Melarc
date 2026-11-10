import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Which ends of a scrolling row hold something that is cut off: nothing, the start, the end, or both. */
export type EdgeFade = '' | 'start' | 'end' | 'start end';

/** A fade is 1.5rem wide (the stylesheet's); a tab brought into view stays clear of it by as much. */
const FADE_REM = 1.5;

/**
 * The distance, in pixels, of a tab that is brought into view from the edge of the row: the width of the fade. It is 1.5rem, so it is of the **root's** text, whatever size the row's own text is
 * (the row's is smaller, and a distance taken from it left a tab 3px under the fade: found by the browser test of a view reached by an arrow key, 10 November 2026).
 */
function clearance(element: HTMLElement): number {
  const size = Number.parseFloat(getComputedStyle(element.ownerDocument.documentElement).fontSize);
  return FADE_REM * (Number.isFinite(size) ? size : 16);
}

/**
 * A tab is moved until it is whole and clear of the end it lies near by the width of the fade, and no further (a tab already clear is not moved). Only the row scrolls: `scrollLeft` is set,
 * which no browser does to the page.
 */
function keepClear(element: HTMLElement, tab: HTMLElement): void {
  const room = element.getBoundingClientRect();
  const place = tab.getBoundingClientRect();
  const margin = clearance(element);
  if (place.left < room.left + margin) {
    element.scrollLeft += place.left - room.left - margin;
  } else if (place.right > room.right - margin) {
    element.scrollLeft += place.right - room.right + margin;
  }
}

/** What a person does to a row of tabs with their own hands: from then on its position is theirs, until the current view changes. */
const BY_HAND = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * What a row of tabs that scrolls sideways needs on a narrow screen: which of its ends are cut off (so that the stylesheet can fade them: a row
 * that ends at the edge of the screen with a whole tab looks complete), and the current tab brought into view when it changes (a view chosen by
 * the address, by a link, or by the keys) and kept in view while the list grows (the counts arrive, the fonts load, the text is enlarged) until
 * the person scrolls the row themselves. **A tab that takes focus is brought clear of the fades too** (the Product Owner, 10 November 2026): a browser scrolls a focused tab into view only when
 * none of it is in view (Chromium) or just into the row (the others), so that a view reached by an arrow key lay half under the fade at the edge, its words erased. It reads the row and sets
 * nothing but its scroll position; it never takes focus. The row is measured when it is drawn, when it is scrolled, and when its own box or its list changes size.
 */
export function useEdgeFade(current: string): {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly fade: EdgeFade;
} {
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<EdgeFade>('');
  /** Whether the row is following the current tab: so from a change of view until the person puts a hand on the row. */
  const following = useRef(true);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const hidden = element.scrollWidth - element.clientWidth;
    const at = Math.abs(element.scrollLeft);
    const start = hidden > 1 && at > 1;
    const end = hidden > 1 && at < hidden - 1;
    setFade(start && end ? 'start end' : start ? 'start' : end ? 'end' : '');
  }, []);

  // The current tab is brought into view, and no further: a tab already clear of both ends is not moved, and the page is not scrolled (only the row is). The first and the last
  // tab go to the start and to the end of the row: nothing lies beyond them to show, and a fade left at an end that holds only the list's padding would say that something is hidden.
  const bringCurrentIntoView = useCallback(() => {
    const element = scroller.current;
    const tab = element?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (element === null || tab === null || tab === undefined) return;
    const tabs = [...element.querySelectorAll('[role="tab"]')];
    if (tab === tabs[0]) {
      element.scrollLeft = 0;
    } else if (tab === tabs[tabs.length - 1]) {
      element.scrollLeft = element.scrollWidth;
    } else {
      keepClear(element, tab);
    }
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    measure();
    const onResize = (): void => {
      if (following.current) bringCurrentIntoView();
      measure();
    };
    const takeOver = (): void => {
      following.current = false;
    };
    // A tab that takes focus, by the arrow keys, by Tab or by a press, is moved clear of the fades.
    const onFocus = (event: FocusEvent): void => {
      const tab = event.target;
      if (tab instanceof HTMLElement && tab.getAttribute('role') === 'tab') keepClear(element, tab);
    };
    element.addEventListener('focusin', onFocus);
    element.addEventListener('scroll', measure, { passive: true });
    for (const type of BY_HAND) element.addEventListener(type, takeOver, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    // A tab is wider when its count arrives, and the list it is in keeps its own box (the tabs overflow it), so a change of size is seen only by watching the tabs themselves: otherwise the row
    // stays where it was and the last view is cut off by what the counts added (found by the engines run of 10 November 2026, in Firefox, where the counts arrive after the first draw).
    // Views that come and go, and a count that appears, are told by what changes in the row.
    const watchTabs = (): void => {
      for (const tab of element.querySelectorAll('[role="tab"]')) observer?.observe(tab);
    };
    watchTabs();
    const changes =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            watchTabs();
            onResize();
          });
    changes?.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      element.removeEventListener('focusin', onFocus);
      element.removeEventListener('scroll', measure);
      for (const type of BY_HAND) element.removeEventListener(type, takeOver);
      observer?.disconnect();
      changes?.disconnect();
    };
  }, [measure, bringCurrentIntoView]);

  useLayoutEffect(() => {
    following.current = true;
    bringCurrentIntoView();
    measure();
  }, [current, measure, bringCurrentIntoView]);

  return { scroller, fade };
}
