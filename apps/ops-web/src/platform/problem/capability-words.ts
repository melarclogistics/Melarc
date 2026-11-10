/**
 * What holding a permission lets a person do, in the plain words of a refusal (PRODUCT_DESIGN_DIRECTION section 6.5, the Product Owner's decision of 5 November 2026): **a refusal names the
 * capability and never the key or a role.** "Your account can't see pickup requests. Ask an administrator for access." is the whole message. The direction lets a key appear
 * only in a tooltip or in a technical detail meant for support, and never as the message; this portal draws it in neither, so the key (`pickup.read`) is on no screen. A person is
 * not asked to know what a key is, and a role name tells them nothing they can do.
 *
 * Every permission key the portal names has its words here (`capability-words.test.ts` reads the catalogue, `contracts/permissions.md`, and the source, and fails when a key the
 * portal names has none, or an entry names a key the portal never uses), and a key that has none is told as "do this", never as the key itself. The words follow
 * "Your account can't": a verb and what it acts on, in the words of the screen ("book a pickup", "see staff profiles"). The server judges every request whatever a screen says.
 *
 * **The words are this table's and no page's** (the review of f6cf02b: `cannotText('pickup.read', 'pickup.read')` drew a key and passed, because the second argument was free text): the
 * `doing` of {@link cannotText} and the `capability` of the refusal components are a {@link CapabilityWords}, a value of this table, so that the compiler refuses any other text.
 */
const CAPABILITY = {
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
} as const satisfies Readonly<Record<string, string>>;

/**
 * What a page reads with a key where that is not what the key's own words say, named once here so that the page writes no words of its own: the list and the pages of
 * a pickup run are read with `pickup.read`, the key that reads requests, and are told as "see pickup runs" (the review of 499399c: the list of runs was refused in the
 * words of the requests it is not about).
 */
const READ_WITH_THE_SAME_KEY = ['see pickup runs'] as const;

/** Words of the table: what holding a key lets a person do, or what a page reads with it. The one type a refusal component or `cannotText` takes for them. */
export type CapabilityWords =
  (typeof CAPABILITY)[keyof typeof CAPABILITY] | (typeof READ_WITH_THE_SAME_KEY)[number];

/** The words of what the key lets a person do, after "can't": `undefined` for a key that has none. */
export function capabilityOf(permission: string): CapabilityWords | undefined {
  return Object.hasOwn(CAPABILITY, permission)
    ? CAPABILITY[permission as keyof typeof CAPABILITY]
    : undefined;
}

/** What to do when a refusal is for want of access: the one way out, whatever the key. */
export const ASK_FOR_ACCESS = 'Ask an administrator for access.';

/**
 * The refusal of a page, a panel or an act for want of a permission, as a sentence: "Your account can’t see pickup requests. Ask an administrator for access." A key with no words
 * is told as "do this", never as the key. A page that reads something else with the same key says what it is (`doing`, "see pickup runs"): the sentence is the table’s, the words are
 * a {@link CapabilityWords} and not free text, and the page makes none of its own.
 */
export function cannotText(permission: string | undefined, doing?: CapabilityWords): string {
  const words = doing ?? (permission === undefined ? undefined : capabilityOf(permission));
  return `Your account can’t ${words ?? 'do this'}. ${ASK_FOR_ACCESS}`;
}

/** The permission keys that have words, for the test that holds the table to the catalogue and to the source. */
export const CAPABILITY_KEYS: readonly string[] = Object.keys(CAPABILITY);

/** Every wording the table can give, for the test that holds each to a plain sentence with no key in it. */
export const CAPABILITY_WORDS: readonly CapabilityWords[] = [
  ...Object.values(CAPABILITY),
  ...READ_WITH_THE_SAME_KEY,
];
