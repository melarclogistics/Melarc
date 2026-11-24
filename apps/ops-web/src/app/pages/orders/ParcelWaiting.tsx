import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
import { useApiClient } from '../../../platform/api/api-client';
import {
  setParcelWaiting,
  type ParcelWaitView,
} from '../../../platform/hub-orders/orders-commands';
import type { WaitingMarkView } from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import './orders-pages.css';

const W = WORDS.form.waiting;

/** The most a note may say: one short line (the API's own limit, which it also holds in the database). */
const NOTE_MAX = 120;

interface MarkCommand {
  readonly note: string | undefined;
}

/**
 * The dialog that marks a parcel as **waiting for the vendor's details** (`setParcelWaitingForVendor`, `hub.intake.itemize`; the Product Owner's decision D-S7-12 of 24 November 2026): the officer calls or messages the
 * vendor, and the other officers see on every screen that the parcel is being waited on. The note says what was asked and how, in one short line, **and holds no phone number** (the API refuses it and the dialog
 * says so on the note: *Leave the number out of the note.*). The act states the parcel's desired state, so it takes no key and a lost answer may be sent again; it is sent on the vendor's version, which it does not move.
 */
function MarkDialog({
  parcelId,
  version,
  onCancel,
  onDone,
  onReload,
}: {
  readonly parcelId: string;
  /** The vendor's version, exactly as it was read: asked when the act is sent. */
  readonly version: () => string;
  readonly onCancel: () => void;
  readonly onDone: (done: ParcelWaitView) => void;
  readonly onReload: () => unknown;
}) {
  const client = useApiClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ActDialog<MarkCommand, ParcelWaitView>
      open
      title={W.title}
      consequence={<p>{W.consequence}</p>}
      confirmLabel={W.confirm}
      confirmVariant="primary"
      cancelLabel={W.cancel}
      size="lg"
      operation="setParcelWaitingForVendor"
      retryable
      build={() => {
        const said = note.trim();
        if (said.length > NOTE_MAX) {
          setError(W.badNote);
          return undefined;
        }
        return { note: said === '' ? undefined : said };
      }}
      send={(command) => setParcelWaiting(client, parcelId, true, command.note, version())}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        const onNote = (problem.violations ?? []).filter(
          (violation) => violation.pointer === '/note',
        );
        if (onNote.some((violation) => violation.rule === 'phone_number')) setError(W.numberInNote);
        else if (onNote.length > 0) setError(W.badNote);
      }}
    >
      <Field label={W.noteLabel} help={W.noteHelp} {...(error === undefined ? {} : { error })}>
        <Input
          name="note"
          maxLength={NOTE_MAX}
          autoComplete="off"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setError(undefined);
          }}
        />
      </Field>
    </ActDialog>
  );
}

/**
 * What the form of an order says of the parcel it is for when the officer cannot make the order yet (D-S7-12): a button *Waiting for the vendor's details*, which marks the parcel on the server; and, once it is
 * marked, who can see that it is, what was asked and how, and one press that takes the mark off. The mark is cleared by the server when the parcel's order is made. **Nothing here decides**: the mark, its moment and its
 * note are the server's, and an officer who is waiting is told so on every screen that lists the parcel.
 */
export function ParcelWaiting({
  parcelId,
  mark,
  version,
  onMarked,
  onChanged,
  onReload,
}: {
  readonly parcelId: string;
  readonly mark: WaitingMarkView | null;
  /** The vendor's version, exactly as it was read: asked when an act is sent. */
  readonly version: () => string;
  /** The parcel was marked: the officer goes on to the next parcel. */
  readonly onMarked: () => void;
  /** The mark was taken off: the parcel's row is read again. */
  readonly onChanged: () => void;
  readonly onReload: () => unknown;
}) {
  const client = useApiClient();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  async function takeOff(): Promise<void> {
    setSending(true);
    setProblem(undefined);
    try {
      await setParcelWaiting(client, parcelId, false, undefined, version());
      onChanged();
    } catch (error) {
      const told = problemOf(error, { operation: 'setParcelWaitingForVendor' });
      if (told.kind !== 'stale' && told.kind !== 'session-ended') setProblem(told);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="orders-waiting" aria-label={W.title}>
      {mark === null ? (
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => {
            setAsking(true);
          }}
        >
          {W.button}
        </Button>
      ) : (
        <>
          <p>{W.marked}</p>
          {mark.note === null ? null : <p className="orders-note">{mark.note}</p>}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            loading={sending}
            onClick={() => {
              void takeOff();
            }}
          >
            {W.takeOff}
          </Button>
        </>
      )}
      {problem === undefined ? null : (
        <Alert variant="danger" announce>
          <p>{problem.message}</p>
        </Alert>
      )}
      {asking ? (
        <MarkDialog
          parcelId={parcelId}
          version={version}
          onCancel={() => {
            setAsking(false);
          }}
          onDone={() => {
            setAsking(false);
            onMarked();
          }}
          onReload={onReload}
        />
      ) : null}
    </section>
  );
}
