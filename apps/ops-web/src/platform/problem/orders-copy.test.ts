import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { everyOrdersWord, ORDERS_COPY, ORDERS_WORDS } from './orders-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/** What no floor screen says: the words of the people who built the system (OB-S1-111), and the token that is a digest of a review. */
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|server|terms_token|assessment_token|token)\b/i;
/** A permission key as the catalogue writes it, or the name of a role. */
const KEY_OR_ROLE =
  /\b(?:(?:hub|pricing|pickup|notification|staff|dispatch|vendor|permission)\.[a-z_]+(?:\.[a-z_]+)*|Ops Staff|Platform Admin|Senior Ops|Hub Manager)\b/;

/**
 * The words of the order screens (S1.40), in the one table the Ops Portal keeps. The tests pin that every rule is in the table the screens read and is for an operation they call, that each refused act names its
 * own capability and no key or role, that **what a senior officer decides is never answered with "ask an administrator"** (OB-S1-111), that a conflict which declares a rule is worded by the rule, and that
 * **no wording, whether a rule or a word a screen draws, speaks in the voice of the system's builders** (*intake*, *adjudicate*, *itemise*, *reconciliation*, *advisory lock*, *the server*, a token). Each break named below
 * is one these tests catch.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });
const conflict = (rule: string | undefined): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], rule === undefined ? {} : { rule });
const invalid = (pointer: string, rule = 'format'): OperationFailure =>
  new OperationFailure(refused('VALIDATION_FAILED', 400), [{ in: 'body', pointer, rule }]);
const invalidWith = (rule: string): OperationFailure =>
  new OperationFailure(refused('VALIDATION_FAILED', 400), [], { rule });
const unprocessable = (code: string, rule?: string): OperationFailure =>
  new OperationFailure(refused(code, 422), [], rule === undefined ? {} : { rule });

const OPERATIONS = [
  'listIntakeOrders',
  'previewOrder',
  'itemizeOrder',
  'previewOrderAmendment',
  'amendOrder',
  'getOrder',
  'reverseOrderArrival',
  'requestPayerCorrection',
  'listPayerCorrections',
  'getPayerCorrection',
  'approvePayerCorrection',
  'getIntakeClosure',
  'closeHubIntake',
  'getIntakeSummary',
  'listClosedIntakeExceptions',
  'listHubIntakes',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of ORDERS_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation these screens do not call', () => {
    for (const rule of ORDERS_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  // Break caught: an operation of these screens with no words of its own, so a refusal of it is told as a generic failure.
  it('has words for every operation of these screens', () => {
    for (const operation of OPERATIONS) {
      expect(
        ORDERS_COPY.some(
          (rule) =>
            rule.operation === operation && rule.code === undefined && rule.context === undefined,
        ),
        operation,
      ).toBe(true);
    }
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = ORDERS_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(PROBLEM_COPY.filter((rule) => !ORDERS_COPY.includes(rule)).map(place));
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key, or the wrong act, so that an administrator is asked to grant the wrong access.
  it.each([
    ['listIntakeOrders', /see what has been handed over at a hub/],
    ['listHubIntakes', /see what has been handed over at a hub/],
    ['previewOrder', /make orders for the parcels received at a hub/],
    ['itemizeOrder', /make orders for the parcels received at a hub/],
    ['previewOrderAmendment', /make orders for the parcels received at a hub/],
    ['amendOrder', /make orders for the parcels received at a hub/],
    ['getOrder', /see the price of an order/],
    ['requestPayerCorrection', /ask for a change of who pays for an order/],
    ['listPayerCorrections', /ask for a change of who pays for an order/],
    ['getPayerCorrection', /ask for a change of who pays for an order/],
    ['getIntakeClosure', /close a vendor once its orders are made/],
    ['closeHubIntake', /close a vendor once its orders are made/],
    ['getIntakeSummary', /see pickup requests/],
    ['listClosedIntakeExceptions', /close a vendor that still has parcels without an order/],
  ])('names the capability of %s and never a key', (operation, words) => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
    expect(message).toMatch(words);
    expect(message).not.toMatch(KEY_OR_ROLE);
  });

  // Break caught: a decision refused to an officer who is told to ask an administrator for access: a senior officer decides, and an administrator cannot decide for them (OB-S1-111).
  it.each([
    ['reverseOrderArrival', 'A senior officer takes back an arrival. Ask one to do it.'],
    ['approvePayerCorrection', 'A senior officer decides this. Ask one to open this page.'],
  ])(
    'tells an officer without the decision of %s that a senior officer makes it, and never to ask an administrator',
    (operation, words) => {
      const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
      expect(message).toBe(words);
      expect(message).not.toMatch(/administrator/i);
    },
  );

  it.each(OPERATIONS)(
    'tells a hub that is not the account’s, for %s, as one, with no hub named',
    (operation) => {
      const rule = ORDERS_COPY.find(
        (each) => each.operation === operation && each.code === 'HUB_SCOPE_VIOLATION',
      );
      // Every read and act of an order or a vendor says it; the lists are scoped by the server, so they have none.
      if (rule === undefined) {
        expect([
          'listPayerCorrections',
          'getPayerCorrection',
          'approvePayerCorrection',
          'requestPayerCorrection',
          'listHubIntakes',
          'listClosedIntakeExceptions',
        ]).toContain(operation);
        return;
      }
      expect(rule.text).toMatch(/at a hub your account does not work in/);
    },
  );
});

describe('the words of the conflicts', () => {
  it.each([
    [
      'previewOrder',
      'stale',
      /This vendor changed while you were working\. Your entries are kept\./,
    ],
    [
      'itemizeOrder',
      'stale',
      /This vendor changed while you were working\. Your entries are kept\./,
    ],
    [
      'itemizeOrder',
      'terms_changed',
      /The price or the terms changed while you were looking at them\./,
    ],
    [
      'itemizeOrder',
      'configuration_changing',
      /prices are being changed at the moment, so nothing was saved/,
    ],
    ['itemizeOrder', 'parcel_ordered', /already has an order/],
    ['itemizeOrder', 'parcel_missing', /is missing, so it cannot be ordered/],
    ['itemizeOrder', 'parcel_void', /was taken back, so it has no order/],
    ['itemizeOrder', 'orders_exceed_received', /Every parcel received already has an order/],
    ['itemizeOrder', 'check_in_open', /still being checked in/],
    ['itemizeOrder', 'reconciliation_open', /waiting for a senior officer to decide/],
    ['itemizeOrder', 'intake_not_ready', /not cleared for orders yet/],
    ['itemizeOrder', 'intake_closed', /vendor is closed/],
    [
      'amendOrder',
      'order_confirmed',
      /is confirmed, so it cannot be changed here\. To change who pays, ask for a correction\./,
    ],
    ['amendOrder', 'price_frozen', /already fixed, so this cannot be changed here/],
    ['amendOrder', 'terms_changed', /The price or the terms changed/],
    ['reverseOrderArrival', 'stale', /changed after you opened it, so nothing was changed/],
    [
      'reverseOrderArrival',
      'order_not_confirmed',
      /not confirmed yet, so there is no arrival to take back/,
    ],
    ['reverseOrderArrival', 'order_progressed', /paid for or reserved/],
    ['reverseOrderArrival', 'order_dispatched', /gone out for delivery/],
    ['reverseOrderArrival', 'already_reversed', /already taken back/],
    [
      'reverseOrderArrival',
      'correction_open',
      /waiting for a decision on this order\. Decide it first/,
    ],
    ['reverseOrderArrival', 'intake_closed', /vendor is closed/],
    [
      'reverseOrderArrival',
      'blind_count_intake',
      /counted without photos, so there is no parcel to take back/,
    ],
  ])('words %s by the rule %s', (operation, rule, words) => {
    expect(problemOf(conflict(rule), { operation }).message).toMatch(words);
  });

  // Break caught: a refusal about one field of an order told as a banner that never names what to change, or a rule of the API shown as it is.
  it.each([
    [
      'previewOrder',
      unprocessable('SIZE_CLASS_REQUIRED'),
      /Choose the size of the parcel\. Nothing is chosen for you\./,
    ],
    [
      'previewOrder',
      unprocessable('VALUE_DECLARATION_REQUIRED'),
      /needs the sender’s agreement to the liability limit/,
    ],
    [
      'previewOrder',
      unprocessable('CARRIER_COST_REQUIRED'),
      /Enter the carrier’s charge from the waybill/,
    ],
    [
      'previewOrder',
      unprocessable('MARGIN_NOT_CONFIGURED'),
      /no margin set for parcels sent outside its area/,
    ],
    ['previewOrder', unprocessable('SERVICE_DATE_NOT_PERMITTED'), /We do not deliver on that day/],
    ['previewOrder', unprocessable('SETTING_MISSING'), /no price set for this order yet/],
    [
      'previewOrder',
      unprocessable('SETTING_MISSING', 'destination_zone_unresolved'),
      /does not match a zone of this hub/,
    ],
    [
      'previewOrder',
      invalidWith('destination_zone_ambiguous'),
      /matches more than one zone\. Choose the right one\./,
    ],
    ['previewOrder', invalidWith('destination_zone_not_available'), /not one this hub delivers to/],
    [
      'previewOrder',
      invalidWith('requested_before_default'),
      /earlier than the first day we can deliver/,
    ],
    ['previewOrder', invalidWith('parcel_required'), /Choose the parcel this order is for\./],
    [
      'previewOrder',
      invalidWith('parcel_not_allowed'),
      /counted without photos, so an order is not made for a parcel/,
    ],
    [
      'previewOrderAmendment',
      invalidWith('no_change'),
      /Nothing was changed\. Change something, or go back\./,
    ],
  ])('words the refusal of %s', (operation, failure, words) => {
    expect(problemOf(failure, { operation }).message).toMatch(words);
  });

  // Break caught: a note the ledger would not keep repeated back to the officer, or told without saying what to change.
  it.each(['reverseOrderArrival', 'approvePayerCorrection'])(
    'tells a refused note of %s at the note and never repeats it',
    (operation) => {
      expect(problemOf(invalid('/note'), { operation }).message).toBe(
        'Check the note marked below: it was not accepted as written.',
      );
    },
  );

  // The request of a change has a proposal and a reason, so its refusal points at the fields; the form of an order ties a refusal to the field the server named (`refusedFields`).
  it('tells a refused request of a change at its fields, and never repeats what was written', () => {
    expect(problemOf(invalid('/note'), { operation: 'requestPayerCorrection' }).message).toMatch(
      /fields marked below/,
    );
  });

  // Break caught: an operation whose conflict with no rule is told as a bare failure, with nothing to do next.
  it.each([
    'previewOrder',
    'itemizeOrder',
    'amendOrder',
    'reverseOrderArrival',
    'approvePayerCorrection',
  ])('tells any other conflict of %s in words of its own, with what to do next', (operation) => {
    expect(problemOf(conflict(undefined), { operation }).message).toMatch(
      /Reload|Check the price again/,
    );
  });

  it('tells a lost answer to a request that clashed as one to look at, never to send again', () => {
    for (const operation of ['itemizeOrder', 'amendOrder']) {
      expect(problemOf(refused('IDEMPOTENCY_KEY_CONFLICT', 409), { operation }).message).toMatch(
        /Look at the orders before you try again/,
      );
    }
  });
});

describe('the voice of the floor', () => {
  /** Every function of the words, drawn with the sample figures it could be given: its text is a word a screen draws as much as a string is. */
  const SAMPLES: readonly (readonly unknown[])[] = [
    ['ACC-OR-ABC123'],
    ['Kente Crafts'],
    [0],
    [1],
    [3],
    [null],
    ['GH₵10.00', 'GH₵25.00'],
    ['the recipient and the size'],
  ];
  function drawn(value: unknown, into: string[]): void {
    if (typeof value === 'string') into.push(value);
    else if (typeof value === 'function') {
      for (const args of SAMPLES) {
        try {
          const text: unknown = (value as (...given: unknown[]) => unknown)(...args);
          if (typeof text === 'string') into.push(text);
        } catch {
          // A function of another kind of figure: the samples above are not its.
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const member of Object.values(value)) drawn(member, into);
    }
  }
  const everything = (): readonly string[] => {
    const found: string[] = [...everyOrdersWord()];
    drawn(ORDERS_WORDS, found);
    return found;
  };

  // Break caught (OB-S1-111): a word of the system's builders on a floor screen.
  it('has no word the floor does not use, in any rule or in any word a screen draws', () => {
    const words = everything();
    expect(words.length).toBeGreaterThan(300);
    for (const text of words) expect(text, text).not.toMatch(FORBIDDEN);
  });

  // Break caught: wording that names a key or a role.
  it('names no key and no role', () => {
    for (const text of everything()) expect(text, text).not.toMatch(KEY_OR_ROLE);
  });

  // Break caught: a function of the words that draws nothing for a figure it is given (an empty cell on a screen).
  it('draws a sentence for the figures its functions are given', () => {
    expect(ORDERS_WORDS.common.orders(1)).toBe('1 order');
    expect(ORDERS_WORDS.common.orders(3)).toBe('3 orders');
    expect(ORDERS_WORDS.record.reverseDone(2)).toBe(
      'The arrival was taken back. The vendor now counts 2 parcels received and is back in review.',
    );
    expect(ORDERS_WORDS.record.history.amended('the size')).toBe('Changed: the size.');
    expect(ORDERS_WORDS.corrections.amounts('GH₵10.00', 'GH₵25.00')).toBe(
      'The sender pays GH₵10.00 and the recipient pays GH₵25.00.',
    );
    expect(ORDERS_WORDS.toMake.received(null)).toBe('Not counted');
    expect(ORDERS_WORDS.toMake.received(1)).toBe('1 parcel');
    expect(ORDERS_WORDS.closedExceptions.stillCount(1)).toBe('1 parcel');
    expect(ORDERS_WORDS.summary.title(undefined)).toBe('Summary');
    expect(ORDERS_WORDS.summary.title('Kente Crafts')).toBe('Summary for Kente Crafts');
  });

  // Break caught: a message of the log named in the system's word on the summary, which draws it.
  it('words the close of a vendor as a check-in, in the log the summary draws', async () => {
    const { MESSAGE_KIND_LABELS } = await import('../../app/pages/messages/message-presentation');
    expect(MESSAGE_KIND_LABELS.INTAKE_COMPLETED_SENDER).toBe('Check-in finished');
    expect(MESSAGE_KIND_LABELS.INTAKE_COMPLETED_VENDOR_FEED).toBe('Check-in finished');
  });
});
