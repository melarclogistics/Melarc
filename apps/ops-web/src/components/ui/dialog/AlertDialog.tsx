import type { ReactNode } from 'react';

import { Alert } from '../alert/Alert';
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
  /**
   * The act failed, in the page's own words (never the API's `message`): the question stays open with the words under it, so that the person can try again or go
   * back. It is announced when it appears.
   */
  readonly error?: string;
}

/**
 * The confirmation of a high-risk act (COMPONENT_PATTERNS section 20): an alert dialog with a question, its consequence and two buttons.
 * It is for an act that is hard to undo and never for information. Focus starts on the safe action, so a keypress meant for something else
 * cannot do the harm. The confirming button says what it does, in the Danger treatment, and is the form's submit, so Enter confirms from a
 * field as well. A click on the backdrop answers nothing. **Its submit stays inside it** (`stopPropagation`): a dialog drawn where a form holds it (an action
 * menu in a form) must not send that form when the question is confirmed (task R5.2, M3).
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
  error,
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
          event.stopPropagation();
          if (!pending) onConfirm();
        }}
      >
        {error === undefined ? null : (
          <Alert variant="danger" announce>
            {error}
          </Alert>
        )}
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
