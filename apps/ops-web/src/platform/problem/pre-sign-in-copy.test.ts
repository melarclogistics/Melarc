import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { copyFor, PROBLEM_COPY, problemOf } from './problem-copy';

/**
 * The words of the pre-sign-in screens (S0.43), in the one table the Ops Portal keeps, keyed by operation, context and code
 * (COMPONENT_PATTERNS section 33). They are proposed here for the Product Owner to review with the composed screens, and the tests pin what
 * they must never be: a way to tell which addresses belong to staff.
 */

const refused = (code: string, status = 400): ApiError =>
  new ApiError({ kind: 'http', status, code });

describe('the words of the staff sign-in', () => {
  it('says one thing for a refused sign-in', () => {
    expect(
      problemOf(refused('INVALID_CREDENTIALS', 401), { operation: 'staffSignIn' }).message,
    ).toBe('The email or password is not correct.');
  });

  it('tells the person to wait, and nothing more, when too many attempts were made', () => {
    expect(problemOf(refused('RATE_LIMITED', 429), { operation: 'staffSignIn' })).toMatchObject({
      kind: 'rate-limited',
      message: 'Too many attempts. Wait a minute, then try again.',
    });
  });

  it('says the request could not be verified for a refused Origin', () => {
    expect(
      problemOf(refused('CSRF_VALIDATION_FAILED', 403), { operation: 'staffSignIn' }).message,
    ).toBe('The request could not be verified. Reload the page and try again.');
  });

  // Break caught (ops-portal.md section 7: there is no lockout state on the sign-in page): any wording at the password step that says what
  // is true of an address, which would make the screen the account-existence oracle it exists not to be.
  it('has no wording that names a lock, an account, a status or an address', () => {
    const rules = PROBLEM_COPY.filter((rule) => rule.operation === 'staffSignIn');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.text, rule.code).not.toMatch(
        /lock|account|exist|suspend|pending|offboard|unknown|no such|not registered|disabled|recover/i,
      );
    }
  });

  it('has no rule for a lock at the password step', () => {
    expect(
      PROBLEM_COPY.some(
        (rule) => rule.operation === 'staffSignIn' && rule.code === 'CREDENTIAL_LOCKED',
      ),
    ).toBe(false);
  });

  it('words the two fields it can refuse, without echoing a value', () => {
    expect(
      problemOf(refused('VALIDATION_FAILED'), { operation: 'staffSignIn', context: 'email' })
        .message,
    ).toBe('Enter your work email address.');
    expect(
      problemOf(refused('VALIDATION_FAILED'), { operation: 'staffSignIn', context: 'password' })
        .message,
    ).toBe('A password has at most 128 characters.');
  });

  it('has an unknown-outcome wording for a sign-in that got no answer', () => {
    expect(copyFor({ operation: 'staffSignIn', context: 'unknown-outcome' })).toBe(
      'The server could not be reached or could not finish this. Try again.',
    );
  });
});

describe('the words of the second step of sign-in: four refusals, four states, not merged', () => {
  const wording = (code: string) =>
    problemOf(refused(code, 400), { operation: 'completeStaffMfaSignIn' }).message;

  it.each([
    ['MFA_PROOF_INVALID', 'That code was not accepted.'],
    ['CHALLENGE_UNUSABLE', 'This attempt is finished. Sign in again.'],
    ['CHALLENGE_EXPIRED', 'That took too long. Sign in again.'],
    [
      'CREDENTIAL_LOCKED',
      'This account is locked for fifteen minutes. Recovering the password clears it.',
    ],
    [
      'MFA_ENROLMENT_REQUIRED',
      'You cannot sign in until your authenticator is set up. If your set-up link has expired or was already used, ask someone who can reset authenticators to reset yours: a new link will be sent to your work email.',
    ],
  ])('words %s', (code, text) => {
    expect(wording(code)).toBe(text);
  });

  // Break caught (the Product Owner's review of 67bc979): a person sent to a set-up link that may be used or expired, with no way on. The specification (credential-recovery.md: resetStaffMfa reaches an
  // identity with a password and a pending factor; the new link goes to the work email only) gives the way: ask someone who can reset authenticators. No role is named.
  it('tells a person whose set-up link is gone who can send a new one, and names no role', () => {
    const text = wording('MFA_ENROLMENT_REQUIRED');

    expect(text).toMatch(/expired or was already used/);
    expect(text).toMatch(/ask someone who can reset authenticators/);
    expect(text).toMatch(/new link will be sent to your work email/);
    expect(text).not.toMatch(/admin|administrator|platform|senior|role/i);
  });

  // Break caught: two of the refusals worded alike, which tells the person to retry something that is finished, or to start again when a
  // new code would do.
  it('words the four refusals differently from each other', () => {
    const four = [
      'MFA_PROOF_INVALID',
      'CHALLENGE_UNUSABLE',
      'CHALLENGE_EXPIRED',
      'CREDENTIAL_LOCKED',
    ].map(wording);
    expect(new Set(four).size).toBe(4);
  });

  // Break caught: the attempts left being shown, which tells a thief how many guesses remain.
  it('does not say how many attempts are left', () => {
    expect(wording('MFA_PROOF_INVALID')).not.toMatch(/\d|attempt|left|remain/i);
  });

  it('asks the person to enter the six digits when the code was not well formed', () => {
    expect(
      problemOf(refused('VALIDATION_FAILED'), {
        operation: 'completeStaffMfaSignIn',
        context: 'code',
      }).message,
    ).toBe('Enter the six digits shown in your authenticator app.');
  });

  it('asks the person to wait when too many attempts were made', () => {
    expect(
      problemOf(refused('RATE_LIMITED', 429), { operation: 'completeStaffMfaSignIn' }).message,
    ).toBe('Too many attempts. Wait a minute, then try again.');
  });
});

describe('the words of the link pages', () => {
  const GRANT_INVALID =
    'This link cannot be used. It may have expired, or it may already have been used.';

  // Break caught (ops-portal.md section 7: one error for an unknown, expired, consumed or superseded grant): wording that says which, on any
  // of the three operations a link reaches.
  it.each(['completeStaffCredentialSetup', 'beginMfaReenrolment', 'completeMfaEnrolment'])(
    'words a grant that cannot be used the same way for %s, and says no more than that it may have expired or been used',
    (operation) => {
      const message = problemOf(refused('SETUP_GRANT_INVALID'), { operation }).message;
      expect(message).toBe(GRANT_INVALID);
      expect(message).not.toMatch(/consumed|superseded|unknown|no such|reissue|new link/i);
    },
  );

  it('states the rule of a new password when the server refuses the field', () => {
    expect(
      problemOf(refused('VALIDATION_FAILED'), {
        operation: 'completeStaffCredentialSetup',
        context: 'password',
      }).message,
    ).toBe('Use 12 to 128 characters. Spaces are allowed, and nothing else is required.');
  });

  it('says a code that did not prove the authenticator left it not set up', () => {
    expect(
      problemOf(refused('MFA_PROOF_INVALID'), { operation: 'completeMfaEnrolment' }).message,
    ).toBe(
      'That code was not accepted. Your authenticator is not set up yet. Try the next code it shows.',
    );
  });

  it('asks the person to enter six digits when the enrolment code was not well formed', () => {
    expect(
      problemOf(refused('VALIDATION_FAILED'), {
        operation: 'completeMfaEnrolment',
        context: 'code',
      }).message,
    ).toBe('Enter the six digits shown in your authenticator app.');
  });

  // Break caught: a lost answer worded as a failure or as a success: a single-use grant may have been used, and the person must be told
  // what to do either way.
  it.each([
    [
      'completeStaffCredentialSetup',
      'We could not confirm whether your password was set. Try again. If the link is then refused, try signing in.',
    ],
    [
      'beginMfaReenrolment',
      'We could not confirm whether this started. Try again. If the link is then refused, ask for a new one.',
    ],
    [
      'completeMfaEnrolment',
      'We could not confirm whether your authenticator was set up. Try a new code. If the link is then refused, try signing in.',
    ],
  ])('words an unknown outcome of %s', (operation, text) => {
    expect(copyFor({ operation, context: 'unknown-outcome' })).toBe(text);
  });

  it.each(['completeStaffCredentialSetup', 'beginMfaReenrolment', 'completeMfaEnrolment'])(
    'asks the person to wait when too many attempts were made at %s',
    (operation) => {
      expect(problemOf(refused('RATE_LIMITED', 429), { operation }).message).toBe(
        'Too many attempts. Wait a minute, then try again.',
      );
    },
  );

  it.each(['completeStaffCredentialSetup', 'beginMfaReenrolment', 'completeMfaEnrolment'])(
    'says the request could not be verified for %s',
    (operation) => {
      expect(problemOf(refused('CSRF_VALIDATION_FAILED', 403), { operation }).message).toBe(
        'The request could not be verified. Reload the page and try again.',
      );
    },
  );
});

describe('the failure of a pre-sign-in call is never the server’s text', () => {
  it('shows none of the diagnostic, only the request id as a reference', () => {
    const failure = new OperationFailure(
      new ApiError({ kind: 'http', status: 401, code: 'INVALID_CREDENTIALS', requestId: 'req-77' }),
      [],
    );
    const problem = problemOf(failure, { operation: 'staffSignIn' });
    expect(problem.reference).toBe('req-77');
    expect(problem.message).not.toMatch(/req-77|Diagnostic/);
  });
});
