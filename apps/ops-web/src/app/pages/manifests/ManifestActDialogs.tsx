import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ButtonVariant } from '../../../components/ui/button/Button';
import { Dialog } from '../../../components/ui/dialog/Dialog';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import type { PickerOption } from '../../../components/ui/picker/Picker';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import {
  CommandOutcomeActions,
  CommandOutcomeNotice,
} from '../../../components/ui/reason-confirmation/command-outcome';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import type { HandoverDestination } from '../../../platform/manifest/manifest-commands';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { RiderPicker } from './RiderPicker';

/**
 * The dialogs of the acts on one manifest (S1.25), each over `useConfirmedCommand`, so that a lost answer never becomes a second act and a stale
 * version never becomes a silent overwrite (COMPONENT_PATTERNS section 33.2): the command is held as sent, with the version the page read; an
 * outcome nobody knows keeps the dialog and offers the record (and a retry under the same key for an act that takes one); a refusal says why in
 * the table's words, and puts what is wrong on its field; `STATE_CONFLICT` says the record changed and reads it again.
 *
 * **They are separate acts, each with its own confirmation**: assigning a rider, dispatching, cancelling, opening a custody handover, marking it
 * failed and accepting it for the hub never share a button or a dialog. The cancellation and the failing of a handover are the note dialog of the
 * pickup screens (`NoteActDialog`); what is here is what a manifest adds.
 */
export interface ActDialogProps<Command extends object, Result> {
  readonly title: string;
  readonly consequence: ReactNode;
  readonly confirmLabel: string;
  readonly confirmVariant?: ButtonVariant;
  readonly cancelLabel?: string;
  /** The `operationId`, so that a failure is worded for it. */
  readonly operation: string;
  /** The act takes an `Idempotency-Key`, so a lost answer can be tried again under the same key. */
  readonly retryable: boolean;
  /** The command the form describes, or nothing when the form is not ready (and has said why). It is called once when the person confirms. */
  readonly build: () => Command | undefined;
  readonly send: (command: Command, idempotencyKey: string) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
  /** The act was refused or came to nothing: the form may want to say where. Not called for a screen that has gone. */
  readonly onRefused?: (problem: Problem) => void;
  /** More words under a refusal, for what the words of the table cannot carry (the stops a dispatch names). */
  readonly aside?: (problem: Problem) => ReactNode;
  /** The fields of the act. */
  readonly children?: ReactNode;
}

/** A dialog of one act of a manifest: a question, its consequence, the fields and the two buttons, over the confirmed command. */
export function ActDialog<Command extends object, Result>(
  props: {
    readonly open: boolean;
  } & ActDialogProps<Command, Result>,
) {
  const { open, ...rest } = props;
  return open ? <OpenAct {...rest} /> : null;
}

function OpenAct<Command extends object, Result>({
  title,
  consequence,
  confirmLabel,
  confirmVariant = 'primary',
  cancelLabel = 'Cancel',
  operation,
  retryable,
  build,
  send,
  onDone,
  onCancel,
  onReload,
  onRefused,
  aside,
  children,
}: ActDialogProps<Command, Result>) {
  const form = useRef<HTMLFormElement>(null);
  const [attempts, setAttempts] = useState(0);
  const command = useConfirmedCommand<Command, Result>({
    send,
    onDone,
    onReload,
    retryable,
    operation,
  });

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown' || command.phase === 'conflict') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);
  const problem = command.problem;
  useEffect(() => {
    if (problem !== undefined && (command.phase === 'refused' || command.phase === 'conflict')) {
      onRefused?.(problem);
    }
    // Told once for each refusal that arrives, not for each render of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, command.phase]);

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
          const built = build();
          if (built === undefined) {
            setAttempts((count) => count + 1);
            return;
          }
          void command.submit(built);
        }}
      >
        {children}
        <CommandOutcomeNotice command={command} />
        {problem === undefined || aside === undefined ? null : aside(problem)}
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

/** The version of the record an act is sent on, held with the command so that a retry is the same request. */
interface Versioned {
  readonly version: string;
}

export interface AssignDialogProps<Result> {
  readonly open: boolean;
  /** The manifest's hub: the riders offered are the active riders of it. */
  readonly hubId: string;
  readonly version: string;
  readonly send: (riderId: string, version: string) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

/** Assigning a rider to a draft (`assignRider`): the cutoff for the vendor's own cancellation, so the consequence is told. */
export function AssignRiderDialog<Result>(props: AssignDialogProps<Result>) {
  return props.open ? <OpenAssign {...props} /> : null;
}

function OpenAssign<Result>({
  hubId,
  version,
  send,
  onDone,
  onCancel,
  onReload,
}: AssignDialogProps<Result>) {
  const [rider, setRider] = useState<PickerOption | null>(null);
  const [missing, setMissing] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const error = missing ? 'Choose a rider.' : refused;
  return (
    <ActDialog<Versioned & { readonly riderId: string }, Result>
      open
      title="Assign this rider?"
      consequence={
        <p>
          Assigning a rider closes the vendor’s own cancellation of every request on this pickup
          run: from then on only the office can cancel them, and it records a decision on the
          cancellation charge when it does. The pickup run stays a draft, and the rider sees nothing
          until you dispatch it.
        </p>
      }
      confirmLabel="Assign the rider"
      operation="assignRider"
      retryable={false}
      build={() => {
        if (rider === null) {
          setMissing(true);
          return undefined;
        }
        return { riderId: rider.value, version };
      }}
      send={(command) => send(command.riderId, command.version)}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        // The rider the server will not take is set aside, so that another is chosen and not the same one sent again.
        if (problem.code === 'RIDER_UNAVAILABLE') {
          setRider(null);
          setRefused(copyFor({ operation: 'assignRider', code: 'RIDER_UNAVAILABLE' }));
        }
      }}
    >
      <RiderPicker
        label="Rider"
        hubId={hubId}
        value={rider}
        onChange={(next) => {
          setRider(next);
          setMissing(false);
          setRefused(undefined);
        }}
        {...(error === undefined ? {} : { error })}
      />
    </ActDialog>
  );
}

export interface DispatchDialogProps<Result> {
  readonly open: boolean;
  /** Who the stops are shown to: the assigned rider, by name when it is known. */
  readonly riderName: string | undefined;
  readonly version: string;
  readonly send: (version: string) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
  /** The stops a refusal names, in words ("stops 2 and 4"). */
  readonly onStopsNamed: (stopIds: readonly string[]) => string;
  /** The dispatch was refused: the page may mark the stops the refusal names. */
  readonly onRefused?: (problem: Problem) => void;
}

/** Dispatching a draft (`dispatchManifest`): publication to the rider. It does not start the run, and the dialog says so. */
export function DispatchDialog<Result>({
  open,
  riderName,
  version,
  send,
  onDone,
  onCancel,
  onReload,
  onStopsNamed,
  onRefused,
}: DispatchDialogProps<Result>) {
  return (
    <ActDialog<Versioned, Result>
      open={open}
      title="Dispatch this pickup run?"
      consequence={
        <p>
          The pickup run becomes dispatched and its stops are shown to{' '}
          {riderName ?? 'the assigned rider'}, and to no other rider. A text message for the rider
          is queued with it. Dispatching does not start the run: the rider starts it on the run’s
          day. A cancelled pickup is never sent.
        </p>
      }
      confirmLabel="Dispatch the pickup run"
      operation="dispatchManifest"
      retryable={false}
      build={() => ({ version })}
      send={(command) => send(command.version)}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      {...(onRefused === undefined ? {} : { onRefused })}
      aside={(problem) =>
        problem.rule === 'request_not_confirmed' && problem.stops !== undefined ? (
          <p className="manifest-note">{`Concerned: ${onStopsNamed(problem.stops)}.`}</p>
        ) : null
      }
    />
  );
}

export interface InitiateHandoverDialogProps<Result> {
  readonly open: boolean;
  readonly hubId: string;
  /** The hub's name, as the session knows it; nothing is shown when it is not one of the officer's hubs. */
  readonly hubName: string;
  readonly version: string;
  readonly send: (
    destination: HandoverDestination,
    note: string,
    version: string,
  ) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

type DestinationKind = 'RIDER' | 'HUB';

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** What is wrong with a mandatory note before it is sent: only what the server would certainly refuse. */
export function noteProblem(note: string): string | undefined {
  if (note.trim() === '') return 'Write a note saying why.';
  if (hasControlCharacter(note)) return 'The note must be one line.';
  return undefined;
}

/**
 * Opening a custody handover on a run in progress (`initiateRunCustodyHandover`): to another rider, or to the hub where a field transfer would
 * be unsafe, with a mandatory note. **Nothing is chosen for the officer**: neither destination is preselected. The dialog says that opening one
 * moves nothing, because custody stays with the rider who holds it until the receiver accepts.
 */
export function InitiateHandoverDialog<Result>(props: InitiateHandoverDialogProps<Result>) {
  return props.open ? <OpenInitiate {...props} /> : null;
}

function OpenInitiate<Result>({
  hubId,
  hubName,
  version,
  send,
  onDone,
  onCancel,
  onReload,
}: InitiateHandoverDialogProps<Result>) {
  const [kind, setKind] = useState<DestinationKind | null>(null);
  const [rider, setRider] = useState<PickerOption | null>(null);
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<{ kind?: string; rider?: string; note?: string }>({});
  return (
    <ActDialog<
      Versioned & { readonly destination: HandoverDestination; readonly note: string },
      Result
    >
      open
      title="Open a custody handover?"
      consequence={
        <p>
          Opening a handover moves nothing. Custody of the parcels stays with the rider who holds it
          until the receiver accepts, so there is no moment when nobody holds them. Only one
          handover can wait at a time on a run.
        </p>
      }
      confirmLabel="Open the handover"
      operation="initiateRunCustodyHandover"
      retryable={false}
      build={() => {
        const found = {
          ...(kind === null ? { kind: 'Choose where custody goes.' } : {}),
          ...(kind === 'RIDER' && rider === null ? { rider: 'Choose the rider.' } : {}),
          ...(noteProblem(note) === undefined ? {} : { note: noteProblem(note) }),
        };
        setInvalid(found);
        if (
          kind === null ||
          (kind === 'RIDER' && rider === null) ||
          noteProblem(note) !== undefined
        ) {
          return undefined;
        }
        const destination: HandoverDestination =
          kind === 'RIDER' && rider !== null ? { riderId: rider.value } : { hubId };
        return { destination, note: note.trim(), version };
      }}
      send={(command) => send(command.destination, command.note, command.version)}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        if (problem.code === 'RIDER_UNAVAILABLE') {
          setRider(null);
          setInvalid((current) => ({
            ...current,
            rider: copyFor({ operation: 'initiateRunCustodyHandover', code: 'RIDER_UNAVAILABLE' }),
          }));
        }
      }}
    >
      <RadioGroup
        legend="Where custody goes"
        name="handover-destination"
        required
        value={kind}
        options={[
          { value: 'RIDER', label: 'To another rider' },
          {
            value: 'HUB',
            label: `To the hub${hubName === '' ? '' : `: ${hubName}`}`,
            help: 'Where a field transfer would be unsafe, the parcels are brought to the hub.',
          },
        ]}
        onChange={(value) => {
          setKind(value === 'HUB' ? 'HUB' : 'RIDER');
          setInvalid((current) => ({ ...current, kind: undefined }));
        }}
        {...(invalid.kind === undefined ? {} : { error: invalid.kind })}
      />
      {kind === 'RIDER' ? (
        <RiderPicker
          label="Receiving rider"
          hubId={hubId}
          value={rider}
          onChange={(next) => {
            setRider(next);
            setInvalid((current) => ({ ...current, rider: undefined }));
          }}
          {...(invalid.rider === undefined ? {} : { error: invalid.rider })}
        />
      ) : null}
      <Field
        label="Why custody is being handed over"
        required
        help="One line, kept with the handover. Leave out phone numbers and email addresses."
        {...(invalid.note === undefined ? {} : { error: invalid.note })}
      >
        <Input
          name="note"
          value={note}
          autoComplete="off"
          onChange={(event) => {
            setNote(event.target.value);
            setInvalid((current) => ({ ...current, note: undefined }));
          }}
        />
      </Field>
    </ActDialog>
  );
}

export interface AcceptHandoverDialogProps<Result> {
  readonly open: boolean;
  /** The version of the handover read, sent as `If-Match`. */
  readonly version: string;
  readonly send: (
    parcelCountTaken: number,
    version: string,
    idempotencyKey: string,
  ) => Promise<Result>;
  readonly onDone: (result: Result) => void;
  readonly onCancel: () => void;
  readonly onReload: () => unknown;
}

/** The most a figure of parcels taken may be before it is not one a person typed meaning it. */
const MAX_PARCELS_TYPED = 1_000_000;

/**
 * Accepting a custody handover for the hub (`acceptRunCustodyHandover`), as Ops. **The number is a custody record**: how many parcels were
 * physically taken, written down at the moment custody moves. It is never the hub's count and is never used as one: the hub's blind count runs
 * on its own at intake and does not start from this figure, and the dialog says so beside the field.
 */
export function AcceptHandoverDialog<Result>(props: AcceptHandoverDialogProps<Result>) {
  return props.open ? <OpenAccept {...props} /> : null;
}

function OpenAccept<Result>({
  version,
  send,
  onDone,
  onCancel,
  onReload,
}: AcceptHandoverDialogProps<Result>) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  return (
    <ActDialog<Versioned & { readonly parcels: number }, Result>
      open
      title="Accept this handover for the hub?"
      consequence={
        <p>
          Custody of the run’s parcels moves to the hub. Stops already worked stay attributed to the
          rider who worked them, and that rider can no longer complete the run.
        </p>
      }
      confirmLabel="Accept the handover"
      operation="acceptRunCustodyHandover"
      retryable
      build={() => {
        const trimmed = text.trim();
        if (!/^\d+$/.test(trimmed) || Number(trimmed) > MAX_PARCELS_TYPED) {
          setInvalid('Enter how many parcels were taken, as a whole number: 0 or more.');
          return undefined;
        }
        setInvalid(undefined);
        return { parcels: Number(trimmed), version };
      }}
      send={(command, key) => send(command.parcels, command.version, key)}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
    >
      <Field
        label="Parcels taken"
        required
        help="How many parcels were physically taken. This is a record of custody only: it is not the hub’s count, which is made separately at intake and does not start from this number."
        {...(invalid === undefined ? {} : { error: invalid })}
      >
        <Input
          name="parcel-count-taken"
          value={text}
          inputMode="numeric"
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(undefined);
          }}
        />
      </Field>
    </ActDialog>
  );
}
