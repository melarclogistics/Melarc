import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseIntakeListPage } from './intake-list-shape';
import {
  parseCandidates,
  parseClosed,
  parseClosedExceptionPage,
  parseClosure,
  parseCorrection,
  parseCorrectionPage,
  parseOrder,
  parseReversal,
  parseSummary,
  parseTerms,
  parseWorklist,
  workItemKey,
} from './orders-shape';

/**
 * What the order screens believe of an answer (`orders-shape.ts`), proved **against answers the real API sent**: the fixtures are captured from the API running on a disposable PostgreSQL database
 * (S1.40, 22 November 2026), one for each answer the screens read, so that a guard that is stricter than the API (and would refuse a real answer) or looser than the contract (and would draw a
 * wrong one) is found here and not on the floor. Each break named below is one these tests catch.
 */
const FIXTURES = resolve(import.meta.dirname, '../../../test/fixtures/orders');
const load = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
const bodyOf = (name: string): unknown => (load(name) as { body: unknown }).body;
const detailsOf = (name: string): Record<string, unknown> =>
  (bodyOf(name) as { details: Record<string, unknown> }).details;

/** A deep copy that a test may change: the fixture itself is never edited. */
const copy = <T>(value: T): T => structuredClone(value);

describe('the worklist', () => {
  // Break caught: a guard that refuses the answer of a vendor with door photos, or draws the counts of a page.
  it('accepts the answer for a vendor with door photos and keeps the counts of the whole vendor', () => {
    const list = parseWorklist(load('worklist-photo'));
    expect(list).toBeDefined();
    expect(list?.receiving_mode).toBe('PHOTO_CHECK_IN');
    expect(list?.progress).toEqual({
      received: 3,
      awaiting_arrival: 0,
      needs_order: 1,
      prepared: 0,
      itemized: 2,
      payment_required: 0,
      missing: 0,
      orders: 2,
    });
    expect(list?.items.map((item) => item.work_state).toSorted()).toEqual([
      'ITEMIZED',
      'ITEMIZED',
      'NEEDS_ORDER',
    ]);
  });

  it('accepts a vendor whose check-in is open: parcels not here yet, and an order made for one of them', () => {
    const list = parseWorklist(load('worklist-early'));
    expect(list?.items.map((item) => item.work_state).toSorted()).toEqual([
      'AWAITING_ARRIVAL',
      'PREPARED',
    ]);
    const prepared = list?.items.find((item) => item.work_state === 'PREPARED');
    expect(prepared?.order?.confirmed).toBe(false);
  });

  it('accepts a vendor counted without photos: rows are orders, and there is no parcel', () => {
    const list = parseWorklist(load('worklist-blind'));
    expect(list?.receiving_mode).toBe('BLIND_COUNT');
    expect(list?.items.every((item) => item.parcel === null && item.order !== null)).toBe(true);
    expect(list?.progress.needs_order).toBe(1);
  });

  it('keeps the order of an arrival that was taken back apart from the parcel, as history', () => {
    const list = parseWorklist(load('worklist-reversed'));
    expect(list?.items.some((item) => item.reversed_order !== null)).toBe(true);
  });

  // Break caught: a count the server did not give read as zero (a vendor counted blind whose count is not committed is "awaiting", never none).
  it('keeps null as null in the counts of a vendor whose count is awaited', () => {
    const awaiting = copy(load('worklist-blind')) as { progress: Record<string, unknown> };
    awaiting.progress.received = null;
    awaiting.progress.needs_order = null;
    expect(parseWorklist(awaiting)?.progress).toMatchObject({ received: null, needs_order: null });
  });

  // Break caught: a row of the other mode (a parcel in a list of orders, an order missing from a list of orders), or two rows for one parcel.
  it.each([
    [
      'a parcel row in a list of orders',
      'worklist-blind',
      (list: { items: Record<string, unknown>[] }) => {
        list.items[0] = {
          ...list.items[0],
          parcel: {
            id: '01a124d3-7400-7e71-bd8d-a560d31a60e3',
            ordinal: 1,
            origin: 'DOOR_PHOTO',
            state: 'ARRIVED',
            door_photo_evidence_id: null,
            hub_photo_evidence_id: null,
          },
        };
      },
    ],
    [
      'a row of parcels with no parcel',
      'worklist-photo',
      (list: { items: Record<string, unknown>[] }) => {
        list.items[0] = { ...list.items[0], parcel: null };
      },
    ],
    [
      'a state that says there is an order where there is none',
      'worklist-photo',
      (list: { items: Record<string, unknown>[] }) => {
        list.items[0] = { ...list.items[0], order: null };
      },
    ],
    [
      'two rows for one parcel',
      'worklist-photo',
      (list: { items: Record<string, unknown>[] }) => {
        list.items.push(structuredClone(list.items[0] ?? {}));
      },
    ],
    [
      'an unknown state',
      'worklist-photo',
      (list: { items: Record<string, unknown>[] }) => {
        list.items[0] = { ...list.items[0], work_state: 'DONE' };
      },
    ],
  ])('refuses %s', (_name, fixture, change) => {
    const broken = copy(load(fixture)) as { items: Record<string, unknown>[] };
    change(broken);
    expect(parseWorklist(broken)).toBeUndefined();
  });

  it('refuses an answer that has no counts or has a count that is not a whole number', () => {
    const noCounts = copy(load('worklist-photo')) as Record<string, unknown>;
    delete noCounts.progress;
    expect(parseWorklist(noCounts)).toBeUndefined();
    const fraction = copy(load('worklist-photo')) as { progress: Record<string, unknown> };
    fraction.progress.orders = 1.5;
    expect(parseWorklist(fraction)).toBeUndefined();
  });

  it('tells a row by its parcel, and by its order for a vendor counted without photos', () => {
    const photo = parseWorklist(load('worklist-photo'));
    const blind = parseWorklist(load('worklist-blind'));
    expect(photo?.items.map(workItemKey).every((key) => key.length === 36)).toBe(true);
    expect(blind?.items.map(workItemKey).every((key) => key.length === 36)).toBe(true);
  });
});

describe('what an order would be (the terms the officer reviews)', () => {
  // Break caught: a guard that refuses the real preview, or that drops the digest the save is given back as `reviewed_terms`.
  it('accepts the preview and keeps its digest and its figures as integers of pesewas', () => {
    const terms = parseTerms(load('preview'));
    expect(terms).toBeDefined();
    expect(terms?.terms_token).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(terms?.total.amount_minor)).toBe(true);
    expect(terms?.will_confirm).toBe('ON_CONFIRMATION');
    expect(terms?.destination.outside_service_area).toBe(false);
    expect(terms?.destination.zone_name).not.toBeNull();
    expect(terms?.current).toBeNull();
  });

  it('accepts the preview of an amendment beside the quote the order holds now', () => {
    const terms = parseTerms(load('amend-preview'));
    expect(terms?.order_id).not.toBeNull();
    expect(terms?.order_version).not.toBeNull();
    expect(terms?.current?.total.amount_minor).toBeGreaterThan(0);
    // An amendment confirms nothing, whatever the parcel's state.
    expect(terms?.will_confirm).toBe('WHEN_ARRIVAL_IS_COMMITTED');
  });

  it('accepts the terms that come back when what was reviewed is not what confirming gives', () => {
    const current = detailsOf('save-terms-changed').current_terms;
    expect(parseTerms(current)).toBeDefined();
  });

  // Break caught: a preview with no digest (a save could not be made on it), a digest that is not a SHA-256, a price that is not money, an order named without its version.
  it.each([
    ['no digest', (terms: Record<string, unknown>) => delete terms.terms_token],
    ['a digest of another length', (terms: Record<string, unknown>) => (terms.terms_token = 'abc')],
    [
      'a price that is not money',
      (terms: Record<string, unknown>) =>
        (terms.price = { total: { amount_minor: 3500.5, currency: 'GHS' }, components: [] }),
    ],
    [
      'a price in another currency',
      (terms: Record<string, unknown>) =>
        (terms.price = { total: { amount_minor: 3500, currency: 'USD' }, components: [] }),
    ],
    [
      'an order with no version',
      (terms: Record<string, unknown>) => (terms.order_id = '01a124d3-7400-7e71-bd8d-a560d31a60e3'),
    ],
    [
      'a status other than the current preview',
      (terms: Record<string, unknown>) => (terms.status = 'FROZEN'),
    ],
    [
      'a window of the day with one end',
      (terms: Record<string, unknown>) =>
        (terms.delivery = { ...(terms.delivery as object), window_start: '09:00', window_end: 5 }),
    ],
  ])('refuses %s', (_name, change) => {
    const broken = copy(load('preview')) as Record<string, unknown>;
    change(broken);
    expect(parseTerms(broken)).toBeUndefined();
  });

  // Break caught: a zone that could not be told (the officer is shown nothing to choose from).
  it('reads the zones an address matched with each other, from the refusal, and nothing else of it', () => {
    const candidates = parseCandidates(detailsOf('preview-zone-choice').candidates);
    expect(candidates?.map((zone) => zone.name).toSorted()).toEqual(['Accra Central', 'Tema']);
    expect(parseCandidates([])).toBeUndefined();
    expect(parseCandidates([{ zone_id: 'not-an-id', name: 'Tema' }])).toBeUndefined();
    expect(parseCandidates(undefined)).toBeUndefined();
  });
});

describe('an order', () => {
  it('accepts an order whose price is fixed, with its portions and its history', () => {
    const order = parseOrder(load('order'));
    expect(order?.price_status).toBe('FROZEN');
    expect(order?.locked_price?.amount_minor).toBe(3500);
    expect(order?.payer_allocation).toEqual({ sender_minor: 0, recipient_minor: 3500 });
    expect(order?.recipient?.name).toBe('Ama Mensah');
    expect(order?.amendments).toEqual([]);
  });

  it('accepts an order that waits for its parcel: calculated, not locked, and its quote told apart from a price', () => {
    const order = parseOrder(load('order-early'));
    expect(order?.price_status).toBe('EARLY_QUOTE');
    expect(order?.locked_price).toBeNull();
    expect(order?.calculated_total_minor).toBe(3500);
    expect(order?.intake_parcel_state).toBe('EXPECTED');
  });

  it('accepts an order whose arrival was taken back, with who and why', () => {
    const order = parseOrder(load('order-reversed'));
    expect(order?.commercial_state).toBe('REVERSED');
    expect(order?.reversal?.note).toBe('The parcel was not on the table');
    // The price is kept: a reversal erases nothing.
    expect(order?.locked_price).not.toBeNull();
  });

  // Break caught: an order that says its price is fixed and holds none, or holds one and says it is a quote (a screen would draw two prices as one).
  it('refuses an order that contradicts itself about its price', () => {
    const frozenWithNone = copy(load('order')) as Record<string, unknown>;
    frozenWithNone.locked_price = null;
    expect(parseOrder(frozenWithNone)).toBeUndefined();
    const quoteWithPrice = copy(load('order')) as Record<string, unknown>;
    quoteWithPrice.price_status = 'EARLY_QUOTE';
    expect(parseOrder(quoteWithPrice)).toBeUndefined();
  });

  it('accepts what a save and an amendment answer, as an order', () => {
    expect(parseOrder(load('order-saved'))).toBeDefined();
    expect(parseOrder(load('amend-saved'))).toBeDefined();
  });

  it('refuses an order with a code that is not an operational code, or a size that is not one', () => {
    const code = copy(load('order')) as Record<string, unknown>;
    code.code = 'not a code';
    expect(parseOrder(code)).toBeUndefined();
    const size = copy(load('order')) as Record<string, unknown>;
    size.size_class = 'HUGE';
    expect(parseOrder(size)).toBeUndefined();
  });

  it('accepts what a reversal answers and refuses one that is for no order or leaves the order unreversed', () => {
    expect(parseReversal(load('reversal'))?.parcel_state).toBe('MISSING');
    const notReversed = copy(load('reversal')) as Record<string, unknown>;
    notReversed.commercial_state = 'PRICED';
    expect(parseReversal(notReversed)).toBeUndefined();
  });
});

describe('the close', () => {
  it('accepts what closing finds for a vendor that has parity', () => {
    const closure = parseClosure(load('closure-ready'));
    expect(closure).toMatchObject({
      can_close: true,
      needs_exception: false,
      blockers: [],
      outstanding_count: 0,
    });
  });

  it('accepts what closing finds for a vendor with a parcel left without an order, with the parcel named', () => {
    const closure = parseClosure(load('closure-exception'));
    expect(closure?.needs_exception).toBe(true);
    expect(closure?.can_close).toBe(false);
    expect(closure?.outstanding_count).toBe(1);
    expect(closure?.outstanding_parcels).toHaveLength(1);
    expect(closure?.assessment_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a closure read after the close, with the reason that was given', () => {
    const closure = parseClosure(load('closure-closed'));
    expect(closure?.closed_at).not.toBeNull();
    expect(closure?.parity_exception_note).toBe('One parcel is on the rider’s bike');
  });

  it('accepts the assessment that comes back when what closing finds is not what the senior read', () => {
    const current = detailsOf('close-assessment-changed').current_assessment;
    const closure = parseClosure(current);
    expect(closure?.ordered).toBe(3);
    expect(closure?.can_close).toBe(true);
  });

  // Break caught: a closure with no digest (the exception could not be closed against what the senior read), or a count that is negative or a blocker that is not one.
  it.each([
    ['no digest', (closure: Record<string, unknown>) => delete closure.assessment_token],
    ['a negative count', (closure: Record<string, unknown>) => (closure.ordered = -1)],
    [
      'a blocker that is not one',
      (closure: Record<string, unknown>) => (closure.blockers = ['because']),
    ],
    [
      'a parcel named twice',
      (closure: Record<string, unknown>) => {
        const parcels = closure.outstanding_parcels as unknown[];
        closure.outstanding_parcels = [...parcels, ...parcels];
      },
    ],
  ])('refuses %s', (_name, change) => {
    const broken = copy(load('closure-exception')) as Record<string, unknown>;
    change(broken);
    expect(parseClosure(broken)).toBeUndefined();
  });

  it('believes only that a closed vendor is closed', () => {
    expect(parseClosed(load('close-parity'))?.id).toBeDefined();
    expect(
      parseClosed({ id: '01a124d3-7400-7e71-bd8d-a560d31a60e3', state: 'ITEMIZING' }),
    ).toBeUndefined();
  });

  it('accepts the closes that left work, newest first, and none that has nothing left', () => {
    const page = parseClosedExceptionPage(load('closed-exceptions'));
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0]?.outstanding_count).toBe(1);
    const none = copy(load('closed-exceptions')) as { items: { outstanding_count: number }[] };
    none.items[0] = { ...none.items[0], outstanding_count: 0 };
    expect(parseClosedExceptionPage(none)).toBeUndefined();
  });
});

describe('the summary of a closed vendor', () => {
  // Break caught: a price drawn for a reader who was not given one, or a price that was given and is lost.
  it('keeps a price where the server gave one and none where it did not', () => {
    const officer = parseSummary(load('summary-officer'));
    expect(officer?.orders.every((order) => order.locked_price?.amount_minor === 3500)).toBe(true);
    const reader = parseSummary(load('summary-no-price'));
    expect(reader?.orders).toHaveLength(2);
    expect(reader?.orders.every((order) => order.locked_price === null)).toBe(true);
  });

  it('refuses a summary with a price that is not money, or the same order twice', () => {
    const bad = copy(load('summary-officer')) as { orders: Record<string, unknown>[] };
    bad.orders[0] = { ...bad.orders[0], locked_price: { amount_minor: 'free', currency: 'GHS' } };
    expect(parseSummary(bad)).toBeUndefined();
    const twice = copy(load('summary-officer')) as { orders: Record<string, unknown>[] };
    twice.orders.push(structuredClone(twice.orders[0] ?? {}));
    expect(parseSummary(twice)).toBeUndefined();
  });
});

describe('who pays after the price is fixed', () => {
  it('accepts a correction as it was asked for, in actual amounts, and as it was decided', () => {
    const asked = parseCorrection(load('correction'));
    expect(asked).toMatchObject({
      state: 'REQUESTED',
      proposed_commercial_state: 'PAYMENT_REQUIRED',
    });
    expect(asked?.proposed_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    expect(asked?.total?.amount_minor).toBe(3500);
    const decided = parseCorrection(load('correction-decided'));
    expect(decided?.state).toBe('APPROVED');
    expect(decided?.resulting_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
  });

  it('accepts the queue of corrections', () => {
    expect(parseCorrectionPage(load('corrections-list'))?.items.length).toBeGreaterThan(0);
  });

  // Break caught: an approval that carries no result (a decision that says nothing of what it did), or a correction not yet decided that says it was.
  it('refuses a correction that contradicts its state', () => {
    const noResult = copy(load('correction-decided')) as Record<string, unknown>;
    noResult.resulting_allocation = null;
    expect(parseCorrection(noResult)).toBeUndefined();
    const early = copy(load('correction')) as Record<string, unknown>;
    early.decided_at = '2026-11-22T10:00:00.000Z';
    expect(parseCorrection(early)).toBeUndefined();
  });
});

describe('the vendors a hub has cleared for their orders', () => {
  it('accepts a vendor checked in against photos, and keeps what the list says of it', () => {
    const page = parseIntakeListPage(load('intakes-itemizing'));
    expect(page?.items.length).toBeGreaterThan(0);
    expect(page?.items[0]).toMatchObject({ mode: 'PHOTO_CHECK_IN', state: 'ITEMIZING' });
    expect(page?.items[0]?.vendor_name).not.toBeNull();
  });

  it('accepts the vendors that are ready for their first order', () => {
    expect(
      parseIntakeListPage(load('intakes-ready'))?.items.every(
        (item) => item.state === 'READY_FOR_ITEMIZATION',
      ),
    ).toBe(true);
  });

  // Break caught: a vendor that is not cleared for orders in a list of those that are.
  it('refuses a vendor that is not cleared for orders', () => {
    const page = copy(load('intakes-itemizing')) as { items: Record<string, unknown>[] };
    page.items[0] = { ...page.items[0], state: 'AWAITING_COUNT' };
    expect(parseIntakeListPage(page)).toBeUndefined();
  });
});
