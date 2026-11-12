import { useCallback, useEffect, useState, type RefObject } from 'react';

import { useFocusReturn } from './focus-return';

/** The key hint the search shows: `⌘K` on an Apple platform, `Ctrl K` anywhere else. */
export function shortcutHint(): string {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

/**
 * When the palette is open, and where focus goes when it closes (surfaces/ops-portal.md section 4: **Enter opens, Escape closes and returns focus to
 * whatever opened it**).
 *
 * - **Ctrl or ⌘ K** opens it from anywhere in the shell, and closes it again. The browser's own use of the key (a search in the address bar) is
 *   taken only when the shell handles it, a key held down included (a repeat toggles nothing, and still must not give the address bar focus midway).
 *   While a modal dialog of the page is open the key does nothing and is left to the browser: the palette would be drawn beneath the dialog's own
 *   layer, where it cannot be reached. Ctrl and ⌘ are both taken on every platform (a recorded decision: the brief says "Ctrl K (⌘K on macOS)").
 * - **Whatever had focus when it opened gets it back when it closes** (the button of the top bar when nothing did), unless the person went to a page:
 *   focus is then put on the new page's heading (`useFocusReturn`).
 *
 * The ref of the search button is the caller's, which draws the button, and is given in: what comes out is values and callbacks only, so that none
 * of it is read as a ref (a ref beside values in one object makes every read of the object a read of a ref, in render).
 */
export function usePalette(searchButton: RefObject<HTMLButtonElement | null>) {
  const [open, setOpen] = useState(false);
  const focus = useFocusReturn(searchButton);
  const { remember } = focus;

  const openPalette = useCallback((): void => {
    remember();
    setOpen(true);
  }, [remember]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (document.querySelector('dialog[open]') !== null) return;
      event.preventDefault();
      if (event.repeat) return;
      if (open) setOpen(false);
      else openPalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, openPalette]);

  return { open, setOpen, openPalette, onCloseAutoFocus: focus.onCloseAutoFocus };
}
