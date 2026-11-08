import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { serverError } from '../../test-support/fake-pg.js';
import {
  CommitOutcomeUnknownError,
  guardReasonIn,
  TransactionRolledBackError,
} from './database-failures.js';

/** A check violation as the server sends it, with the DETAIL a guard trigger gave it. */
function refusal(detail: string | undefined, code = '23514'): pg.DatabaseError {
  const error = serverError(code, 'a grant is consumed only while it has not expired');
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** The audit of 21 October 2026, A06: only a guard's stated reason is an expiry; nothing else may be taken for one. */
describe('guardReasonIn', () => {
  // Break caught: a check violation without the reason mapped to an expiry (a defect answered as an expired link), or the reason lost.
  it('names the reason of a check violation that states one, and only that', () => {
    expect(guardReasonIn(refusal('reason=GRANT_EXPIRED'))).toBe('GRANT_EXPIRED');
    expect(guardReasonIn(refusal('reason=CHALLENGE_EXPIRED'))).toBe('CHALLENGE_EXPIRED');
    expect(guardReasonIn(refusal(undefined))).toBeUndefined();
    expect(guardReasonIn(refusal(''))).toBeUndefined();
  });

  it('finds the reason through the wrappers a driver puts around the server’s error', () => {
    const wrapped = new Error('Failed query', { cause: refusal('reason=GRANT_EXPIRED') });
    const twice = new Error('transaction failed', { cause: wrapped });

    expect(guardReasonIn(wrapped)).toBe('GRANT_EXPIRED');
    expect(guardReasonIn(twice)).toBe('GRANT_EXPIRED');
  });

  // Break caught: a reason read from another SQLSTATE (a unique violation or a deadline with a similar detail) or from loose text.
  it.each([
    ['another SQLSTATE', refusal('reason=GRANT_EXPIRED', '23505')],
    ['a deadline', refusal('reason=GRANT_EXPIRED', '55P03')],
    ['text that is not a bare reason', refusal('Key (id)=(1) reason=GRANT_EXPIRED')],
    ['a reason in lower case', refusal('reason=grant_expired')],
    ['a reason with a trailing word', refusal('reason=GRANT_EXPIRED now')],
    ['an empty reason', refusal('reason=')],
  ])('names nothing for %s', (_name, error) => {
    expect(guardReasonIn(error)).toBeUndefined();
  });

  // Break caught (the audit: "do not swallow unknown commits"): a lost commit or a rolled-back one taken for the guard's refusal.
  it('names nothing for an error that is not the server’s: a lost commit, a rolled-back one, anything else', () => {
    const lost = new CommitOutcomeUnknownError('connection-lost', { cause: new Error('socket') });
    // Each carries, as its cause, a refusal that on its own would be read as the expiry: the commit's outcome is what the caller has.
    const unknown = new CommitOutcomeUnknownError('unrecognized-completion', {
      cause: refusal('reason=GRANT_EXPIRED'),
    });
    const rolledBack = new TransactionRolledBackError({
      cause: refusal('reason=CHALLENGE_EXPIRED'),
    });

    expect(guardReasonIn(lost)).toBeUndefined();
    expect(guardReasonIn(unknown)).toBeUndefined();
    expect(guardReasonIn(rolledBack)).toBeUndefined();
    expect(guardReasonIn(new TransactionRolledBackError())).toBeUndefined();
    expect(guardReasonIn(new Error('reason=GRANT_EXPIRED'))).toBeUndefined();
    expect(guardReasonIn('reason=GRANT_EXPIRED')).toBeUndefined();
    expect(guardReasonIn(undefined)).toBeUndefined();
    expect(guardReasonIn(null)).toBeUndefined();
  });
});
