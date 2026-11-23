import { Checkbox } from '../../../components/ui/checkbox/Checkbox';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import type { UploadGate } from '../../../components/ui/evidence-upload/UploadGate';
import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { TaskFormSection } from '../../../components/ui/templates/TaskForm';
import {
  DESTINATIONS,
  type OrderField,
  type OrderFieldErrors,
  type OrderFormValues,
  type PayerChoice,
} from '../../../platform/hub-orders/order-form-model';
import {
  PAYER_INTENTS,
  SIZE_CLASSES,
  SPLIT_BASES,
  type SizeClass,
  type SplitBasis,
  type ZoneCandidateView,
} from '../../../platform/hub-orders/orders-shape';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { todayText } from '../../../platform/time/format-time';
import { ReceivingPhoto } from '../receiving/ReceivingPhoto';
import './orders-pages.css';

const F = WORDS.form;

export interface OrderFieldsProps {
  readonly values: OrderFormValues;
  readonly errors: OrderFieldErrors;
  /** A request is on its way or its outcome is not known: the form is not to be changed, because a changed form would be a different order. */
  readonly locked: boolean;
  /** The vendor the photos an order cites belong to (their owner). */
  readonly intakeId: string;
  /** The zones the address matched with each other, for the officer to choose one. */
  readonly candidates: readonly ZoneCandidateView[] | undefined;
  readonly gate: UploadGate;
  /** The form changes an order that exists: it asks why. */
  readonly amendment: boolean;
  /** Takes the patch into the form's values and the fields it makes right off the list of what is wrong. */
  readonly change: (patch: Partial<OrderFormValues>, ...fields: OrderField[]) => void;
}

const PAYER_OPTIONS: readonly PayerChoice[] = ['AS_BOOKED', ...PAYER_INTENTS];

const isSize = (value: string): value is SizeClass =>
  (SIZE_CLASSES as readonly string[]).includes(value);
const isBasis = (value: string): value is SplitBasis =>
  (SPLIT_BASES as readonly string[]).includes(value);

/**
 * The sections of the form of an order, in the order an officer thinks of the parcel in front of them: who it is for, how big it is, where it goes, what it is worth, when and who pays. **Nothing is chosen for
 * the officer**: the size has no default (it is a judgement, MSC-DEC-209), and the price is never a field. The one amount typed is the carrier's charge, an observation with the photo of its waybill beside it,
 * only where the parcel goes outside our area. A field tells what is wrong with it in place, in the floor's words, and the page puts focus on the first.
 */
export function OrderFields({
  values,
  errors,
  locked,
  intakeId,
  candidates,
  gate,
  amendment,
  change,
}: OrderFieldsProps) {
  const errorOf = (field: OrderField): { error?: string } =>
    errors[field] === undefined ? {} : { error: errors[field] };

  return (
    <>
      <TaskFormSection title={F.sections.recipient}>
        <Field label={F.fields.name} required {...errorOf('name')}>
          <Input
            name="name"
            value={values.name}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ name: event.target.value }, 'name');
            }}
          />
        </Field>
        <Field label={F.fields.phone} required help={F.fields.phoneHelp} {...errorOf('phone')}>
          <Input
            name="phone"
            value={values.phone}
            inputMode="tel"
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ phone: event.target.value }, 'phone');
            }}
          />
        </Field>
        <Field
          label={F.fields.address}
          required
          help={F.fields.addressHelp}
          {...errorOf('address')}
        >
          <Textarea
            name="address"
            rows={2}
            value={values.address}
            readOnly={locked}
            onChange={(event) => {
              // A new address is a new question for the server: the zone the officer chose was chosen for the old one.
              change(
                { address: event.target.value, zoneId: null, zoneNote: '' },
                'address',
                'zone',
                'zoneNote',
              );
            }}
          />
        </Field>
        <Field label={F.fields.landmark}>
          <Input
            name="landmark"
            value={values.landmark}
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change(
                { landmark: event.target.value, zoneId: null, zoneNote: '' },
                'zone',
                'zoneNote',
              );
            }}
          />
        </Field>
      </TaskFormSection>

      {candidates === undefined ? null : (
        <TaskFormSection title={F.fields.zone} description={F.fields.zoneHelp}>
          <RadioGroup
            legend={F.fields.zone}
            name="zone"
            required
            size="lg"
            options={candidates.map((candidate) => ({
              value: candidate.zone_id,
              label: candidate.name,
            }))}
            value={values.zoneId}
            disabled={locked}
            {...errorOf('zone')}
            onChange={(value) => {
              change({ zoneId: value }, 'zone');
            }}
          />
          <Field
            label={F.fields.zoneNote}
            required
            help={F.fields.zoneNoteHelp}
            {...errorOf('zoneNote')}
          >
            <Input
              name="zoneNote"
              value={values.zoneNote}
              autoComplete="off"
              readOnly={locked}
              onChange={(event) => {
                change({ zoneNote: event.target.value }, 'zoneNote');
              }}
            />
          </Field>
        </TaskFormSection>
      )}

      <TaskFormSection title={F.sections.size}>
        <RadioGroup
          legend={F.fields.size}
          name="size"
          required
          size="lg"
          help={F.fields.sizeHelp}
          options={SIZE_CLASSES.map((value) => ({ value, label: F.sizes[value] }))}
          value={values.sizeClass}
          disabled={locked}
          {...errorOf('sizeClass')}
          onChange={(value) => {
            change({ sizeClass: isSize(value) ? value : null }, 'sizeClass');
          }}
        />
      </TaskFormSection>

      <TaskFormSection title={F.sections.destination}>
        <RadioGroup
          legend={F.fields.destination}
          name="destination"
          required
          size="lg"
          options={DESTINATIONS.map((value) => ({
            value,
            label: F.destinations[value].label,
            help: F.destinations[value].help,
          }))}
          value={values.destination}
          disabled={locked}
          {...errorOf('destination')}
          onChange={(value) => {
            const next = DESTINATIONS.find((each) => each === value) ?? null;
            // The carrier's charge and its waybill belong to a parcel sent by a carrier: anything typed for another way is not carried to this one.
            change(
              next === 'CARRIER'
                ? { destination: next }
                : { destination: next, carrierCost: '', waybillEvidenceId: null },
              'destination',
              'carrierCost',
              'waybill',
            );
          }}
        />
      </TaskFormSection>

      {values.destination === 'CARRIER' ? (
        <TaskFormSection title={F.sections.carrier}>
          <Field
            label={F.fields.carrierCost}
            required
            help={F.fields.carrierCostHelp}
            {...errorOf('carrierCost')}
          >
            <Input
              name="carrierCost"
              value={values.carrierCost}
              inputMode="decimal"
              autoComplete="off"
              readOnly={locked}
              onChange={(event) => {
                change({ carrierCost: event.target.value }, 'carrierCost');
              }}
            />
          </Field>
          <ReceivingPhoto
            intakeId={intakeId}
            purpose="ITEMIZATION"
            use="itemize"
            label={F.fields.waybill}
            help={F.fields.waybillHelp}
            required
            error={errors.waybill}
            onChange={(stored) => {
              change({ waybillEvidenceId: stored.at(-1) ?? null }, 'waybill');
            }}
            onBusyChange={gate.watch(F.fields.waybill)}
          />
        </TaskFormSection>
      ) : null}

      <TaskFormSection title={F.sections.value}>
        <Field
          label={F.fields.declaredValue}
          help={F.fields.declaredValueHelp}
          {...errorOf('declaredValue')}
        >
          <Input
            name="declaredValue"
            value={values.declaredValue}
            inputMode="decimal"
            autoComplete="off"
            readOnly={locked}
            onChange={(event) => {
              change({ declaredValue: event.target.value }, 'declaredValue');
            }}
          />
        </Field>
        <Checkbox
          name="highValue"
          size="lg"
          label={F.fields.highValue}
          help={F.fields.highValueHelp}
          checked={values.highValue}
          disabled={locked}
          onChange={(event) => {
            change({ highValue: event.target.checked }, 'evidence');
          }}
        />
        {values.highValue ? (
          <ReceivingPhoto
            intakeId={intakeId}
            purpose="ITEMIZATION"
            use="itemize"
            label={F.fields.evidence}
            help={F.fields.evidenceHelp}
            required
            error={errors.evidence}
            onChange={(stored) => {
              change({ evidenceIds: stored }, 'evidence');
            }}
            onBusyChange={gate.watch(F.fields.evidence)}
          />
        ) : null}
        <Checkbox
          name="serialized"
          size="lg"
          label={F.fields.serialized}
          checked={values.serialized}
          disabled={locked}
          onChange={(event) => {
            change({ serialized: event.target.checked }, 'serial');
          }}
        />
        {values.serialized ? (
          <Field label={F.fields.serial} required {...errorOf('serial')}>
            <Input
              name="serial"
              value={values.serial}
              autoComplete="off"
              readOnly={locked}
              onChange={(event) => {
                change({ serial: event.target.value }, 'serial');
              }}
            />
          </Field>
        ) : null}
      </TaskFormSection>

      <TaskFormSection title={F.sections.date}>
        <Field
          label={F.fields.requestedDate}
          help={F.fields.requestedDateHelp}
          {...errorOf('requestedDate')}
        >
          <DatePicker
            value={values.requestedDate}
            minValue={todayText()}
            isReadOnly={locked}
            onChange={(next) => {
              change({ requestedDate: next }, 'requestedDate');
            }}
          />
        </Field>
      </TaskFormSection>

      <TaskFormSection title={F.sections.payer}>
        <RadioGroup
          legend={F.fields.payer}
          name="payer"
          required
          size="lg"
          help={F.fields.payerHelp}
          options={PAYER_OPTIONS.map((value) => ({
            value,
            label: F.payers[value].label,
            ...(value === 'AS_BOOKED' ? { help: F.payers.AS_BOOKED.help } : {}),
          }))}
          value={values.payer}
          disabled={locked}
          {...errorOf('payer')}
          onChange={(value) => {
            const next = PAYER_OPTIONS.find((each) => each === value);
            if (next !== undefined)
              change({ payer: next }, 'payer', 'splitBasis', 'splitAmount', 'splitPercentage');
          }}
        />
        {values.payer === 'SPLIT' ? (
          <>
            <RadioGroup
              legend={F.fields.splitBasis}
              name="splitBasis"
              required
              size="lg"
              options={SPLIT_BASES.map((value) => ({ value, label: F.splitBases[value] }))}
              value={values.splitBasis}
              disabled={locked}
              {...errorOf('splitBasis')}
              onChange={(value) => {
                change(
                  { splitBasis: isBasis(value) ? value : null },
                  'splitBasis',
                  'splitAmount',
                  'splitPercentage',
                );
              }}
            />
            {values.splitBasis === 'FIXED_AMOUNT' ? (
              <Field label={F.fields.splitAmount} required {...errorOf('splitAmount')}>
                <Input
                  name="splitAmount"
                  value={values.splitAmount}
                  inputMode="decimal"
                  autoComplete="off"
                  readOnly={locked}
                  onChange={(event) => {
                    change({ splitAmount: event.target.value }, 'splitAmount');
                  }}
                />
              </Field>
            ) : null}
            {values.splitBasis === 'PERCENTAGE' ? (
              <Field label={F.fields.splitPercentage} required {...errorOf('splitPercentage')}>
                <Input
                  name="splitPercentage"
                  value={values.splitPercentage}
                  inputMode="decimal"
                  autoComplete="off"
                  readOnly={locked}
                  onChange={(event) => {
                    change({ splitPercentage: event.target.value }, 'splitPercentage');
                  }}
                />
              </Field>
            ) : null}
          </>
        ) : null}
      </TaskFormSection>

      {amendment ? (
        <TaskFormSection title={F.sections.reason}>
          <Field label={F.fields.reason} required help={F.fields.reasonHelp} {...errorOf('reason')}>
            <Textarea
              name="reason"
              rows={2}
              value={values.reason}
              readOnly={locked}
              onChange={(event) => {
                change({ reason: event.target.value }, 'reason');
              }}
            />
          </Field>
        </TaskFormSection>
      ) : null}
    </>
  );
}
