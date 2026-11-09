import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import type { ButtonVariant } from '../../../components/ui/button/Button';
import { Dialog } from '../../../components/ui/dialog/Dialog';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import {
  CommandOutcomeActions,
  CommandOutcomeNotice,
} from '../../../components/ui/reason-confirmation/command-outcome';
import { Select } from '../../../components/ui/select/Select';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import type { CancellationFields } from '../../../platform/pickup/pickup-commands';
import type { AttributedReason, CutoffDecision } from '../../../platform/pickup/pickup-shape';
import { usePickupReasons } from '../../../platform/pickup/use-pickup-queries';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * The dialogs of the acts on one pickup request (S1.19), each over `useConfirmedCommand`, so that a lost answer never becomes a second act and
 * a stale version never becomes a silent overwrite (COMPONENT_PATTERNS section 33.2): the command is held as sent, with the version the page
 * read; an outcome nobody knows keeps the dialog and offers the record (and a retry under the same key for an act that takes one); a refusal
 * puts what is wrong on its field; `STATE_CONFLICT` says the record changed and reads it again.
 *
 * **The reasons of the slice are of two kinds** (domain-model.md section 3.9, D-05): a cancellation takes a reason of the `PICKUP_CANCELLATION`
 * catalogue, read from the server and never written here; an escalation, an extension of the attempts, a waiver and a late booking's decision
 * take a mandatory note of free text instead, and no code.
 */

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** What is wrong with a mandatory note before it is sent: only what the server would certainly refuse. */
function noteProblem(note: string): string | undefined {
  if (note.trim() === '') return 'Write a note saying why.';
  if (hasControlCharacter(note)) return 'The note must be one line.';
  return undefined;
}

/** The note's error from a refusal: the place the API named, or the code that says a note is missing. */
function refusedNote(
  problem: Problem | undefined,
  pointers: readonly string[],
): string | undefined {
  if (problem === undefined) return undefined;
  const places = new Set(problem.violations?.map((violation) => violation.pointer));
  if (pointers.some((pointer) => places.has(pointer))) {
    return copyFor({ context: 'note', code: 'VALIDATION_FAILED' });
  }
  return problem.code === 'REASON_REQUIRED' ? 'Write a note saying why.' : undefined;
}

/** The version of the record an act is sent on, held with the command so that a retry is the same request. */
interface Versioned {
  readonly version: string;
}

export interface NoteActDialogProps<Result> {
  readonly open: boolean;
  /** The question, as a question: "Escalate this request?". */
  readonly title: string;
  readonly consequence: ReactNode;
  /** What confirming does, in the act's own words. */
  readonly confirmLabel: string;
  readonly confirmVariant?: ButtonVariant;
  /** What the note is for: "Why it is escalated". */
  readonly noteLabel: string;
  readonly noteHelp: string;
  /** The `operationId`, so that a failure is worded for it. */
  readonly operation: string;
  /** The JSON pointer the API names when it refuses the note (`/note`, or `/reason` for an extension). */
  readonly notePointer: string;
  /** The version the page read, sent as `If-Match`. */
  readonly version: string;
  /** The act takes an `Idempotency-Key`, so a lost answer can be tried again under the same key. */
  readonly retryable: boolean;
  readonly send: (note: string, version: string, idempotencyKey: string) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

/** An act that asks for a mandatory note and a confirmation: an escalation, an extension of the attempts, a waiver. */
export function NoteActDialog<Result>(props: NoteActDialogProps<Result>) {
  return props.open ? <OpenNoteAct {...props} /> : null;
}

function OpenNoteAct<Result>({
  title,
  consequence,
  confirmLabel,
  confirmVariant = 'primary',
  noteLabel,
  noteHelp,
  operation,
  notePointer,
  version,
  retryable,
  send,
  onDone,
  onCancel,
  onReload,
}: NoteActDialogProps<Result>) {
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const command = useConfirmedCommand<{ readonly note: string } & Versioned, Result>({
    send: (sent, key) => send(sent.note, sent.version, key),
    onDone,
    onReload,
    retryable,
    operation,
  });
  const noteError =
    invalid ??
    (command.phase === 'refused' ? refusedNote(command.problem, [notePointer]) : undefined);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
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
          if (command.locked) return;
          const found = noteProblem(note);
          setInvalid(found);
          if (found !== undefined) {
            setAttempts((count) => count + 1);
            return;
          }
          void command.submit({ note: note.trim(), version });
        }}
      >
        <Field
          label={noteLabel}
          required
          help={noteHelp}
          {...(noteError === undefined ? {} : { error: noteError })}
        >
          <Input
            name="note"
            value={note}
            autoComplete="off"
            readOnly={command.locked}
            onChange={(event) => {
              setNote(event.target.value);
              setInvalid(undefined);
              command.dismiss();
            }}
          />
        </Field>
        <CommandOutcomeNotice command={command} />
        <CommandOutcomeActions
          command={command}
          cancelLabel="Cancel"
          onCancel={onCancel}
          confirmLabel={confirmLabel}
          confirmVariant={confirmVariant}
        />
      </form>
    </Dialog>
  );
}

const CUTOFF_OPTIONS: readonly { value: CutoffDecision; label: string; help: string }[] = [
  {
    value: 'APPROVE_SAME_DAY',
    label: 'Approve it for the same day',
    help: 'The request stays confirmed for the date it was booked for.',
  },
  {
    value: 'RESCHEDULE_NEXT_DAY',
    label: 'Move it to the next operating day',
    help: 'This request is cancelled and a new pending request is booked for the next operating day, linked to it.',
  },
];

export interface CutoffDialogProps<Result> {
  readonly open: boolean;
  readonly version: string;
  readonly send: (
    resolution: { readonly decision: CutoffDecision; readonly note: string },
    version: string,
    idempotencyKey: string,
  ) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

/** The decision on a late booking (`resolveCutoffException`): the same day or the next operating day, with a mandatory note. */
export function CutoffDialog<Result>(props: CutoffDialogProps<Result>) {
  return props.open ? <OpenCutoff {...props} /> : null;
}

function OpenCutoff<Result>({
  version,
  send,
  onDone,
  onCancel,
  onReload,
}: CutoffDialogProps<Result>) {
  const [decision, setDecision] = useState<CutoffDecision | null>(null);
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<{ decision?: string; note?: string }>({});
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const command = useConfirmedCommand<
    { readonly decision: CutoffDecision; readonly note: string } & Versioned,
    Result
  >({
    send: (sent, key) => send({ decision: sent.decision, note: sent.note }, sent.version, key),
    onDone,
    onReload,
    retryable: true,
    operation: 'resolveCutoffException',
  });
  const refused = command.phase === 'refused' ? command.problem : undefined;
  const noteError = invalid.note ?? refusedNote(refused, ['/note']);
  const decisionError =
    invalid.decision ??
    (refused?.violations?.some((violation) => violation.pointer === '/decision') === true
      ? 'Choose what happens to the late booking.'
      : undefined);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);

  return (
    <Dialog
      open
      role="alertdialog"
      title="Decide this late booking?"
      description={
        <p>
          The request was booked after the hub’s cut-off. It is confirmed and waits for your
          decision: approve it for the day it was booked for, or move it to the next operating day.
        </p>
      }
      {...(command.locked ? {} : { onRequestClose: onCancel })}
    >
      <form
        ref={form}
        noValidate
        aria-busy={command.phase === 'sending' ? true : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (command.locked) return;
          const wrongNote = noteProblem(note);
          const found = {
            ...(decision === null ? { decision: 'Choose what happens to the late booking.' } : {}),
            ...(wrongNote === undefined ? {} : { note: wrongNote }),
          };
          setInvalid(found);
          if (decision === null || wrongNote !== undefined) {
            setAttempts((count) => count + 1);
            return;
          }
          void command.submit({ decision, note: note.trim(), version });
        }}
      >
        <RadioGroup
          legend="What happens to it"
          name="cutoff-decision"
          options={CUTOFF_OPTIONS}
          value={decision}
          required
          disabled={command.locked}
          {...(decisionError === undefined ? {} : { error: decisionError })}
          onChange={(value) => {
            setDecision(CUTOFF_OPTIONS.find((option) => option.value === value)?.value ?? null);
            setInvalid((current) => ({ ...current, decision: undefined }));
            command.dismiss();
          }}
        />
        <Field
          label="Why"
          required
          help="One line, kept with the decision."
          {...(noteError === undefined ? {} : { error: noteError })}
        >
          <Input
            name="note"
            value={note}
            autoComplete="off"
            readOnly={command.locked}
            onChange={(event) => {
              setNote(event.target.value);
              setInvalid((current) => ({ ...current, note: undefined }));
              command.dismiss();
            }}
          />
        </Field>
        <CommandOutcomeNotice command={command} />
        <CommandOutcomeActions
          command={command}
          cancelLabel="Cancel"
          onCancel={onCancel}
          confirmLabel="Record the decision"
          confirmVariant="primary"
        />
      </form>
    </Dialog>
  );
}

/** The charge decision, as the person made it, or none. */
type ChargeChoice = 'APPLY' | 'NONE';

export interface CancelDialogProps<Result> {
  readonly open: boolean;
  /** A plain cancellation, or a reschedule: the cancellation that creates the next attempt in the same act. */
  readonly mode: 'cancel' | 'reschedule';
  /**
   * Whether the cancellation carries a charge decision: the read says a rider holds the confirmed request's run (`rider_assigned`). Then the
   * decision and its reason are required either way (`REASON_REQUIRED` otherwise); before, none is sent (`VALIDATION_FAILED` otherwise).
   */
  readonly decidesCharge: boolean;
  /** Whether the session holds `pickup.request.cancel_chargeable`, without which only "no charge" can be decided. */
  readonly mayCharge: boolean;
  /** Whether the session holds `pickup.attempt.extend`, which a reschedule refused at the attempt limit is told about. */
  readonly canExtend: boolean;
  readonly version: string;
  readonly send: (
    fields: CancellationFields,
    version: string,
    idempotencyKey: string,
  ) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

/**
 * The cancellation of a request, or its reschedule (`cancelPickupRequest`), with a reason of the `PICKUP_CANCELLATION` catalogue. **The catalogue
 * may be empty**: its codes are the Product Owner's and may not be seeded yet, and then the act cannot be done here, and the dialog says so in
 * words that say who can change that. **The charge is discretionary** (MSC-DEC-197) and is decided only once a rider holds the request's run:
 * then it is an explicit choice with nothing chosen, required either way with its reason, and not offered at all for a reason that attributes
 * the cause to Melarc, for which none is permitted (MSC-DEC-388; the server records `EXEMPT`). A reschedule refused at the attempt limit
 * cancelled nothing, and says what comes next by the key the person holds.
 */
export function CancelRequestDialog<Result>(props: CancelDialogProps<Result>) {
  return props.open ? <OpenCancel {...props} /> : null;
}

interface CancelErrors {
  readonly reason?: string;
  readonly note?: string;
  readonly charge?: string;
  readonly chargeReason?: string;
}

const DECIDE_CHARGE = 'Decide whether to apply the charge.';
const WHY_CHARGE = 'Choose why the charge was or was not applied.';
const CHARGE_NEEDS_KEY = cannotText('pickup.request.cancel_chargeable');

/** The fields a refusal of a cancellation is about, in the words of each field, from the places the API named and from its code. */
function refusedCancelFields(problem: Problem | undefined): CancelErrors {
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
    : undefined;
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
    ...(places.has('/apply_charge') ? { charge: DECIDE_CHARGE } : {}),
    ...(places.has('/charge_reason_code') ? { chargeReason: WHY_CHARGE } : {}),
  };
}

function OpenCancel<Result>({
  mode,
  decidesCharge,
  mayCharge,
  canExtend,
  version,
  send,
  onDone,
  onCancel,
  onReload,
}: CancelDialogProps<Result>) {
  const reasons = usePickupReasons('PICKUP_CANCELLATION');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [charge, setCharge] = useState<ChargeChoice | null>(null);
  const [chargeReasonCode, setChargeReasonCode] = useState('');
  const [invalid, setInvalid] = useState<CancelErrors>({});
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const reschedule = mode === 'reschedule';

  const command = useConfirmedCommand<CancellationFields & Versioned, Result>({
    send: (sent, key) => {
      const { version: sentVersion, ...fields } = sent;
      return send(fields, sentVersion, key);
    },
    onDone,
    onReload,
    retryable: true,
    operation: 'cancelPickupRequest',
  });

  const loaded = reasons.status === 'success' && reasons.data.length > 0;
  // A reason the catalogue no longer offers is no choice.
  const chosen: AttributedReason | undefined = reasons.data?.find(
    (reason) => reason.code === reasonCode,
  );
  const chargeReason = reasons.data?.find((reason) => reason.code === chargeReasonCode);
  const melarc = chosen?.attribution === 'MELARC';
  const refused = command.phase === 'refused' ? command.problem : undefined;
  const fromServer = refusedCancelFields(refused);
  const reasonError = invalid.reason ?? fromServer.reason;
  const noteError = invalid.note ?? fromServer.note;
  const chargeError = invalid.charge ?? fromServer.charge;
  const chargeReasonError = invalid.chargeReason ?? fromServer.chargeReason;
  // The catalogue may have changed under the person: read it again, and let the reason be chosen from what it now says.
  const refetchReasons = reasons.refetch;
  const refusedReason = refused?.code === 'REASON_NOT_ACTIVE';
  // A reschedule refused at the attempt limit cancelled nothing; what comes next is said by whether the person can allow one further attempt.
  const limitNext =
    refused?.code === 'PICKUP_ATTEMPT_LIMIT_REACHED'
      ? copyFor({
          operation: 'cancelPickupRequest',
          context: canExtend ? 'extend-held' : 'extend-not-held',
          code: 'PICKUP_ATTEMPT_LIMIT_REACHED',
        })
      : undefined;
  const chargeOptions: readonly { value: ChargeChoice; label: string; disabled?: boolean }[] = [
    {
      value: 'APPLY',
      label: 'Apply the cancellation charge',
      ...(mayCharge ? {} : { disabled: true }),
    },
    { value: 'NONE', label: 'Do not apply a charge' },
  ];

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);
  useEffect(() => {
    if (refusedReason) void refetchReasons();
  }, [refusedReason, refetchReasons]);

  /**
   * What is wrong before anything is sent. Once a rider holds the run, the charge decision is required either way, with its reason: a choice
   * (none for a reason attributed to Melarc, which permits no charge) and why. Before that, nothing about a charge is asked or sent.
   */
  function validate(): CancelErrors {
    const found: { -readonly [Key in keyof CancelErrors]: CancelErrors[Key] } = {};
    if (chosen === undefined) found.reason = 'Choose a reason.';
    if (hasControlCharacter(note)) found.note = 'The note must be one line.';
    else if (chosen?.requiresNote === true && note.trim() === '') {
      found.note = 'This reason needs a note.';
    }
    if (decidesCharge && chosen !== undefined) {
      if (!melarc && charge === null) found.charge = DECIDE_CHARGE;
      if (chargeReason === undefined) found.chargeReason = WHY_CHARGE;
    }
    return found;
  }

  function fields(): CancellationFields {
    // The decision is sent when one is due: a choice and its reason, or, for a reason attributed to Melarc (which permits no charge), "no
    // charge" with its reason, which the server records as exempt.
    const decided =
      decidesCharge &&
      chosen !== undefined &&
      chargeReason !== undefined &&
      (melarc || charge !== null);
    return {
      reasonCode: chosen?.code ?? '',
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      createReplacement: reschedule,
      ...(decided ? { applyCharge: !melarc && charge === 'APPLY' } : {}),
      ...(decided ? { chargeReasonCode: chargeReason.code } : {}),
    };
  }

  const reasonOptions = (list: readonly AttributedReason[]) =>
    list.map((reason) => (
      <option key={reason.code} value={reason.code}>
        {reason.label}
      </option>
    ));

  return (
    <Dialog
      open
      role="alertdialog"
      title={reschedule ? 'Reschedule this pickup?' : 'Cancel this pickup request?'}
      description={
        reschedule ? (
          <p>
            This request is cancelled with the reason you choose, and a new pending request is
            booked as its next attempt, linked to it. The two are never active together.
          </p>
        ) : (
          <p>
            The request is cancelled with the reason you choose. Its record and its history stay.
          </p>
        )
      }
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
          if (Object.keys(found).length > 0) {
            setAttempts((count) => count + 1);
            return;
          }
          void command.submit({ ...fields(), version });
        }}
      >
        <ReadState
          query={reasons}
          operation="listReasonDefinitions"
          context="cancellation"
          permission="settings.reason.read"
          loadingLabel="Loading the cancellation reasons…"
          isEmpty={(list) => list.length === 0}
          empty={
            <Alert variant="danger">
              <p>
                No cancellation reason is configured yet, so a request cannot be{' '}
                {reschedule ? 'rescheduled' : 'cancelled'} here. An administrator adds the reasons
                to the reason catalogue.
              </p>
            </Alert>
          }
        >
          {(list) => (
            <>
              <Field
                label="Reason"
                required
                {...(reasonError === undefined ? {} : { error: reasonError })}
              >
                <Select
                  name="reason"
                  value={chosen === undefined ? '' : reasonCode}
                  disabled={command.locked}
                  onChange={(event) => {
                    setReasonCode(event.target.value);
                    // Another reason may attribute the cause elsewhere: a charge decision made for the last one is not carried over.
                    setCharge(null);
                    setInvalid((current) => ({ ...current, reason: undefined, charge: undefined }));
                    command.dismiss();
                  }}
                >
                  <option value="">Choose a reason</option>
                  {reasonOptions(list)}
                </Select>
              </Field>
              <Field
                label="Note"
                required={chosen?.requiresNote === true}
                help="One line, kept with the cancellation."
                {...(noteError === undefined ? {} : { error: noteError })}
              >
                <Input
                  name="note"
                  value={note}
                  autoComplete="off"
                  readOnly={command.locked}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setInvalid((current) => ({ ...current, note: undefined }));
                    command.dismiss();
                  }}
                />
              </Field>
              {decidesCharge ? (
                <section className="pickup-form-section" aria-label="Cancellation charge">
                  <p className="pickup-form-note">
                    A rider is assigned to this request’s run, so the cancellation records a
                    decision on the hub’s cancellation charge, either way, and why. The charge is at
                    your discretion.
                  </p>
                  {chosen === undefined ? (
                    <p className="pickup-form-note">
                      Choose the reason first: whether a charge can be applied depends on it.
                    </p>
                  ) : melarc ? (
                    <p className="pickup-form-note">
                      This reason puts the cause with Melarc, so no charge is permitted: the
                      cancellation is recorded as exempt from the charge.
                    </p>
                  ) : (
                    <RadioGroup
                      legend="Cancellation charge"
                      name="charge"
                      options={chargeOptions}
                      value={charge}
                      required
                      disabled={command.locked}
                      {...(mayCharge ? {} : { help: CHARGE_NEEDS_KEY })}
                      {...(chargeError === undefined ? {} : { error: chargeError })}
                      onChange={(value) => {
                        setCharge(value === 'APPLY' ? 'APPLY' : 'NONE');
                        setInvalid((current) => ({ ...current, charge: undefined }));
                        command.dismiss();
                      }}
                    />
                  )}
                  {chosen === undefined ? null : (
                    <Field
                      label="Why the charge was or was not applied"
                      required
                      help="A reason of the cancellation catalogue, recorded with the decision."
                      {...(chargeReasonError === undefined ? {} : { error: chargeReasonError })}
                    >
                      <Select
                        name="charge-reason"
                        value={chargeReason === undefined ? '' : chargeReasonCode}
                        disabled={command.locked}
                        onChange={(event) => {
                          setChargeReasonCode(event.target.value);
                          setInvalid((current) => ({
                            ...current,
                            charge: undefined,
                            chargeReason: undefined,
                          }));
                          command.dismiss();
                        }}
                      >
                        <option value="">Choose a reason</option>
                        {reasonOptions(list)}
                      </Select>
                    </Field>
                  )}
                </section>
              ) : null}
            </>
          )}
        </ReadState>

        {refused !== undefined && limitNext !== undefined ? (
          <Alert variant="danger" announce>
            <p>{refused.message}</p>
            <p>{limitNext}</p>
            {refused.reference === undefined ? null : <p>Reference: {refused.reference}</p>}
          </Alert>
        ) : (
          <CommandOutcomeNotice command={command} />
        )}
        <CommandOutcomeActions
          command={command}
          cancelLabel="Keep the request"
          onCancel={onCancel}
          confirmLabel={reschedule ? 'Reschedule the pickup' : 'Cancel the request'}
          confirmVariant="danger"
          confirmDisabled={!loaded}
        />
      </form>
    </Dialog>
  );
}
