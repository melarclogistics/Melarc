import { describe, expect, it } from 'vitest';

import {
  closureTokenOf,
  closureViewOf,
  decodeExceptionToken,
  encodeExceptionToken,
  type ClosureRow,
} from './intake-worklist.service.js';
import { termsTokenOf, type OrderPreviewView } from './itemization.service.js';

/**
 * The two tokens of the review of 20 November 2026 (findings 3 and 6): the digest of the terms an officer was shown, and the digest of what a close would find. What the tokens are for is that **anything a
 * save or a close depends on moves them**, so each member is changed in turn and the token must change; and that the same facts give the same token however they are built.
 */
const money = (amountMinor: number): { amount_minor: number; currency: 'GHS' } => ({
  amount_minor: amountMinor,
  currency: 'GHS',
});

const terms = (): Omit<OrderPreviewView, 'terms_token' | 'current'> => ({
  intake_id: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  parcel_id: '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
  order_id: null,
  order_version: null,
  status: 'CURRENT_PREVIEW',
  validation: { evidence: 'NONE_CITED' },
  cited_evidence: { high_value: [], carrier_waybill: null },
  will_confirm: 'ON_CONFIRMATION',
  quote_policy: 'PROTECTED_UNTIL_AMENDED',
  price: {
    total: money(3500),
    components: [{ kind: 'SERVICE_AREA_BASE_FEE', amount: money(3500) }],
  },
  is_high_value: false,
  high_value_surcharge: null,
  destination_zone_snapshot: { scope: 'SERVICE_AREA', zone_id: 'zone-a' },
  destination_zone_resolution: 'SERVER_RESOLVED',
  delivery: {
    default_date: '2026-11-24',
    requested_date: null,
    committed_date: '2026-11-24',
    window_start: '10:00',
    window_end: '16:00',
  },
  payer: {
    source: 'REQUEST',
    payer_intent: 'RECIPIENT_PAYS',
    sender: money(0),
    recipient: money(3500),
    commercial_state_after_confirmation: 'NO_VENDOR_CHARGE',
  },
});

describe('the token of the terms an officer was shown', () => {
  // Break caught: a token that is not a function of the terms (a clock, a counter), so that no save could ever match its preview.
  it('is the same for the same terms and is a digest in hexadecimal', () => {
    expect(termsTokenOf(terms())).toBe(termsTokenOf(terms()));
    expect(termsTokenOf(terms())).toMatch(/^[0-9a-f]{64}$/);
  });

  // Break caught: a member of what is shown that a save can then differ in without the token noticing: the price, who pays, the promise, the status of the parcel, the evidence, the order it is for.
  it.each([
    [
      'the total',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        price: { ...each.price, total: money(4500) },
      }),
    ],
    [
      'a component of the price',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        price: {
          ...each.price,
          components: [{ kind: 'SERVICE_AREA_BASE_FEE', amount: money(3000) }],
        },
      }),
    ],
    [
      'the high-value status',
      (each: ReturnType<typeof terms>) => ({ ...each, is_high_value: true }),
    ],
    [
      'the payer',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        payer: {
          ...each.payer,
          payer_intent: 'SENDER_PAYS_FULL',
          sender: money(3500),
          recipient: money(0),
        },
      }),
    ],
    [
      'the portion the sender pays',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        payer: { ...each.payer, sender: money(1), recipient: money(3499) },
      }),
    ],
    [
      'the state the gate would give',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        payer: { ...each.payer, commercial_state_after_confirmation: 'PAYMENT_REQUIRED' as const },
      }),
    ],
    [
      'the date committed',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        delivery: { ...each.delivery, committed_date: '2026-11-25' },
      }),
    ],
    [
      'the window',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        delivery: { ...each.delivery, window_end: '17:00' },
      }),
    ],
    [
      'the zone',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        destination_zone_snapshot: { scope: 'SERVICE_AREA', zone_id: 'zone-b' },
      }),
    ],
    [
      'how the zone was resolved',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        destination_zone_resolution: 'EXPLICITLY_AUTHORIZED' as const,
      }),
    ],
    [
      'whether the evidence was verified',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        validation: { evidence: 'VERIFIED' as const },
      }),
    ],
    [
      'a record the order cites (the review of 21 November 2026, finding 2)',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        cited_evidence: {
          ...each.cited_evidence,
          high_value: ['4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e'],
        },
      }),
    ],
    [
      'another record in its place',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        cited_evidence: {
          ...each.cited_evidence,
          high_value: ['5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f'],
        },
      }),
    ],
    [
      'the waybill of the carrier',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        cited_evidence: {
          ...each.cited_evidence,
          carrier_waybill: '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a',
        },
      }),
    ],
    [
      'when the order would be confirmed',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        will_confirm: 'WHEN_ARRIVAL_IS_COMMITTED' as const,
      }),
    ],
    [
      'the order it is of an amendment of',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        order_id: '2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c',
      }),
    ],
    [
      'the version of that order',
      (each: ReturnType<typeof terms>) => ({ ...each, order_version: 3 }),
    ],
    [
      'the parcel',
      (each: ReturnType<typeof terms>) => ({
        ...each,
        parcel_id: '3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d',
      }),
    ],
  ])('moves with %s', (_name, change) => {
    expect(termsTokenOf(change(terms()))).not.toBe(termsTokenOf(terms()));
  });
});

const closure = (): ClosureRow => ({
  state: 'ITEMIZING',
  receiving_mode: 'PHOTO_CHECK_IN',
  received: 3,
  ordered: 1,
  unpriced: 0,
  payment_required: 0,
  missing: 0,
  outstanding_count: 2,
  outstanding_parcels: [],
  outstanding_digest: 'a'.repeat(64),
  closed_at: null,
  parity_exception_note: null,
});
const INTAKE = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

describe('the token of what a close would find', () => {
  // Break caught: a token that is not a function of what the close finds.
  it('is the same for the same facts, whatever the case of the identifier', () => {
    expect(closureTokenOf(INTAKE, closure())).toBe(closureTokenOf(INTAKE.toUpperCase(), closure()));
    expect(closureTokenOf(INTAKE, closure())).toMatch(/^[0-9a-f]{64}$/);
  });

  // Break caught: a fact a senior's reason is written for that can change between the read and the close without the token noticing; above all the identity of the outstanding parcels, which a count alone does not say.
  it.each([
    ['the state', (each: ClosureRow) => ({ ...each, state: 'READY_FOR_ITEMIZATION' })],
    ['the parcels received', (each: ClosureRow) => ({ ...each, received: 4 })],
    ['the orders that stand', (each: ClosureRow) => ({ ...each, ordered: 2 })],
    ['the orders not priced', (each: ClosureRow) => ({ ...each, unpriced: 1 })],
    ['the orders awaiting payment', (each: ClosureRow) => ({ ...each, payment_required: 1 })],
    ['the parcels missing', (each: ClosureRow) => ({ ...each, missing: 1 })],
    ['the number outstanding', (each: ClosureRow) => ({ ...each, outstanding_count: 1 })],
    [
      'WHICH parcels are outstanding, the number being the same',
      (each: ClosureRow) => ({ ...each, outstanding_digest: 'b'.repeat(64) }),
    ],
    [
      'a count that is not committed',
      (each: ClosureRow) => ({ ...each, received: null, outstanding_count: null }),
    ],
  ])('moves with %s', (_name, change) => {
    expect(closureTokenOf(INTAKE, change(closure()))).not.toBe(closureTokenOf(INTAKE, closure()));
  });

  // Break caught: one intake's assessment taken for another's.
  it('is of one intake', () => {
    expect(closureTokenOf('9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f', closure())).not.toBe(
      closureTokenOf(INTAKE, closure()),
    );
  });
});

describe('the position in the queue of the closes that left work', () => {
  const MOMENT = '2026-11-20T09:15:30.123456Z';

  // Break caught: a position that loses the microseconds of the close (two closes in one millisecond skipped or repeated), or is read back as another.
  it('keeps the moment of the close to the microsecond and the intake, and gives them back as they were', () => {
    const token = encodeExceptionToken(MOMENT, INTAKE.toUpperCase());
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeExceptionToken(token)).toEqual({ moment: MOMENT, id: INTAKE });
  });

  // Break caught: a position that reaches a statement as anything but a moment and a UUID (the position is text a caller sends).
  it.each([
    ['nothing', ''],
    ['not base64', '%%%'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['one member', Buffer.from(JSON.stringify([MOMENT])).toString('base64url')],
    [
      'a moment that is not to the microsecond',
      Buffer.from(JSON.stringify(['2026-11-20T09:15:30Z', INTAKE])).toString('base64url'),
    ],
    [
      'a statement in the moment',
      Buffer.from(
        JSON.stringify(["2026-11-20T09:15:30.123456Z'; drop table pickup_intake; --", INTAKE]),
      ).toString('base64url'),
    ],
    [
      'an identifier that is not a UUID',
      Buffer.from(JSON.stringify([MOMENT, 'not-a-uuid'])).toString('base64url'),
    ],
    ['a number for the moment', Buffer.from(JSON.stringify([1, INTAKE])).toString('base64url')],
    ['a token that is too long', 'A'.repeat(200)],
  ])('refuses %s', (_name, token) => {
    expect(decodeExceptionToken(token)).toBeUndefined();
  });

  // Break caught: a position made of a moment or an identifier that is not one.
  it('is not made of anything but a moment and a UUID', () => {
    expect(() => encodeExceptionToken('yesterday', INTAKE)).toThrow(TypeError);
    expect(() => encodeExceptionToken(MOMENT, 'not-a-uuid')).toThrow(TypeError);
  });
});

/** What a close would find over a surplus of orders (the review of 21 November 2026, finding 1). */
describe('the view of what a close would find over a surplus', () => {
  const blind = (received: number, ordered: number): ClosureRow => ({
    ...closure(),
    receiving_mode: 'BLIND_COUNT',
    received,
    ordered,
    outstanding_count: Math.max(received - ordered, 0),
    outstanding_digest: null,
  });

  // Break caught: a surplus that is an outstanding count of nothing and a close that needs the exception for it, as the reviewer found it.
  it('names a surplus as a blocker, counts it, and offers no exception over it', () => {
    const view = closureViewOf(INTAKE, blind(2, 3));
    expect(view).toMatchObject({
      excess_count: 1,
      outstanding_count: 0,
      can_close: false,
      needs_exception: false,
    });
    expect(view.blockers).toContain('orders_exceed_received');
  });

  // Break caught: a shortage that is read as a surplus, or parity that is.
  it.each([
    ['a shortage', 3, 2, true],
    ['parity', 3, 3, false],
  ])('has no surplus in %s', (_name, received, ordered, needsException) => {
    const view = closureViewOf(INTAKE, blind(received, ordered));
    expect(view.excess_count).toBe(0);
    expect(view.blockers).toEqual([]);
    expect(view.needs_exception).toBe(needsException);
    expect(view.can_close).toBe(!needsException);
  });

  // Break caught: a count that is not committed read as a surplus of everything.
  it('has no surplus where nothing is known to have been received', () => {
    const view = closureViewOf(INTAKE, {
      ...blind(0, 0),
      state: 'AWAITING_COUNT',
      received: null,
      outstanding_count: null,
    });
    expect(view.excess_count).toBe(0);
  });
});
