import type { components, operations } from '@melarc/api-client';

import {
  calendarDateOf,
  OPERATIONAL_CODE,
  parseLocation,
  type LocationView,
} from '../pickup/pickup-shape';
import { instantOf, isOneOf, isRecord, lineOf, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the manifest screens (S1.25) believe of an answer, judged field by field before anything is drawn, as the pickup, rider and identity
 * screens' are (`pickup-shape.ts`, `rider-shape.ts`, `staff-shape.ts`). The types are the contract's, narrowed to the fields a screen reads; a
 * field the contract adds and this does not read goes nowhere, and an answer that is not the API's (a proxy's page, another version's list) is
 * refused whole rather than shown in part. `test/manifest-contract.test.ts` holds every list below to the contract.
 *
 * **What a stop's summary does not carry here:** the rider's contact number (`contact_phone`) is read by the rider's run screen and by nobody
 * else; the Ops screens name a pickup by its reference, sender and place, and the request's own page holds the contact.
 * **A custody handover carries no note and no count the hub is given**: `parcel_count_taken` is a record of what a receiver took, judged here
 * as that and drawn as that, never as a count of the hub's.
 */
type ManifestBody = components['schemas']['PickupManifest'];
type StopBody = components['schemas']['PickupStop'];
type HandoverBody = components['schemas']['RunCustodyHandover'];

export type ManifestState = ManifestBody['state'];
export type StopState = StopBody['state'];
export type HandoverState = HandoverBody['state'];
export type FailureCategory = NonNullable<StopBody['failure_category']>;

export const MANIFEST_STATES = [
  'DRAFT',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * The states the list can be narrowed to: the generated type of the operation's own `state` parameter (OB-S1-25), not a type written here. A
 * type has no values to offer in a menu, so `MANIFEST_FILTER_STATES` is the list of them, and the two lines after it make it the generated
 * type's values and no others at compile time (a state the contract adds, or one this list holds that it lacks, is a type error), as
 * `test/manifest-contract.test.ts` holds it to the contract's enumeration at run time.
 */
export type ManifestFilterState = NonNullable<
  NonNullable<operations['listPickupManifests']['parameters']['query']>['state']
>;
export const MANIFEST_FILTER_STATES: readonly ManifestFilterState[] = MANIFEST_STATES;
type MissingFilterState = Exclude<ManifestFilterState, (typeof MANIFEST_STATES)[number]>;
/** Compile-time only: it is `true` while every state the contract can filter by is in the list, and a type error the day one is not. */
export const EVERY_FILTER_STATE_IS_LISTED: [MissingFilterState] extends [never] ? true : never =
  true;
export const STOP_STATES = [
  'PENDING',
  'ARRIVED',
  'COLLECTED',
  'PARTIALLY_COLLECTED',
  'FAILED',
  'SKIPPED',
] as const;
export const FAILURE_CATEGORIES = [
  'VENDOR_UNAVAILABLE',
  'ACCESS_DENIED',
  'PARCEL_NOT_READY',
  'REFUSED_COLLECTION',
] as const;
export const HANDOVER_STATES = ['PENDING', 'COMPLETED', 'FAILED'] as const;

/**
 * The reasons a stop is skipped by the system and not by an officer: its request was cancelled, or its manifest was. They are the contract's
 * (`PickupStop.skipped`), carry no note, and are not codes of the `PICKUP_STOP_SKIP` catalogue.
 */
export const SYSTEM_SKIP_REASONS = ['REQUEST_CANCELLED', 'MANIFEST_CANCELLED'] as const;
export type SystemSkipReason = (typeof SYSTEM_SKIP_REASONS)[number];

/** What a rider is shown of a pickup, as far as Ops draws it: which pickup, whose, how many as declared, and the place. No contact. */
export interface StopSummaryView {
  readonly reference: string;
  readonly sender_display_name: string;
  readonly declared_package_count: number;
  readonly resolved_pickup_location: LocationView;
}

/** A skip as the stop records it. The `note` is an officer's own text and staff's alone (the contract: shown to staff only). */
export interface SkipView {
  readonly reason_code: string;
  readonly note?: string;
  readonly skipped_at: string;
}

export interface StopView {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly sequence: number;
  readonly state: StopState;
  readonly arrived_at?: string;
  readonly failure_category?: FailureCategory;
  readonly skipped?: SkipView;
  readonly pickup_summary?: StopSummaryView;
}

export interface ManifestView {
  readonly id: string;
  readonly code: string;
  readonly state: ManifestState;
  readonly service_date: string;
  readonly responsible_hub_id: string;
  readonly assigned_rider_id?: string;
  readonly assigned_at?: string;
  readonly dispatched_at?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  /** The moment the run was made (contract 5.100.0): always there, read and held here, and drawn by no screen yet. */
  readonly created_at: string;
  /** In their sequence. A list of manifests carries none (`getPickupManifest` does), and then this is absent. */
  readonly stops?: readonly StopView[];
}

export interface ManifestPageView {
  readonly items: readonly ManifestView[];
  readonly nextPageToken: string | null;
}

/**
 * A custody handover as the Ops side reads it: where custody is going, where it stands and, once the receiver took it, what they say they
 * took. It carries no note (the contract: a rider party to a handover is not shown Ops's text, and Ops's own note lives in the audit trail).
 */
export interface HandoverView {
  readonly id: string;
  readonly manifest_id: string;
  readonly from_rider_id: string;
  /** Exactly one of the two destinations is set. */
  readonly to_rider_id?: string;
  readonly to_hub_id?: string;
  readonly state: HandoverState;
  /** A custody record of what the receiver took, set exactly when the handover is `COMPLETED`; never the hub's count. */
  readonly parcel_count_taken?: number;
  readonly initiated_at: string;
  readonly resolved_at?: string;
}

export interface HandoverPageView {
  readonly items: readonly HandoverView[];
  readonly nextPageToken: string | null;
}

/** The fields each guard reads, held to the contract by `test/manifest-contract.test.ts`. */
export const MANIFEST_FIELDS = {
  PickupManifest: {
    required: ['id', 'code', 'state', 'service_date', 'responsible_hub_id', 'created_at'],
    optional: [
      'assigned_rider_id',
      'assigned_at',
      'dispatched_at',
      'started_at',
      'stops',
      'completed_at',
    ],
    enums: { state: MANIFEST_STATES },
  },
  PickupStop: {
    required: ['id', 'pickup_manifest_id', 'pickup_request_id', 'sequence', 'state'],
    optional: ['arrived_at', 'failure_category', 'skipped', 'pickup_summary'],
    enums: { state: STOP_STATES, failure_category: FAILURE_CATEGORIES },
  },
  PickupStopSummary: {
    required: [
      'reference',
      'sender_display_name',
      'declared_package_count',
      'resolved_pickup_location',
      'location_note',
      'contact_phone',
    ],
    optional: [],
    enums: {},
  },
  RunCustodyHandover: {
    required: [
      'id',
      'manifest_id',
      'from_rider_id',
      'to_rider_id',
      'to_hub_id',
      'state',
      'parcel_count_taken',
      'initiated_at',
      'resolved_at',
    ],
    optional: [],
    enums: { state: HANDOVER_STATES },
  },
} as const;

/** A manifest holds at most 64 stops (`PickupManifestCreate.pickup_request_ids`). */
export const MAX_STOPS = 64;
/** The most a page of either list can hold (the contract's largest `page_size`). */
const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;
const MAX_CODE_LENGTH = 64;
const REASON_CODE = /^[A-Za-z0-9_.-]+$/;
/** The longest note the audit ledger keeps: one line. */
const MAX_NOTE = 1000;
/** The most a receiver can say they took: far beyond a run's 64 pickups of however many packages, and bounded so a figure is a figure. */
const MAX_PARCELS_TAKEN = 1_000_000;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** A note an officer wrote: not blank, one line, within the ledger's bound. */
function noteOf(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_NOTE &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

const wholeAtLeast = (value: unknown, least: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least ? value : undefined;

function parseSummary(body: unknown): StopSummaryView | undefined {
  if (!isRecord(body)) return undefined;
  const reference = typeof body.reference === 'string' ? body.reference : undefined;
  const sender = lineOf(body.sender_display_name);
  const packages = wholeAtLeast(body.declared_package_count, 0);
  const place = parseLocation(body.resolved_pickup_location);
  if (
    reference === undefined ||
    !OPERATIONAL_CODE.test(reference) ||
    sender === undefined ||
    packages === undefined ||
    place === undefined
  ) {
    return undefined;
  }
  return {
    reference,
    sender_display_name: sender,
    declared_package_count: packages,
    resolved_pickup_location: place,
  };
}

function parseSkip(body: unknown): SkipView | undefined {
  if (!isRecord(body)) return undefined;
  const code = body.reason_code;
  const at = instantOf(body.skipped_at);
  const note = optional(body.note, noteOf);
  if (
    typeof code !== 'string' ||
    code.length === 0 ||
    code.length > MAX_CODE_LENGTH ||
    !REASON_CODE.test(code) ||
    at === undefined ||
    note === undefined
  ) {
    return undefined;
  }
  return { reason_code: code, skipped_at: at, ...(note === null ? {} : { note }) };
}

/** One stop, or nothing when it is not one the screens may show. */
export function parseStop(body: unknown): StopView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const manifest = uuidOf(body.pickup_manifest_id);
  const request = uuidOf(body.pickup_request_id);
  const sequence = wholeAtLeast(body.sequence, 1);
  const arrived = optional(body.arrived_at, instantOf);
  const category = optional(body.failure_category, (value) =>
    isOneOf(FAILURE_CATEGORIES, value) ? value : undefined,
  );
  const skipped = optional(body.skipped, parseSkip);
  const summary = optional(body.pickup_summary, parseSummary);
  if (
    id === undefined ||
    manifest === undefined ||
    request === undefined ||
    sequence === undefined ||
    !isOneOf(STOP_STATES, body.state) ||
    arrived === undefined ||
    category === undefined ||
    skipped === undefined ||
    summary === undefined
  ) {
    return undefined;
  }
  // A skip is recorded exactly when the stop is skipped: a stop that says one thing and records the other is not one the API sent.
  if ((body.state === 'SKIPPED') !== (skipped !== null)) return undefined;
  return {
    id,
    pickup_manifest_id: manifest,
    pickup_request_id: request,
    sequence,
    state: body.state,
    ...(arrived === null ? {} : { arrived_at: arrived }),
    ...(category === null ? {} : { failure_category: category }),
    ...(skipped === null ? {} : { skipped }),
    ...(summary === null ? {} : { pickup_summary: summary }),
  };
}

/**
 * One manifest, or nothing when it is not one the screens may show. With `stops: 'required'` (the record `getPickupManifest` and the acts on it
 * answer with) the stops must be there, in a list that is sound: every stop is this manifest's, none is repeated, and no two share a place.
 * With `'optional'` (a list of manifests, which carries none) they may be absent, and are judged the same when they are there.
 */
export function parseManifest(
  body: unknown,
  stops: 'required' | 'optional' = 'optional',
): ManifestView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const hub = uuidOf(body.responsible_hub_id);
  const date = calendarDateOf(body.service_date);
  const rider = optional(body.assigned_rider_id, uuidOf);
  const assignedAt = optional(body.assigned_at, instantOf);
  const dispatchedAt = optional(body.dispatched_at, instantOf);
  const startedAt = optional(body.started_at, instantOf);
  const completedAt = optional(body.completed_at, instantOf);
  const createdAt = instantOf(body.created_at);
  if (
    id === undefined ||
    hub === undefined ||
    date === undefined ||
    typeof body.code !== 'string' ||
    !OPERATIONAL_CODE.test(body.code) ||
    !isOneOf(MANIFEST_STATES, body.state) ||
    rider === undefined ||
    assignedAt === undefined ||
    dispatchedAt === undefined ||
    startedAt === undefined ||
    completedAt === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  let parsedStops: StopView[] | undefined;
  if (body.stops === undefined || body.stops === null) {
    if (stops === 'required') return undefined;
  } else {
    if (!Array.isArray(body.stops) || body.stops.length > MAX_STOPS) return undefined;
    const list = body.stops.map(parseStop);
    if (list.some((stop) => stop === undefined)) return undefined;
    parsedStops = (list as StopView[]).toSorted((a, b) => a.sequence - b.sequence);
    const seenIds = new Set<string>();
    const seenPlaces = new Set<number>();
    for (const stop of parsedStops) {
      if (
        stop.pickup_manifest_id.toLowerCase() !== id.toLowerCase() ||
        seenIds.has(stop.id.toLowerCase()) ||
        seenPlaces.has(stop.sequence)
      ) {
        return undefined;
      }
      seenIds.add(stop.id.toLowerCase());
      seenPlaces.add(stop.sequence);
    }
  }

  return {
    id,
    code: body.code,
    state: body.state,
    service_date: date,
    responsible_hub_id: hub,
    ...(rider === null ? {} : { assigned_rider_id: rider }),
    ...(assignedAt === null ? {} : { assigned_at: assignedAt }),
    ...(dispatchedAt === null ? {} : { dispatched_at: dispatchedAt }),
    ...(startedAt === null ? {} : { started_at: startedAt }),
    ...(completedAt === null ? {} : { completed_at: completedAt }),
    created_at: createdAt,
    ...(parsedStops === undefined ? {} : { stops: parsedStops }),
  };
}

function pageOf<Item>(
  body: unknown,
  parse: (entry: unknown) => Item | undefined,
  keyOf: (item: Item) => string,
): { items: Item[]; nextPageToken: string | null } | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parse(entry);
    if (item === undefined || seen.has(keyOf(item).toLowerCase())) return undefined;
    seen.add(keyOf(item).toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}

/** A page of `listPickupManifests`. One entry that is not a manifest makes the whole page unusable, and a manifest listed twice is not the API's. */
export function parseManifestPage(body: unknown): ManifestPageView | undefined {
  return pageOf(
    body,
    (entry) => parseManifest(entry, 'optional'),
    (item) => item.id,
  );
}

/** One custody handover, or nothing when it is not one the screens may show. */
export function parseHandover(body: unknown): HandoverView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const manifest = uuidOf(body.manifest_id);
  const from = uuidOf(body.from_rider_id);
  const toRider = optional(body.to_rider_id, uuidOf);
  const toHub = optional(body.to_hub_id, uuidOf);
  const initiated = instantOf(body.initiated_at);
  const resolved = optional(body.resolved_at, instantOf);
  const taken = optional(body.parcel_count_taken, (value) => {
    const count = wholeAtLeast(value, 0);
    return count !== undefined && count <= MAX_PARCELS_TAKEN ? count : undefined;
  });
  if (
    id === undefined ||
    manifest === undefined ||
    from === undefined ||
    toRider === undefined ||
    toHub === undefined ||
    initiated === undefined ||
    resolved === undefined ||
    taken === undefined ||
    !isOneOf(HANDOVER_STATES, body.state)
  ) {
    return undefined;
  }
  // Custody goes to a rider or to the hub, one of the two (`RunCustodyHandoverCreate`); a record that names both or neither is not the API's.
  if ((toRider === null) === (toHub === null)) return undefined;
  // What the contract states of the two moments and the count: the count and the resolution are set exactly when they should be.
  if ((body.state === 'COMPLETED') !== (taken !== null)) return undefined;
  if ((body.state === 'PENDING') !== (resolved === null)) return undefined;
  return {
    id,
    manifest_id: manifest,
    from_rider_id: from,
    ...(toRider === null ? {} : { to_rider_id: toRider }),
    ...(toHub === null ? {} : { to_hub_id: toHub }),
    state: body.state,
    ...(taken === null ? {} : { parcel_count_taken: taken }),
    initiated_at: initiated,
    ...(resolved === null ? {} : { resolved_at: resolved }),
  };
}

/** A page of `listRunCustodyHandovers`. */
export function parseHandoverPage(body: unknown): HandoverPageView | undefined {
  return pageOf(body, parseHandover, (item) => item.id);
}
