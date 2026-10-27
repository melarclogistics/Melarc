import type { SecurityContext } from '../../database/transaction-context.js';
import { isMessagePurpose, type SetupGrantPurpose } from './setup-grant-vocabulary.js';

/**
 * Who may issue a setup grant, end a pending one and queue its message in the transaction of an act (S0.36, S0.37; migrations 0029 and
 * 0030). The grant and the delivery job are rows of the `authentication` capability, which issues them for the pre-session acts (the
 * bootstrap, the setup operations). The acts of a staff member on another person's identity are different: they run in the caller's own
 * staff context, and the tables admit them by **the authorization key of the operation** (row-level security names the key, the target
 * the caller's scope shows, and the shape of the act). The key is the operation's: the one authority exercised again, never a role. A
 * staff context under any other key is refused here, before a statement is sent, as row-level security would refuse it in the database;
 * neither refusal may look like "nothing was live".
 */
export const STAFF_ISSUING_KEY: Readonly<Partial<Record<SetupGrantPurpose, string>>> =
  Object.freeze({
    // `approveStaffIdentity` issues the first grant, and `reissueStaffCredentialSetup` the next, under the one key `staff.identity.approve`.
    STAFF_CREDENTIAL_SETUP: 'staff.identity.approve',
    // `resetStaffMfa` issues the re-enrolment grant of its episode.
    MFA_REENROLMENT: 'staff.mfa.reset',
    // `reissueVendorCredentialSetup` (S0.47) issues a vendor's setup grant again, under the approval authority of its organisation
    // (migration 0035 binds the arms to the account the act has locked).
    VENDOR_CREDENTIAL_SETUP: 'vendor.organization.approve',
    // `registerRiderDevice` (S0.53b) and `reregisterRiderDevice` (S0.53c) issue the rider's two device grants, each under the key of its own
    // act, so that the catalogue can say which act was authorised (rider-authentication.md section 8). Migration 0040 binds the arms to the
    // rider the act has locked. A rider grant travels as a QR in the response and queues no message.
    RIDER_DEVICE_ENROLMENT: 'staff.device.register',
    RIDER_DEVICE_REREGISTRATION: 'staff.device.reregister',
  });

/**
 * The grants a key may end while it is pending (and read, to know what it ends): the approval's key the staff credential setup it
 * issued; the reset's key the enrolment continuation and the re-enrolment grant of the identity whose factor it resets; each rider key the
 * pending device grant of its own purpose (the next one supersedes it).
 */
const STAFF_ENDING_KEY: Readonly<Partial<Record<SetupGrantPurpose, string>>> = Object.freeze({
  STAFF_CREDENTIAL_SETUP: 'staff.identity.approve',
  MFA_ENROLMENT: 'staff.mfa.reset',
  MFA_REENROLMENT: 'staff.mfa.reset',
  VENDOR_CREDENTIAL_SETUP: 'vendor.organization.approve',
  RIDER_DEVICE_ENROLMENT: 'staff.device.register',
  RIDER_DEVICE_REREGISTRATION: 'staff.device.reregister',
});

/**
 * The keys under which a staff context queues a **recovery link's** message (S0.51b): an administrator's recovery is the Platform Admin's own
 * act, in a staff context under the key of the operation, and migration 0038 admits that key to the recovery messages of the principal the
 * act has locked (kind `RECOVERY_LINK`) and to no other message.
 */
const RECOVERY_KEYS: readonly string[] = ['staff.credential.recover', 'vendor.credential.recover'];

/**
 * The keys under which a staff context queues a message: those that issue a grant which **travels as a message** (the staff and the vendor
 * setup, the re-enrolment), and the recovery keys. The two rider keys issue grants that are shown as a QR, so they are not among them:
 * the delivery queue is refused to them here, and the policies of the delivery job name neither.
 */
const ISSUING_KEYS: readonly string[] = [
  ...new Set([
    ...Object.entries(STAFF_ISSUING_KEY)
      .filter(([purpose]) => isMessagePurpose(purpose))
      .map(([, key]) => key),
    ...RECOVERY_KEYS,
  ]),
];

const isAuthentication = (context: SecurityContext): boolean =>
  context.principalType === 'SYSTEM' && context.taskCapability === 'authentication';

/** Whether `context` may issue a grant of `purpose`. */
export function mayIssueGrant(context: SecurityContext, purpose: SetupGrantPurpose): boolean {
  if (isAuthentication(context)) return true;
  const key = STAFF_ISSUING_KEY[purpose];
  return context.principalType === 'STAFF' && key !== undefined && context.authorizationKey === key;
}

/** Whether `context` may read the pending grants of `purpose` and end one that is pending, in the transaction of an act. */
export function mayEndGrant(context: SecurityContext, purpose: SetupGrantPurpose): boolean {
  if (isAuthentication(context)) return true;
  const key = STAFF_ENDING_KEY[purpose];
  return context.principalType === 'STAFF' && key !== undefined && context.authorizationKey === key;
}

/** Whether `context` may queue the message of a grant, or cancel it: the issuing capability, or a staff context under an issuing key. */
export function mayQueueGrantMessage(context: SecurityContext): boolean {
  if (isAuthentication(context)) return true;
  return (
    context.principalType === 'STAFF' &&
    context.authorizationKey !== undefined &&
    ISSUING_KEYS.includes(context.authorizationKey)
  );
}
