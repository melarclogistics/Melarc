import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router';

import { openerOf } from '../../components/ui/opener/opener';

/**
 * Whether focus is on the page, inside the main landmark: after a client-side navigation the frame puts it on the new page's heading
 * (`AppFrame`), so a menu that closes *because the person went to a page* finds it there.
 *
 * A Radix menu gives focus back to its trigger when it closes, which is right when it was dismissed and wrong when it was used to go somewhere:
 * it would take focus from the heading of the page that opened, a moment after the frame moved it there. The shell passes `keepFocusOnThePage` as the
 * `onCloseAutoFocus` of each menu, so that the return of focus is stopped in exactly that case and left alone otherwise.
 */
export function focusIsOnThePage(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement && active !== document.body && active.closest('main') !== null
  );
}

/** The `onCloseAutoFocus` of a menu: take focus back to its button, unless focus is already on the page the person went to. */
export function keepFocusOnThePage(event: Event): void {
  if (focusIsOnThePage()) event.preventDefault();
}

/** Puts focus on the heading of the page, the way the frame does after a navigation, or on the main landmark when the page has no heading yet. */
export function focusPageHeading(): void {
  const main = document.querySelector<HTMLElement>('main');
  (main?.querySelector<HTMLElement>('h1') ?? main)?.focus();
}

/**
 * Where focus goes when a **dialog that has no trigger of its own** closes: the palette, and the sidebar's sheet. Radix gives focus back to a dialog's
 * trigger and to nothing else (a dialog opened by a key, or by a button that is not its `Trigger`, leaves focus on the page's body), so it is given
 * back here:
 *
 * - **to the control that opened it** (`openerOf`: the one that was pressed, and else the one that had focus when the dialog opened, since Safari's engine gives a
 *   pressed button no focus), or to `fallback` (the ref of the button of the top bar, read when the dialog closes) when there was none;
 * - **unless the person went to a page by it**: the frame moved focus to the new page's heading, but a dialog that is still open when it does keeps
 *   focus inside itself (it traps it), so focus is on the body when the dialog has gone. It is put on the heading then, as the frame would have.
 *
 * Call `remember` when the dialog opens, and pass `onCloseAutoFocus` to it.
 */
export function useFocusReturn(fallback: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const now = useRef(pathname);
  useLayoutEffect(() => {
    now.current = pathname;
  });
  const opened = useRef<{ readonly element: HTMLElement | null; readonly path: string }>({
    element: null,
    path: pathname,
  });

  const remember = useCallback((): void => {
    opened.current = { element: openerOf(), path: now.current };
  }, []);

  const onCloseAutoFocus = useCallback(
    (event: Event): void => {
      // Radix gives focus back to a trigger this dialog does not have: it is given back here, or not at all.
      event.preventDefault();
      if (now.current !== opened.current.path) {
        focusPageHeading();
        return;
      }
      const { element } = opened.current;
      (element?.isConnected === true ? element : fallback.current)?.focus();
    },
    [fallback],
  );

  return { remember, onCloseAutoFocus };
}
