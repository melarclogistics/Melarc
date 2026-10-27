import type { ReactNode } from 'react';

import { Button } from '../button/Button';
import { Dialog, DialogActions } from './Dialog';

export interface AlertDialogProps {
  readonly open: boolean;
  /** The question, as a question: "End this session?". */
  readonly title: string;
  /** The consequence, in words. The dialog is described by it. */
  readonly children: ReactNode;
  /** What confirming does, in the act's own words ("Reset the second factor"), never "OK" or "Yes". */
  readonly confirmLabel: string;
  /** What cancelling does. Cancelling leaves things as they are. */
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** The act is under way. The confirming button is busy, cancelling is not offered, and Escape does nothing: what is under way must stay in sight. */
  readonly pending?: boolean;
}

/**
 * The confirmation of a high-risk act (COMPONENT_PATTERNS section 20): an alert dialog with a question, its consequence and two buttons.
 * It is for an act that is hard to undo and never for information. Focus starts on the safe action, so a keypress meant for something else
 * cannot do the harm. The confirming button says what it does, in the Danger treatment, and is the form's submit, so Enter confirms from a
 * field as well. A click on the backdrop answers nothing.
 */
export function AlertDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  pending = false,
}: AlertDialogProps) {
  return (
    <Dialog
      open={open}
      role="alertdialog"
      title={title}
      description={children}
      {...(pending ? {} : { onRequestClose: onCancel })}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onConfirm();
        }}
      >
        <DialogActions>
          <Button
            type="button"
            variant="secondary"
            data-initial-focus
            disabled={pending}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button type="submit" variant="danger" loading={pending}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
