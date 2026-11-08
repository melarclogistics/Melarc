import { describe, expect, it } from 'vitest';

import { decideMfaResetState, type ResetFacts } from './mfa-reset-state.js';

/**
 * The one rule that says whether a staff identity's second factor can be reset, and which branch of the reset it is (S0.35;
 * state-machines.md section 18; `StaffIdentity.mfa_reset_state`), on the facts it is made from. The facts are read from the recorded
 * rows (`mfa-reset-state.db.test.ts`); here is the decision, one fact at a time, so that the screen's projection and the operation
 * `resetStaffMfa` (S0.37), which call it, cannot be told apart.
 */
const BASE: ResetFacts = {
  status: 'ACTIVE',
  origin: 'MAKER_CHECKER',
  privileged: true,
  hasCredential: true,
  hasActiveFactor: false,
  hasPendingFactor: false,
  hasUsableGrant: false,
  hasPendingDelivery: false,
  latestFactor: null,
};
const facts = (overrides: Partial<ResetFacts>): ResetFacts => ({ ...BASE, ...overrides });
const REVOKED_BY_AN_ADMINISTRATOR = {
  status: 'REVOKED',
  revokedByAdministrator: true,
  hasRevocationEpisode: true,
} as const;

describe('state 1: an ACTIVE factor to revoke', () => {
  // Break caught: the identity with a proven factor not being offered the reset, which is the original case.
  it.each(['ACTIVE', 'SUSPENDED'])('is FACTOR_ACTIVE for a privileged %s identity', (status) => {
    expect(decideMfaResetState(facts({ status, hasActiveFactor: true }))).toBe('FACTOR_ACTIVE');
  });

  // Break caught: a bootstrap administrator being refused the one state it is reached in.
  it('is FACTOR_ACTIVE for a bootstrap administrator, which is reached in state 1 only', () => {
    expect(decideMfaResetState(facts({ origin: 'BOOTSTRAP', hasActiveFactor: true }))).toBe(
      'FACTOR_ACTIVE',
    );
  });
});

describe('state 2: a stranded enrolment', () => {
  const stranded = { hasPendingFactor: true, latestFactor: { status: 'PENDING' } as const };

  // Break caught: an enrolment with nothing left to finish it not being offered the reset.
  it('is ENROLMENT_UNFINISHED for a PENDING factor with no usable grant and no pending delivery', () => {
    expect(decideMfaResetState(facts(stranded))).toBe('ENROLMENT_UNFINISHED');
  });

  // Break caught: a live enrolment being reset under the person who is finishing it.
  it.each([
    ['a usable grant', { hasUsableGrant: true }],
    ['a pending delivery attempt', { hasPendingDelivery: true }],
  ] as const)('is NOT_ELIGIBLE while there is %s', (_name, held) => {
    expect(decideMfaResetState(facts({ ...stranded, ...held }))).toBe('NOT_ELIGIBLE');
  });

  // Break caught: the stranded bootstrap administrator being reset through the business API instead of being resumed through the
  // provisioning channel (its work email was never accepted by an approval).
  it('is NOT_ELIGIBLE for a bootstrap administrator', () => {
    expect(decideMfaResetState(facts({ ...stranded, origin: 'BOOTSTRAP' }))).toBe('NOT_ELIGIBLE');
  });
});

describe('state 3: an unfinished reset', () => {
  // Break caught: an administrator's revocation with no replacement not being offered the reset again.
  it('is ENROLMENT_UNFINISHED when the latest factor was revoked by an administrator, with its episode, and none is live', () => {
    expect(decideMfaResetState(facts({ latestFactor: REVOKED_BY_AN_ADMINISTRATOR }))).toBe(
      'ENROLMENT_UNFINISHED',
    );
  });

  // Break caught: the system's own ending of a factor (an abandoned enrolment, a replacement) read as a reset that was started: no
  // factor record, or one the system ended, is no evidence that a reset was begun.
  it.each([
    ['no factor record at all', null],
    [
      'a factor the system ended',
      { status: 'REVOKED', revokedByAdministrator: false, hasRevocationEpisode: false },
    ],
    [
      'a revocation that names no episode',
      { status: 'REVOKED', revokedByAdministrator: true, hasRevocationEpisode: false },
    ],
    // The table holds an administrator and an episode together; the rule asks for both, so neither alone is a reset.
    [
      'an episode with no administrator',
      { status: 'REVOKED', revokedByAdministrator: false, hasRevocationEpisode: true },
    ],
  ] as const)('is NOT_ELIGIBLE for %s', (_name, latestFactor) => {
    expect(decideMfaResetState(facts({ latestFactor }))).toBe('NOT_ELIGIBLE');
  });

  // Break caught: the bootstrap administrator, who is resumed and never reset, being reached in state 3.
  it('is NOT_ELIGIBLE for a bootstrap administrator', () => {
    expect(
      decideMfaResetState(
        facts({ origin: 'BOOTSTRAP', latestFactor: REVOKED_BY_AN_ADMINISTRATOR }),
      ),
    ).toBe('NOT_ELIGIBLE');
  });
});

describe('what no state can make eligible', () => {
  const everything = {
    hasActiveFactor: true,
    hasPendingFactor: true,
    latestFactor: REVOKED_BY_AN_ADMINISTRATOR,
  } as const;

  // Break caught: an identity that holds no factor to speak of being offered a reset because it is in some other status: a
  // PENDING_APPROVAL or REJECTED profile holds none, and OFFBOARDED is terminal.
  it.each(['PENDING_APPROVAL', 'REJECTED', 'OFFBOARDED'])(
    'is NOT_ELIGIBLE when the status is %s',
    (status) => {
      expect(decideMfaResetState(facts({ ...everything, status }))).toBe('NOT_ELIGIBLE');
    },
  );

  // Break caught: a non-privileged identity, which has no MFA, being offered a reset.
  it('is NOT_ELIGIBLE for a non-privileged identity', () => {
    expect(decideMfaResetState(facts({ ...everything, privileged: false }))).toBe('NOT_ELIGIBLE');
  });

  // Break caught: an identity that has not established its password being offered a reset.
  it('is NOT_ELIGIBLE for an identity with no established password', () => {
    expect(decideMfaResetState(facts({ ...everything, hasCredential: false }))).toBe(
      'NOT_ELIGIBLE',
    );
  });

  // Break caught: a status this build does not know being read as one that may be reset: the narrowest reading.
  it('is NOT_ELIGIBLE for a status it does not know', () => {
    expect(decideMfaResetState(facts({ ...everything, status: 'ARCHIVED' }))).toBe('NOT_ELIGIBLE');
  });
});
