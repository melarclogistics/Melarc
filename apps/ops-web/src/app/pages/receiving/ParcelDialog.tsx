import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { Dialog, DialogActions } from '../../../components/ui/dialog/Dialog';
import type { ParcelView, VendorView } from '../../../platform/hub-receiving/receiving-shape';
import type { Problem } from '../../../platform/problem/problem-copy';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { formatClock } from '../../../platform/time/format-time';
import { PhotoPicture } from '../evidence/PhotoPicture';
import { conditionWords } from './receiving-presentation';
import type { RunActs } from './use-run-acts';
import './receiving-pages.css';

export interface ParcelDialogProps {
  /** The parcel as the page now holds it: the dialog stays right when a tap changes it. */
  readonly parcel: ParcelView;
  readonly vendor: VendorView;
  /** The officer holds the key that checks parcels in: without it the dialog shows the parcel and offers nothing. */
  readonly mayCount: boolean;
  readonly acts: RunActs;
  readonly onClose: () => void;
  /** Opens the form that records damage on this parcel. Left out where the form does not exist yet. */
  readonly onDamaged?: (parcel: ParcelView) => void;
  /** An act of the dialog was done: the page says what happened and the dialog closes. */
  readonly onDone: (notice: string) => void;
}

/** What the parcel is, in a sentence: the API's state and the officer and the moment it was checked in. */
export function stateLine(parcel: ParcelView): string {
  switch (parcel.state) {
    case 'ARRIVED': {
      const at = parcel.arrived_at === null ? undefined : formatClock(parcel.arrived_at);
      if (parcel.arrived_by_name !== null && at !== undefined) {
        return WORDS.parcel.checkedInBy(parcel.arrived_by_name, at);
      }
      return at === undefined ? WORDS.states.parcel.ARRIVED : WORDS.parcel.checkedInAt(at);
    }
    case 'MISSING': {
      const since =
        parcel.missing_marked_at === null ? undefined : formatClock(parcel.missing_marked_at);
      return since === undefined ? WORDS.states.parcel.MISSING : WORDS.parcel.missingSince(since);
    }
    case 'VOID':
      return WORDS.parcel.takenBack;
    case 'EXPECTED':
      return WORDS.parcel.notCheckedIn;
  }
}

/** What is known of the parcel's condition: **not checked yet until someone has recorded one**, then what was recorded, by whom and when, and the note. */
function ConditionLines({ parcel }: { readonly parcel: ParcelView }) {
  if (parcel.state !== 'ARRIVED') return null;
  const condition = parcel.condition;
  if (condition === null) return <p>{conditionWords(null)}.</p>;
  const at = formatClock(condition.recorded_at) ?? '';
  return (
    <>
      <p>{WORDS.parcel.conditionBy(conditionWords(condition), condition.recorded_by_name, at)}</p>
      {condition.note === null || condition.note === '' ? null : (
        <p>{WORDS.parcel.note(condition.note)}</p>
      )}
    </>
  );
}

/**
 * One parcel, opened (D-D2, D-D4, D-D7): its photo, where it stands and its condition, with the acts that can still be made on it, **offered by what the page holds and decided by the API**: *Found it* for a missing
 * parcel while the vendor's case is open, *Take this parcel back* for an extra while the vendor is open, and *Damaged* for a parcel that is checked in and has no condition yet. A parcel that is not checked in
 * yet says so, and that it must be before damage is recorded. Each act is one tap and is answered in words; a refusal stays in the dialog, with the parcel as it is.
 */
export function ParcelDialog({
  parcel,
  vendor,
  mayCount,
  acts,
  onClose,
  onDamaged,
  onDone,
}: ParcelDialogProps) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const label = WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA');
  const finished = vendor.state !== 'ITEMIZING' && vendor.state !== 'CLOSED';
  const canFind =
    mayCount && parcel.state === 'MISSING' && vendor.state === 'RECONCILIATION_REQUIRED';
  const canTakeBack =
    mayCount &&
    parcel.origin === 'HUB_EXTRA' &&
    parcel.state === 'ARRIVED' &&
    vendor.state === 'AWAITING_COUNT';
  // Damage is recorded once for each parcel, on a parcel that is checked in, until the orders are listed.
  const recordDamage =
    mayCount && parcel.state === 'ARRIVED' && parcel.condition === null && finished
      ? onDamaged
      : undefined;
  const mustCheckIn = mayCount && parcel.state === 'EXPECTED';

  async function tap(arrived: boolean, notice: string): Promise<void> {
    setWorking(true);
    setProblem(undefined);
    const result = await acts.tap(vendor.intake_id, parcel.id, arrived);
    setWorking(false);
    if (result.problem !== undefined) {
      setProblem(result.problem);
      return;
    }
    onDone(notice);
  }

  return (
    <Dialog
      open
      title={label}
      description={WORDS.parcel.from(vendor.vendor_name)}
      onRequestClose={onClose}
    >
      <div className="receiving-parcel">
        <PhotoPicture
          evidenceId={parcel.photo_evidence_id}
          wanted
          size="full"
          alt={label}
          reading={{ permission: 'hub.read', context: 'intake' }}
        />
        <p>{stateLine(parcel)}</p>
        <ConditionLines parcel={parcel} />
        {mustCheckIn ? <p>{WORDS.parcel.checkInFirst}</p> : null}
        {problem === undefined ? null : (
          <Alert variant="danger" announce>
            <p>{problem.message}</p>
          </Alert>
        )}
      </div>
      <DialogActions>
        <Button type="button" variant="secondary" size="lg" data-initial-focus onClick={onClose}>
          {WORDS.parcel.close}
        </Button>
        {recordDamage === undefined ? null : (
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={working}
            onClick={() => {
              recordDamage(parcel);
            }}
          >
            {WORDS.parcel.damaged}
          </Button>
        )}
        {canTakeBack ? (
          <Button
            type="button"
            variant="danger"
            size="lg"
            loading={working}
            onClick={() => {
              void tap(false, WORDS.vendor.done.takenBack(label));
            }}
          >
            {WORDS.parcel.takeBack}
          </Button>
        ) : null}
        {canFind ? (
          <Button
            type="button"
            size="lg"
            loading={working}
            onClick={() => {
              void tap(true, WORDS.vendor.done.found(label));
            }}
          >
            {WORDS.parcel.found}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
