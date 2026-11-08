import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../primitives/sheet';
import { OperationalCode } from '../code/OperationalCode';
import { IconButton } from '../icon-button/IconButton';
import { Link } from '../link/Link';
import { AnimatePresence, motion, useMotion } from '../motion/motion';
import { InSidePanel } from './side-panel-context';
import { useMediaQuery } from './use-media-query';
import './side-panel.css';

/** At this width and below the panel is a full-screen sheet: the tablet, and the phone (768px is `breakpoint.md`, in rem). */
const SHEET_QUERY = '(max-width: 48rem)';

export interface SidePanelProps {
  readonly open: boolean;
  /** The person asked to close it (Escape, the close button, the sheet's own close). The page decides: it holds `open`. */
  readonly onClose: () => void;
  /** The record's code, exactly as the server gave it. It names the panel and is its heading. */
  readonly code: string;
  /** The record's status as a badge, beside the code (a slot: the page passes the StatusBadge of its mapping). */
  readonly status?: ReactNode;
  /** Where the whole record is: the "Open full page" link. */
  readonly fullPage?: { readonly to: string };
  /** What the panel holds: the page's own summary of the record, with its own loading, failure and refusal in place. */
  readonly children: ReactNode;
  /**
   * The control that opened the panel (the code button of a row). Focus goes back to it when the panel closes. Left out, it is whatever had focus when
   * the panel opened, which for a press on a row's button is that button.
   */
  readonly returnFocusTo?: () => HTMLElement | null;
}

/**
 * A record beside its list (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *SidePanel*): 360 to 420px wide, 12px corners, the floating shadow, sliding
 * in 18px with a fade over `motion.slow` (Motion; nothing moves under reduced motion). Its header is the record's code, "Open full page" and a close button.
 * At 768px and below it is a full-screen sheet (a modal dialog on the sheet primitive). Focus moves into the panel when it opens, and **back to the row** when it
 * closes; Escape closes it; opening another record moves focus to the new heading. It holds the record's summary and nothing of its own: loading, failure
 * and refusal are what the page puts inside.
 */
export function SidePanel({
  open,
  onClose,
  code,
  status,
  fullPage,
  children,
  returnFocusTo,
}: SidePanelProps) {
  const sheet = useMediaQuery(SHEET_QUERY);
  const motionKit = useMotion();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  /** What had focus when the panel (or the record in it) was last opened. */
  const opener = useRef<Element | null>(null);
  /** The page's way back to the row, as it is now: the effect below must not run again because the page wrote a new function. */
  const returnTo = useRef(returnFocusTo);
  useLayoutEffect(() => {
    returnTo.current = returnFocusTo;
  });
  const wasOpen = useRef(false);

  const giveFocusBack = (): void => {
    const back = returnTo.current?.() ?? opener.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };

  // Docked: focus goes to the heading when the panel opens and when another record takes it, and back to the row when it closes. The sheet is a modal
  // dialog, which moves focus in itself (below) and has no trigger of its own to give it back to.
  const docked = !sheet;
  useEffect(() => {
    if (!docked) return;
    if (open) {
      // A press on another row's button moves focus out of the panel first: that button is the one to go back to.
      if (!wasOpen.current || document.activeElement?.closest('.ui-side-panel') === null) {
        opener.current = document.activeElement;
      }
      wasOpen.current = true;
      // Without a scroll: the panel is in view where it stands (it is sticky beside the list), and moving the page to the heading would shift the list under the person who opened it.
      heading.current?.focus({ preventScroll: true });
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      // Focus goes back to the row only if it was in the panel (Escape, the close button) or nowhere (the focused control went with the panel). A page that closes the
      // panel while the person is on another control (a filter, a field) must not pull focus away from it (task R5.2, M7).
      const active = document.activeElement;
      const wasInside =
        active === null || active === document.body || active.closest('.ui-side-panel') !== null;
      if (!wasInside) return;
      const back = returnTo.current?.() ?? opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    }
  }, [docked, open, code]);

  if (sheet) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent
          side="right"
          className="ui-side-sheet"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Radix would focus the first control; the heading says what has opened.
            opener.current = document.activeElement;
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // The sheet has no trigger, so Radix has nowhere to send focus: it goes to the row.
            event.preventDefault();
            giveFocusBack();
          }}
        >
          <SheetHeader className="ui-side-panel__header">
            <SheetTitle ref={heading} tabIndex={-1} className="ui-side-panel__heading">
              <OperationalCode>{code}</OperationalCode>
            </SheetTitle>
            {status === undefined ? null : <span className="ui-side-panel__status">{status}</span>}
            {fullPage === undefined ? null : (
              <div className="ui-side-panel__actions">
                <Link to={fullPage.to}>Open full page</Link>
              </div>
            )}
          </SheetHeader>
          <div className="ui-side-panel__body">
            <InSidePanel.Provider value>{children}</InSidePanel.Provider>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="side-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="ui-side-panel"
          initial={motionKit.reduced ? false : { opacity: 0, x: 18 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 18 }}
          transition={motionKit.transition('slow')}
          onKeyDown={(event) => {
            // A menu or a popover inside the panel closes on Escape itself and says so; the panel closes only for an Escape nothing has taken.
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.stopPropagation();
              onClose();
            }
          }}
        >
          <div className="ui-side-panel__header">
            <h2 id={titleId} ref={heading} tabIndex={-1} className="ui-side-panel__heading">
              <OperationalCode>{code}</OperationalCode>
            </h2>
            {status === undefined ? null : <span className="ui-side-panel__status">{status}</span>}
            <div className="ui-side-panel__actions">
              {fullPage === undefined ? null : <Link to={fullPage.to}>Open full page</Link>}
              <IconButton type="button" icon="close" label="Close the panel" onClick={onClose} />
            </div>
          </div>
          <div
            className="ui-side-panel__body"
            role="region"
            aria-label={`Details of ${code}`}
            tabIndex={0}
          >
            <InSidePanel.Provider value>{children}</InSidePanel.Provider>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
