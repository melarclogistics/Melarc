import { describe, expect, it } from 'vitest';

import {
  IDENTITY_OPERATION_DOMAINS,
  REASON_BRANCHES,
  ReasonRefusedError,
  decideReason,
  type ReasonRequest,
  type ReasonRow,
} from './reason-validator.js';

const row = (overrides: Partial<ReasonRow> = {}): ReasonRow => ({
  code: 'SESSION_SECURITY_CONCERN',
  domain: 'SESSION_REVOCATION',
  label: 'Session security concern',
  requires_note: false,
  requires_photo: false,
  requires_contact_attempt: false,
  requires_approval: false,
  requires_ops_review: false,
  requires_escalation: false,
  attribution: 'MELARC',
  consumes_delivery_attempt: false,
  active: true,
  permitted_operations: ['revokeSession'],
  ...overrides,
});

const request = (overrides: Partial<ReasonRequest> = {}): ReasonRequest => ({
  reasonCode: 'SESSION_SECURITY_CONCERN',
  operationId: 'revokeSession',
  ...overrides,
});

const refusal = (run: () => unknown): ReasonRefusedError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReasonRefusedError);
    return error as ReasonRefusedError;
  }
  throw new Error('expected the reason to be refused');
};

describe('validating a reason', () => {
  // Break caught: a valid reason refused, or returned without what the audit event and the operation need from it.
  it('accepts an active reason of the operation’s domain that permits the operation', () => {
    const accepted = decideReason(request(), row());

    expect(accepted).toMatchObject({
      code: 'SESSION_SECURITY_CONCERN',
      domain: 'SESSION_REVOCATION',
      label: 'Session security concern',
      requiresNote: false,
      attribution: 'MELARC',
    });
  });

  // Break caught: an empty reason answered as an unknown one (the two are different answers, errors-and-enums.md).
  it('says REASON_REQUIRED for no reason at all, and nothing else', () => {
    for (const reasonCode of [undefined, null, '', ' ', '   ', '\t', '\n ']) {
      expect(
        refusal(() => decideReason(request({ reasonCode }), undefined)).code,
        String(reasonCode),
      ).toBe('REASON_REQUIRED');
    }
  });

  // Break caught: a code that cannot be one, or one that is not in the catalogue, passing as a reason.
  it('says REASON_NOT_ACTIVE for a code that is unknown, malformed or not text', () => {
    expect(refusal(() => decideReason(request(), undefined)).code).toBe('REASON_NOT_ACTIVE');
    for (const reasonCode of [
      7,
      {},
      [],
      true,
      'session_security_concern',
      'HAS SPACE',
      ' SESSION_SECURITY_CONCERN',
      'SESSION_SECURITY_CONCERN ',
      'X'.repeat(65),
      'É',
      "A'; DROP TABLE reason_code; --",
    ]) {
      expect(
        refusal(() => decideReason(request({ reasonCode }), row())).code,
        JSON.stringify(reasonCode),
      ).toBe('REASON_NOT_ACTIVE');
    }
  });

  // Break caught: a retired reason still being accepted.
  it('says REASON_NOT_ACTIVE for a retired reason', () => {
    expect(refusal(() => decideReason(request(), row({ active: false }))).code).toBe(
      'REASON_NOT_ACTIVE',
    );
  });

  // Break caught: a reason of another domain accepted because its list happens to name the operation.
  it('says REASON_NOT_ACTIVE for a reason of another domain, whatever its list says', () => {
    const foreign = row({ domain: 'STAFF_MFA_RESET', permitted_operations: ['revokeSession'] });

    expect(refusal(() => decideReason(request(), foreign)).code).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: a reason being used with an operation it does not permit.
  it('says REASON_NOT_ACTIVE for an operation the reason does not permit', () => {
    expect(
      refusal(() =>
        decideReason(
          request({ operationId: 'revokeSession' }),
          row({ permitted_operations: ['reissueStaffCredentialSetup'] }),
        ),
      ).code,
    ).toBe('REASON_NOT_ACTIVE');
    expect(refusal(() => decideReason(request(), row({ permitted_operations: [] }))).code).toBe(
      'REASON_NOT_ACTIVE',
    );
    // An operation whose name merely begins like a permitted one is not that operation.
    expect(
      refusal(() => decideReason(request(), row({ permitted_operations: ['revokeSessionNow'] })))
        .code,
    ).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: a reason with no list (a non-identity domain) being accepted for an identity operation.
  it('says REASON_NOT_ACTIVE for an identity operation when the reason has no list of operations', () => {
    expect(
      refusal(() =>
        decideReason(request(), row({ domain: 'SESSION_REVOCATION', permitted_operations: null })),
      ).code,
    ).toBe('REASON_NOT_ACTIVE');
  });
});

describe('a reason that applies to one branch of its operation', () => {
  const rejection = row({
    code: 'STAFF_DETAILS_INCORRECT',
    domain: 'STAFF_PROFILE_REJECTION',
    permitted_operations: ['approveStaffIdentity#APPROVAL_REJECTED'],
  });
  const approval = (overrides: Partial<ReasonRequest> = {}) =>
    request({
      reasonCode: 'STAFF_DETAILS_INCORRECT',
      operationId: 'approveStaffIdentity',
      ...overrides,
    });

  // Break caught: a branch-qualified entry ignored, so that it is valid on every branch.
  it('is valid on the branch it names and on no other', () => {
    expect(decideReason(approval({ branch: 'APPROVAL_REJECTED' }), rejection).code).toBe(
      'STAFF_DETAILS_INCORRECT',
    );

    for (const branch of ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED'] as const) {
      expect(refusal(() => decideReason(approval({ branch }), rejection)).code, branch).toBe(
        'REASON_NOT_ACTIVE',
      );
    }
  });

  // Break caught: a qualified reason accepted when the use case gave no branch.
  it('is not valid when the use case supplies no branch', () => {
    expect(refusal(() => decideReason(approval(), rejection)).code).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: a bare entry being narrowed by a branch it never named.
  it('lets a bare entry stand on every branch, and with none', () => {
    const bare = row({
      code: 'X',
      domain: 'STAFF_MFA_RESET',
      permitted_operations: ['resetStaffMfa'],
    });
    const reset = (branch?: (typeof REASON_BRANCHES)[number]) =>
      request({
        reasonCode: 'X',
        operationId: 'resetStaffMfa',
        ...(branch === undefined ? {} : { branch }),
      });

    expect(decideReason(reset(), bare).code).toBe('X');
    for (const branch of REASON_BRANCHES) expect(decideReason(reset(branch), bare).code).toBe('X');
  });

  // Break caught: a branch of one operation counting for another (the entry is operation#BRANCH, both parts).
  it('does not let a branch of one operation stand for the same branch of another', () => {
    const wrongOperation = row({
      code: 'X',
      domain: 'STAFF_MFA_RESET',
      permitted_operations: ['approveStaffIdentity#FACTOR_ACTIVE'],
    });

    expect(
      refusal(() =>
        decideReason(
          request({ reasonCode: 'X', operationId: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' }),
          wrongOperation,
        ),
      ).code,
    ).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: a branch from the client reaching the check as text: it must be one of the closed set the use case derives.
  it('refuses a branch that is not one of the three, as a defect of the caller', () => {
    for (const branch of ['', 'approval_rejected', 'APPROVAL_REJECTED ', 'OTHER', 'a#b']) {
      expect(() => decideReason(approval({ branch: branch as never }), rejection), branch).toThrow(
        TypeError,
      );
    }
  });
});

describe('the metadata that makes a field mandatory (§35.9.2)', () => {
  // Break caught: a reason that requires a note accepted without one.
  it('says REASON_REQUIRED when the reason requires a note and none is given', () => {
    const noted = row({ requires_note: true });

    for (const note of [undefined, null, '', '   ']) {
      expect(
        refusal(() => decideReason(request(note === undefined ? {} : { note }), noted)).code,
        String(note),
      ).toBe('REASON_REQUIRED');
    }
    expect(decideReason(request({ note: 'Called the officer.' }), noted).requiresNote).toBe(true);
    expect(decideReason(request(), row({ requires_note: false })).requiresNote).toBe(false);
  });

  // Break caught: the other flags dropped, so that an operation could not enforce what it must.
  it('hands the other flags to the operation, which owns them', () => {
    const flagged = row({
      requires_photo: true,
      requires_contact_attempt: true,
      requires_approval: true,
      requires_ops_review: true,
      requires_escalation: true,
      consumes_delivery_attempt: true,
      attribution: 'CUSTOMER',
    });

    expect(decideReason(request(), flagged)).toMatchObject({
      requiresPhoto: true,
      requiresContactAttempt: true,
      requiresApproval: true,
      requiresOpsReview: true,
      requiresEscalation: true,
      consumesDeliveryAttempt: true,
      attribution: 'CUSTOMER',
    });
  });
});

describe('which domain an operation takes its reason from', () => {
  // Break caught: the operation-to-domain table drifting from the document that owns it (a Family Z comparison is in the database test).
  it('knows the nine identity operations and their six domains', () => {
    expect(IDENTITY_OPERATION_DOMAINS).toEqual({
      revokeSession: 'SESSION_REVOCATION',
      approveStaffIdentity: 'STAFF_PROFILE_REJECTION',
      resetStaffMfa: 'STAFF_MFA_RESET',
      reissueStaffCredentialSetup: 'CREDENTIAL_ADMINISTRATION',
      reissueVendorCredentialSetup: 'CREDENTIAL_ADMINISTRATION',
      recoverStaffCredential: 'CREDENTIAL_ADMINISTRATION',
      recoverVendorCredential: 'CREDENTIAL_ADMINISTRATION',
      reregisterRiderDevice: 'RIDER_DEVICE_REPLACEMENT',
      revokeRiderDevice: 'RIDER_DEVICE_REVOCATION',
    });
  });

  // Break caught: an operation with no known domain being validated against a guess.
  it('needs the domain from the caller for an operation that is not an identity operation', () => {
    const delivery = row({
      code: 'RECIPIENT_ABSENT',
      domain: 'DELIVERY_FAILURE',
      permitted_operations: null,
    });
    const failStop = request({
      reasonCode: 'RECIPIENT_ABSENT',
      operationId: 'recordDeliveryFailure',
    });

    expect(() => decideReason(failStop, delivery)).toThrow(TypeError);
    expect(decideReason({ ...failStop, domain: 'DELIVERY_FAILURE' }, delivery).code).toBe(
      'RECIPIENT_ABSENT',
    );
    expect(
      refusal(() => decideReason({ ...failStop, domain: 'RECIPIENT_CONTACT' }, delivery)).code,
    ).toBe('REASON_NOT_ACTIVE');
  });

  // Break caught: the refusal repeating what the client sent, which can be any text.
  it('never repeats the code it was given', () => {
    const error = refusal(() =>
      decideReason(request({ reasonCode: 'ATTACKER_TEXT_9' }), undefined),
    );

    expect(error.message).not.toContain('ATTACKER_TEXT_9');
  });
});
