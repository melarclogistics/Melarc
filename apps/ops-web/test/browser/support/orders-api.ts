import { createHash, randomUUID } from 'node:crypto';

import type { BrowserContext, Page, Route } from '@playwright/test';

import { INTAKE_HUB_ID } from '../../../src/test-support/hub-intake-fixture';
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
import { checkInFixture } from '../../../src/test-support/receiving-fixture';
import { freezeClock } from './clock';
import { answerQueueSummary } from './queue-summary';
import { PICTURE } from './receiving-api';

/**
 * What the browser tests of the order screens (S1.40) put in place of the API: a small **stateful** stand-in for the operations the screens use, built from the answers the real API gave (`test/fixtures/orders`) so that
 * a shape cannot drift from the contract. It keeps what the API keeps: the vendor's version moves with every order made (a save on an older one is refused as `stale`), the price is the stand-in's server's and is
 * never the page's (a save is on the digest of the terms that were read, and a price that changed meanwhile answers the terms as they are now), a key makes an order once, a change of who pays is a request that a
 * checker decides, and a vendor is closed on the assessment the officer read. Every request is recorded as the browser sent it (method, path, query, `If-Match`, `Idempotency-Key`, body), and any other request to
 * `/api` is a failure of the test: it is answered with a network error and listed in `unexpected`.
 *
 * Everything in the answers is synthetic and says so.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export const IDS = {
  me: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
  session: '3f4c6b0e-0d8a-4a6e-9f55-1b2f0c9d7e11',
  hub: INTAKE_HUB_ID,
  vendor: VENDOR_ID,
} as const;

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
  version: number;
  amendments: { id: string; note: string; changed: string[]; at: string }[];
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
}

export interface World {
  permissions: string[];
  vendorState: 'READY_FOR_ITEMIZATION' | 'ITEMIZING' | 'CLOSED';
  orders: StoredOrder[];
  corrections: StoredCorrection[];
  /** What the stand-in's server charges for each size, in pesewas. The page never works one out. */
  prices: Record<Size, number>;
  /** The next save finds the price of its size changed to this figure, once: the terms the officer read are then no longer the terms. */
  repriceOnce: number | undefined;
  /** How long the stand-in's server takes to work a price out, in milliseconds: none by default. A test that taps while a price is being checked asks for a slow one. */
  previewDelayMs: number;
  /** Saves made under a key already seen are answered as the first was and make nothing. */
  keys: Map<string, { status: number; body: unknown; etag: string | undefined }>;
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
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const pause = (milliseconds: number): Promise<void> =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
/** The digest of the terms a preview worked out: the same facts at the same price give the same digest, and another price another. */
const tokenOf = (size: Size, price: number, parcel: string | undefined): string =>
  sha(`${size}|${String(price)}|${parcel ?? ''}`);

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
    intake_parcel_id: parcelOf(order.parcel)?.id ?? null,
    intake_parcel_state: 'ARRIVED',
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
    })),
    reversal: null,
  };
}

function rowOf(w: World, ordinal: number) {
  const order = orderForParcel(w, ordinal);
  if (order === undefined) return parcelRow(ordinal, 'NEEDS_ORDER');
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

function worklistWire(w: World, view: string | null) {
  const rows = [1, 2, 3].map((ordinal) => rowOf(w, ordinal));
  const needs = rows.filter((row) => row.work_state === 'NEEDS_ORDER').length;
  const made = w.orders.length;
  const items = rows.filter((row) =>
    view === 'needs_order'
      ? row.work_state === 'NEEDS_ORDER'
      : view === 'itemized'
        ? row.work_state === 'ITEMIZED'
        : true,
  );
  return worklistOf(
    items,
    {
      received: 3,
      needs_order: needs,
      itemized: w.orders.filter((each) => each.status === 'FROZEN').length,
      prepared: w.orders.filter((each) => each.status !== 'FROZEN').length,
      orders: made,
      payment_required: w.orders.filter((each) => (each.sender ?? 0) > 0).length,
    },
    { intake_state: w.vendorState },
  );
}

function closureWire(w: World): Record<string, unknown> {
  const needs = 3 - w.orders.length;
  const outstanding = [1, 2, 3]
    .filter((ordinal) => orderForParcel(w, ordinal) === undefined)
    .map((ordinal) => ({
      origin: 'DOOR_PHOTO',
      ordinal,
      parcel_id: parcelOf(ordinal)?.id,
      hub_photo_evidence_id: null,
      door_photo_evidence_id: parcelOf(ordinal)?.photo_evidence_id ?? null,
    }));
  return closureOf('ready', {
    intake_state: w.vendorState,
    received: 3,
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
    approved_by: decided ? IDS.me : null,
    approved_by_name: decided ? 'Synthetic Officer' : null,
    requested_by: IDS.me,
    requested_by_name: 'Synthetic Officer',
    order_commercial_state:
      sender > 0 && stored.state === 'APPROVED' ? 'PAYMENT_REQUIRED' : 'NO_VENDOR_CHARGE',
  });
}

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
        principal_id: IDS.me,
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

  // The vendors a hub cleared for their orders.
  if (method === 'GET' && path === '/api/v1/hub-intakes') {
    if (await needs('hub.read')) return;
    const asked = new URLSearchParams(call.search).get('state');
    const items = asked === w.vendorState ? [vendorWire(w)] : [];
    return route.fulfill(ok({ items, next_page_token: null }));
  }
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}`) {
    if (await needs('hub.read')) return;
    return route.fulfill(ok(vendorWire(w), 200, vendorEtag(w)));
  }
  if (method === 'GET' && path === `/api/v1/hub-intakes/${VENDOR_ID}/orders`) {
    if (await needs('hub.read')) return;
    return route.fulfill(ok(worklistWire(w, new URLSearchParams(call.search).get('view'))));
  }

  // The price, checked before anything is saved: the stand-in's server works it out and writes nothing.
  if (method === 'POST' && path === `/api/v1/hub-intakes/${VENDOR_ID}/orders/preview`) {
    if (await needs('hub.intake.itemize')) return;
    const size = SIZES.find((each) => each === body.size_class);
    if (size === undefined) return route.fulfill(error(422, 'SIZE_CLASS_REQUIRED'));
    const price = w.prices[size];
    await pause(w.previewDelayMs);
    return route.fulfill(
      ok(
        termsOf(
          { parcel_id: body.parcel_id ?? null },
          price,
          tokenOf(size, price, typeof body.parcel_id === 'string' ? body.parcel_id : undefined),
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
    const earlier = w.keys.get(call.idempotencyKey);
    if (earlier !== undefined) return route.fulfill(ok(earlier.body, earlier.status, earlier.etag));
    if (call.ifMatch !== vendorEtag(w)) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    const size = SIZES.find((each) => each === body.size_class);
    const parcelId = typeof body.parcel_id === 'string' ? body.parcel_id : undefined;
    const ordinal = PARCELS.findIndex((each) => each.id === parcelId) + 1;
    if (size === undefined || ordinal === 0)
      return route.fulfill(error(422, 'SIZE_CLASS_REQUIRED'));
    if (orderForParcel(w, ordinal) !== undefined) {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'parcel_ordered' }));
    }
    if (w.repriceOnce !== undefined) {
      w.prices[size] = w.repriceOnce;
      w.repriceOnce = undefined;
    }
    const price = w.prices[size];
    if (body.reviewed_terms !== tokenOf(size, price, parcelId)) {
      return route.fulfill(
        error(409, 'STATE_CONFLICT', {
          rule: 'terms_changed',
          current_terms: termsOf(
            { parcel_id: parcelId ?? null },
            price,
            tokenOf(size, price, parcelId),
          ),
        }),
      );
    }
    const recipient = asRecord(body.recipient);
    const made = storedOrder(ordinal, {
      size,
      price,
      name: typeof recipient.name === 'string' ? recipient.name : 'Ama Mensah',
      phone: typeof recipient.phone === 'string' ? recipient.phone : '',
      address:
        typeof asRecord(recipient.location).address === 'string'
          ? (asRecord(recipient.location).address as string)
          : '',
    });
    w.orders.push(made);
    // The first order of a vendor moves it from ready to being worked, and its version with it.
    if (w.vendorState === 'READY_FOR_ITEMIZATION') w.vendorState = 'ITEMIZING';
    const saved = { ...orderWire(made) };
    w.keys.set(call.idempotencyKey, {
      status: 201,
      body: saved,
      etag: `"o${String(made.version)}"`,
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
      if (call.ifMatch !== `"o${String(order.version)}"`) {
        return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
      }
      const size = SIZES.find((each) => each === body.size_class) ?? order.size;
      if (body.reviewed_terms !== tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id)) {
        return route.fulfill(
          error(409, 'STATE_CONFLICT', {
            rule: 'terms_changed',
            current_terms: termsOf(
              {},
              w.prices[size],
              tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id),
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
      });
      return route.fulfill(ok(orderWire(order), 200, `"o${String(order.version)}"`));
    }
  }
  const amendPreview = id(/^\/api\/v1\/orders\/([0-9a-f-]{36})\/amendment-preview$/);
  if (method === 'POST' && amendPreview !== undefined) {
    if (await needs('hub.intake.itemize')) return;
    const order = orderById(w, amendPreview);
    if (order === undefined) return route.fulfill(error(404, 'NOT_FOUND'));
    const size = SIZES.find((each) => each === body.size_class) ?? order.size;
    await pause(w.previewDelayMs);
    return route.fulfill(
      ok(
        termsOf(
          {
            order_id: order.id,
            order_version: order.version,
            status: 'CURRENT_PREVIEW',
            // What the order holds now, as the API gives it: the quote beside which the amendment is read.
            current: {
              ...(captured('amend-preview').current as Record<string, unknown>),
              total: money(order.price),
            },
          },
          w.prices[size],
          tokenOf(size, w.prices[size], parcelOf(order.parcel)?.id),
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
    if (call.ifMatch !== `"c${String(found.version)}"` || found.state !== 'REQUESTED') {
      return route.fulfill(error(409, 'STATE_CONFLICT', { rule: 'stale' }));
    }
    found.state = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
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
    const item = (captured('closed-exceptions').items as Record<string, unknown>[])[0] ?? {};
    return route.fulfill(ok({ items: [{ ...item, intake_id: VENDOR_ID }], next_page_token: null }));
  }
  if (method === 'GET' && path === '/api/v1/notifications') {
    if (await needs('notification.read')) return;
    return route.fulfill(ok({ items: [], next_page_token: null }));
  }

  // The door photo beside the form: the authorization to read one stored photo, and the picture itself (the store is the page's own origin).
  const photo = id(/^\/api\/v1\/evidence\/([0-9a-f-]{36})\/retrieval-authorization$/);
  if (method === 'POST' && photo !== undefined) {
    return route.fulfill(
      ok({
        method: 'GET',
        url: `/test-evidence-store/photo/${photo}?token=issued-${String(state.images.length)}`,
        expires_at: '2026-11-03T08:36:00Z',
      }),
    );
  }

  state.unexpected.push(`${method} ${path}`);
  return route.abort('failed');
}

/** Answers the operations of the order screens from a small world and records every request to the API. */
export async function stubOrdersApi(
  target: Page | BrowserContext,
  initial: World = world(),
): Promise<OrdersApi> {
  const state: OrdersApi = { world: initial, calls: [], unexpected: [], images: [] };
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
