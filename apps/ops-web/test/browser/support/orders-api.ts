import { createHash, randomUUID } from 'node:crypto';

import type { BrowserContext, Page, Route } from '@playwright/test';

import { INTAKE_HUB_ID, preCountFixture } from '../../../src/test-support/hub-intake-fixture';
import { MANIFEST_ID } from '../../../src/test-support/manifest-fixture';
import {
  captured,
  closureOf,
  correctionOf,
  orderOf,
  PARCELS,
  parcelRow,
  termsOf,
  VENDOR_ID,
  worklistOf,
} from '../../../src/test-support/orders-fixture';
import {
  blindVendorFixture,
  checkInFixture,
  runFixture,
} from '../../../src/test-support/receiving-fixture';
import { freezeClock } from './clock';
import { answerQueueSummary } from './queue-summary';
import { PICTURE } from './receiving-api';

/**
 * What the browser tests of the order screens (S1.40) put in place of the API: a small **stateful** stand-in for the operations the screens use, built from the answers the real API gave (`test/fixtures/orders`) so that
 * a shape cannot drift from the contract. It keeps what the API keeps: the vendor's version moves when its state does and not with each order (a save on an older read is refused as `stale`), the price is the stand-in's server's and is
 * never the page's (a save is on the digest of the terms that were read, and a price that changed meanwhile answers the terms as they are now), a key makes an order once and is refused with another body (`IDEMPOTENCY_KEY_CONFLICT`), a change of
 * who pays is a request that a checker other than the officer who asked decides (`SELF_APPROVAL_FORBIDDEN`), the recipient of a confirmed order is corrected with a reason, and a vendor is closed on the assessment
 * the officer read. Who pays adds up to the price in every answer, and the digest of a price covers every term it was worked out from, not the size and the price alone. Every request is recorded as the browser sent it (method, path, query, `If-Match`, `Idempotency-Key`, body), and any other request to
 * `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`.
 *
 * Everything in the answers is synthetic and says so.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  /** Another officer, who decides what `me` asked: nobody decides what they asked themselves. */
  checker: 'c4a5b6d7-e8f9-4a0b-8c1d-2e3f4a5b6c7d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: INTAKE_HUB_ID,
  vendor: VENDOR_ID,
} as const;

/** The identifier of the vendor's nth parcel (1 to 3): what the address of the form names. */
export const parcelIdOf = (ordinal: number): string => PARCELS[ordinal - 1]?.id ?? '';

/** The record of the photo of the vendor's nth parcel, of any place of a long vendor: what the link of its picture is asked for. */
export const photoIdOf = (ordinal: number): string =>
  parcelRow(ordinal, 'NEEDS_ORDER').parcel.door_photo_evidence_id;

export type Size = 'SMALL' | 'MEDIUM' | 'LARGE';

export interface StoredOrder {
  readonly id: string;
  readonly code: string;
  /** Which of the vendor's three parcels the order is for (1 to 3). */
  readonly parcel: number;
  size: Size;
  name: string;
  phone: string;
  address: string;
  price: number;
  /** An early quote is changed here; a fixed price is not. */
  status: 'EARLY_QUOTE' | 'FROZEN';
  /** An order of a vendor counted without photos is for no parcel: it names none, and is told by its code. */
  readonly parcelless?: boolean;
  version: number;
  amendments: {
    id: string;
    note: string;
    changed: string[];
    at: string;
    kind?: 'AMENDMENT' | 'RECIPIENT_CORRECTION';
  }[];
  /** How who pays was set by a decided change, or `undefined` for as booked. */
  sender: number | undefined;
}

export interface StoredCorrection {
  readonly id: string;
  readonly orderId: string;
  state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly intent: string;
  readonly note: string;
  version: number;
  /** Who asked: `IDS.me` unless the world says another officer did. */
  readonly requestedBy?: string;
  decidedBy?: string;
}

export interface World {
  permissions: string[];
  /** Who is signed in: the officer, or another one (the checker of what the officer asked). */
  principal: string;
  /** How the vendor was checked in: against door photos (the default), or counted without photos (D-S7-3), whose orders are for no parcel and whose parcels are only a count. */
  mode: 'PHOTO_CHECK_IN' | 'BLIND_COUNT';
  /** How many parcels the vendor arrived with: three, unless a test works a longer list a page at a time. For a vendor counted without photos it is the committed count. */
  parcelCount: number;
  /** Why the vendor waits for a senior officer (D-S7-7, narrowed by D-S7-11), or none: only an arrival a senior took back. The list of vendors that wait for one holds the vendor only when the world says so, and says why, as the API's does; a vendor whose parcels still need an order is the officer's and is never listed there. */
  seniorNeeded: 'ARRIVAL_TAKEN_BACK' | null;
  /** The parcels the officer is waiting on the vendor's details for (D-S7-12), by the parcel's place: when it was marked and the note. The server holds it, and an order for the parcel ends it. */
  waiting: Map<number, { since: string; note: string | null }>;
  /** The parcel another officer makes the order for between the price check and the save of this one: its place. The save then finds the parcel ordered and is refused as the API refuses it, and the order is there. */
  takenAtSave: number | undefined;
  /** The next price checks (of an order and of a change) answer a fault instead of a price: a lost connection, a fault of the server, or a 429 with the wait it asks for. Each check that meets it uses one of its `times`. */
  previewFault:
    | { kind: 'network' | 'server' | 'rate-limit'; times: number; retryAfterSeconds: number }
    | undefined;
  vendorState: 'READY_FOR_ITEMIZATION' | 'ITEMIZING' | 'CLOSED';
  orders: StoredOrder[];
  corrections: StoredCorrection[];
  /** What the stand-in's server charges for each size, in pesewas. The page never works one out. */
  prices: Record<Size, number>;
  /** The next save finds the price of its size changed to this figure, once: the terms the officer read are then no longer the terms. */
  repriceOnce: number | undefined;
  /** How long the stand-in's server takes to work a price out, in milliseconds: none by default. A test that taps while a price is being checked asks for a slow one. */
  previewDelayMs: number;
  /** How long the stand-in's server takes to give the link of a photo, in milliseconds: none by default. A test that counts how many links are asked for at once asks for a slow one, so that the ones in flight overlap. */
  linkDelayMs: number;
  /** The next links of photos answer a 429 with the wait it asks for instead of a link, each using one of its `times`: the API's limit told to a page that draws many photos. */
  linkFault: { times: number; retryAfterSeconds: number } | undefined;
  /** Saves made under a key already seen are answered as the first was and make nothing, and a key seen with another body is refused. */
  keys: Map<
    string,
    { status: number; body: unknown; etag: string | undefined; fingerprint: string }
  >;
}

const SIZES: readonly Size[] = ['SMALL', 'MEDIUM', 'LARGE'];

/** A confirmed order for a parcel (its price is fixed). */
export function storedOrder(parcel: number, over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: `a0${String(parcel)}00000-0000-4000-8000-00000000000${String(parcel)}`,
    code: `ACC-OR-${['2CD3FG', '4HJ5KM', '6NP7QR'][parcel - 1] ?? '8STVWX'}`,
    parcel,
    size: 'SMALL',
    name: 'Ama Mensah',
    phone: '+233241234567',
    address: '12 Madina Estate, near the market',
    price: 3500,
    status: 'FROZEN',
    version: 1,
    amendments: [],
    sender: undefined,
    ...over,
  };
}

export function world(over: Partial<World> = {}): World {
  return {
    principal: IDS.me,
    mode: 'PHOTO_CHECK_IN',
    parcelCount: 3,
    seniorNeeded: null,
    waiting: new Map(),
    takenAtSave: undefined,
    previewFault: undefined,
    permissions: [
      'hub.read',
      'hub.intake.itemize',
      'hub.intake.close',
      'pricing.read',
      'pickup.read',
    ],
    // The vendor arrived with three parcels, was checked in, and is cleared for its orders: none is made yet.
    vendorState: 'READY_FOR_ITEMIZATION',
    orders: [],
    corrections: [],
    prices: { SMALL: 3500, MEDIUM: 4000, LARGE: 5000 },
    repriceOnce: undefined,
    previewDelayMs: 0,
    linkDelayMs: 0,
    linkFault: undefined,
    keys: new Map(),
    ...over,
  };
}

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

export interface OrdersApi {
  readonly world: World;
  readonly calls: Call[];
  readonly unexpected: string[];
  /** The pictures the browser fetched from the store. */
  readonly images: string[];
  /**
   * The links of photos the browser asked for: the ones not yet answered, the most that were ever asked for at once, the photo of each in the order they were asked for, the moment each was asked for
   * (`performance.now()` of the test's own process, in milliseconds), and the moment the first refusal was answered, if one was (`linkFault`).
   */
  readonly links: {
    current: number;
    peak: number;
    readonly asked: string[];
    readonly at: number[];
    refusedAt: number | undefined;
  };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const pause = (milliseconds: number): Promise<void> =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
/**
 * The terms of an order beyond its size, its price and its parcel that a price is worked out from: where it goes and how, the declared value, what is high value, the carrier's charge, the date asked for, who pays and
 * the zone an officer chose. The stand-in works none of them out, and keeps every one: a change of any is another digest.
 */
const TERM_MEMBERS = [
  'lane',
  'commercial_mode',
  'is_high_value',
  'declared_value_minor',
  'is_serialized_goods',
  'serial_imei',
  'carrier_cost',
  'carrier_waybill_evidence_id',
  'requested_delivery_date',
  'payer_override',
  'destination_zone_authorization',
  'evidence_ids',
] as const;
const termsOfBody = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    TERM_MEMBERS.filter((member) => body[member] !== undefined).map((member) => [
      member,
      body[member],
    ]),
  );
/** The digest of the terms a preview worked out: the same facts at the same price give the same digest, and any other fact or price another. */
const tokenOf = (
  size: Size,
  price: number,
  parcel: string | undefined,
  terms: Record<string, unknown> = {},
): string => sha(`${size}|${String(price)}|${parcel ?? ''}|${JSON.stringify(terms)}`);

const error = (status: number, code: string, details?: unknown) => ({
  status,
  headers: JSON_HEADERS,
  json: {
    code,
    message: 'Diagnostic text that must never reach a screen.',
    request_id: 'req-browser-s140',
    ...(details === undefined ? {} : { details }),
  },
});
const ok = (json: unknown, status = 200, etag?: string) => ({
  status,
  headers: { ...JSON_HEADERS, ...(etag === undefined ? {} : { etag }) },
  json,
});

const money = (amount: number) => ({ amount_minor: amount, currency: 'GHS' });
const parcelOf = (ordinal: number) => PARCELS[ordinal - 1];
const orderForParcel = (w: World, ordinal: number) =>
  w.orders.find((each) => each.parcel === ordinal);
const orderById = (w: World, id: string) => w.orders.find((each) => each.id === id);

/**
 * The vendor's version. **It moves when the vendor's state does and not with each order**, as the API's does (`melarc.itemize_order` writes the intake only to move it from ready to being worked, with the first order),
 * so a save on a read from before the first order is refused as stale, and the second order is made on a read taken after it.
 */
const vendorEtag = (w: World): string =>
  `"v${String(w.vendorState === 'READY_FOR_ITEMIZATION' ? 1 : w.vendorState === 'ITEMIZING' ? 2 : 3)}"`;

function vendorWire(w: World) {
  if (w.mode === 'BLIND_COUNT') {
    // A vendor counted without photos: the count the hub committed is the whole of what it knows of the parcels (the intake as the blind-count screens judge it).
    return {
      ...preCountFixture({ id: VENDOR_ID }),
      state: w.vendorState,
      count_phase: 'POST_COUNT',
      rider_declared_count: w.parcelCount,
      physical_count: w.parcelCount,
      count_variance: 'MATCH',
      count_difference: 0,
      condition: 'OK',
      condition_findings: [],
      parcel_photo_ids: [],
      // The API names the vendor now (Run G1, Part 1 item 4): from the stop's dispatch snapshot.
      vendor_name: 'Fixture Sender',
    };
  }
  return checkInFixture(PARCELS, {
    id: VENDOR_ID,
    state: w.vendorState,
    // The dates are the world's: the page says how long ago the vendor was handed over.
    handed_over_at: '2026-11-03T07:40:00Z',
    counted_at: '2026-11-03T07:55:00Z',
  });
}

/** An order as `getOrder` answers it. */
function orderWire(order: StoredOrder): Record<string, unknown> {
  const base = orderOf(order.status === 'FROZEN' ? 'frozen' : 'early');
  const frozen = order.status === 'FROZEN';
  const recipient = base.recipient as Record<string, unknown>;
  const sender = order.sender ?? 0;
  return {
    ...base,
    id: order.id,
    code: order.code,
    pickup_intake_id: VENDOR_ID,
    intake_parcel_id: order.parcelless === true ? null : (parcelOf(order.parcel)?.id ?? null),
    intake_parcel_state: order.parcelless === true ? null : 'ARRIVED',
    // The picture of the parcel the order is made for (Run G1, D-S7-14): null for a vendor counted without photos.
    intake_parcel_photo_evidence_id:
      order.parcelless === true ? null : (parcelOf(order.parcel)?.photo_evidence_id ?? null),
    size_class: order.size,
    locked_price: frozen ? money(order.price) : null,
    price_status: order.status,
    commercial_state: frozen ? (sender > 0 ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE') : null,
    price_components_snapshot: {
      currency: 'GHS',
      components: [
        {
          kind: 'SERVICE_AREA_BASE_FEE',
          hub_id: IDS.hub,
          scope_ref: 'ACCRA_TEMA',
          setting_key: 'service_area_base_fee',
          amount_minor: order.price,
          effective_version: 1,
        },
      ],
      total_minor: order.price,
    },
    recipient: {
      ...recipient,
      name: order.name,
      phone: order.phone,
      location: { address: order.address },
    },
    payer_allocation: frozen
      ? { sender_minor: sender, recipient_minor: order.price - sender }
      : null,
    amendments: order.amendments.map((each) => ({
      id: each.id,
      amended_by: IDS.me,
      amended_at: each.at,
      note: each.note,
      changed: each.changed,
      kind: each.kind ?? 'AMENDMENT',
    })),
    reversal: null,
  };
}

function rowOf(w: World, ordinal: number) {
  const order = orderForParcel(w, ordinal);
  const mark = w.waiting.get(ordinal);
  if (order === undefined) {
    return parcelRow(ordinal, 'NEEDS_ORDER', mark === undefined ? {} : { waiting: mark });
  }
  return parcelRow(ordinal, order.status === 'FROZEN' ? 'ITEMIZED' : 'PREPARED', {
    order: {
      id: order.id,
      code: order.code,
      recipient_name: order.name,
      service_area: 'ACCRA_TEMA',
      size_class: order.size,
      commercial_state:
        order.status === 'FROZEN' ? (order.sender ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE') : null,
      confirmed: order.status === 'FROZEN',
      payment_required: (order.sender ?? 0) > 0,
    },
  });
}

/** The most rows a page of the worklist holds when the browser does not say: the API's own default, twenty-five (a long vendor is worked a page at a time). */
const PAGE_SIZE = 25;

/**
 * The worklist of a vendor counted without photos: its rows are its orders (it has no parcel to list), the work still to do is a number (the count less the orders, which opens no rows), and the view of the
 * vendor's orders that the saved screen reads to the end is a hundred to a page, oldest first.
 */
function blindWorklistWire(w: World, view: string | null, pageSize: number, offset: number) {
  const rows = w.orders.map((order) => ({
    work_state: order.status === 'FROZEN' ? 'ITEMIZED' : 'PREPARED',
    parcel: null,
    reversed_order: null,
    order: {
      id: order.id,
      code: order.code,
      recipient_name: order.name,
      service_area: 'ACCRA_TEMA',
      size_class: order.size,
      commercial_state:
        order.status === 'FROZEN' ? (order.sender ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE') : null,
      confirmed: order.status === 'FROZEN',
      payment_required: (order.sender ?? 0) > 0,
    },
  }));
  const wanted = rows.filter((row) =>
    view === 'needs_order' ? false : view === 'itemized' ? row.work_state === 'ITEMIZED' : true,
  );
  const items = wanted.slice(offset, offset + pageSize);
  const next = offset + pageSize < wanted.length ? String(offset + pageSize) : null;
  return worklistOf(
    items,
    {
      received: w.parcelCount,
      needs_order: Math.max(0, w.parcelCount - w.orders.length),
      itemized: w.orders.filter((each) => each.status === 'FROZEN').length,
      prepared: w.orders.filter((each) => each.status !== 'FROZEN').length,
      orders: w.orders.length,
      payment_required: w.orders.filter((each) => (each.sender ?? 0) > 0).length,
    },
    { intake_state: w.vendorState, receiving_mode: 'BLIND_COUNT', next_page_token: next },
  );
}

function worklistWire(w: World, view: string | null, pageSize: number, offset: number) {
  if (w.mode === 'BLIND_COUNT') return blindWorklistWire(w, view, pageSize, offset);
  const rows = Array.from({ length: w.parcelCount }, (_, index) => rowOf(w, index + 1));
  const needs = rows.filter((row) => row.work_state === 'NEEDS_ORDER').length;
  const made = w.orders.length;
  const wanted = rows.filter((row) =>
    view === 'needs_order'
      ? row.work_state === 'NEEDS_ORDER'
      : view === 'itemized'
        ? row.work_state === 'ITEMIZED'
        : view === 'waiting_for_vendor'
          ? row.parcel.waiting_for_vendor !== null
          : true,
  );
  // A page at a time, from the place the token names: the token of the next page is where it begins, and there is none after the last.
  const items = wanted.slice(offset, offset + pageSize);
  const next = offset + pageSize < wanted.length ? String(offset + pageSize) : null;
  return worklistOf(
    items,
    {
      received: w.parcelCount,
      needs_order: needs,
      itemized: w.orders.filter((each) => each.status === 'FROZEN').length,
      prepared: w.orders.filter((each) => each.status !== 'FROZEN').length,
      orders: made,
      payment_required: w.orders.filter((each) => (each.sender ?? 0) > 0).length,
      waiting_for_vendor: w.waiting.size,
    },
    { intake_state: w.vendorState, next_page_token: next },
  );
}

/** The most outstanding parcels the closure names: the API's own limit, a hundred, with the number of all of them beside the list. */
const OUTSTANDING_LIMIT = 100;

function closureWire(w: World): Record<string, unknown> {
  const needs = w.parcelCount - w.orders.length;
  const outstanding = Array.from({ length: w.parcelCount }, (_, index) => index + 1)
    .filter((ordinal) => orderForParcel(w, ordinal) === undefined)
    .slice(0, OUTSTANDING_LIMIT)
    .map((ordinal) => {
      const { parcel } = parcelRow(ordinal, 'NEEDS_ORDER');
      return {
        origin: 'DOOR_PHOTO',
        ordinal,
        parcel_id: parcel.id,
        hub_photo_evidence_id: null,
        door_photo_evidence_id: parcel.door_photo_evidence_id,
      };
    });
  return closureOf('ready', {
    intake_state: w.vendorState,
    received: w.parcelCount,
    ordered: w.orders.length,
    payment_required: w.orders.filter((each) => (each.sender ?? 0) > 0).length,
    outstanding_count: needs,
    outstanding_parcels: outstanding,
    can_close: needs === 0 && w.vendorState === 'ITEMIZING',
    needs_exception: needs > 0,
    blockers: [],
    assessment_token: sha(`closure|${String(w.orders.length)}|${w.vendorState}`),
    payment_still_required: w.orders.some((each) => (each.sender ?? 0) > 0),
    closed_at: w.vendorState === 'CLOSED' ? '2026-11-03T08:25:00.000Z' : null,
  });
}

function correctionWire(w: World, stored: StoredCorrection) {
  const order = orderById(w, stored.orderId);
  const price = order?.price ?? 3500;
  const before = order?.sender ?? 0;
  const decided = stored.state !== 'REQUESTED';
  const sender = stored.intent === 'SENDER_PAYS_FULL' ? price : 0;
  return correctionOf({
    id: stored.id,
    order_id: stored.orderId,
    order_code: order?.code ?? null,
    state: stored.state,
    proposed: { payer_intent: stored.intent },
    previous_allocation: {
      sender_minor: decided ? 0 : before,
      recipient_minor: price - (decided ? 0 : before),
    },
    proposed_allocation: { sender_minor: sender, recipient_minor: price - sender },
    proposed_commercial_state: sender > 0 ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE',
    resulting_allocation:
      stored.state === 'APPROVED'
        ? { sender_minor: sender, recipient_minor: price - sender }
        : null,
    resulting_commercial_state:
      stored.state === 'APPROVED' ? (sender > 0 ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE') : null,
    note: stored.note,
    total: money(price),
    created_at: '2026-11-03T08:10:00.000Z',
    decided_at: decided ? '2026-11-03T08:20:00.000Z' : null,
    approved_by: decided ? (stored.decidedBy ?? IDS.checker) : null,
    approved_by_name: decided ? 'Synthetic Checker' : null,
    requested_by: stored.requestedBy ?? IDS.me,
    requested_by_name:
      (stored.requestedBy ?? IDS.me) === IDS.me ? 'Synthetic Officer' : 'Synthetic Checker',
    order_commercial_state:
      sender > 0 && stored.state === 'APPROVED' ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE',
  });
}

/** The stand-in server's zones: an address that names nowhere matches no zone of the hub (D-S7-5), and the officer then chooses one of the hub's and says why. */
const UNMATCHED_ADDRESS = /nowhere/i;
const addressOf = (body: Record<string, unknown>): string | undefined => {
  const address = asRecordOf(asRecordOf(body.recipient).location).address;
  return typeof address === 'string' ? address : undefined;
};
function asRecordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
/** The refusal of an address no zone matches, as the API words it, unless the officer already chose a zone for it. */
const unresolved = (body: Record<string, unknown>) => {
  const address = addressOf(body);
  return address !== undefined &&
    UNMATCHED_ADDRESS.test(address) &&
    body.destination_zone_authorization === undefined
    ? error(422, 'SETTING_MISSING', { rule: 'destination_zone_unresolved' })
    : undefined;
};
/** What a zone the officer chose is called in the terms: the hub's own list names it. */
const chosenZone = (body: Record<string, unknown>) => {
  const chosen = asRecordOf(body.destination_zone_authorization).zone_id;
  const zones = (captured('destination-zones') as { items: { zone_id: string; name: string }[] })
    .items;
  return zones.find((zone) => zone.zone_id === chosen);
};
/** The terms of a price when the officer chose the zone: the resolution says so, and the zone is the one chosen. */
const zoneOverrides = (body: Record<string, unknown>): Record<string, unknown> => {
  const zone = chosenZone(body);
  if (zone === undefined) return {};
  const snapshot = captured('preview').destination_zone_snapshot as Record<string, unknown>;
  return {
    destination_zone_resolution: 'EXPLICITLY_AUTHORIZED',
    destination_zone_snapshot: { ...snapshot, zone_id: zone.zone_id, zone_name: zone.name },
  };
};

const parsed = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** A price check that meets the fault the world holds is answered with it, once for each of its times: a lost connection, a fault of the server, or a 429 with the wait it asks for. */
async function faultOf(route: Route, w: World): Promise<boolean> {
  const fault = w.previewFault;
  if (fault === undefined || fault.times <= 0) return false;
  fault.times -= 1;
  if (fault.kind === 'network') {
    await route.abort('failed');
  } else if (fault.kind === 'server') {
    await route.fulfill(error(500, 'INTERNAL_ERROR'));
  } else {
    await route.fulfill({
      ...error(429, 'RATE_LIMITED'),
      headers: { ...JSON_HEADERS, 'retry-after': String(fault.retryAfterSeconds) },
    });
  }
  return true;
}

async function answer(route: Route, state: OrdersApi, call: Call): Promise<void> {
  const { world: w } = state;
  const { method, path } = call;
  const holds = (key: string): boolean => w.permissions.includes(key);
  const body = asRecord(call.body);
  const id = (pattern: RegExp): string | undefined => pattern.exec(path)?.[1];
  const needs = async (key: string): Promise<boolean> => {
    if (holds(key)) return false;
    await route.fulfill(error(403, 'PERMISSION_DENIED'));
    return true;
  };

  if (method === 'GET' && path === '/api/v1/auth/session') {
    return route.fulfill(
      ok({
        id: IDS.session,
        principal_type: 'STAFF',
        principal_id: w.principal,
        state: 'ACTIVE',
        permissions: w.permissions,
        issued_at: '2026-11-03T06:00:00.000Z',
        expires_at: '2026-11-03T16:00:00.000Z',
        last_activity_at: '2026-11-03T08:00:00.000Z',
        termination_reason: null,
        principal_display_name: 'Synthetic Officer',
        authorized_hubs: [{ id: IDS.hub, display_name: 'Accra Hub' }],
      }),
    );
  }

  // The hub's own zones, for an address that matches none (D-S7-5).
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}/destination-zones`) {
    if (await needs('hub.intake.itemize')) return;
    return route.fulfill(ok(captured('destination-zones')));
  }
  // A parcel the officer is waiting on the vendor's details for (D-S7-12): the server holds the mark, on the vendor's version, which the mark does not move; a note that holds a number is refused on the note.
  const waits = id(/^\/api\/v1\/intake-parcels\/([0-9a-f-]{36})\/waiting-for-vendor$/);
  if (method === 'PUT' && waits !== undefined) {
    if (await needs('hub.intake.itemize')) return;
    if (call.ifMatch === undefined) {
      return route.fulfill(
        error(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'header', pointer: '/If-Match', rule: 'required' }],
        }),
      );
    }
    if (call.ifMatch !== vendorEtag(w)) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    const ordinal = PARCELS.findIndex((each) => each.id === waits) + 1;
    if (ordinal === 0) return route.fulfill(error(404, 'NOT_FOUND'));
    if (orderForParcel(w, ordinal) !== undefined) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'parcel_ordered' }));
    }
    const note = typeof body.note === 'string' ? body.note : null;
    if (body.waiting === true) {
      if (note !== null && /(?:\+?\d[\s().-]?){7,}/.test(note)) {
        return route.fulfill(
          error(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'body', pointer: '/note', rule: 'phone_number' }],
          }),
        );
      }
      w.waiting.set(ordinal, { since: '2026-11-03T08:12:00.000Z', note });
      return route.fulfill(
        ok({ parcel_id: waits, waiting: true, since: '2026-11-03T08:12:00.000Z', note }),
      );
    }
    w.waiting.delete(ordinal);
    return route.fulfill(ok({ parcel_id: waits, waiting: false, since: null, note: null }));
  }

  // The vendors a hub cleared for their orders, as the list counts them: the orders made and the parcels still to order are the count of the whole vendor (D-S7-6), and the vendors that wait for a senior officer are a
  // view of the server's (D-S7-7), which holds the vendor only when the world says one is needed and says why.
  if (method === 'GET' && path === '/api/v1/hub-intakes') {
    if (await needs('hub.read')) return;
    const asked = new URLSearchParams(call.search);
    // `senior_needed` is present when a senior officer is needed, in whichever view the vendor is listed (the contract's words), and absent otherwise.
    const counted = {
      ...vendorWire(w),
      orders_made: w.orders.length,
      parcels_needing_order: Math.max(0, w.parcelCount - w.orders.length),
      ...(w.seniorNeeded === null ? {} : { senior_needed: w.seniorNeeded }),
    };
    const items =
      asked.get('view') === 'needs_senior'
        ? w.seniorNeeded === null
          ? []
          : [counted]
        : asked.get('state') === w.vendorState
          ? [counted]
          : [];
    return route.fulfill(ok({ items, next_page_token: null }));
  }
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}`) {
    if (await needs('hub.read')) return;
    return route.fulfill(ok(vendorWire(w), 200, vendorEtag(w)));
  }
  // The run the vendor came in on: the order screens of a vendor counted without photos read its section to know whose it is. A vendor with door photos is known by its own record, and no screen asks.
  if (
    method === 'GET' &&
    path === `/api/v1/receiving-runs/${MANIFEST_ID}` &&
    w.mode === 'BLIND_COUNT'
  ) {
    if (await needs('hub.read')) return;
    return route.fulfill(ok(runFixture([blindVendorFixture({ intake_id: VENDOR_ID })])));
  }
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}/orders`) {
    if (await needs('hub.read')) return;
    const asked = new URLSearchParams(call.search);
    const offset = Number(asked.get('page_token') ?? '0');
    return route.fulfill(
      ok(
        worklistWire(
          w,
          asked.get('view'),
          Number(asked.get('page_size') ?? String(PAGE_SIZE)),
          Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
        ),
      ),
    );
  }

  // The price, checked before anything is saved: the stand-in's server works it out and writes nothing.
  if (method === 'POST' && path === `/api/v1/hub-intakes/${VENDOR_ID}/orders/preview`) {
    if (await needs('hub.intake.itemize')) return;
    if (await faultOf(route, w)) return;
    const size = SIZES.find((each) => each === body.size_class);
    if (size === undefined) return route.fulfill(error(422, 'SIZE_CLASS_REQUIRED'));
    const unmatched = unresolved(body);
    if (unmatched !== undefined) return route.fulfill(unmatched);
    const parcel = typeof body.parcel_id === 'string' ? body.parcel_id : undefined;
    // A parcel that has an order is not priced for another: the preview refuses it as the save does.
    const ordinal = PARCELS.findIndex((each) => each.id === parcel) + 1;
    if (ordinal > 0 && orderForParcel(w, ordinal) !== undefined) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'parcel_ordered' }));
    }
    const price = w.prices[size];
    await pause(w.previewDelayMs);
    return route.fulfill(
      ok(
        termsOf(
          { parcel_id: body.parcel_id ?? null, ...zoneOverrides(body) },
          price,
          tokenOf(size, price, parcel, termsOfBody(body)),
        ),
      ),
    );
  }

  // The order, made on the terms that were read.
  if (method === 'POST' && path === `/api/v1/hub-intakes/${VENDOR_ID}/orders`) {
    if (await needs('hub.intake.itemize')) return;
    if (call.idempotencyKey === undefined || call.ifMatch === undefined) {
      return route.fulfill(error(428, 'PRECONDITION_REQUIRED'));
    }
    const fingerprint = sha(JSON.stringify(call.body));
    const earlier = w.keys.get(call.idempotencyKey);
    if (earlier !== undefined) {
      // The same key and the same body is the same save, answered as the first was; the same key with another body is a mistake of the client's, and nothing is made.
      return earlier.fingerprint === fingerprint
        ? route.fulfill(ok(earlier.body, earlier.status, earlier.etag))
        : route.fulfill(error(409, 'IDEMPOTENCY_KEY_CONFLICT'));
    }
    if (call.ifMatch !== vendorEtag(w)) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    const unmatched = unresolved(body);
    if (unmatched !== undefined) return route.fulfill(unmatched);
    const size = SIZES.find((each) => each === body.size_class);
    const parcelId = typeof body.parcel_id === 'string' ? body.parcel_id : undefined;
    // A vendor counted without photos makes its orders for no parcel, as many as it counted and no more: the next is the one after those made.
    const blind = w.mode === 'BLIND_COUNT';
    const ordinal = blind
      ? w.orders.length + 1
      : PARCELS.findIndex((each) => each.id === parcelId) + 1;
    if (size === undefined || ordinal === 0)
      return route.fulfill(error(422, 'SIZE_CLASS_REQUIRED'));
    // Another officer made the order for this parcel while this one was being filled in.
    if (!blind && w.takenAtSave === ordinal && orderForParcel(w, ordinal) === undefined) {
      w.orders.push(storedOrder(ordinal));
      w.waiting.delete(ordinal);
      if (w.vendorState === 'READY_FOR_ITEMIZATION') w.vendorState = 'ITEMIZING';
      w.takenAtSave = undefined;
    }
    if (blind ? w.orders.length >= w.parcelCount : orderForParcel(w, ordinal) !== undefined) {
      return route.fulfill(
        error(409, 'STATE_CONFLICT', {
          rule: blind ? 'orders_exceed_received' : 'parcel_ordered',
        }),
      );
    }
    if (w.repriceOnce !== undefined) {
      w.prices[size] = w.repriceOnce;
      w.repriceOnce = undefined;
    }
    const price = w.prices[size];
    const facts = termsOfBody(body);
    if (body.reviewed_terms !== tokenOf(size, price, parcelId, facts)) {
      return route.fulfill(
        error(409, 'STATE_CONFLICT', {
          rule: 'terms_changed',
          current_terms: termsOf(
            { parcel_id: parcelId ?? null },
            price,
            tokenOf(size, price, parcelId, facts),
          ),
        }),
      );
    }
    const recipient = asRecord(body.recipient);
    const made = storedOrder(ordinal, {
      size,
      price,
      parcelless: blind,
      name: typeof recipient.name === 'string' ? recipient.name : 'Ama Mensah',
      phone: typeof recipient.phone === 'string' ? recipient.phone : '',
      address:
        typeof asRecord(recipient.location).address === 'string'
          ? (asRecord(recipient.location).address as string)
          : '',
    });
    w.orders.push(made);
    // The server clears the mark of a parcel when its order is made (D-S7-12).
    w.waiting.delete(ordinal);
    // The first order of a vendor moves it from ready to being worked, and its version with it.
    if (w.vendorState === 'READY_FOR_ITEMIZATION') w.vendorState = 'ITEMIZING';
    const saved = { ...orderWire(made) };
    w.keys.set(call.idempotencyKey, {
      status: 201,
      body: saved,
      etag: `"o${String(made.version)}"`,
      fingerprint,
    });
    return route.fulfill(ok(saved, 201, `"o${String(made.version)}"`));
  }

  // One order.
  const orderPath = id(/^\/api\/v1\/orders\/([0-9a-f-]{36})$/);
  if (orderPath !== undefined) {
    const order = orderById(w, orderPath);
    if (order === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (method === 'GET') {
      if (await needs('pricing.read')) return;
      return route.fulfill(ok(orderWire(order), 200, `"o${String(order.version)}"`));
    }
    if (method === 'PATCH') {
      if (await needs('hub.intake.itemize')) return;
      if (call.idempotencyKey === undefined || call.ifMatch === undefined) {
        return route.fulfill(error(428, 'PRECONDITION_REQUIRED'));
      }
      const fingerprint = sha(JSON.stringify(call.body));
      const earlier = w.keys.get(call.idempotencyKey);
      if (earlier !== undefined) {
        return earlier.fingerprint === fingerprint
          ? route.fulfill(ok(earlier.body, earlier.status, earlier.etag))
          : route.fulfill(error(409, 'IDEMPOTENCY_KEY_CONFLICT'));
      }
      if (call.ifMatch !== `"o${String(order.version)}"`) {
        return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
      }
      const size = SIZES.find((each) => each === body.size_class) ?? order.size;
      const facts = termsOfBody(body);
      if (
        body.reviewed_terms !== tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id, facts)
      ) {
        return route.fulfill(
          error(409, 'STATE_CONFLICT', {
            rule: 'terms_changed',
            current_terms: termsOf(
              {},
              w.prices[size],
              tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id, facts),
            ),
          }),
        );
      }
      order.size = size;
      order.price = w.prices[size];
      order.version += 1;
      order.amendments.push({
        id: randomUUID(),
        note: typeof body.note === 'string' ? body.note : '',
        changed: Object.keys(body).filter((key) => !['note', 'reviewed_terms'].includes(key)),
        at: '2026-11-03T08:28:00.000Z',
        kind: 'AMENDMENT',
      });
      const answered = ok(orderWire(order), 200, `"o${String(order.version)}"`);
      w.keys.set(call.idempotencyKey, {
        status: 200,
        body: answered.json,
        etag: `"o${String(order.version)}"`,
        fingerprint,
      });
      return route.fulfill(answered);
    }
  }
  // The recipient of a confirmed order, corrected with a reason (D-S7-1): the price, the zone and the date never move, and the old details are kept in the history of the order.
  const correctsRecipient = id(/^\/api\/v1\/orders\/([0-9a-f-]{36})\/recipient-correction$/);
  if (method === 'POST' && correctsRecipient !== undefined) {
    if (await needs('hub.intake.itemize')) return;
    const order = orderById(w, correctsRecipient);
    if (order === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.idempotencyKey === undefined || call.ifMatch === undefined) {
      return route.fulfill(error(428, 'PRECONDITION_REQUIRED'));
    }
    const fingerprint = sha(JSON.stringify(call.body));
    const earlier = w.keys.get(call.idempotencyKey);
    if (earlier !== undefined) {
      return earlier.fingerprint === fingerprint
        ? route.fulfill(ok(earlier.body, earlier.status, earlier.etag))
        : route.fulfill(error(409, 'IDEMPOTENCY_KEY_CONFLICT'));
    }
    if (typeof body.note !== 'string' || body.note.trim() === '') {
      return route.fulfill(error(422, 'REASON_REQUIRED'));
    }
    // What the API refuses by the place it names (Run G1, Part 1 item 5 and the places of the recipient): a name left empty, a phone that is not a number, and a reason that holds a number.
    const given = asRecord(body.recipient);
    const violations: { in: string; pointer: string; rule: string }[] = [];
    if (typeof given.name === 'string' && given.name.trim() === '') {
      violations.push({ in: 'body', pointer: '/recipient/name', rule: 'required' });
    }
    if (
      typeof given.phone === 'string' &&
      !/^(?:\+|00)?\d{9,15}$/.test(given.phone.replace(/[\s().-]/g, ''))
    ) {
      violations.push({ in: 'body', pointer: '/recipient/phone', rule: 'format' });
    }
    if (/(?:\+?\d[\s().-]?){7,}/.test(body.note)) {
      violations.push({ in: 'body', pointer: '/note', rule: 'phone_number' });
    }
    if (violations.length > 0)
      return route.fulfill(error(400, 'VALIDATION_FAILED', { violations }));
    if (call.ifMatch !== `"o${String(order.version)}"`) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    if (order.status !== 'FROZEN') {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'order_not_confirmed' }));
    }
    const recipient = asRecord(body.recipient);
    const location = asRecord(recipient.location);
    const address = typeof location.address === 'string' ? location.address : undefined;
    // The stand-in's zone: an address that names Tema is in another zone than the order's, and moving it would move the price.
    if (address !== undefined && /tema/i.test(address)) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'address_changes_zone' }));
    }
    // What the record says changed is what the API says: the parts of the recipient that differ, by name (Run G2, Part 1, item 3), sorted; and nothing that differs is no change.
    const changed: string[] = [];
    if (typeof recipient.name === 'string' && recipient.name !== order.name) {
      changed.push('recipient.name');
    }
    if (typeof recipient.phone === 'string' && recipient.phone !== order.phone) {
      changed.push('recipient.phone');
    }
    if (address !== undefined && address !== order.address) changed.push('recipient.address');
    if (changed.length === 0) {
      return route.fulfill(error(400, 'VALIDATION_FAILED', { rule: 'no_change' }));
    }
    changed.sort();
    if (typeof recipient.name === 'string') order.name = recipient.name;
    if (typeof recipient.phone === 'string') order.phone = recipient.phone;
    if (address !== undefined) order.address = address;
    order.version += 1;
    order.amendments.push({
      id: randomUUID(),
      note: body.note,
      changed,
      at: '2026-11-03T08:29:00.000Z',
      kind: 'RECIPIENT_CORRECTION',
    });
    const answered = ok(orderWire(order), 200, `"o${String(order.version)}"`);
    w.keys.set(call.idempotencyKey, {
      status: 200,
      body: answered.json,
      etag: `"o${String(order.version)}"`,
      fingerprint,
    });
    return route.fulfill(answered);
  }
  const amendPreview = id(/^\/api\/v1\/orders\/([0-9a-f-]{36})\/amendment-preview$/);
  if (method === 'POST' && amendPreview !== undefined) {
    if (await needs('hub.intake.itemize')) return;
    const order = orderById(w, amendPreview);
    if (order === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (await faultOf(route, w)) return;
    const unmatched = unresolved(body);
    if (unmatched !== undefined) return route.fulfill(unmatched);
    const size = SIZES.find((each) => each === body.size_class) ?? order.size;
    const facts = termsOfBody(body);
    await pause(w.previewDelayMs);
    return route.fulfill(
      ok(
        termsOf(
          {
            order_id: order.id,
            order_version: order.version,
            status: 'CURRENT_PREVIEW',
            // An order made before the parcel is checked in for good is confirmed when its arrival is committed, and keeps its quote until then (5.117.0): the preview says so.
            will_confirm:
              order.status === 'EARLY_QUOTE' ? 'WHEN_ARRIVAL_IS_COMMITTED' : 'ON_CONFIRMATION',
            ...zoneOverrides(body),
            // What the order holds now, as the API gives it: the quote beside which the amendment is read.
            current: {
              ...(captured('amend-preview').current as Record<string, unknown>),
              total: money(order.price),
            },
          },
          w.prices[size],
          tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id, facts),
        ),
      ),
    );
  }

  // Who pays, once the price is fixed.
  const asked = id(/^\/api\/v1\/orders\/([0-9a-f-]{36})\/payer-correction$/);
  if (method === 'POST' && asked !== undefined) {
    if (await needs('pricing.correction.create')) return;
    const order = orderById(w, asked);
    if (order === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    if (call.ifMatch !== `"o${String(order.version)}"`)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    const made: StoredCorrection = {
      id: randomUUID(),
      orderId: order.id,
      state: 'REQUESTED',
      intent:
        typeof asRecord(body.proposed).payer_intent === 'string'
          ? (asRecord(body.proposed).payer_intent as string)
          : 'RECIPIENT_PAYS',
      note: typeof body.note === 'string' ? body.note : '',
      version: 1,
      requestedBy: w.principal,
    };
    w.corrections.push(made);
    return route.fulfill(ok(correctionWire(w, made), 201, '"c1"'));
  }
  if (method === 'GET' && path === '/api/v1/payer-corrections') {
    if (await needs('pricing.correction.create')) return;
    const view = new URLSearchParams(call.search).get('state') ?? 'REQUESTED';
    const items = w.corrections
      .filter((each) => view === 'all' || each.state === view)
      .map((each) => correctionWire(w, each));
    return route.fulfill(ok({ items, next_page_token: null }));
  }
  const correction = id(/^\/api\/v1\/payer-corrections\/([0-9a-f-]{36})$/);
  if (method === 'GET' && correction !== undefined) {
    if (await needs('pricing.correction.create')) return;
    const found = w.corrections.find((each) => each.id === correction);
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill(ok(correctionWire(w, found), 200, `"c${String(found.version)}"`));
  }
  const decision = id(/^\/api\/v1\/payer-corrections\/([0-9a-f-]{36})\/decision$/);
  if (method === 'POST' && decision !== undefined) {
    if (await needs('pricing.correction.approve')) return;
    const found = w.corrections.find((each) => each.id === decision);
    if (found === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    // The maker-checker rule: the officer who asked does not decide (a Platform Admin is the API's exception, and no officer of these screens is one).
    if ((found.requestedBy ?? IDS.me) === w.principal) {
      return route.fulfill(error(422, 'SELF_APPROVAL_FORBIDDEN'));
    }
    if (call.ifMatch !== `"c${String(found.version)}"` || found.state !== 'REQUESTED') {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    found.state = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    found.decidedBy = w.principal;
    found.version += 1;
    if (found.state === 'APPROVED') {
      const order = orderById(w, found.orderId);
      if (order !== undefined) order.sender = found.intent === 'SENDER_PAYS_FULL' ? order.price : 0;
    }
    return route.fulfill(ok(correctionWire(w, found), 200, `"c${String(found.version)}"`));
  }

  // The close.
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}/closure`) {
    if (await needs('hub.intake.close')) return;
    return route.fulfill(ok(closureWire(w)));
  }
  if (method === 'POST' && path === `/api/v1/hub-intakes/${VENDOR_ID}/close`) {
    if (await needs('hub.intake.close')) return;
    if (call.idempotencyKey === undefined || call.ifMatch === undefined)
      return route.fulfill(error(428, 'PRECONDITION_REQUIRED'));
    if (call.ifMatch !== vendorEtag(w))
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    const current = closureWire(w);
    if (body.reviewed_assessment !== current.assessment_token) {
      return route.fulfill(
        error(409, 'STATE_CONFLICT', { rule: 'assessment_changed', current_assessment: current }),
      );
    }
    if (current.can_close !== true)
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'orders_exceed_received' }));
    w.vendorState = 'CLOSED';
    return route.fulfill(ok(vendorWire(w), 200, vendorEtag(w)));
  }
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}/summary`) {
    if (await needs('pickup.read')) return;
    if (w.vendorState !== 'CLOSED') return route.fulfill(error(404, 'NOT_FOUND'));
    return route.fulfill(
      ok({
        intake_id: VENDOR_ID,
        pickup_request_id: vendorWire(w).pickup_request_id,
        closed_at: '2026-11-03T08:25:00.000Z',
        orders: w.orders.map((each) => ({
          id: each.id,
          code: each.code,
          recipient_name: each.name,
          service_area: 'ACCRA_TEMA',
          size_class: each.size,
          ...(holds('pricing.read') ? { locked_price: money(each.price) } : {}),
          commercial_state: (each.sender ?? 0) > 0 ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE',
        })),
      }),
    );
  }
  if (method === 'GET' && path === '/api/v1/hub-intake-exceptions') {
    if (await needs('hub.intake.close_exception')) return;
    const item =
      (captured('closed-exceptions-named').items as Record<string, unknown>[]).find(
        (each) =>
          each.receiving_mode === (w.mode === 'BLIND_COUNT' ? 'BLIND_COUNT' : 'PHOTO_CHECK_IN'),
      ) ?? {};
    return route.fulfill(ok({ items: [{ ...item, intake_id: VENDOR_ID }], next_page_token: null }));
  }
  if (method === 'GET' && path === '/api/v1/notifications') {
    if (await needs('notification.read')) return;
    return route.fulfill(ok({ items: [], next_page_token: null }));
  }

  // The door photo beside the form: the authorization to read one stored photo, and the picture itself (the store is the page's own origin).
  const photo = id(/^\/api\/v1\/evidence\/([0-9a-f-]{36})\/retrieval-authorization$/);
  if (method === 'POST' && photo !== undefined) {
    // How many links are being asked for at once is what a page that draws a hundred photos is held to: counted from the moment a request arrives to the moment it is answered.
    state.links.asked.push(photo);
    state.links.at.push(performance.now());
    state.links.current += 1;
    state.links.peak = Math.max(state.links.peak, state.links.current);
    try {
      await pause(w.linkDelayMs);
      const fault = w.linkFault;
      if (fault !== undefined && fault.times > 0) {
        fault.times -= 1;
        state.links.refusedAt ??= performance.now();
        await route.fulfill({
          ...error(429, 'RATE_LIMITED'),
          headers: { ...JSON_HEADERS, 'retry-after': String(fault.retryAfterSeconds) },
        });
      } else {
        await route.fulfill(
          ok({
            method: 'GET',
            url: `/test-evidence-store/photo/${photo}?token=issued-${String(state.images.length)}`,
            expires_at: '2026-11-03T08:36:00Z',
          }),
        );
      }
    } finally {
      state.links.current -= 1;
    }
    return;
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** Answers the operations of the order screens from a small world and records every request to the API. */
export async function stubOrdersApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<OrdersApi> {
  const state: OrdersApi = {
    world: initial,
    calls: [],
    unexpected: [],
    images: [],
    links: { current: 0, peak: 0, asked: [], at: [], refusedAt: undefined },
  };
  await freezeClock(target);
  await target.route('**/test-evidence-store/photo/**', async (route) => {
    state.images.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' },
      body: PICTURE,
    });
  });
  await target.route('**/api/v1/**', async (route) => {
    if (await answerQueueSummary(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const call: Call = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      ifMatch: headers['if-match'],
      idempotencyKey: headers['idempotency-key'],
      body: parsed(request.postData()),
    };
    state.calls.push(call);
    await answer(route, state, call);
  });
  return state;
}
