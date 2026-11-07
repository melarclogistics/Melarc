import { useEffect } from 'react';

/** The custom property of the root that holds the height the sticky top bar has now, in pixels; `base.css` reads it for the root's scroll padding. */
export const TOP_BAR_HEIGHT_PROPERTY = '--topbar-measured-height';

/**
 * Keeps the root's scroll padding as tall as the sticky top bar **is** (audit B2, 7 November 2026). The bar is 56px in one row, and a second row
 * (or a third) when its controls do not fit in one: text enlarged to 200% on a phone (WCAG 1.4.4, 1.4.10). A scroll padding written for the one row
 * left a control reached by Tab, backwards up a long page, scrolled in under the bar's second row, where it could not be seen (WCAG 2.4.11), so the
 * padding is the bar's **measured** height, kept in step as it changes.
 *
 * The height is published as a custom property of the root with the CSSOM (`style.setProperty`), which the strict content-security policy allows (it
 * refuses a `style` attribute in markup and a script that writes one as text, not a property set from script). Where the bar is not drawn, or has no
 * height (it is `display: none` outside the sidebar layout), or the browser cannot observe sizes, the property is left out and `base.css` falls back to
 * the one-row height of the token.
 *
 * `bar` is the element that sticks (the frame's place for the top bar), and `sticky` is whether the layout makes it stick.
 */
export function useTopBarClearance(bar: HTMLElement | null, sticky: boolean): void {
  useEffect(() => {
    if (bar === null || !sticky) return;
    const root = document.documentElement;
    const publish = (): void => {
      const height = bar.getBoundingClientRect().height;
      if (height > 0) root.style.setProperty(TOP_BAR_HEIGHT_PROPERTY, `${String(height)}px`);
      else root.style.removeProperty(TOP_BAR_HEIGHT_PROPERTY);
    };
    publish();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(TOP_BAR_HEIGHT_PROPERTY);
    };
  }, [bar, sticky]);
}
