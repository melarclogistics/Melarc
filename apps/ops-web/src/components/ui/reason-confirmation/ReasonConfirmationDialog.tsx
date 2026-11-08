import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import {
  useReasonDefinitions,
  type ReasonBranch,
  type ReasonOperation,
} from '../../../platform/reasons/reason-definitions';
import type { ButtonVariant } from '../button/Button';
import { Dialog } from '../dialog/Dialog';
import { Field } from '../field/Field';
import { focusFirstInvalid } from '../form/use-submission';
import { Input } from '../input/Input';
import { ReasonSelect } from '../reason-select/ReasonSelect';
import { CommandOutcomeActions, CommandOutcomeNotice } from './command-outcome';

/** Everything that makes the request what it is: the reason, the note, and the version of the record the person saw (its `If-Match`). */
export interface ReasonedCommand {
  readonly reasonCode: string;
  /** As typed. Left out when it is blank, which the server keeps as none. */
  readonly note?: string;
  readonly version?: string;
}

export interface ReasonConfirmationDialogProps<Result> {
  readonly open: boolean;
  /** The question, as a question: "Reset this person’s second factor?". */
  readonly title: string;
  /** The consequence, in words. */
  readonly consequence: ReactNode;
  /** What confirming does, in the act's own words. */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /**
   * How the act that confirms is drawn. `danger` (the default) is for an act that does harm; `primary` is for one that does not, such as a new
   * link for someone who lost theirs: a colour that warns of harm where there is none teaches people to ignore it.
   */
  readonly confirmVariant?: ButtonVariant;
  /** The identity operation, so that the reasons offered are the ones it accepts. */
  readonly operation: ReasonOperation;
  /**
   * The `operationId` a failure is worded for, when the act is not the operation whose reasons it offers: removing a person's trusted browsers
   * offers the reasons of `revokeSession` (a trusted browser is revoked for the same causes a session is) and is worded for its own operation.
   * Left out, it is `operation`.
   */
  readonly copyOperation?: string;
  /** The branch of the action, from the record (`StaffIdentity.mfa_reset_state`), never from `mfa_enrolled`. The server revalidates it. */
  readonly branch?: ReasonBranch;
  /**
   * Whether the act takes a note beside its reason (the default). An act whose operation has no note field, such as the report of a lost
   * device (`DeviceRevocation` is a reason and nothing else), shows none, so that a person is never asked for what cannot be sent and never
   * believes a sentence they wrote was kept.
   */
  readonly withNote?: boolean;
  /** The version of the record the person saw: the `ETag` of the read, kept exactly. Sent as `If-Match` by `send`. */
  readonly version?: string;
  /** Sending the same command again is safe (see `useConfirmedCommand`). Leave it off for an act that takes no `Idempotency-Key`. */
  readonly retryable?: boolean;
  /** Sends the command: the screen's call, read with `answerOf`, with the version as `If-Match` and the key as `Idempotency-Key` if the operation takes one. */
  readonly send: (command: ReasonedCommand, idempotencyKey: string) => Promise<Result>;
  /** The API said it was done. The screen reads the record again and closes the dialog. */
  readonly onDone: (result: Result) => void;
  /** The person cancelled. */
  readonly onCancel: () => void;
  /** The person asks for the record to be read again (after a conflict, or to find out whether an act was done). */
  readonly onReload: () => unknown;
}

const NOTE_LIMIT = 1000;

interface FieldErrors {
  readonly reason?: string;
  readonly note?: string;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** The fields a refusal is about, in the words of the field, from where the API said it was refused and from its code. */
function serverFieldErrors(problem: Problem | undefined): FieldErrors {
  if (problem === undefined) return {};
  const places = new Set(problem.violations?.map((violation) => violation.pointer));
  const reason =
    places.has('/reason_code') || problem.code === 'REASON_NOT_ACTIVE'
      ? copyFor({
          context: 'reason',
          code: problem.code === 'REASON_NOT_ACTIVE' ? 'REASON_NOT_ACTIVE' : 'VALIDATION_FAILED',
        })
      : undefined;
  const note = places.has('/note')
    ? copyFor({ context: 'note', code: 'VALIDATION_FAILED' })
    : problem.code === 'REASON_REQUIRED'
      ? copyFor({ context: 'note', code: 'REASON_REQUIRED' })
      : undefined;
  return { ...(reason === undefined ? {} : { reason }), ...(note === undefined ? {} : { note }) };
}

/**
 * The reason and confirmation workflow (COMPONENT_PATTERNS section 20.4): an alert dialog that asks a person to choose a reason from the
 * server's catalogue, add a note where the reason demands one, and confirm an act by name. It holds the whole of what the identity screens
 * share, so that none of them gets a part of it wrong:
 *
 * - the reasons are `listReasonDefinitions` filtered for the action; if they cannot be had, the act cannot be confirmed;
 * - the command is everything that makes the request what it is, with the version the person saw, and is held as sent;
 * - **while the act is on its way or its outcome is unknown the reason and the note are locked, Escape does nothing and there is no Cancel**:
 *   a changed command would be refused, and what may have been done must stay in front of the person. The way out is to check the record
 *   (and, for an act that can be sent again, to try again under the same key);
 * - a refusal keeps the dialog and the input, puts what is wrong on its field and in words that are the Ops Portal's, and the next submit
 *   is a new command;
 * - a conflict says the record changed, and the way on is to read it again.
 *
 * The dialog is drawn only while it is open, and starts clean each time.
 */
export function ReasonConfirmationDialog<Result>(props: ReasonConfirmationDialogProps<Result>) {
  return props.open ? <OpenReasonConfirmation {...props} /> : null;
}

function OpenReasonConfirmation<Result>({
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  operation,
  copyOperation,
  branch,
  withNote = true,
  version,
  retryable = false,
  send,
  onDone,
  onCancel,
  onReload,
}: ReasonConfirmationDialogProps<Result>) {
  const reasons = useReasonDefinitions(operation, branch);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<FieldErrors>({});
  const [invalidAttempts, setInvalidAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  const command = useConfirmedCommand<ReasonedCommand, Result>({
    send,
    onDone,
    onReload,
    retryable,
    operation: copyOperation ?? operation,
  });

  const loaded = reasons.status === 'success' && reasons.data.length > 0;
  // A reason the catalogue no longer offers is no choice.
  const chosen = reasons.data?.find((reason) => reason.code === reasonCode);
  const choice = chosen === undefined ? '' : reasonCode;
  const fromServer = command.phase === 'refused' ? serverFieldErrors(command.problem) : {};
  const reasonError = invalid.reason ?? fromServer.reason;
  const noteError = invalid.note ?? fromServer.note;

  // After the errors are on the screen, focus goes to the first field that says it is invalid, which reads its error.
  useEffect(() => {
    if (invalidAttempts > 0) focusFirstInvalid(form.current);
  }, [invalidAttempts]);

  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    // The way out of a state the person must resolve is where a keyboard user should land.
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);

  // The catalogue may have changed under the person: read it again, and let the reason be chosen from what it now says.
  const refetchReasons = reasons.refetch;
  const refusedReason =
    command.phase === 'refused' && command.problem?.code === 'REASON_NOT_ACTIVE';
  useEffect(() => {
    if (refusedReason) void refetchReasons();
  }, [refusedReason, refetchReasons]);

  function validate(): FieldErrors {
    const found: { reason?: string; note?: string } = {};
    if (choice === '') found.reason = 'Choose a reason.';
    if (!withNote) return found;
    if (hasControlCharacter(note)) found.note = 'The note must be one line.';
    else if (note.length > NOTE_LIMIT) {
      found.note = `The note is too long. Use at most ${String(NOTE_LIMIT)} characters.`;
    } else if (chosen?.requiresNote === true && note.trim() === '') {
      found.note = 'Enter a note for this reason.';
    }
    return found;
  }

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
          if (command.locked || !loaded) return;
          const found = validate();
          setInvalid(found);
          if (found.reason !== undefined || found.note !== undefined) {
            setInvalidAttempts((count) => count + 1);
            return;
          }
          void command.submit({
            reasonCode: choice,
            ...(!withNote || note.trim() === '' ? {} : { note }),
            ...(version === undefined ? {} : { version }),
          });
        }}
      >
        <ReasonSelect
          query={reasons}
          value={choice}
          disabled={command.locked}
          {...(reasonError === undefined ? {} : { error: reasonError })}
          onChange={(code) => {
            setReasonCode(code);
            setInvalid((current) => ({ ...current, reason: undefined }));
            command.dismiss();
          }}
        />
        {loaded && withNote ? (
          <Field
            label="Note"
            required={chosen?.requiresNote === true}
            help="One line, up to 1000 characters. Leave out email addresses and telephone numbers."
            {...(noteError === undefined ? {} : { error: noteError })}
          >
            <Input
              name="note"
              value={note}
              maxLength={NOTE_LIMIT}
              autoComplete="off"
              readOnly={command.locked}
              onChange={(event) => {
                setNote(event.target.value);
                setInvalid((current) => ({ ...current, note: undefined }));
                command.dismiss();
              }}
            />
          </Field>
        ) : null}

        <CommandOutcomeNotice command={command} />

        <CommandOutcomeActions
          command={command}
          cancelLabel={cancelLabel}
          onCancel={onCancel}
          confirmLabel={confirmLabel}
          confirmVariant={confirmVariant}
          confirmDisabled={!loaded}
        />
      </form>
    </Dialog>
  );
}
