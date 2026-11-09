/**
 * What holding a permission lets a person do, in the plain words of a refusal (PRODUCT_DESIGN_DIRECTION section 6.5, the Product Owner's decision of 5 November 2026): **a refusal names the
 * capability and never the key or a role.** "Your account can't see pickup requests. Ask an administrator for access." is the whole message. The direction lets a key appear
 * only in a tooltip or in a technical detail meant for support, and never as the message; this portal draws it in neither, so the key (`pickup.read`) is on no screen. A person is
 * not asked to know what a key is, and a role name tells them nothing they can do.
 *
 * Every permission key the portal names has its words here (`capability-words.test.ts` reads the catalogue, `contracts/permissions.md`, and the source, and fails when a key the
 * portal names has none, or an entry names a key the portal never uses), and a key that has none is told as "do this", never as the key itself. The words follow
 * "Your account can't": a verb and what it acts on, in the words of the screen ("book a pickup", "see staff profiles"). The server judges every request whatever a screen says.
 */
const CAPABILITY: Readonly<Record<string, string>> = {
  // Pickup requests, exceptions and runs.
  'pickup.read': 'see pickup requests',
  'pickup.request.create': 'book a pickup',
  'pickup.request.confirm': 'confirm a pickup',
  'pickup.request.cancel': 'cancel a pickup',
  'pickup.request.cancel_chargeable': 'cancel a pickup a rider is already assigned to',
  'pickup.attempt.extend': 'allow a further pickup attempt',
  'pickup.failure.resolve': 'escalate or reschedule a failed pickup',
  'pickup.cancellation_charge.waive': 'waive a cancellation charge',
  'pickup.exception.request': 'ask for a one-package exception',
  'pickup.exception.approve': 'decide a one-package exception',
  'pickup.manifest.create': 'build or cancel a pickup run',
  'pickup.manifest.assign': 'assign a rider to a pickup run',
  'pickup.manifest.dispatch': 'send a pickup run out',
  'pickup.stop.skip': 'skip a stop',
  // Custody of a run's parcels.
  'fleet.custody.read': 'see custody handovers',
  'fleet.custody.initiate': 'start a custody handover',
  'fleet.custody.accept': 'accept a custody handover',
  // The message log and the reasons a screen reads.
  'notification.read': 'see the message log',
  'settings.reason.read': 'see the reasons for this act',
  // People, access and devices.
  'staff.read': 'see staff profiles',
  'staff.identity.create': 'create a staff profile',
  'staff.identity.approve': 'approve or reject a staff profile',
  'staff.mfa.reset': 'reset an authenticator',
  'staff.session.revoke': 'end sessions',
  'staff.credential.recover': 'start a password recovery',
  'staff.device.register': 'register a rider’s device',
  'staff.device.reregister': 'register a replacement handset',
  'staff.device.revoke': 'revoke a rider’s device',
  'permission.assignable_bundle.read': 'see the roles a profile can be given',
  'vendor.read': 'see vendor accounts',
  'vendor.pickup_location.manage': 'choose another of a vendor’s saved locations',
  'vendor.organization.approve': 'send a vendor a setup link',
  'vendor.credential.recover': 'start a vendor’s recovery',
  'dispatch.read': 'see riders',
};

/** The words of what the key lets a person do, after "can't": `undefined` for a key that has none. */
export function capabilityOf(permission: string): string | undefined {
  return Object.hasOwn(CAPABILITY, permission) ? CAPABILITY[permission] : undefined;
}

/** What to do when a refusal is for want of access: the one way out, whatever the key. */
export const ASK_FOR_ACCESS = 'Ask an administrator for access.';

/**
 * The refusal of a page, a panel or an act for want of a permission, as a sentence: "Your account can't see pickup requests. Ask an administrator for access." A key with no words
 * is told as "do this", never as the key.
 */
export function cannotText(permission: string | undefined): string {
  const words = permission === undefined ? undefined : capabilityOf(permission);
  return `Your account can’t ${words ?? 'do this'}. ${ASK_FOR_ACCESS}`;
}

/** What an act that waits for someone else's decision says of who decides: an approver, in the words of the act. The key is never named. */
export const AN_APPROVER_DECIDES = 'An approver decides this.';

/** The permission keys that have words, for the test that holds the table to the catalogue and to the source. */
export const CAPABILITY_KEYS: readonly string[] = Object.keys(CAPABILITY);
