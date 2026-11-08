import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { weekdayOf } from '../pricing/price-calculation.js';

/**
 * The rules of a booking that need no database (S1.14; pickup-request.md sections 5.1 and 5.2; domain-model.md section 6.2). Each takes
 * what the request said, and the hub's settings where one decides, and answers or refuses with the code the catalogue names. The
 * schema of the contract has already decided what it can (shapes, enums, the intents' required members); these are the rules it cannot.
 */

const violation = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * The service day: Monday to Saturday, uniformly (section 21.1, `MSC-DEC-149`: "every zone operates the same Monday–Saturday calendar").
 * A Sunday is `SERVICE_DATE_NOT_PERMITTED`. The date is a calendar day with no time zone, read as the day it names.
 */
export function requireServiceDay(date: string): void {
  if (weekdayOf(date) === 'SUN') {
    throw ApiException.of(ErrorCode.ServiceDateNotPermitted, 'Pickups are made Monday to Saturday');
  }
}

/**
 * The minimum of two packages (section 21.1, section 35.2.3). A vendor books two or more: a single package is barred from self-service.
 * Ops may create a request for one, which then waits for its one-package exception and cannot be confirmed before it (the exception path
 * is `SLICE-001`'s `requestOnePackageException`). An ad-hoc sender has no session: its requests are Ops's.
 */
export function requireMinimum(principalType: 'STAFF' | 'VENDOR', packages: number): void {
  if (principalType === 'VENDOR' && packages < 2) {
    throw ApiException.of(
      ErrorCode.PickupMinimumNotMet,
      'A pickup is at least two packages; a single package needs an approved exception requested by the office',
    );
  }
}

/**
 * The next day the hub operates after a calendar day (section 21.1: Monday to Saturday): the day after it, and the Monday after a Saturday
 * or a Sunday. The cutoff exception's "reschedule to the next day" moves the pickup here, so it never names a Sunday. A calendar date has
 * no time zone, so this is date arithmetic in UTC.
 */
export function nextOperatingDay(date: string): string {
  // Reads the date first, so that what is not a calendar date is refused rather than rolled into one.
  weekdayOf(date);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  if (next.getUTCDay() === 0) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export interface PayerInput {
  readonly default_payer_intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT';
  readonly split_basis?: 'FIXED_AMOUNT' | 'PERCENTAGE';
  readonly split_sender_amount?: { readonly amount_minor: number; readonly currency: string };
  readonly split_sender_percentage?: number;
}

export interface PayerColumns {
  readonly default_payer_intent: PayerInput['default_payer_intent'];
  readonly split_basis: 'FIXED_AMOUNT' | 'PERCENTAGE' | null;
  readonly split_sender_amount_minor: number | null;
  readonly split_sender_percentage: number | null;
}

/**
 * The payer arrangement, **intent only** (section 5.2.1: a standard request "does not yet contain parcel destinations or authoritative
 * prices"): `SPLIT` names its basis and exactly the figure of that basis; any other arrangement carries no split member at all. A member
 * that decides nothing is refused and not stored as if it did.
 */
export function payerOf(input: PayerInput): PayerColumns {
  const split = input.default_payer_intent === 'SPLIT';
  const amount = input.split_sender_amount;
  const percentage = input.split_sender_percentage;
  if (!split) {
    if (input.split_basis !== undefined) throw violation('/split_basis', 'unexpected');
    if (amount !== undefined) throw violation('/split_sender_amount', 'unexpected');
    if (percentage !== undefined) throw violation('/split_sender_percentage', 'unexpected');
    return {
      default_payer_intent: input.default_payer_intent,
      split_basis: null,
      split_sender_amount_minor: null,
      split_sender_percentage: null,
    };
  }
  if (input.split_basis === undefined) throw violation('/split_basis', 'required');
  if (input.split_basis === 'FIXED_AMOUNT') {
    if (amount === undefined) throw violation('/split_sender_amount', 'required');
    if (percentage !== undefined) throw violation('/split_sender_percentage', 'unexpected');
    if (!Number.isSafeInteger(amount.amount_minor) || amount.amount_minor < 0) {
      throw violation('/split_sender_amount', 'format');
    }
    return {
      default_payer_intent: 'SPLIT',
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount_minor: amount.amount_minor,
      split_sender_percentage: null,
    };
  }
  if (percentage === undefined) throw violation('/split_sender_percentage', 'required');
  if (amount !== undefined) throw violation('/split_sender_amount', 'unexpected');
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw violation('/split_sender_percentage', 'range');
  }
  return {
    default_payer_intent: 'SPLIT',
    split_basis: 'PERCENTAGE',
    split_sender_amount_minor: null,
    split_sender_percentage: percentage,
  };
}

/**
 * The declared value and the liability-cap acknowledgement (section 23.4, `MSC-DEC-212`, `MSC-DEC-220`; `AC-SLICE-001-81`). A value above
 * `value_declaration_threshold` needs the acknowledgement that liability is capped regardless of it: `VALUE_DECLARATION_REQUIRED`
 * otherwise. At or below the threshold none is needed, and one given anyway is recorded (the customer did acknowledge it). An
 * acknowledgement with no declared value is about nothing and is refused. Returns whether the booking records an acknowledgement.
 */
export function declarationOf(
  declaredValueMinor: number | undefined,
  acknowledged: boolean | undefined,
  thresholdMinor: number,
): { readonly acknowledged: boolean } {
  if (
    declaredValueMinor !== undefined &&
    (!Number.isSafeInteger(declaredValueMinor) || declaredValueMinor < 0)
  ) {
    throw violation('/declared_value_minor', 'format');
  }
  if (declaredValueMinor === undefined) {
    if (acknowledged === true) throw violation('/liability_cap_acknowledged', 'unexpected');
    return { acknowledged: false };
  }
  if (declaredValueMinor > thresholdMinor && acknowledged !== true) {
    throw ApiException.of(
      ErrorCode.ValueDeclarationRequired,
      'A declared value above the threshold needs the liability-cap acknowledgement at booking',
    );
  }
  return { acknowledged: acknowledged === true };
}
