import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { serverError } from '../test-support/fake-pg.js';
import { ApiException } from '../platform/http/api-exception.js';
import { reasonOfAnotherCategory, reasonRefusedByGuard } from './pickup-reason-validation.js';

/** A check violation as the server sends it, with the DETAIL a guard trigger gave it. */
function refusal(detail: string | undefined, code = '23514'): pg.DatabaseError {
  const error = serverError(
    code,
    'the reason of a short count is an active reason of the catalogue',
  );
  if (detail !== undefined) error.detail = detail;
  return error;
}

/**
 * The answer to a reason that the record's guard refused after the validator accepted it (OB-S1-60, migration 0069): the catalogue changed between the
 * act's reading of the reason and its insert. It is the contract's own error, the one the validator gives, and never a server error.
 */
describe('reasonRefusedByGuard', () => {
  // Break caught: the guard's refusal answered as a server error (the act would end in a 500 on a catalogue edit), or the two reasons swapped.
  it.each([
    ['REASON_NOT_ACTIVE', 'REASON_NOT_ACTIVE', 422],
    ['REASON_REQUIRED', 'REASON_REQUIRED', 422],
  ] as const)('answers %s as the contract’s error of that name', (word, code, status) => {
    const answer = reasonRefusedByGuard(refusal(`reason=${word}`));
    expect(answer).toBeInstanceOf(ApiException);
    expect(answer?.getStatus()).toBe(status);
    expect(answer?.code).toBe(code);
  });

  // Break caught (D-A4): a failure reported under a category its reason does not belong to, refused by the stop's guard after the service let it through (the catalogue changed between
  // the reading and the write), answered as a server error, or as a reason that is not active (the reason is fine: the pairing is the field at fault).
  it('answers REASON_CATEGORY_MISMATCH as a validation failure at the reason, rule category', () => {
    const answer = reasonRefusedByGuard(refusal('reason=REASON_CATEGORY_MISMATCH'));
    expect(answer).toBeInstanceOf(ApiException);
    expect(answer?.getStatus()).toBe(400);
    expect(answer?.code).toBe('VALIDATION_FAILED');
    expect(answer?.details).toEqual({
      violations: [{ in: 'body', pointer: '/reason_code', rule: 'category' }],
    });
    expect(reasonOfAnotherCategory().details).toEqual(answer?.details);
  });

  // Break caught: the reason found through the wrappers the driver puts around the server's error, as the stores of the platform read it.
  it('finds the refusal through the wrappers a driver puts around the server’s error', () => {
    const wrapped = new Error('Failed query', { cause: refusal('reason=REASON_NOT_ACTIVE') });
    expect(
      reasonRefusedByGuard(new Error('transaction failed', { cause: wrapped })),
    ).toBeInstanceOf(ApiException);
  });

  // Break caught: every other failure answered as a reason (a check violation with no stated reason, another reason word, another SQLSTATE, a plain error),
  // which would hide a defect behind a 422 or send a client to fix a reason that is not the problem.
  it.each([
    ['a check violation that states no reason', refusal(undefined)],
    ['another reason word', refusal('reason=GRANT_EXPIRED')],
    ['another SQLSTATE', refusal('reason=REASON_NOT_ACTIVE', '23505')],
    ['loose text', refusal('Key (id)=(1) reason=REASON_NOT_ACTIVE')],
    ['an error that is not the server’s', new Error('reason=REASON_NOT_ACTIVE')],
    ['nothing at all', undefined],
  ] as const)('answers %s as nothing, for the caller to rethrow', (_what, error) => {
    expect(reasonRefusedByGuard(error)).toBeUndefined();
  });

  it('gives the caller’s details to the answer', () => {
    const answer = reasonRefusedByGuard(refusal('reason=REASON_REQUIRED'), { rule: 'photo' });
    expect(answer?.details).toEqual({ rule: 'photo' });
  });
});
