import { describe, expect, it } from 'vitest';

import { ApiException } from '../platform/http/api-exception.js';
import { weekdayOf } from '../pricing/price-calculation.js';
import {
  declarationOf,
  nextOperatingDay,
  payerOf,
  requireMinimum,
  requireServiceDay,
  type PayerInput,
} from './booking-rules.js';

/**
 * The rules of a booking that need no database (S1.14; pickup-request.md sections 5.1 and 5.2; domain-model.md section 6.2). Each takes
 * what the request said and what the hub's settings are and answers or refuses with the code the catalogue names.
 */
const refusal = (run: () => unknown): ApiException => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    return error as ApiException;
  }
  throw new Error('expected the rule to refuse');
};
const violationsOf = (error: ApiException): readonly { pointer?: string; rule?: string }[] =>
  (error.details?.violations ?? []) as readonly { pointer?: string; rule?: string }[];

describe('the service day', () => {
  // Break caught: a Sunday accepted (the calendar is Monday to Saturday, uniform: MSC-DEC-149), or a weekday refused.
  it.each(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])(
    'accepts %s, Monday to Saturday',
    (date) => {
      expect(() => {
        requireServiceDay(date);
      }).not.toThrow();
    },
  );

  it('refuses a Sunday as SERVICE_DATE_NOT_PERMITTED', () => {
    const error = refusal(() => {
      requireServiceDay('2026-11-08');
    });
    expect(error.code).toBe('SERVICE_DATE_NOT_PERMITTED');
    expect(error.getStatus()).toBe(422);
  });
});

describe('the minimum of two packages (AC-SLICE-001-02)', () => {
  // Break caught: a vendor booking one package, which self-service bars (the exception path is Ops'); or Ops barred from creating the
  // one-package request that then waits for its exception.
  it('refuses a vendor with fewer than two packages, and lets Ops create a request for one', () => {
    expect(
      refusal(() => {
        requireMinimum('VENDOR', 1);
      }).code,
    ).toBe('PICKUP_MINIMUM_NOT_MET');
    expect(() => {
      requireMinimum('VENDOR', 2);
    }).not.toThrow();
    expect(() => {
      requireMinimum('VENDOR', 40);
    }).not.toThrow();
    expect(() => {
      requireMinimum('STAFF', 1);
    }).not.toThrow();
    expect(() => {
      requireMinimum('STAFF', 2);
    }).not.toThrow();
  });
});

describe('the payer arrangement (intent only; domain-model.md section 6.2)', () => {
  const base = (over: Partial<PayerInput> = {}): PayerInput => ({
    default_payer_intent: 'RECIPIENT_PAYS',
    ...over,
  });

  it.each(['RECIPIENT_PAYS', 'SENDER_PAYS_FULL'] as const)('takes %s with no split', (intent) => {
    expect(payerOf(base({ default_payer_intent: intent }))).toEqual({
      default_payer_intent: intent,
      split_basis: null,
      split_sender_amount_minor: null,
      split_sender_percentage: null,
    });
  });

  it('takes a split by a fixed amount, in pesewas', () => {
    expect(
      payerOf(
        base({
          default_payer_intent: 'SPLIT',
          split_basis: 'FIXED_AMOUNT',
          split_sender_amount: { amount_minor: 1500, currency: 'GHS' },
        }),
      ),
    ).toEqual({
      default_payer_intent: 'SPLIT',
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount_minor: 1500,
      split_sender_percentage: null,
    });
  });

  it('takes a split by a percentage', () => {
    expect(
      payerOf(
        base({
          default_payer_intent: 'SPLIT',
          split_basis: 'PERCENTAGE',
          split_sender_percentage: 40,
        }),
      ),
    ).toMatchObject({
      split_basis: 'PERCENTAGE',
      split_sender_percentage: 40,
      split_sender_amount_minor: null,
    });
  });

  // Break caught: a split that names no basis or the wrong figure (the server would then divide a price by a guess), and a split figure
  // sent with an arrangement that has no split (a field that decides nothing and is stored as if it did).
  it.each([
    ['a split with no basis', { default_payer_intent: 'SPLIT' }, '/split_basis'],
    [
      'a fixed split with no amount',
      { default_payer_intent: 'SPLIT', split_basis: 'FIXED_AMOUNT' },
      '/split_sender_amount',
    ],
    [
      'a fixed split that also names a percentage',
      {
        default_payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: 100, currency: 'GHS' },
        split_sender_percentage: 10,
      },
      '/split_sender_percentage',
    ],
    [
      'a percentage split with no percentage',
      { default_payer_intent: 'SPLIT', split_basis: 'PERCENTAGE' },
      '/split_sender_percentage',
    ],
    [
      'a percentage split that also names an amount',
      {
        default_payer_intent: 'SPLIT',
        split_basis: 'PERCENTAGE',
        split_sender_percentage: 10,
        split_sender_amount: { amount_minor: 100, currency: 'GHS' },
      },
      '/split_sender_amount',
    ],
    ['a basis with no split', { split_basis: 'PERCENTAGE' }, '/split_basis'],
    [
      'an amount with no split',
      { split_sender_amount: { amount_minor: 100, currency: 'GHS' } },
      '/split_sender_amount',
    ],
    ['a percentage with no split', { split_sender_percentage: 10 }, '/split_sender_percentage'],
    [
      'a negative amount',
      {
        default_payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: -1, currency: 'GHS' },
      },
      '/split_sender_amount',
    ],
    [
      'a fractional amount',
      {
        default_payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: 10.5, currency: 'GHS' },
      },
      '/split_sender_amount',
    ],
  ] as const)('refuses %s as a validation failure naming the field', (_label, over, pointer) => {
    const error = refusal(() => payerOf(base(over)));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.getStatus()).toBe(400);
    expect(violationsOf(error).map((each) => each.pointer)).toContain(pointer);
  });
});

describe('the declared value and the liability cap (AC-SLICE-001-81)', () => {
  const THRESHOLD = 50_000;

  // Break caught: a declaration above the threshold accepted without the acknowledgement (the customer learns the cap after a loss), or
  // at or below it refused for lack of one.
  it('needs the acknowledgement above the threshold, and not at or below it', () => {
    expect(refusal(() => declarationOf(50_001, undefined, THRESHOLD)).code).toBe(
      'VALUE_DECLARATION_REQUIRED',
    );
    expect(refusal(() => declarationOf(50_001, false, THRESHOLD)).code).toBe(
      'VALUE_DECLARATION_REQUIRED',
    );
    expect(declarationOf(50_001, true, THRESHOLD)).toEqual({ acknowledged: true });
    expect(declarationOf(50_000, undefined, THRESHOLD)).toEqual({ acknowledged: false });
    expect(declarationOf(0, undefined, THRESHOLD)).toEqual({ acknowledged: false });
    expect(declarationOf(undefined, undefined, THRESHOLD)).toEqual({ acknowledged: false });
  });

  // Break caught: an acknowledgement given for a value at or below the threshold being thrown away (the customer did acknowledge it), or
  // an acknowledgement given with no value declared being recorded as if it were about something.
  it('records an acknowledgement given when none was needed, and refuses one given with nothing declared', () => {
    expect(declarationOf(100, true, THRESHOLD)).toEqual({ acknowledged: true });
    const error = refusal(() => declarationOf(undefined, true, THRESHOLD));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(violationsOf(error).map((each) => each.pointer)).toContain(
      '/liability_cap_acknowledged',
    );
  });

  it('refuses a declared value that is not a whole number of pesewas', () => {
    for (const value of [-1, 1.5, Number.NaN]) {
      const error = refusal(() => declarationOf(value, true, THRESHOLD));
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(violationsOf(error).map((each) => each.pointer)).toContain('/declared_value_minor');
    }
  });
});

describe('the next operating day (resolveCutoffException, RESCHEDULE_NEXT_DAY)', () => {
  // Break caught: a late booking rescheduled to a Sunday (the hub does not operate), or by two days on a weekday.
  it.each([
    ['2026-11-02', '2026-11-03'],
    ['2026-11-05', '2026-11-06'],
    ['2026-11-06', '2026-11-07'],
    ['2026-11-07', '2026-11-09'],
    ['2026-11-08', '2026-11-09'],
    ['2026-12-31', '2027-01-01'],
    ['2028-02-28', '2028-02-29'],
  ])('is %s after %s', (from, expected) => {
    expect(nextOperatingDay(from)).toBe(expected);
  });

  it('is never a Sunday, whichever day it starts from', () => {
    let day = '2026-11-02';
    for (let step = 0; step < 60; step += 1) {
      const next = nextOperatingDay(day);
      expect(weekdayOf(next), `after ${day}`).not.toBe('SUN');
      expect(next > day).toBe(true);
      day = next;
    }
  });
});
