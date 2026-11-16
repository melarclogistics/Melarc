import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Checkbox } from '../../../components/ui/checkbox/Checkbox';
import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import {
  MAX_PARCELS,
  type PostCountIntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import {
  correctIntakeCount,
  type CorrectedIntake,
  type CorrectionRequest,
} from '../../../platform/hub-receiving/receiving-commands';
import type { CheckInView, ParcelView } from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import './receiving-pages.css';

/** What a senior officer corrects: a vendor checked in against its door photos, or a vendor whose parcels were counted without them. */
export type CorrectionTarget =
  | { readonly kind: 'check-in'; readonly view: CheckInView }
  | { readonly kind: 'blind'; readonly intake: PostCountIntakeView };

/** What a correction came to: the record as it now is, and the number of parcels before and after (the API recorded both, with the reason; the notice says them). */
export interface CorrectionDone {
  readonly result: CorrectedIntake;
  readonly before: number;
  readonly now: number;
}

export interface CorrectionDialogProps {
  readonly target: CorrectionTarget;
  /** The vendor's `ETag`, exactly as the read gave it. */
  readonly version: string;
  readonly onCancel: () => void;
  readonly onDone: (done: CorrectionDone) => void;
  readonly onReload: () => unknown;
}

/** A whole number as a person types it: digits only, nothing else, and no more than the platform can hold. An empty field is not a count of zero. */
const WHOLE_COUNT = /^\d{1,10}$/;

interface Errors {
  readonly parcels?: string;
  readonly count?: string;
  readonly reason?: string;
}

/** The parcels a correction can move: those the check-in has decided (a parcel still not checked in is the check-in's, not the correction's). */
const correctable = (view: CheckInView): readonly ParcelView[] =>
  view.parcels.filter((parcel) => parcel.state !== 'EXPECTED');

/** The state a parcel is moved to when it is not here: a door parcel is missing, an extra that was added by mistake is taken back. */
const notHere = (parcel: ParcelView): 'MISSING' | 'VOID' =>
  parcel.origin === 'HUB_EXTRA' ? 'VOID' : 'MISSING';

/**
 * A senior officer's correction of a count or a check-in (D-D8): the safety net for a mistaken count, with **a reason in words that is required**, and the number before and the number after recorded by the
 * API with the officer and the moment. A vendor checked in against its photos is corrected parcel by parcel (a tick for each parcel that is here), and only the parcels the officer changed are sent; a vendor
 * counted without photos is corrected by the number of parcels on the table. It is sent on the version the page read, so that a vendor that changed since is told and never overwritten, and it takes a key, so
 * that a lost answer is never a second correction. **The API refuses a correction once listing the orders has begun, and says so.**
 */
export function CorrectionDialog({
  target,
  version,
  onCancel,
  onDone,
  onReload,
}: CorrectionDialogProps) {
  const client = useApiClient();
  const parcels = target.kind === 'check-in' ? correctable(target.view) : [];
  const [here, setHere] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(parcels.map((parcel) => [parcel.id, parcel.state === 'ARRIVED'])),
  );
  const [count, setCount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const before =
    target.kind === 'check-in' ? (target.view.arrived_count ?? 0) : target.intake.physical_count;
  const vendor = target.kind === 'check-in' ? target.view.vendor_name : undefined;

  return (
    <ActDialog<CorrectionRequest, CorrectedIntake>
      open
      title={vendor === undefined ? WORDS.correction.titleBlind : WORDS.correction.title(vendor)}
      consequence={<p>{WORDS.correction.consequence}</p>}
      confirmLabel={WORDS.correction.confirm}
      confirmVariant="primary"
      size="lg"
      operation="correctIntakeCount"
      retryable
      build={() => {
        const said = reason.trim();
        const found: { parcels?: string; count?: string; reason?: string } = {};
        let request: CorrectionRequest | undefined;
        if (target.kind === 'check-in') {
          const changes = parcels
            .filter((parcel) => here[parcel.id] !== (parcel.state === 'ARRIVED'))
            .map((parcel) => ({
              parcelId: parcel.id,
              state: here[parcel.id] === true ? ('ARRIVED' as const) : notHere(parcel),
            }));
          if (changes.length === 0) found.parcels = WORDS.correction.nothingChanged;
          else request = { reason: said, parcelChanges: changes };
        } else {
          const typed = count.trim();
          const number = WHOLE_COUNT.test(typed) ? Number(typed) : undefined;
          if (number === undefined || number > MAX_PARCELS)
            found.count = WORDS.correction.countInvalid;
          else if (number === target.intake.physical_count)
            found.count = WORDS.correction.sameCount;
          else request = { reason: said, physicalCount: number };
        }
        if (said === '') found.reason = WORDS.correction.writeReason;
        setErrors(found);
        return Object.keys(found).length > 0 ? undefined : request;
      }}
      send={(request, key) =>
        correctIntakeCount(
          client,
          target.kind === 'check-in' ? target.view.id : target.intake.id,
          request,
          version,
          key,
        )
      }
      onDone={(result) => {
        const now =
          result.checkIn === undefined
            ? result.counted.physical_count
            : (result.checkIn.arrived_count ?? 0);
        onDone({ result, before, now });
      }}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        if (problem.code === 'REASON_REQUIRED') setErrors({ reason: WORDS.correction.writeReason });
      }}
    >
      {target.kind === 'check-in' ? (
        <fieldset className="receiving-correction__parcels">
          <legend>{WORDS.correction.parcelsLegend}</legend>
          <p>{WORDS.correction.parcelsHelp}</p>
          {parcels.map((parcel) => (
            <Checkbox
              key={parcel.id}
              size="lg"
              label={WORDS.correction.parcelHere(
                WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA'),
              )}
              checked={here[parcel.id] === true}
              onChange={(event) => {
                setHere((all) => ({ ...all, [parcel.id]: event.target.checked }));
                setErrors((current) => ({ ...current, parcels: undefined }));
              }}
            />
          ))}
          {errors.parcels === undefined ? null : (
            <Alert variant="danger" announce>
              <p>{errors.parcels}</p>
            </Alert>
          )}
        </fieldset>
      ) : (
        <Field
          label={WORDS.correction.countLabel}
          help={WORDS.correction.countHelp}
          required
          {...(errors.count === undefined ? {} : { error: errors.count })}
        >
          <Input
            name="count"
            inputMode="numeric"
            autoComplete="off"
            value={count}
            onChange={(event) => {
              setCount(event.target.value);
              setErrors((current) => ({ ...current, count: undefined }));
            }}
          />
        </Field>
      )}
      <Field
        label={WORDS.correction.reasonLabel}
        help={WORDS.correction.reasonHelp}
        required
        {...(errors.reason === undefined ? {} : { error: errors.reason })}
      >
        <Textarea
          name="reason"
          value={reason}
          rows={3}
          maxLength={1000}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((current) => ({ ...current, reason: undefined }));
          }}
        />
      </Field>
    </ActDialog>
  );
}
