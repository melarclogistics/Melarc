import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { arrivedParcel, parcelFixture, KENTE_INTAKE_ID, uuid } from './receiving-fixture';

/**
 * What the tests of the order screens (S1.40) are made of: **answers the real API sent**, captured on 22 November 2026 from the API running on a disposable PostgreSQL database
 * (`test/fixtures/orders/*.json`), copied and changed by the test that needs another figure, never written from the contract by hand. A test that needs a vendor, a parcel or an order of
 * its own builds it from these, so that what a screen is shown in a test is what the API gives.
 */
const FIXTURES = resolve(import.meta.dirname, '../../test/fixtures/orders');

export function captured(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** A refusal as the API sent it (`{ status, body }` fixtures hold both). */
export function capturedRefusal(name: string): {
  readonly status: number;
  readonly body: Record<string, unknown>;
} {
  return captured(name) as { status: number; body: Record<string, unknown> };
}

export const VENDOR_ID = KENTE_INTAKE_ID;
export const ORDER_ID = (captured('order') as { id: string }).id;
export const ORDER_CODE = (captured('order') as { code: string }).code;
export const EARLY_ORDER_ID = (captured('order-early') as { id: string }).id;
export const TOKEN = (captured('preview') as { terms_token: string }).terms_token;
export const NEW_TOKEN = 'f'.repeat(64);
export const ASSESSMENT = (captured('closure-exception') as { assessment_token: string })
  .assessment_token;
export const NEW_ASSESSMENT = '0'.repeat(63) + '1';

/** The parcels of a vendor with door photos, as the vendor's record lists them. */
export const PARCELS = [arrivedParcel(1), arrivedParcel(2), arrivedParcel(3)];
export const EXPECTED_PARCEL = parcelFixture(4);

export interface ProgressOverrides {
  readonly received?: number | null;
  readonly awaiting_arrival?: number;
  readonly needs_order?: number | null;
  readonly prepared?: number;
  readonly itemized?: number;
  readonly payment_required?: number;
  readonly missing?: number;
  readonly orders?: number;
  /** The parcels the officer is waiting on the vendor's details for (D-S7-12); the answers captured before it was built do not say it. */
  readonly waiting_for_vendor?: number | null;
}

export const progressOf = (overrides: ProgressOverrides = {}) => ({
  received: 3,
  awaiting_arrival: 0,
  needs_order: 2,
  prepared: 0,
  itemized: 1,
  payment_required: 0,
  missing: 0,
  orders: 1,
  ...overrides,
});

/** One row of the worklist of a vendor with door photos. */
export function parcelRow(
  n: number,
  workState: 'NEEDS_ORDER' | 'AWAITING_ARRIVAL' | 'PREPARED' | 'ITEMIZED' | 'MISSING',
  overrides: {
    order?: Record<string, unknown> | null;
    origin?: 'DOOR_PHOTO' | 'HUB_EXTRA';
    parcelState?: string;
    /** The mark of a parcel the officer is waiting on (D-S7-12), in the shape the API answered it. */
    waiting?: { readonly since: string; readonly note: string | null };
  } = {},
) {
  const parcel = n === 4 ? EXPECTED_PARCEL : (PARCELS[n - 1] ?? arrivedParcel(n));
  const hasOrder = workState === 'PREPARED' || workState === 'ITEMIZED';
  return {
    work_state: workState,
    reversed_order: null,
    parcel: {
      id: parcel.id,
      ordinal: n,
      origin: overrides.origin ?? 'DOOR_PHOTO',
      state:
        overrides.parcelState ??
        (workState === 'AWAITING_ARRIVAL'
          ? 'EXPECTED'
          : workState === 'MISSING'
            ? 'MISSING'
            : 'ARRIVED'),
      door_photo_evidence_id: parcel.photo_evidence_id,
      hub_photo_evidence_id: null,
      waiting_for_vendor: overrides.waiting ?? null,
    },
    order:
      overrides.order !== undefined
        ? overrides.order
        : hasOrder
          ? {
              id: ORDER_ID,
              code: ORDER_CODE,
              recipient_name: 'Ama Mensah',
              service_area: 'ACCRA_TEMA',
              size_class: 'SMALL',
              commercial_state: workState === 'ITEMIZED' ? 'NO_VENDOR_CHARGE' : null,
              confirmed: workState === 'ITEMIZED',
              payment_required: false,
            }
          : null,
  };
}

export function worklistOf(
  items: readonly unknown[],
  progress: ProgressOverrides = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    intake_id: VENDOR_ID,
    intake_state: 'ITEMIZING',
    receiving_mode: 'PHOTO_CHECK_IN',
    progress: progressOf(progress),
    items: [...items],
    next_page_token: null,
    ...overrides,
  };
}

/** A row of the worklist of a vendor counted without photos: an order and no parcel. */
export const blindRow = (n: number, state: 'PREPARED' | 'ITEMIZED' = 'ITEMIZED') => ({
  work_state: state,
  parcel: null,
  reversed_order: null,
  order: {
    id: uuid(0x5a, n),
    code: `ACC-OR-${['2CD3FG', '4HJ5KM', '6NP7QR'][n - 1] ?? '8STVWX'}`,
    recipient_name: 'Ama Mensah',
    service_area: 'ACCRA_TEMA',
    size_class: 'SMALL',
    commercial_state: 'NO_VENDOR_CHARGE',
    confirmed: true,
    payment_required: false,
  },
});

/** The preview of an order, with the figures a test changes. */
export function termsOf(overrides: Record<string, unknown> = {}, total = 3500, token = TOKEN) {
  const base = structuredClone(captured('preview'));
  // Who pays adds up to the price in every answer: the sender's portion is as it was captured, and the recipient's is what is left of the total (a price of another figure would otherwise carry the captured portions).
  const payer = base.payer as {
    sender: { amount_minor: number };
    recipient: { amount_minor: number };
  };
  return {
    ...base,
    intake_id: VENDOR_ID,
    parcel_id: PARCELS[0]?.id ?? null,
    price: {
      total: { amount_minor: total, currency: 'GHS' },
      components: [
        { kind: 'SERVICE_AREA_BASE_FEE', amount: { amount_minor: total, currency: 'GHS' } },
      ],
    },
    payer: {
      ...payer,
      recipient: { ...payer.recipient, amount_minor: total - payer.sender.amount_minor },
    },
    terms_token: token,
    ...overrides,
  };
}

/** An order as `getOrder` answers it, early (a quote) or fixed. */
export function orderOf(
  kind: 'frozen' | 'early' | 'reversed' = 'frozen',
  overrides: Record<string, unknown> = {},
) {
  const name = kind === 'frozen' ? 'order' : kind === 'early' ? 'order-early' : 'order-reversed';
  return { ...structuredClone(captured(name)), ...overrides };
}

export function closureOf(
  kind: 'ready' | 'exception' | 'closed' = 'ready',
  overrides: Record<string, unknown> = {},
) {
  const name =
    kind === 'ready'
      ? 'closure-ready'
      : kind === 'exception'
        ? 'closure-exception'
        : 'closure-closed';
  return { ...structuredClone(captured(name)), intake_id: VENDOR_ID, ...overrides };
}

export function correctionOf(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(captured('correction')), ...overrides };
}
