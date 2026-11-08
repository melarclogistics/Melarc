import type { ConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import { Alert } from '../alert/Alert';
import { Button, type ButtonVariant } from '../button/Button';
import { DialogActions } from '../dialog/Dialog';

/**
 * What the two confirmation dialogs (`ReasonConfirmationDialog`, `ConfirmationDialog`) say and offer once a command is under way, refused,
 * in conflict or of unknown outcome. It is one place so that they cannot disagree: the words an unknown outcome is told in, which way out
 * is offered and which button has the focus are the pattern's (COMPONENT_PATTERNS sections 20.4 and 33.2), not a dialog's own.
 */
type Outcome = Pick<
  ConfirmedCommand<object>,
  'phase' | 'problem' | 'canRetry' | 'locked' | 'retry' | 'checkRecord'
>;

const UNKNOWN_RETRYABLE =
  'We could not confirm whether this was done. You can try again: if it was already done, it is not done twice. Or check the record first.';
const UNKNOWN_CHECK_ONLY =
  'We could not confirm whether this was done. Check the record before doing anything else.';

/**
 * The alert a command leaves: an outcome nobody knows, or a refusal in approved words. Nothing for a command that is idle, sending or done.
 * An act that has words of its own for an outcome nobody knows (a code that may or may not have been made) passes them as `unknownText`; the
 * generic sentence is the default, and the way out the person is offered does not depend on which is said.
 */
export function CommandOutcomeNotice({
  command,
  unknownText,
}: {
  readonly command: Outcome;
  readonly unknownText?: string | undefined;
}) {
  if (command.phase === 'unknown') {
    return (
      <Alert variant="danger" announce>
        <p>{unknownText ?? (command.canRetry ? UNKNOWN_RETRYABLE : UNKNOWN_CHECK_ONLY)}</p>
        {command.problem === undefined ? null : <p>{command.problem.message}</p>}
      </Alert>
    );
  }
  if ((command.phase === 'refused' || command.phase === 'conflict') && command.problem) {
    return (
      <Alert variant="danger" announce>
        <p>{command.problem.message}</p>
        {command.problem.reference === undefined ? null : (
          <p>Reference: {command.problem.reference}</p>
        )}
      </Alert>
    );
  }
  return null;
}

export interface CommandOutcomeActionsProps {
  readonly command: Outcome;
  readonly cancelLabel: string;
  readonly onCancel: () => void;
  readonly confirmLabel: string;
  /** `danger` for an act that does harm (the default of the dialogs); `primary` for one that does not. */
  readonly confirmVariant: ButtonVariant;
  /** The act cannot be confirmed yet (the reasons are still loading). */
  readonly confirmDisabled?: boolean;
}

/**
 * The foot of a confirmation: Cancel and the act, or, once an outcome is unknown, the way out (check the record, and try again for an act
 * that can be sent again), or, once the record is in conflict, Cancel and a reload. While the act is under way Cancel is not offered.
 *
 * **Every button has a key of its own.** Without one, React gives the next branch the button the person clicked and changes its type, and the
 * button of a reload becomes the dialog's submit button before the browser acts on the click: the browser then submits the form, so that reading
 * the record again asks for the act again (found by the rider screens' browser test, which jsdom cannot show). A key makes the old button go
 * and a new one come, and a click on a button that has gone does nothing.
 */
export function CommandOutcomeActions({
  command,
  cancelLabel,
  onCancel,
  confirmLabel,
  confirmVariant,
  confirmDisabled = false,
}: CommandOutcomeActionsProps) {
  return (
    <DialogActions>
      {command.phase === 'unknown' ? (
        <>
          <Button
            key="check"
            type="button"
            variant="secondary"
            data-recovery
            onClick={command.checkRecord}
          >
            Check the record
          </Button>
          {command.canRetry ? (
            <Button
              key="retry"
              type="button"
              onClick={() => {
                void command.retry();
              }}
            >
              Try again
            </Button>
          ) : null}
        </>
      ) : command.phase === 'conflict' ? (
        <>
          <Button key="cancel" type="button" variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button key="reload" type="button" data-recovery onClick={command.checkRecord}>
            Reload the record
          </Button>
        </>
      ) : (
        <>
          <Button
            key="cancel"
            type="button"
            variant="secondary"
            data-initial-focus
            disabled={command.locked}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            key="confirm"
            type="submit"
            variant={confirmVariant}
            disabled={confirmDisabled}
            loading={command.phase === 'sending'}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    </DialogActions>
  );
}
