import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { openerOf } from '../opener/opener';
import './dialog.css';
import { DialogContainer } from './dialog-container';

export interface DialogProps {
  readonly open: boolean;
  /** The dialog's name, and its heading. */
  readonly title: string;
  /** What the dialog is about, in words. The dialog is described by it, so a screen reader reads it with the name. */
  readonly description?: ReactNode;
  /** `alertdialog` for a question that interrupts: a high-risk confirmation. Most dialogs are `dialog`. */
  readonly role?: 'dialog' | 'alertdialog';
  /**
   * Escape, and a close the browser made on its own, ask the page to close the dialog. The page decides. Leave it out and the dialog cannot
   * be dismissed: it stays, and is opened again if the browser closed it. A click on the backdrop never asks.
   */
  readonly onRequestClose?: () => void;
  /** The content, drawn only while the dialog is open, so that a dialog opened again starts clean. */
  readonly children?: ReactNode;
}

/** The control that has focus when the dialog opens is the one that says so, and otherwise the browser's choice: the first. */
const INITIAL_FOCUS = '[data-initial-focus]';

/**
 * The modal dialog (COMPONENT_PATTERNS section 20), on the platform's own `<dialog>` opened with `showModal()`. That is the primitive, and
 * the reason is what it gives for nothing: the top layer (nothing can sit above it or be clipped under it), a page behind it that is inert
 * (no focus by Tab or by script, no click), Escape as a `cancel` event, a backdrop to draw, and no dependency to qualify. What it does not
 * do the component does:
 *
 * - **Opening** is the page's `open` prop; the dialog element is always in the page and is opened and closed with it, so the browser's
 *   state and the page's cannot drift (a `close` the browser made on its own is brought back in line, see below).
 * - **Initial focus** goes to the control marked `data-initial-focus` when there is one (an alert dialog marks its safe action) and
 *   otherwise to the first focusable one.
 * - **Return of focus**: the control that opened it gets focus back when the dialog closes, whether the page closed it, Escape did, or
 *   the page it was on went away. That control is the one that was pressed, and else the one that had focus (`openerOf`: Safari's engine
 *   gives a pressed button no focus, so the focused element alone would be the body). If it is gone, focus stays where the browser leaves it.
 * - **Escape** is the `cancel` event: the browser's closing is prevented and the page is asked, so React's state is the one truth.
 * - **The backdrop** never closes it. What a person typed would be lost to a stray click, and a state they must see could be hidden.
 *
 * The content is drawn only while the dialog is open.
 */
export function Dialog({
  open,
  title,
  description,
  role = 'dialog',
  onRequestClose,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const element = useRef<HTMLDialogElement | null>(null);
  // The element is also state, so that what is drawn inside the dialog (a calendar that opens over it) can be drawn into it.
  const [host, setHost] = useState<HTMLDialogElement | null>(null);
  const attach = useCallback((node: HTMLDialogElement | null) => {
    element.current = node;
    setHost(node);
  }, []);
  const latest = useRef({ open, onRequestClose });
  /** How many `close` events are still to come from closes this component made itself: a browser queues the event, and it may arrive after the dialog was opened again. */
  const ownCloses = useRef(0);

  // Kept current at commit, so that an event handler never reads what an earlier render knew.
  useLayoutEffect(() => {
    latest.current = { open, onRequestClose };
  });

  useLayoutEffect(() => {
    const dialog = element.current;
    if (dialog === null || !open) return;
    const opener = openerOf();
    // A dialog that is already open is left as it is: `showModal()` throws for one.
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(INITIAL_FOCUS)?.focus();
    return () => {
      if (dialog.open) {
        ownCloses.current += 1;
        dialog.close();
      }
      if (opener?.isConnected === true) opener.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={attach}
      className="ui-dialog"
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        // The browser would close it. The page decides, and a page that cannot be asked leaves it open.
        event.preventDefault();
        latest.current.onRequestClose?.();
      }}
      onClose={() => {
        // The dialog closed because this component closed it (the page already knows), possibly before it was opened again: the event
        // is the browser's, and it comes after the call.
        if (ownCloses.current > 0) {
          ownCloses.current -= 1;
          return;
        }
        const { open: wanted, onRequestClose: ask } = latest.current;
        if (!wanted) return;
        // The browser closed it on its own (a second Escape on a page nobody has touched is not cancelable). The page is told, and a dialog
        // the page still wants is opened again once the page has had its say.
        ask?.();
        setTimeout(() => {
          const dialog = element.current;
          if (dialog !== null && latest.current.open && !dialog.open) dialog.showModal();
        }, 0);
      }}
    >
      {open ? (
        <DialogContainer value={host}>
          <div className="ui-dialog__panel">
            <h2 id={titleId} className="ui-dialog__title">
              {title}
            </h2>
            {description === undefined ? null : (
              <div id={descriptionId} className="ui-dialog__description">
                {description}
              </div>
            )}
            {children}
          </div>
        </DialogContainer>
      ) : null}
    </dialog>
  );
}

/** The row of buttons at the foot of a dialog. They wrap on a narrow screen, and the primary act is last. */
export function DialogActions({ children }: { readonly children: ReactNode }) {
  return <div className="ui-dialog__actions">{children}</div>;
}
