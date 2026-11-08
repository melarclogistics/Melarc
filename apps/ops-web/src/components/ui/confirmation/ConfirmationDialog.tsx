import { useEffect, useRef, type ReactNode } from 'react';

import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import type { ButtonVariant } from '../button/Button';
import { Dialog } from '../dialog/Dialog';
import {
  CommandOutcomeActions,
  CommandOutcomeNotice,
} from '../reason-confirmation/command-outcome';

/** Everything that makes the request what it is when the act asks for nothing but a confirmation: the version of the record the person saw. */
export interface PlainCommand {
  readonly version?: string;
}

export interface ConfirmationDialogProps<Result> {
  readonly open: boolean;
  /** The question, as a question: "Approve Kofi Boateng?". */
  readonly title: string;
  /** The consequence, in words. */
  readonly consequence: ReactNode;
  /** What confirming does, in the act's own words, never "OK" or "Yes". */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /**
   * How the act that confirms is drawn. `primary` (the default) is for an act that gives something, such as access; `danger` is for one that does
   * harm. A reason dialog is the other way round, because most of what asks for a reason is harm.
   */
  readonly confirmVariant?: ButtonVariant;
  /** The `operationId`, so that a refusal is worded for it. */
  readonly operation?: string;
  /** The version of the record the person saw: the `ETag` of the read, kept exactly. Sent as `If-Match` by `send`. */
  readonly version?: string;
  /** Sending the same command again is safe (see `useConfirmedCommand`). Leave it off for an act that takes no `Idempotency-Key`. */
  readonly retryable?: boolean;
  /** Sends the command: the screen's call, read with `answerOf`, with the version as `If-Match` and the key as `Idempotency-Key` if the operation takes one. */
  readonly send: (command: PlainCommand, idempotencyKey: string) => Promise<Result>;
  /** The API said it was done. The screen reads the record again and closes the dialog. */
  readonly onDone: (result: Result) => void;
  /** The person cancelled. */
  readonly onCancel: () => void;
  /** The person asks for the record to be read again (after a conflict, or to find out whether an act was done). */
  readonly onReload: () => unknown;
}

/**
 * The confirmation of an act that needs no reason (COMPONENT_PATTERNS section 20): an alert dialog with a question, its consequence and two
 * buttons, over the same machinery as the reason dialog (`useConfirmedCommand`), so that what happens to the person's trust when the answer
 * is lost, the record has moved or the session has changed is the same in both:
 *
 * - **while the act is on its way or its outcome is unknown there is no Cancel and Escape does nothing**: what may have been done must stay
 *   in front of the person; the way out is to check the record (and, for an act that can be sent again, to try again under the same key);
 * - a refusal keeps the dialog and says why in approved words, and the next confirmation is a new command;
 * - a conflict says the record changed, and the way on is to read it again.
 *
 * The dialog is drawn only while it is open, and starts clean each time.
 */
export function ConfirmationDialog<Result>(props: ConfirmationDialogProps<Result>) {
  return props.open ? <OpenConfirmation {...props} /> : null;
}

function OpenConfirmation<Result>({
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  operation,
  version,
  retryable = false,
  send,
  onDone,
  onCancel,
  onReload,
}: ConfirmationDialogProps<Result>) {
  const form = useRef<HTMLFormElement>(null);
  const command = useConfirmedCommand<PlainCommand, Result>({
    send,
    onDone,
    onReload,
    retryable,
    ...(operation === undefined ? {} : { operation }),
  });

  useEffect(() => {
    // The way out of a state the person must resolve is where a keyboard user should land.
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);

  return (
    <Dialog
      open
      role="alertdialog"
      title={title}
      description={consequence}
      {...(command.locked ? {} : { onRequestClose: onCancel })}
    >
      <form
        ref={form}
        noValidate
        aria-busy={command.phase === 'sending' ? true : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          // Its submit stays inside it: a form that holds the dialog must not be sent by it (task R5.2, M3).
          event.stopPropagation();
          if (command.locked) return;
          void command.submit(version === undefined ? {} : { version });
        }}
      >
        <CommandOutcomeNotice command={command} />
        <CommandOutcomeActions
          command={command}
          cancelLabel={cancelLabel}
          onCancel={onCancel}
          confirmLabel={confirmLabel}
          confirmVariant={confirmVariant}
        />
      </form>
    </Dialog>
  );
}
