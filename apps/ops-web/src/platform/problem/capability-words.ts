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
import type { ForbiddenKind } from '../../components/ui/forbidden-state/ForbiddenState';

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

/**
 * What a session cannot do, in ONE sentence, when it lacks several keys of one page (a draft pickup run offers three acts): "Your account can’t assign a rider to a pickup run or send a pickup run
 * out. Ask an administrator for access." Each key is told in its words (a key with none as "do this"), once, and the way out is said once at the end.
 */
export function cannotAllText(permissions: readonly string[]): string {
  const words = [
    ...new Set(permissions.map((permission) => capabilityOf(permission) ?? 'do this')),
  ];
  const last = words.at(-1);
  const list =
    last === undefined
      ? 'do this'
      : words.length === 1
        ? last
        : `${words.slice(0, -1).join(', ')} or ${last}`;
  return `Your account can’t ${list}. ${ASK_FOR_ACCESS}`;
}

/**
 * What a session lacks of the keys one page offers acts for, in one sentence ({@link cannotAllText}), or `undefined` when it holds every one: the page asks the session's `holds` and
 * names the keys, and writes no words.
 */
export function lackedText(
  holds: (permission: string) => boolean,
  permissions: readonly string[],
): string | undefined {
  const lacking = permissions.filter((permission) => !holds(permission));
  return lacking.length === 0 ? undefined : cannotAllText(lacking);
}

/**
 * What a refusal for a hub says of what a page holds, by what the page holds. A page names what it lists (`of: 'riders'`, a member of this list) and writes no sentence of its own (the review of
 * f6cf02b: six pages each wrote "These … are at a hub your account does not work in."), so that the words of a refusal are one table's whatever the screen. A list is "these"; a person and a
 * linked request are one.
 */
const OUTSIDE_HUBS_OF = {
  'pickup requests': 'These pickup requests are at a hub your account does not work in.',
  'pickup runs': 'These pickup runs are at a hub your account does not work in.',
  messages: 'These messages are at a hub your account does not work in.',
  riders: 'These riders are at a hub your account does not work in.',
  'vendor accounts': 'These vendor accounts are at a hub your account does not work in.',
  'staff profiles': 'These staff profiles are at a hub your account does not work in.',
  'this person': 'This person is at a hub your account does not work in.',
  'a linked request': 'It belongs to a hub your account does not work in, or it is no longer there.',
} as const;

/** What a page can say it holds when a refusal is for a hub (see {@link refusalText}). */
export type HeldBy = keyof typeof OUTSIDE_HUBS_OF;

/**
 * The sentence of a refusal of authority, **one function for every screen** (PRODUCT_DESIGN_DIRECTION section 6.5): a missing permission is what the account cannot do, in plain words and never
 * the key ({@link cannotText}); a higher authority is told as that; a hub is told as the hub of what the page holds when it says what it holds (`of`), and as "this record" when it does not;
 * a different approver and an act the record does not allow are told as they are. The kit's refusal components (`ForbiddenState`, `ForbiddenPage`) and every page that words a refusal call it,
 * so that two screens never tell the same refusal in two ways (the staff list told every kind as a missing key). `kind` is `Problem.forbidden`; `undefined` is a refusal for want of a key.
 */
export function refusalText(
  kind: ForbiddenKind | undefined,
  permission: string | undefined,
  options: { readonly doing?: CapabilityWords; readonly of?: HeldBy } = {},
): string {
  switch (kind) {
    case 'insufficient-authority':
      return 'This needs a higher authority than your session has.';
    case 'outside-hubs':
      return options.of === undefined
        ? 'This record belongs to a hub your account does not work in.'
        : OUTSIDE_HUBS_OF[options.of];
    case 'approval-required':
      return 'A different approver decides this.';
    case 'unavailable-here':
      return 'This cannot be done for this record as it stands.';
    case 'permission-missing':
    case undefined:
      return cannotText(permission, options.doing);
  }
}

/** Every sentence a hub refusal can be, for the test that holds each to plain words with no key and no role in it. */
export const OUTSIDE_HUBS_SENTENCES: readonly string[] = Object.values(OUTSIDE_HUBS_OF);

/** The permission keys that have words, for the test that holds the table to the catalogue and to the source. */
export const CAPABILITY_KEYS: readonly string[] = Object.keys(CAPABILITY);

/** Every wording the table can give, for the test that holds each to a plain sentence with no key in it. */
export const CAPABILITY_WORDS: readonly CapabilityWords[] = [
  ...Object.values(CAPABILITY),
  ...READ_WITH_THE_SAME_KEY,
];
