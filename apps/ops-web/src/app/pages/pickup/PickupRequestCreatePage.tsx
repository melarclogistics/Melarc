import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';

import { FormPage } from '../../../components/FormPage';
import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { Checkbox } from '../../../components/ui/checkbox/Checkbox';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { Field } from '../../../components/ui/field/Field';
import { ForbiddenState } from '../../../components/ui/forbidden-state/ForbiddenState';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { pesewasFromCedis } from '../../../components/ui/money/money-value';
import { Picker, type PickerOption } from '../../../components/ui/picker/Picker';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import type { ReadQuery } from '../../../components/ui/read-state/ReadState';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { useApiClient } from '../../../platform/api/api-client';
import { useConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import {
  createPickupRequest,
  type NewPickupRequest,
} from '../../../platform/pickup/pickup-commands';
import {
  calendarDateOf,
  PAYER_INTENTS,
  PICKUP_INTENTS,
  type PayerIntent,
  type PickupIntent,
  type PickupRequestView,
  type VendorPickupLocationView,
} from '../../../platform/pickup/pickup-shape';
import {
  useAdHocSenderLookup,
  useVendorPickupLocations,
} from '../../../platform/pickup/use-pickup-queries';
import { copyFor, type Problem } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { todayText } from '../../../platform/time/format-time';
import { useVendorAccounts } from '../../../platform/vendor/use-vendor-queries';
import { EstimateSummary } from './EstimateSummary';
import {
  INTENT_LABELS,
  PAYER_LABELS,
  PICKUP_STATE_MAP,
  serviceDateText,
  weekdayOf,
} from './pickup-presentation';
import './pickup-pages.css';

const OPERATION = 'createPickupRequest';
const VENDOR_READ = 'vendor.read';
const LOCATIONS_READ = 'vendor.pickup_location.manage';
/** The longest search the server accepts (`listVendorAccounts`, `q`). */
const SEARCH_LIMIT = 128;

const INTENT_HELP: Readonly<Record<PickupIntent, string>> = {
  OWN_PACKAGES: 'A registered vendor sends its own parcels from one of its saved locations.',
  COLLECT_FOR_VENDOR:
    'The parcel is with a seller or another business, and goes to a registered vendor.',
  ADHOC_SENDER: 'A person or business that is not a registered vendor.',
};

const PAYER_HELP: Readonly<Record<PayerIntent, string>> = {
  RECIPIENT_PAYS: 'The recipient pays for delivery.',
  SENDER_PAYS_FULL: 'The sender pays for delivery in full.',
  SPLIT: 'The sender pays a part and the recipient the rest.',
};

type SenderSource = 'RETURNING' | 'NEW';
type SplitBasis = 'FIXED_AMOUNT' | 'PERCENTAGE';
/** The destination of a collection: the vendor's default saved location, or one of its saved locations by id. */
const DEFAULT_DESTINATION = 'DEFAULT';

/** Everything the form holds, as typed. What is sent is built from it at submit time, for the intent chosen. */
interface Values {
  readonly intent: PickupIntent | null;
  readonly vendor: PickerOption | null;
  readonly locationId: string;
  readonly override: boolean;
  readonly overrideAddress: string;
  readonly overrideLandmark: string;
  readonly goods: string;
  readonly pointName: string;
  readonly pointPhone: string;
  readonly pointAddress: string;
  readonly pointLandmark: string;
  readonly referenceName: string;
  readonly sellerOrder: string;
  readonly itemDescription: string;
  readonly itemQuantity: string;
  readonly handlingNote: string;
  readonly destination: string;
  readonly senderSource: SenderSource | null;
  readonly sender: PickerOption | null;
  readonly newName: string;
  readonly newPhone: string;
  readonly newBusiness: string;
  readonly newContact: string;
  readonly newAddress: string;
  readonly newLandmark: string;
  readonly primaryPhone: string;
  readonly secondaryPhone: string;
  readonly serviceDate: string | null;
  readonly packages: string;
  readonly payer: PayerIntent | null;
  readonly splitBasis: SplitBasis | null;
  readonly splitAmount: string;
  readonly splitPercentage: string;
  readonly declaredValue: string;
  readonly capAcknowledged: boolean;
}

const EMPTY: Values = {
  intent: null,
  vendor: null,
  locationId: '',
  override: false,
  overrideAddress: '',
  overrideLandmark: '',
  goods: '',
  pointName: '',
  pointPhone: '',
  pointAddress: '',
  pointLandmark: '',
  referenceName: '',
  sellerOrder: '',
  itemDescription: '',
  itemQuantity: '',
  handlingNote: '',
  destination: '',
  senderSource: null,
  sender: null,
  newName: '',
  newPhone: '',
  newBusiness: '',
  newContact: '',
  newAddress: '',
  newLandmark: '',
  primaryPhone: '',
  secondaryPhone: '',
  serviceDate: null,
  packages: '',
  payer: null,
  splitBasis: null,
  splitAmount: '',
  splitPercentage: '',
  declaredValue: '',
  capAcknowledged: false,
};

type FieldKey =
  | 'intent'
  | 'vendor'
  | 'overrideAddress'
  | 'goods'
  | 'pointName'
  | 'pointPhone'
  | 'pointAddress'
  | 'referenceName'
  | 'itemDescription'
  | 'itemQuantity'
  | 'destination'
  | 'senderSource'
  | 'sender'
  | 'newName'
  | 'newPhone'
  | 'newAddress'
  | 'primaryPhone'
  | 'serviceDate'
  | 'packages'
  | 'payer'
  | 'splitBasis'
  | 'splitAmount'
  | 'splitPercentage'
  | 'declaredValue';

type FieldErrors = Partial<Record<FieldKey, string>>;

/** The fields that hold a line of text the person types and that an error can be tied to. */
const TEXT_KEYS = [
  'overrideAddress',
  'goods',
  'pointName',
  'pointPhone',
  'pointAddress',
  'referenceName',
  'itemDescription',
  'itemQuantity',
  'newName',
  'newPhone',
  'newAddress',
  'primaryPhone',
  'packages',
  'splitAmount',
  'splitPercentage',
  'declaredValue',
] as const satisfies readonly (FieldKey & keyof Values)[];

type TextKey = (typeof TEXT_KEYS)[number];

/** The lines of text that are optional and that the API never refuses on their own: no error is tied to them. */
type OptionalTextKey =
  | 'overrideLandmark'
  | 'pointLandmark'
  | 'sellerOrder'
  | 'handlingNote'
  | 'newBusiness'
  | 'newContact'
  | 'newLandmark'
  | 'secondaryPhone';

/** The places the API names when it refuses a booking, and the field each is. */
const POINTERS: Readonly<Record<string, FieldKey>> = {
  '/pickup_intent': 'intent',
  '/vendor_organization_id': 'vendor',
  '/location_overrides': 'overrideAddress',
  '/location_overrides/address': 'overrideAddress',
  '/current_item_description': 'goods',
  '/collection_point': 'pointName',
  '/collection_point/contact_name': 'pointName',
  '/collection_point/phone': 'pointPhone',
  '/collection_point/location': 'pointAddress',
  '/collection_point/location/address': 'pointAddress',
  '/collection_reference': 'referenceName',
  '/collection_reference/reference_name': 'referenceName',
  '/collection_item': 'itemDescription',
  '/collection_item/description': 'itemDescription',
  '/collection_item/quantity': 'itemQuantity',
  '/destination_location_id': 'destination',
  '/use_vendor_default_destination': 'destination',
  '/ad_hoc_sender_id': 'sender',
  '/new_ad_hoc_sender': 'newName',
  '/new_ad_hoc_sender/name': 'newName',
  '/new_ad_hoc_sender/phone': 'newPhone',
  '/new_ad_hoc_sender/pickup_location': 'newAddress',
  '/new_ad_hoc_sender/pickup_location/address': 'newAddress',
  '/primary_phone': 'primaryPhone',
  '/scheduled_service_date': 'serviceDate',
  '/declared_package_count': 'packages',
  '/default_payer_intent': 'payer',
  '/split_basis': 'splitBasis',
  '/split_sender_amount': 'splitAmount',
  '/split_sender_amount/amount_minor': 'splitAmount',
  '/split_sender_percentage': 'splitPercentage',
  '/declared_value_minor': 'declaredValue',
};

const WORDS: Readonly<Record<FieldKey, string>> = {
  intent: 'Choose what is being booked.',
  vendor: 'Choose the vendor.',
  overrideAddress: 'Enter the address to collect from this time.',
  goods: 'Say what is being sent today.',
  pointName: 'Enter who the parcel is collected from: a person or a business.',
  pointPhone: 'Enter the phone of who the parcel is collected from.',
  pointAddress: 'Enter the address the parcel is collected from.',
  referenceName: 'Enter the name the seller holds the item under.',
  itemDescription: 'Describe the item to collect.',
  itemQuantity: 'Enter how many items, a whole number of at least 1.',
  destination: 'Choose where the parcel goes.',
  senderSource: 'Say whether the sender has used Melarc before.',
  sender: 'Find the returning sender by phone, and choose them.',
  newName: 'Enter the sender’s name.',
  newPhone: 'Enter the sender’s phone, with the country code.',
  newAddress: 'Enter the address the parcel is collected from.',
  primaryPhone: 'Enter a contact phone for this pickup.',
  serviceDate: 'Enter the service date, as day, month and year.',
  packages: 'Enter the number of packages, a whole number of at least 1.',
  payer: 'Choose who pays.',
  splitBasis: 'Choose how the cost is shared.',
  splitAmount: 'Enter the sender’s share in cedis, for example 15.00.',
  splitPercentage: 'Enter the sender’s share as a percentage from 0 to 100, for example 40.',
  declaredValue: 'Enter the declared value in cedis, for example 250.00, or leave it empty.',
};

const SUNDAY = 0;
const PERCENTAGE = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

const blank = (text: string): boolean => text.trim() === '';

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** A whole count typed as digits, at least 1, or nothing. */
function countOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return undefined;
  const count = Number(trimmed);
  return count >= 1 ? count : undefined;
}

/**
 * What is wrong with the booking before anything is sent: only what the server would refuse for certain, in the words of each field. The
 * service date's days are the product's calendar (Monday to Saturday, MSC-DEC-149), checked here for quicker news and decided by the server;
 * whether a value needs the liability-cap acknowledgement is the server's alone, because the threshold is a hub setting the page is not given.
 */
function problemsWith(values: Values): FieldErrors {
  const found: FieldErrors = {};
  const need = (key: FieldKey, text: string): void => {
    if (blank(text)) found[key] = WORDS[key];
  };
  if (values.intent === null) found.intent = WORDS.intent;
  if (values.intent === 'OWN_PACKAGES' || values.intent === 'COLLECT_FOR_VENDOR') {
    if (values.vendor === null) found.vendor = WORDS.vendor;
  }
  if (values.intent === 'OWN_PACKAGES' && values.override)
    need('overrideAddress', values.overrideAddress);
  if (values.intent === 'COLLECT_FOR_VENDOR') {
    need('pointName', values.pointName);
    need('pointPhone', values.pointPhone);
    need('pointAddress', values.pointAddress);
    need('referenceName', values.referenceName);
    need('itemDescription', values.itemDescription);
    if (countOf(values.itemQuantity) === undefined) found.itemQuantity = WORDS.itemQuantity;
    if (values.destination === '') found.destination = WORDS.destination;
    need('primaryPhone', values.primaryPhone);
  }
  if (values.intent === 'ADHOC_SENDER') {
    if (values.senderSource === null) found.senderSource = WORDS.senderSource;
    if (values.senderSource === 'RETURNING' && values.sender === null) found.sender = WORDS.sender;
    if (values.senderSource === 'NEW') {
      need('newName', values.newName);
      need('newPhone', values.newPhone);
      need('newAddress', values.newAddress);
    }
    need('goods', values.goods);
    need('primaryPhone', values.primaryPhone);
  }
  const date = calendarDateOf(values.serviceDate);
  if (date === undefined || Number(date.slice(0, 4)) < 1000) found.serviceDate = WORDS.serviceDate;
  else if (weekdayOf(date) === SUNDAY) {
    found.serviceDate = copyFor({ operation: OPERATION, code: 'SERVICE_DATE_NOT_PERMITTED' }) ?? '';
  }
  if (countOf(values.packages) === undefined) found.packages = WORDS.packages;
  if (values.payer === null) found.payer = WORDS.payer;
  if (values.payer === 'SPLIT') {
    if (values.splitBasis === null) found.splitBasis = WORDS.splitBasis;
    if (
      values.splitBasis === 'FIXED_AMOUNT' &&
      pesewasFromCedis(values.splitAmount) === undefined
    ) {
      found.splitAmount = WORDS.splitAmount;
    }
    if (values.splitBasis === 'PERCENTAGE' && !PERCENTAGE.test(values.splitPercentage.trim())) {
      found.splitPercentage = WORDS.splitPercentage;
    }
  }
  if (!blank(values.declaredValue) && pesewasFromCedis(values.declaredValue) === undefined) {
    found.declaredValue = WORDS.declaredValue;
  }
  // A line typed into a one-line field cannot hold a line break; one pasted in is refused here, not sent.
  for (const key of TEXT_KEYS) {
    if (found[key] === undefined && hasControlCharacter(values[key])) {
      found[key] = 'Keep it to one line.';
    }
  }
  return found;
}

/** A Location of what was typed: the address, and the landmark when there is one. */
function locationOf(address: string, landmark: string) {
  const mark = landmark.trim();
  return { address: address.trim(), ...(mark === '' ? {} : { landmark: mark }) };
}

/**
 * A collection booking taken to the vendor's default saved location. `use_vendor_default_destination` is a field of `PickupRequestCreate` that
 * the contract declares only inside the `COLLECT_FOR_VENDOR` branch of the schema's `allOf`, and the generated type does not carry it; it is
 * added here to a booking the generated type already describes, and nothing else is. This is the one place a booking holds a field its type
 * does not name (reported for the contract to hoist the field).
 */
function toVendorDefault(booking: NewPickupRequest): NewPickupRequest {
  return Object.assign({ use_vendor_default_destination: true }, booking);
}

/**
 * The booking as the contract wants it, for the intent chosen and nothing of another intent: an `OWN_PACKAGES` booking carries no collection
 * point (it is refused as mis-declared), an `ADHOC_SENDER` booking exactly one identity source. It carries payer intent and never a price.
 */
function bookingOf(values: Values): NewPickupRequest | undefined {
  const date = calendarDateOf(values.serviceDate);
  const packages = countOf(values.packages);
  if (
    values.intent === null ||
    values.payer === null ||
    date === undefined ||
    packages === undefined
  ) {
    return undefined;
  }
  const declared = blank(values.declaredValue) ? undefined : pesewasFromCedis(values.declaredValue);
  const secondary = values.secondaryPhone.trim();
  const goods = values.goods.trim();
  const common = {
    pickup_intent: values.intent,
    scheduled_service_date: date,
    declared_package_count: packages,
    default_payer_intent: values.payer,
    ...(values.payer === 'SPLIT' && values.splitBasis !== null
      ? { split_basis: values.splitBasis }
      : {}),
    ...(values.payer === 'SPLIT' && values.splitBasis === 'FIXED_AMOUNT'
      ? {
          split_sender_amount: {
            amount_minor: pesewasFromCedis(values.splitAmount) ?? 0,
            currency: 'GHS' as const,
          },
        }
      : {}),
    ...(values.payer === 'SPLIT' && values.splitBasis === 'PERCENTAGE'
      ? { split_sender_percentage: Number(values.splitPercentage.trim()) }
      : {}),
    ...(declared === undefined ? {} : { declared_value_minor: declared }),
    ...(declared !== undefined && values.capAcknowledged
      ? { liability_cap_acknowledged: true }
      : {}),
    ...(secondary === '' ? {} : { secondary_phone: secondary }),
  };
  switch (values.intent) {
    case 'OWN_PACKAGES':
      return {
        ...common,
        vendor_organization_id: values.vendor?.value ?? '',
        ...(values.locationId === '' ? {} : { vendor_pickup_location_id: values.locationId }),
        ...(values.override
          ? { location_overrides: locationOf(values.overrideAddress, values.overrideLandmark) }
          : {}),
        ...(goods === '' ? {} : { current_item_description: goods }),
      };
    case 'COLLECT_FOR_VENDOR': {
      const order = values.sellerOrder.trim();
      const handling = values.handlingNote.trim();
      const collection: NewPickupRequest = {
        ...common,
        vendor_organization_id: values.vendor?.value ?? '',
        collection_point: {
          contact_name: values.pointName.trim(),
          phone: values.pointPhone.trim(),
          location: locationOf(values.pointAddress, values.pointLandmark),
        },
        collection_reference: {
          reference_name: values.referenceName.trim(),
          ...(order === '' ? {} : { seller_order_reference: order }),
        },
        collection_item: {
          description: values.itemDescription.trim(),
          quantity: countOf(values.itemQuantity) ?? 1,
          ...(handling === '' ? {} : { handling_note: handling }),
        },
        ...(values.destination === DEFAULT_DESTINATION
          ? {}
          : { destination_location_id: values.destination }),
        primary_phone: values.primaryPhone.trim(),
      };
      return values.destination === DEFAULT_DESTINATION ? toVendorDefault(collection) : collection;
    }
    case 'ADHOC_SENDER': {
      const business = values.newBusiness.trim();
      const contact = values.newContact.trim();
      return {
        ...common,
        ...(values.senderSource === 'RETURNING'
          ? { ad_hoc_sender_id: values.sender?.value ?? '' }
          : {
              new_ad_hoc_sender: {
                name: values.newName.trim(),
                phone: values.newPhone.trim(),
                ...(business === '' ? {} : { business_name: business }),
                ...(contact === '' ? {} : { pickup_contact_name: contact }),
                pickup_location: locationOf(values.newAddress, values.newLandmark),
              },
            }),
        current_item_description: goods,
        primary_phone: values.primaryPhone.trim(),
      };
    }
  }
}

/** The fields a refusal is about, in the words of each field, from the places the API named. */
function refusedFields(problem: Problem | undefined): FieldErrors {
  if (problem === undefined) return {};
  const found: FieldErrors = {};
  if (
    problem.code === 'SERVICE_DATE_NOT_PERMITTED' ||
    problem.code === 'ZONE_NOT_SERVICED_ON_DATE'
  ) {
    found.serviceDate = problem.message;
  }
  if (problem.code === 'DESTINATION_UNRESOLVED') found.destination = problem.message;
  if (problem.code === 'PICKUP_MINIMUM_NOT_MET') found.packages = problem.message;
  for (const violation of problem.violations ?? []) {
    const key = POINTERS[violation.pointer];
    if (key !== undefined && found[key] === undefined) found[key] = WORDS[key];
  }
  return found;
}

/** A read the picker can show: the query's state, with its data turned into the picker's options. */
function asOptions<Data>(
  query: UseQueryResult<Data>,
  options: (data: Data) => readonly PickerOption[],
): ReadQuery<readonly PickerOption[]> {
  return {
    status: query.status,
    data: query.data === undefined ? undefined : options(query.data),
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

function VendorPicker({
  value,
  error,
  disabled,
  onChange,
}: {
  readonly value: PickerOption | null;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (vendor: PickerOption | null) => void;
}) {
  const me = useSignedInSession();
  const holds = me?.holds(VENDOR_READ) === true;
  const [search, setSearch] = useState<string | undefined>(undefined);
  const vendors = useVendorAccounts({
    q: search ?? '',
    enabled: holds && search !== undefined,
  });
  if (!holds) {
    return (
      <>
        <ForbiddenState kind="permission-missing" permission={VENDOR_READ} />
        {error === undefined ? null : (
          <p className="pickup-form-note" role="note">
            {error}
          </p>
        )}
      </>
    );
  }
  return (
    <Picker
      label="Vendor"
      required
      searchLabel="Search vendors by name or account"
      searchHelp="Leave it empty and search to list the vendors of your hubs."
      maxLength={SEARCH_LIMIT}
      searchAction="Search"
      onSearch={setSearch}
      results={
        search === undefined
          ? undefined
          : asOptions(vendors, (page) => {
              // One account is listed for each vendor; the organisation is what a booking names.
              const seen = new Set<string>();
              return page.items.flatMap((account) => {
                const key = account.vendor_organization_id.toLowerCase();
                if (seen.has(key)) return [];
                seen.add(key);
                return [
                  {
                    value: account.vendor_organization_id,
                    label: account.legal_name,
                    description:
                      account.status === 'SUSPENDED'
                        ? `Account ${account.account_identifier}, suspended`
                        : `Account ${account.account_identifier}`,
                  },
                ];
              });
            })
      }
      moreResults={vendors.data !== undefined && vendors.data.nextPageToken !== null}
      noResults={<p>No vendor matches. Try another name or account.</p>}
      value={value}
      onChange={onChange}
      chooseAction="Choose"
      changeAction="Choose another vendor"
      disabled={disabled}
      operation="listVendorAccounts"
      context="vendor-picker"
      permission={VENDOR_READ}
      {...(error === undefined ? {} : { error })}
    />
  );
}

/**
 * The vendor's active saved locations, in the server's order (the default first), handed to the field that offers them. The vendor's default is
 * always a choice without the list, so a session that may not read the list, a read on its way and a read that failed each leave the default
 * to choose, and say why nothing else is offered.
 */
function SavedLocations({
  vendorId,
  children,
}: {
  readonly vendorId: string;
  readonly children: (locations: readonly VendorPickupLocationView[]) => ReactNode;
}) {
  const me = useSignedInSession();
  const holds = me?.holds(LOCATIONS_READ) === true;
  const locations = useVendorPickupLocations(vendorId, holds);
  if (!holds) {
    return (
      <>
        {children([])}
        <p className="pickup-form-note">
          Choosing another of the vendor’s saved locations needs the permission{' '}
          <code>{LOCATIONS_READ}</code>, which your session does not hold.
        </p>
      </>
    );
  }
  if (locations.status === 'success') {
    return children(locations.data.filter((location) => location.active));
  }
  return (
    <>
      <ReadState
        query={locations}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Loading the vendor’s saved locations…"
        operation="listVendorPickupLocations"
        permission={LOCATIONS_READ}
      >
        {() => null}
      </ReadState>
      {children([])}
    </>
  );
}

const locationLabel = (location: VendorPickupLocationView): string =>
  `${location.label}: ${location.location.address}${location.is_default ? ' (the default)' : ''}`;

function SenderPicker({
  value,
  error,
  disabled,
  onChange,
  onBlankSearch,
}: {
  readonly value: PickerOption | null;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (sender: PickerOption | null) => void;
  readonly onBlankSearch: () => void;
}) {
  const me = useSignedInSession();
  const holds = me?.holds(VENDOR_READ) === true;
  const [phone, setPhone] = useState<string | undefined>(undefined);
  const senders = useAdHocSenderLookup(holds ? phone : undefined);
  if (!holds) return <ForbiddenState kind="permission-missing" permission={VENDOR_READ} />;
  return (
    <Picker
      label="Returning sender"
      required
      searchLabel="The sender’s phone"
      searchHelp="The phone they used before, with the country code, for example +233 24 000 0000."
      inputMode="tel"
      searchAction="Find the sender"
      onSearch={(text) => {
        if (text === '') {
          onBlankSearch();
          return;
        }
        setPhone(text);
      }}
      results={
        phone === undefined
          ? undefined
          : asOptions(senders, (list) =>
              list.map((sender) => ({
                value: sender.id,
                label: sender.display_name,
                description: sender.blocked === true ? `${sender.phone}, blocked` : sender.phone,
              })),
            )
      }
      noResults={<p>No returning sender has this phone. Enter them as a first-time sender.</p>}
      value={value}
      onChange={onChange}
      chooseAction="Use this sender"
      changeAction="Find another sender"
      disabled={disabled}
      operation="findAdHocSender"
      permission={VENDOR_READ}
      {...(error === undefined ? {} : { error })}
    />
  );
}

function BookingForm({ onBooked }: { readonly onBooked: (request: PickupRequestView) => void }) {
  const client = useApiClient();
  const [values, setValues] = useState<Values>(EMPTY);
  const [invalid, setInvalid] = useState<FieldErrors>({});
  const [attempts, setAttempts] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const command = useConfirmedCommand<NewPickupRequest, PickupRequestView>({
    send: (body, key) => createPickupRequest(client, body, key),
    onDone: onBooked,
    // The booking takes an Idempotency-Key: a lost answer is sent again under the same key, and a booking that went through is not made twice.
    retryable: true,
    operation: OPERATION,
  });
  const fromServer = command.phase === 'refused' ? refusedFields(command.problem) : {};
  const belongsToAField = Object.keys(fromServer).length > 0;
  const locked = command.locked;

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (command.phase === 'refused') focusFirstInvalid(form.current);
    if (command.phase === 'unknown') {
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
    }
  }, [command.phase]);

  const errorOf = (key: FieldKey): { error?: string } => {
    const text = invalid[key] ?? fromServer[key];
    return text === undefined ? {} : { error: text };
  };

  function change(patch: Partial<Values>, ...keys: FieldKey[]): void {
    setValues((current) => ({ ...current, ...patch }));
    if (keys.length > 0) {
      setInvalid((current) => {
        const next: FieldErrors = { ...current };
        for (const key of keys) next[key] = undefined;
        return next;
      });
    }
    command.dismiss();
  }

  function send(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (locked) return;
    const found = problemsWith(values);
    setInvalid(found);
    const booking = bookingOf(values);
    if (Object.keys(found).length > 0 || booking === undefined) {
      setAttempts((count) => count + 1);
      return;
    }
    void command.submit(booking);
  }

  /** A line of text the form holds, with its label, its help and its error. */
  const text = (
    key: TextKey,
    label: string,
    options: { required?: boolean; help?: string; inputMode?: 'tel' | 'numeric' | 'decimal' } = {},
  ) => (
    <Field
      label={label}
      required={options.required === true}
      {...(options.help === undefined ? {} : { help: options.help })}
      {...errorOf(key)}
    >
      <Input
        name={key}
        value={values[key]}
        autoComplete="off"
        readOnly={locked}
        {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
        onChange={(event) => {
          const patch: Partial<Record<TextKey, string>> = {};
          patch[key] = event.target.value;
          change(patch, key);
        }}
      />
    </Field>
  );

  /** An optional line of text, which the API never refuses on its own. */
  const optionalText = (key: OptionalTextKey, label: string, help: string, inputMode?: 'tel') => (
    <Field label={label} help={help}>
      <Input
        name={key}
        value={values[key]}
        autoComplete="off"
        readOnly={locked}
        {...(inputMode === undefined ? {} : { inputMode })}
        onChange={(event) => {
          const patch: Partial<Record<OptionalTextKey, string>> = {};
          patch[key] = event.target.value;
          change(patch);
        }}
      />
    </Field>
  );

  const intent = values.intent;
  const vendorId = values.vendor?.value;

  return (
    <form
      ref={form}
      noValidate
      aria-busy={command.phase === 'sending' ? true : undefined}
      onSubmit={send}
    >
      {command.phase === 'unknown' ? (
        <Alert variant="danger" announce>
          <p>{copyFor({ operation: OPERATION, context: 'unknown-outcome' })}</p>
          {command.problem === undefined ? null : <p>{command.problem.message}</p>}
        </Alert>
      ) : null}
      {command.phase === 'refused' && command.problem !== undefined && !belongsToAField ? (
        <Alert variant="danger" announce>
          <p>{command.problem.message}</p>
          {command.problem.reference === undefined ? null : (
            <p>Reference: {command.problem.reference}</p>
          )}
        </Alert>
      ) : null}

      <RadioGroup
        legend="What is being booked"
        name="intent"
        required
        options={PICKUP_INTENTS.map((value) => ({
          value,
          label: INTENT_LABELS[value],
          help: INTENT_HELP[value],
        }))}
        value={intent}
        disabled={locked}
        {...errorOf('intent')}
        onChange={(value) => {
          change({ intent: PICKUP_INTENTS.find((each) => each === value) ?? null }, 'intent');
        }}
      />

      {intent === null ? (
        <p className="pickup-form-note">
          Choose what is being booked first: it decides what the rest of the booking asks for.
        </p>
      ) : null}

      {intent === 'OWN_PACKAGES' || intent === 'COLLECT_FOR_VENDOR' ? (
        <section className="pickup-form-section" aria-labelledby="booking-vendor">
          <h2 id="booking-vendor">The vendor</h2>
          <VendorPicker
            value={values.vendor}
            error={errorOf('vendor').error}
            disabled={locked}
            onChange={(vendor) => {
              change({ vendor, locationId: '', destination: '' }, 'vendor', 'destination');
            }}
          />
        </section>
      ) : null}

      {intent === 'OWN_PACKAGES' && vendorId !== undefined ? (
        <section className="pickup-form-section" aria-labelledby="booking-own">
          <h2 id="booking-own">Where the parcels are</h2>
          <SavedLocations vendorId={vendorId}>
            {(locations) =>
              locations.length === 0 ? (
                <p className="pickup-form-note">
                  The request uses the vendor’s default saved location.
                </p>
              ) : (
                <Field
                  label="Saved location"
                  help="The vendor’s default unless you choose another of its saved locations."
                >
                  <Select
                    name="location"
                    value={values.locationId}
                    disabled={locked}
                    onChange={(event) => {
                      change({ locationId: event.target.value });
                    }}
                  >
                    <option value="">The vendor’s default location</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {locationLabel(location)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            }
          </SavedLocations>
          <Checkbox
            name="override"
            label="Collect from another address for this pickup only"
            help="The vendor’s saved locations are not changed."
            checked={values.override}
            disabled={locked}
            onChange={(event) => {
              change({ override: event.target.checked }, 'overrideAddress');
            }}
          />
          {values.override ? (
            <>
              {text('overrideAddress', 'Address for this pickup', { required: true })}
              {optionalText('overrideLandmark', 'Landmark', 'Optional. What people find it by.')}
            </>
          ) : null}
          {text('goods', 'What is being sent today', {
            help: 'Optional for a vendor’s own packages: its goods profile already says what it sends.',
          })}
        </section>
      ) : null}

      {intent === 'COLLECT_FOR_VENDOR' && vendorId !== undefined ? (
        <>
          <section className="pickup-form-section" aria-labelledby="booking-point">
            <h2 id="booking-point">Where the parcel is collected from</h2>
            {text('pointName', 'Person or business holding the parcel', { required: true })}
            {text('pointPhone', 'Their phone', {
              required: true,
              inputMode: 'tel',
              help: 'Include the country code, for example +233 24 000 0000.',
            })}
            {text('pointAddress', 'Their address', { required: true })}
            {optionalText('pointLandmark', 'Landmark', 'Optional. What people find it by.')}
          </section>
          <section className="pickup-form-section" aria-labelledby="booking-item">
            <h2 id="booking-item">What is collected</h2>
            {text('referenceName', 'Name the seller holds it under', { required: true })}
            {optionalText(
              'sellerOrder',
              'Seller’s order number',
              'Optional, where the seller gave one.',
            )}
            {text('itemDescription', 'Item', { required: true })}
            {text('itemQuantity', 'How many items', { required: true, inputMode: 'numeric' })}
            {optionalText('handlingNote', 'Handling note', 'Optional. For example: fragile.')}
            <p className="pickup-form-note">
              The rider collects the item and pays the seller nothing: this is not a
              cash-on-delivery purchase.
            </p>
          </section>
          <section className="pickup-form-section" aria-labelledby="booking-destination">
            <h2 id="booking-destination">Where the parcel goes</h2>
            <SavedLocations vendorId={vendorId}>
              {(locations) => (
                <Field label="Destination" required {...errorOf('destination')}>
                  <Select
                    name="destination"
                    value={values.destination}
                    disabled={locked}
                    onChange={(event) => {
                      change({ destination: event.target.value }, 'destination');
                    }}
                  >
                    <option value="">Choose where it goes</option>
                    <option value={DEFAULT_DESTINATION}>The vendor’s default saved location</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {locationLabel(location)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </SavedLocations>
            {text('primaryPhone', 'Contact phone for this pickup', {
              required: true,
              inputMode: 'tel',
              help: 'Include the country code, for example +233 24 000 0000.',
            })}
          </section>
        </>
      ) : null}

      {intent === 'ADHOC_SENDER' ? (
        <section className="pickup-form-section" aria-labelledby="booking-sender">
          <h2 id="booking-sender">The sender</h2>
          <RadioGroup
            legend="Has the sender used Melarc before?"
            name="sender-source"
            required
            options={[
              { value: 'RETURNING', label: 'Yes: find them by phone' },
              { value: 'NEW', label: 'No: this is their first time' },
            ]}
            value={values.senderSource}
            disabled={locked}
            {...errorOf('senderSource')}
            onChange={(value) => {
              change(
                { senderSource: value === 'RETURNING' ? 'RETURNING' : 'NEW', sender: null },
                'senderSource',
                'sender',
              );
            }}
          />
          {values.senderSource === 'RETURNING' ? (
            <SenderPicker
              value={values.sender}
              error={errorOf('sender').error}
              disabled={locked}
              onChange={(sender) => {
                change({ sender }, 'sender');
              }}
              onBlankSearch={() => {
                setInvalid((current) => ({
                  ...current,
                  sender: 'Enter the sender’s phone to find them.',
                }));
              }}
            />
          ) : null}
          {values.senderSource === 'NEW' ? (
            <>
              {text('newName', 'Sender’s name', { required: true })}
              {text('newPhone', 'Sender’s phone', {
                required: true,
                inputMode: 'tel',
                help: 'Their own phone, with the country code. It is how they are found next time.',
              })}
              {optionalText('newBusiness', 'Business name', 'Optional.')}
              {optionalText(
                'newContact',
                'Who hands over the parcel',
                'Optional, if not the sender.',
              )}
              {text('newAddress', 'Address the parcel is collected from', { required: true })}
              {optionalText('newLandmark', 'Landmark', 'Optional. What people find it by.')}
            </>
          ) : null}
          {text('goods', 'What is being sent today', {
            required: true,
            help: 'Asked every time, for example: women’s shoes, books. Last time’s goods say nothing about this box.',
          })}
          {text('primaryPhone', 'Contact phone for this pickup', {
            required: true,
            inputMode: 'tel',
            help: 'Include the country code, for example +233 24 000 0000.',
          })}
        </section>
      ) : null}

      {intent === null ? null : (
        <>
          <section className="pickup-form-section" aria-labelledby="booking-when">
            <h2 id="booking-when">When and how many</h2>
            <Field
              label="Service date"
              required
              help="Monday to Saturday."
              {...errorOf('serviceDate')}
            >
              <DatePicker
                value={values.serviceDate}
                minValue={todayText()}
                isReadOnly={locked}
                onChange={(next) => {
                  change({ serviceDate: next }, 'serviceDate');
                }}
              />
            </Field>
            {text('packages', 'Number of packages', {
              required: true,
              inputMode: 'numeric',
              help: 'At least two. A single package is booked here and waits for a one-package exception before it can be confirmed.',
            })}
            {optionalText(
              'secondaryPhone',
              'Second contact phone',
              'Optional. Include the country code.',
              'tel',
            )}
          </section>

          <section className="pickup-form-section" aria-labelledby="booking-payer">
            <h2 id="booking-payer">Who pays</h2>
            <p className="pickup-form-note">
              The booking records who is meant to pay, never a price: the price is set when the
              parcels are itemized.
            </p>
            <RadioGroup
              legend="Who pays for delivery"
              name="payer"
              required
              options={PAYER_INTENTS.map((value) => ({
                value,
                label: PAYER_LABELS[value],
                help: PAYER_HELP[value],
              }))}
              value={values.payer}
              disabled={locked}
              {...errorOf('payer')}
              onChange={(value) => {
                change({ payer: PAYER_INTENTS.find((each) => each === value) ?? null }, 'payer');
              }}
            />
            {values.payer === 'SPLIT' ? (
              <>
                <RadioGroup
                  legend="How it is shared"
                  name="split-basis"
                  required
                  options={[
                    { value: 'FIXED_AMOUNT', label: 'The sender pays a set amount' },
                    { value: 'PERCENTAGE', label: 'The sender pays a percentage' },
                  ]}
                  value={values.splitBasis}
                  disabled={locked}
                  {...errorOf('splitBasis')}
                  onChange={(value) => {
                    change(
                      { splitBasis: value === 'FIXED_AMOUNT' ? 'FIXED_AMOUNT' : 'PERCENTAGE' },
                      'splitBasis',
                    );
                  }}
                />
                {values.splitBasis === 'FIXED_AMOUNT'
                  ? text('splitAmount', 'The sender’s share, in cedis', {
                      required: true,
                      inputMode: 'decimal',
                      help: 'For example 15.00. The recipient pays the rest.',
                    })
                  : null}
                {values.splitBasis === 'PERCENTAGE'
                  ? text('splitPercentage', 'The sender’s share, as a percentage', {
                      required: true,
                      inputMode: 'decimal',
                      help: 'From 0 to 100. The recipient pays the rest.',
                    })
                  : null}
              </>
            ) : null}
          </section>

          <section className="pickup-form-section" aria-labelledby="booking-value">
            <h2 id="booking-value">Declared value</h2>
            {text('declaredValue', 'Declared value of the goods, in cedis', {
              inputMode: 'decimal',
              help: 'Optional. A value above the hub’s limit for declarations needs the sender’s acknowledgement of the liability cap.',
            })}
            {blank(values.declaredValue) ? null : (
              <Checkbox
                name="cap"
                label="The sender acknowledges that Melarc’s liability is capped, whatever value is declared"
                help="Tell the sender the cap before you tick this. The cap in force now is recorded with the booking."
                checked={values.capAcknowledged}
                disabled={locked}
                onChange={(event) => {
                  change({ capAcknowledged: event.target.checked });
                }}
              />
            )}
          </section>
        </>
      )}

      <div className="ui-form-page__actions">
        {command.phase === 'unknown' ? (
          <Button
            key="retry"
            type="button"
            data-recovery
            onClick={() => {
              void command.retry();
            }}
          >
            Try again
          </Button>
        ) : (
          <>
            <Button key="submit" type="submit" loading={command.phase === 'sending'}>
              Book the pickup
            </Button>
            <Link to="/pickup-requests">Cancel</Link>
          </>
        )}
      </div>
    </form>
  );
}

function Booked({
  request,
  onAnother,
}: {
  readonly request: PickupRequestView;
  readonly onAnother: () => void;
}) {
  const me = useSignedInSession();
  const box = useRef<HTMLDivElement>(null);
  // The form that was here is gone: a keyboard user lands on what replaced it.
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="pickup-booked" ref={box} tabIndex={-1}>
      <Alert variant="success">
        <h2 className="pickup-booked__heading">Pickup booked</h2>
        <p>
          {`${request.code} is booked for ${serviceDateText(request.scheduled_service_date)}. It is ${PICKUP_STATE_MAP[
            request.state
          ].label.toLowerCase()}.`}
        </p>
      </Alert>
      {request.declared_package_count === 1 ? (
        <p className="pickup-act__text">
          It is for a single package: request its one-package exception from the request’s page. It
          is confirmed once the exception is approved.
        </p>
      ) : null}
      {request.indicative_estimate === undefined ? null : (
        <EstimateSummary estimate={request.indicative_estimate} />
      )}
      <div className="pickup-act__buttons">
        {me?.holds('pickup.read') === true ? (
          <ButtonLink to={`/pickup-requests/${request.id}`}>View the request</ButtonLink>
        ) : null}
        <Button type="button" variant="secondary" onClick={onAnother}>
          Book another pickup
        </Button>
      </div>
    </div>
  );
}

/**
 * Book a pickup (surfaces/ops-portal.md section 7, `/pickup-requests/new`; S1.19): a booking entered by Ops from WhatsApp or for a walk-in
 * sender, on the same rules as a vendor's own (§5: the two channels are indistinguishable downstream). **There is no universal form**: what is
 * booked is chosen first and decides what the rest asks for (`OWN_PACKAGES`, `COLLECT_FOR_VENDOR`, `ADHOC_SENDER`, MSC-DEC-335). The booking
 * carries payer intent and never a price; once it is made, the server's **indicative estimate** is shown as an estimate, provisional. It takes
 * an `Idempotency-Key`, so a lost answer is tried again under the same key and is never booked twice. A sender suspended while the form was
 * being filled is the server's answer (`SENDER_SUSPENDED`), told as such.
 */
export function PickupRequestCreatePage() {
  const [booked, setBooked] = useState<PickupRequestView | undefined>(undefined);
  // A new form for each booking: its own state, and its own key.
  const [form, setForm] = useState(0);
  return (
    <>
      <title>Book a pickup · Melarc Ops Portal</title>
      <PageHeader
        title="Book a pickup"
        description="Enter a booking from WhatsApp, a vendor’s call or a walk-in sender. It waits for confirmation once it is booked."
      />
      <FormPage>
        {booked === undefined ? (
          <BookingForm key={form} onBooked={setBooked} />
        ) : (
          <Booked
            request={booked}
            onAnother={() => {
              setBooked(undefined);
              setForm((count) => count + 1);
            }}
          />
        )}
      </FormPage>
    </>
  );
}
