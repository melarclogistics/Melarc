import { describe, expect, it } from 'vitest';

import type { SecurityContext } from '../../database/transaction-context.js';
import {
  mayEndGrant,
  mayIssueGrant,
  mayQueueGrantMessage,
  STAFF_ISSUING_KEY,
} from './issuing-authority.js';
import { SETUP_GRANT_PURPOSES, type SetupGrantPurpose } from './setup-grant-vocabulary.js';

const staff = (authorizationKey?: string): SecurityContext => ({
  principalType: 'STAFF',
  principalId: '00000000-0000-4000-8000-000000000001',
  surface: 'OPS_PORTAL',
  correlationId: 'c',
  ...(authorizationKey === undefined ? {} : { authorizationKey }),
});
const system = (taskCapability: 'authentication' | 'rate_limit'): SecurityContext => ({
  principalType: 'SYSTEM',
  principalId: '00000000-0000-4000-8000-000000000002',
  surface: 'SYSTEM',
  taskCapability,
  correlationId: 'c',
});

const APPROVE = 'staff.identity.approve';
const RESET = 'staff.mfa.reset';
const VENDOR_APPROVE = 'vendor.organization.approve';
const REGISTER = 'staff.device.register';
const REREGISTER = 'staff.device.reregister';
const OTHER_KEYS = [
  'staff.device.revoke',
  undefined,
  'staff.read',
  'staff.identity.create',
  'staff.session.revoke',
  'vendor.read',
  'staff.credential.recover',
  'vendor.credential.recover',
];
/** The keys of an administrator's recovery (S0.51b): they queue a recovery link's message, and issue and end no grant. */
const RECOVER_KEYS: readonly (string | undefined)[] = [
  'staff.credential.recover',
  'vendor.credential.recover',
];

describe('who may issue a setup grant', () => {
  // Break caught: the authentication capability losing the right it has always had (the bootstrap and the setup operations issue
  // every purpose under it).
  it('lets the authentication capability issue and end every purpose, and no other capability', () => {
    for (const purpose of SETUP_GRANT_PURPOSES) {
      expect(mayIssueGrant(system('authentication'), purpose)).toBe(true);
      expect(mayEndGrant(system('authentication'), purpose)).toBe(true);
      expect(mayIssueGrant(system('rate_limit'), purpose)).toBe(false);
      expect(mayEndGrant(system('rate_limit'), purpose)).toBe(false);
    }
    expect(mayQueueGrantMessage(system('authentication'))).toBe(true);
    expect(mayQueueGrantMessage(system('rate_limit'))).toBe(false);
  });

  // Break caught: a staff context issuing under the wrong key, under none, or a purpose the key does not serve.
  it('lets a staff context issue a staff credential-setup grant under the approval key and a re-enrolment grant under the reset key, and nothing else', () => {
    const issuing = (key: string | undefined): SetupGrantPurpose[] =>
      SETUP_GRANT_PURPOSES.filter((purpose) => mayIssueGrant(staff(key), purpose));

    expect(issuing(APPROVE)).toEqual(['STAFF_CREDENTIAL_SETUP']);
    expect(issuing(RESET)).toEqual(['MFA_REENROLMENT']);
    // S0.47: `reissueVendorCredentialSetup` issues the vendor's setup grant under the approval authority of a vendor organisation.
    expect(issuing(VENDOR_APPROVE)).toEqual(['VENDOR_CREDENTIAL_SETUP']);
    // S0.53: the rider's two device grants, each under the key of its own act (a first binding is not a replacement).
    expect(issuing(REGISTER)).toEqual(['RIDER_DEVICE_ENROLMENT']);
    expect(issuing(REREGISTER)).toEqual(['RIDER_DEVICE_REREGISTRATION']);
    for (const key of OTHER_KEYS) expect(issuing(key)).toEqual([]);
    expect(STAFF_ISSUING_KEY).toEqual({
      STAFF_CREDENTIAL_SETUP: APPROVE,
      MFA_REENROLMENT: RESET,
      VENDOR_CREDENTIAL_SETUP: VENDOR_APPROVE,
      RIDER_DEVICE_ENROLMENT: REGISTER,
      RIDER_DEVICE_REREGISTRATION: REREGISTER,
    });
  });

  // Break caught: the reset ending a grant of the approval, or the approval ending the re-enrolment of a reset.
  it('lets each key end only the pending grants of its own acts', () => {
    const ending = (key: string | undefined): SetupGrantPurpose[] =>
      SETUP_GRANT_PURPOSES.filter((purpose) => mayEndGrant(staff(key), purpose));

    expect(ending(APPROVE)).toEqual(['STAFF_CREDENTIAL_SETUP']);
    expect(ending(RESET)).toEqual(['MFA_ENROLMENT', 'MFA_REENROLMENT']);
    expect(ending(VENDOR_APPROVE)).toEqual(['VENDOR_CREDENTIAL_SETUP']);
    expect(ending(REGISTER)).toEqual(['RIDER_DEVICE_ENROLMENT']);
    expect(ending(REREGISTER)).toEqual(['RIDER_DEVICE_REREGISTRATION']);
    for (const key of OTHER_KEYS) expect(ending(key)).toEqual([]);
  });

  // Break caught: a Vendor or a Rider context that happens to carry a key.
  it('never lets a vendor or a rider issue, end or queue', () => {
    const vendor: SecurityContext = {
      principalType: 'VENDOR',
      principalId: '00000000-0000-4000-8000-000000000003',
      surface: 'VENDOR_PWA',
      vendorOrganizationId: '00000000-0000-4000-8000-000000000004',
      correlationId: 'c',
      authorizationKey: APPROVE,
    };
    const rider: SecurityContext = {
      principalType: 'RIDER',
      principalId: '00000000-0000-4000-8000-000000000005',
      surface: 'RIDER_ANDROID',
      riderId: '00000000-0000-4000-8000-000000000005',
      correlationId: 'c',
      authorizationKey: RESET,
    };
    for (const context of [vendor, rider]) {
      for (const purpose of SETUP_GRANT_PURPOSES) {
        expect(mayIssueGrant(context, purpose)).toBe(false);
        expect(mayEndGrant(context, purpose)).toBe(false);
      }
      expect(mayQueueGrantMessage(context)).toBe(false);
    }
  });

  // Break caught: a key that issues nothing queueing a message, or an administrator's recovery unable to queue its link.
  it('lets a staff context queue and cancel a message under an issuing key or a recovery key only', () => {
    expect(mayQueueGrantMessage(staff(APPROVE))).toBe(true);
    expect(mayQueueGrantMessage(staff(RESET))).toBe(true);
    expect(mayQueueGrantMessage(staff(VENDOR_APPROVE))).toBe(true);
    for (const key of RECOVER_KEYS) expect(mayQueueGrantMessage(staff(key))).toBe(true);
    for (const key of OTHER_KEYS.filter((key) => !RECOVER_KEYS.includes(key))) {
      expect(mayQueueGrantMessage(staff(key))).toBe(false);
    }
  });

  // Break caught (S0.53): a rider key that issues a grant shown as a QR being given the delivery queue, which the policies of the job do not
  // admit it to either.
  it('gives the two rider keys no right to queue or cancel a message', () => {
    expect(mayQueueGrantMessage(staff(REGISTER))).toBe(false);
    expect(mayQueueGrantMessage(staff(REREGISTER))).toBe(false);
  });
});
