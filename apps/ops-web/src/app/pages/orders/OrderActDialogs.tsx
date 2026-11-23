import { useState } from 'react';

import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import {
  EMPTY_ORDER_FORM,
  payerProposalOf,
  problemsWith,
  type OrderFormValues,
  type PayerChoice,
} from '../../../platform/hub-orders/order-form-model';
import {
  reverseOrderArrival,
  requestPayerCorrection,
  type CorrectionWithVersion,
  type PayerChoiceBody,
} from '../../../platform/hub-orders/orders-commands';
import {
  PAYER_INTENTS,
  SPLIT_BASES,
  type OrderView,
  type ReversalView,
  type SplitBasis,
} from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import './orders-pages.css';

const isBasis = (value: string): value is SplitBasis =>
  (SPLIT_BASES as readonly string[]).includes(value);

interface ReverseCommand {
  readonly note: string;
}

/**
 * A senior officer takes back a mistaken arrival (`reverseOrderArrival`, `hub.osd.adjudicate`): **corrected, never erased**. The order keeps its price and its trail and is taken back; the parcel goes back to the
 * missing list; the vendor goes back in review. **A reason in words is required** and is kept with the act, which is sent on the version of the order the page read and under a key, so that a lost answer is never a
 * second reversal and an order that changed since is told and never overwritten. The API refuses it once anything has been paid for, reserved or sent out, and says which.
 */
export function ReverseArrivalDialog({
  order,
  version,
  onCancel,
  onDone,
  onReload,
  onStale,
}: {
  readonly order: OrderView;
  /** The order's `ETag`, exactly as the read gave it. */
  readonly version: string;
  readonly onCancel: () => void;
  readonly onDone: (done: ReversalView) => void;
  readonly onReload: () => unknown;
  /** A refusal said the order is not as it was read: the page says so, once, and offers to read it again. */
  readonly onStale?: () => void;
}) {
  const client = useApiClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ActDialog<ReverseCommand, ReversalView>
      open
      title={WORDS.reverse.title}
      consequence={<p>{WORDS.reverse.description(order.code)}</p>}
      confirmLabel={WORDS.reverse.confirm}
      confirmVariant="primary"
      cancelLabel={WORDS.reverse.cancel}
      size="lg"
      operation="reverseOrderArrival"
      retryable
      build={() => {
        const said = reason.trim();
        if (said === '') {
          setError(WORDS.reverse.reasonRequired);
          return undefined;
        }
        return { note: said };
      }}
      send={(command, key) => reverseOrderArrival(client, order.id, command.note, version, key)}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        if (problem.kind === 'conflict' && problem.rule === 'stale') onStale?.();
        if (problem.code === 'REASON_REQUIRED') setError(WORDS.reverse.reasonRequired);
      }}
    >
      <Field
        label={WORDS.reverse.reasonLabel}
        help={WORDS.reverse.reasonHelp}
        required
        {...(error === undefined ? {} : { error })}
      >
        <Textarea
          name="reason"
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(undefined);
          }}
        />
      </Field>
    </ActDialog>
  );
}

interface CorrectionCommand {
  readonly proposed: PayerChoiceBody;
  readonly note: string;
}

type PayerValues = Pick<OrderFormValues, 'splitBasis' | 'splitAmount' | 'splitPercentage'> & {
  readonly payer: PayerChoice | null;
};

const PAYER_VALUES: PayerValues = {
  payer: null,
  splitBasis: null,
  splitAmount: '',
  splitPercentage: '',
};

/**
 * A request to change **who pays** for an order whose price is fixed (`requestPayerCorrection`, `pricing.correction.create`): the price never changes, a senior officer decides how it is shared, and the officer
 * proposes an intent (never a portion) with a reason. The act is sent on the version of the order the page read and under a key. One request is open for an order at a time, and the API says so.
 */
export function PayerCorrectionDialog({
  order,
  version,
  onCancel,
  onDone,
  onReload,
  onStale,
}: {
  readonly order: OrderView;
  readonly version: string;
  readonly onCancel: () => void;
  readonly onDone: (done: CorrectionWithVersion) => void;
  readonly onReload: () => unknown;
  /** A refusal said the order is not as it was read: the page says so, once, and offers to read it again. */
  readonly onStale?: () => void;
}) {
  const client = useApiClient();
  const [payer, setPayer] = useState<PayerValues>(PAYER_VALUES);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{
    payer?: string;
    splitBasis?: string;
    splitAmount?: string;
    splitPercentage?: string;
    reason?: string;
  }>({});
  const options = PAYER_INTENTS.map((value) => ({ value, label: WORDS.form.payers[value].label }));
  return (
    <ActDialog<CorrectionCommand, CorrectionWithVersion>
      open
      title={WORDS.correct.title}
      consequence={<p>{WORDS.correct.description(order.code)}</p>}
      confirmLabel={WORDS.correct.confirm}
      confirmVariant="primary"
      cancelLabel={WORDS.correct.cancel}
      size="lg"
      operation="requestPayerCorrection"
      retryable
      build={() => {
        const said = reason.trim();
        const found: typeof errors = {};
        if (payer.payer === null || payer.payer === 'AS_BOOKED')
          found.payer = WORDS.form.errors.payer;
        else {
          const problems = problemsWith({ ...EMPTY_ORDER_FORM, ...payer, payer: payer.payer });
          if (problems.splitBasis !== undefined) found.splitBasis = problems.splitBasis;
          if (problems.splitAmount !== undefined) found.splitAmount = problems.splitAmount;
          if (problems.splitPercentage !== undefined)
            found.splitPercentage = problems.splitPercentage;
        }
        if (said === '') found.reason = WORDS.correct.reasonRequired;
        setErrors(found);
        if (Object.keys(found).length > 0 || payer.payer === null) return undefined;
        const proposed = payerProposalOf({ ...payer, payer: payer.payer });
        return proposed === undefined ? undefined : { proposed, note: said };
      }}
      send={(command, key) =>
        requestPayerCorrection(client, order.id, command.proposed, command.note, version, key)
      }
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        if (problem.kind === 'conflict' && problem.rule === 'stale') onStale?.();
        if (problem.code === 'REASON_REQUIRED') setErrors({ reason: WORDS.correct.reasonRequired });
      }}
    >
      <RadioGroup
        legend={WORDS.correct.payerLabel}
        name="payer"
        required
        size="lg"
        options={options}
        value={payer.payer}
        {...(errors.payer === undefined ? {} : { error: errors.payer })}
        onChange={(value) => {
          const next = PAYER_INTENTS.find((each) => each === value);
          if (next === undefined) return;
          setPayer({ payer: next, splitBasis: null, splitAmount: '', splitPercentage: '' });
          setErrors((current) => ({ ...current, payer: undefined }));
        }}
      />
      {payer.payer === 'SPLIT' ? (
        <>
          <RadioGroup
            legend={WORDS.form.fields.splitBasis}
            name="splitBasis"
            required
            size="lg"
            options={SPLIT_BASES.map((value) => ({ value, label: WORDS.form.splitBases[value] }))}
            value={payer.splitBasis}
            {...(errors.splitBasis === undefined ? {} : { error: errors.splitBasis })}
            onChange={(value) => {
              setPayer((current) => ({
                ...current,
                splitBasis: isBasis(value) ? value : null,
                splitAmount: '',
                splitPercentage: '',
              }));
              setErrors((current) => ({ ...current, splitBasis: undefined }));
            }}
          />
          {payer.splitBasis === 'FIXED_AMOUNT' ? (
            <Field
              label={WORDS.form.fields.splitAmount}
              required
              {...(errors.splitAmount === undefined ? {} : { error: errors.splitAmount })}
            >
              <Input
                name="splitAmount"
                inputMode="decimal"
                autoComplete="off"
                value={payer.splitAmount}
                onChange={(event) => {
                  setPayer((current) => ({ ...current, splitAmount: event.target.value }));
                  setErrors((current) => ({ ...current, splitAmount: undefined }));
                }}
              />
            </Field>
          ) : null}
          {payer.splitBasis === 'PERCENTAGE' ? (
            <Field
              label={WORDS.form.fields.splitPercentage}
              required
              {...(errors.splitPercentage === undefined ? {} : { error: errors.splitPercentage })}
            >
              <Input
                name="splitPercentage"
                inputMode="decimal"
                autoComplete="off"
                value={payer.splitPercentage}
                onChange={(event) => {
                  setPayer((current) => ({ ...current, splitPercentage: event.target.value }));
                  setErrors((current) => ({ ...current, splitPercentage: undefined }));
                }}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      <Field
        label={WORDS.correct.reasonLabel}
        help={WORDS.correct.reasonHelp}
        required
        {...(errors.reason === undefined ? {} : { error: errors.reason })}
      >
        <Textarea
          name="reason"
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setErrors((current) => ({ ...current, reason: undefined }));
          }}
        />
      </Field>
    </ActDialog>
  );
}
