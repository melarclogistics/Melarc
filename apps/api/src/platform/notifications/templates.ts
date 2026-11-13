/**
 * The wording of the messages (S1.12b; `message-list.ts`), versioned and in English only (decided 29 October 2026). A template is a
 * version of one kind's words with the placeholders it may use; **editing the words is a new version**, so a notification that records
 * the version it used can always be read back as it was said. The administration of templates (an editor, per-vendor preferences) is
 * SLICE-010's; what is here is the mechanism and the first words. A kind may have a second wording for one closed value of one of its parameters (`whenParameters`), as a
 * feed entry that asks nothing of its reader need not say so: each wording is approved, and bound to its digest, on its own.
 *
 * **The words are the Product Owner's to approve (OQ-037; OB-S1-06).** Every template below is a DRAFT until its `approvedBy` names the
 * owner, `approvedOn` the day and `approvedDigest` the digest of the very words approved (`wordingDigest`): the lane puts a real provider
 * in front of approved words only, and holds an unapproved message back (`WORDING_NOT_APPROVED`). **An approval holds for exactly those
 * words**: a wording edited after its approval no longer matches the digest and is a draft again, whether or not the version was raised.
 * The capture adapter, which reaches nobody, sends any. An approval is the owner's act and is recorded here by the owner's word; nothing
 * in the code approves a template.
 *
 * **What a text may hold.** No link (a credential or tracking link would not be a business text), nothing private (no address, no
 * amount, no note, no reason), and only the placeholders the kind names: each is checked on the way in, so a value that would carry a
 * link, a control character or a second line is refused, and a template that uses a placeholder it does not name cannot be rendered.
 * A text is plain ASCII, so that it travels as one message of the GSM alphabet (160 characters) and not as the 70-character kind that a
 * single curly quote forces.
 */

import { createHash } from 'node:crypto';

export interface Template {
  readonly kind: string;
  readonly version: number;
  /** The title of a feed entry; null for a text message. */
  readonly title: string | null;
  /** The words, with `{placeholder}` where a value goes. */
  readonly wording: string;
  /** The placeholders the wording may use, and the only values `render` accepts. */
  readonly placeholders: readonly string[];
  /**
   * Where a kind has a second wording for a closed value of one of its parameters (the feed entry of a skip that asks nothing of the vendor says so in fewer words), the
   * parameters of the notification this wording is for: every member must equal the notification's own (`templateFor`). The wording of the kind that has none is its ordinary
   * one, `templateOf`'s, and is used when no other fits. It is part of what an approval is bound to: the same words approved for another case are not approved.
   */
  readonly whenParameters?: Readonly<Record<string, string>>;
  /** Who approved the words and when: all three set, or none. A draft has none. */
  readonly approvedBy: string | null;
  readonly approvedOn: string | null;
  /** The digest of the words that were approved (`wordingDigest`): the approval holds for exactly those words and no others. */
  readonly approvedDigest: string | null;
}

export const TEMPLATES: readonly Template[] = [
  {
    kind: 'PICKUP_CONFIRMED_SENDER',
    version: 1,
    title: null,
    wording: 'Melarc: your pickup {code} is confirmed for {date}. Please have your parcels ready.',
    placeholders: ['code', 'date'],
    // Approved by the Product Owner on 30 October 2026, for exactly these words (OQ-037).
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-10-30',
    approvedDigest: '649f6799e75097c57350915c178b2f5fa4ec61d17412670ed8bc41aac7e8bd0e',
  },
  {
    kind: 'PICKUP_CONFIRMED_VENDOR_FEED',
    version: 1,
    title: 'Pickup confirmed',
    wording: 'Your pickup request {code} is confirmed for {date}.',
    placeholders: ['code', 'date'],
    // Approved by the Product Owner on 30 October 2026, for exactly these words (OQ-037).
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-10-30',
    approvedDigest: 'b39cd4dd78d83e7509819ad9d8c431d25bc281312b933e5a6ae23458b822b499',
  },
  {
    kind: 'RUN_DISPATCHED_RIDER',
    version: 1,
    title: null,
    wording:
      'Melarc: your pickup run {code} for {date} is ready. Open the Melarc app to see your stops.',
    placeholders: ['code', 'date'],
    // Approved by the Product Owner on 2 November 2026, for exactly these words (OB-S1-06): the approval of wording only. It sends nothing and
    // waives nothing: a real provider still needs the controlled window, its allow-list of numbers, its cap and its credentials
    // (lane-policy.ts), and a text that the provider has not delivered is not a dispatch that failed (the dispatch commits with its envelope).
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-02',
    approvedDigest: '1846cc8b7b2e3354dbb3088d54023af692e977dd4dbae1fd2f3df92a81346b89',
  },
  {
    // S1.23: the feed entry of a skipped stop, for a registered vendor (MSC-DEC-412). The reason and the action are closed tokens that the Vendor's screens turn into words
    // (SLICE-015), and the words here are what the entry says until they do. It holds none of Ops's note. This is the entry of a skip that asks something of the vendor (the
    // action is not `NONE`); the one that asks nothing is the wording below.
    // Approved by the Product Owner on 12 November 2026 (D-A5), for exactly these words (OB-S1-06): the approval of wording only. It sends nothing and waives nothing.
    kind: 'PICKUP_SKIPPED_VENDOR_FEED',
    version: 1,
    title: 'Pickup not collected',
    wording:
      'Your pickup request {code} for {date} was not collected on this run ({reason}). What we need from you: {action}.',
    placeholders: ['code', 'date', 'reason', 'action'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: 'a1fc7435060180a064f1146d79c30bf917c495c0828fc301adab69c15c09c93f',
  },
  {
    // The same entry when the skip asks nothing of the vendor (the run was cut short, the vendor asked for it, the stop was raised in error): the first sentence of the wording
    // above, alone, so that the entry does not say "What we need from you: NONE". Chosen by the notification's own recorded action (`templateFor`); the kind, and so what Ops
    // sees in the log, is the same. Approved by the Product Owner on 12 November 2026 (D-A5) as its own wording, with its own digest.
    kind: 'PICKUP_SKIPPED_VENDOR_FEED',
    version: 1,
    title: 'Pickup not collected',
    wording: 'Your pickup request {code} for {date} was not collected on this run ({reason}).',
    placeholders: ['code', 'date', 'reason'],
    whenParameters: { action: 'NONE' },
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: 'edcb98d628ec6ad33691a7e7e55b716ebbc3f8b4168d77126bb0ab7564bad709',
  },
  {
    // S1.27: the code of the collection handshake, texted to an individual sender (pickup-collection.md): the code and the pickup it is for, nothing else, no link.
    // Approved by the Product Owner on 12 November 2026 (D-A5), for exactly these words (OB-S1-06): the approval of wording only. It sends nothing and waives nothing: a real
    // provider still needs the controlled window, its allow-list of numbers, its cap and its credentials (lane-policy.ts).
    kind: 'HANDSHAKE_CODE_SENDER',
    version: 1,
    title: null,
    wording:
      'Melarc: your pickup code is {handshake_code}. Give it to the rider only when the rider asks, to complete pickup {code}.',
    placeholders: ['code', 'handshake_code'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: '4bf0cf05ebc2f2d9758f8592e17fe37bf527780b0ee3b4cd7950ba7dec69752e',
  },
  {
    // S1.27: the code of the SMS fallback, texted to the registered number of a vendor (MSC-DEC-198 fallback 1). Approved by the Product Owner on 12 November 2026 (D-A5), for
    // exactly these words (OB-S1-06): wording only, as the one above.
    kind: 'HANDSHAKE_CODE_VENDOR_NUMBER',
    version: 1,
    title: null,
    wording:
      'Melarc: the pickup code for {code} is {handshake_code}. Read it to the Melarc rider only, to complete the pickup.',
    placeholders: ['code', 'handshake_code'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: '065060cd5018c37d0bd5d50a77dd0828a1e2232405792fac1763f83259bf55fa',
  },
  {
    // S1.28: the text to an individual sender whose pickup failed (PII-safe): the request and the day it was planned for, and nothing of why, no note, no address and no link.
    // Approved by the Product Owner on 12 November 2026 (D-A5), for exactly these words (OQ-037; OB-S1-06): wording only, as the ones above.
    kind: 'PICKUP_FAILED_SENDER',
    version: 1,
    title: null,
    wording:
      'Melarc: we could not complete your pickup {code} planned for {date}. We will be in touch about the next step.',
    placeholders: ['code', 'date'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: 'ce1e9e98e1ca9dc36fb6e4b523e96b4851fab4882ccf1bd3d2eca326a3f68ef4',
  },
  {
    // S1.28: the registered vendor's feed entry for a failure. The category and the reason are closed tokens that the Vendor's screens turn into words (SLICE-015); the words here
    // are what the entry says until they do. It holds none of the rider's note. Approved by the Product Owner on 12 November 2026 (D-A5), for exactly these words: wording only.
    kind: 'PICKUP_FAILED_VENDOR_FEED',
    version: 1,
    title: 'Pickup not completed',
    wording:
      'Your pickup request {code} for {date} could not be completed ({category}: {reason}). Melarc will be in touch about the next step.',
    placeholders: ['code', 'date', 'category', 'reason'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: 'f43ed602028f9ee5983f5b4b3349dae8bb115bebcf57cbcac4dc1d3b7ca63d38',
  },
  {
    // S1.28: the Ops feed entry for a failure, the "Ops event" of §31.2. It holds none of the rider's note. Approved by the Product Owner on 12 November 2026 (D-A5), for exactly
    // these words: wording only.
    kind: 'PICKUP_FAILED_OPS_FEED',
    version: 1,
    title: 'Pickup failed',
    wording:
      'Pickup request {code} for {date} failed ({category}: {reason}). It waits in the decision queue.',
    placeholders: ['code', 'date', 'category', 'reason'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: '43c99a3e389d3209a12874fc174063c69c18a26dbf767264f2586f625054be14',
  },
  {
    // OB-S1-51: the Ops feed entry for a short count, so that the office is told in the system and not only by a timestamp. It holds no count (a feed entry carries tokens, and
    // the counts are on the record the shortfall list shows) and none of the rider's note. Approved by the Product Owner on 12 November 2026 (D-A5), for exactly these words:
    // wording only.
    kind: 'COLLECTION_SHORT_OPS_FEED',
    version: 1,
    title: 'Pickup counted short',
    wording:
      'Pickup request {code} for {date} was counted short at the door ({reason}). The office is asked to follow it up.',
    placeholders: ['code', 'date', 'reason'],
    approvedBy: 'Mathias Elorm, Product Owner',
    approvedOn: '2026-11-12',
    approvedDigest: '07b770c030f3a0a5bf45ba5eefcbcd911182d9095f57320aab04b6c085f82568',
  },
];

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** The ordinary wording of a kind at a version: the one that is not for a particular value of a parameter. */
export function templateOf(kind: string, version: number): Template | undefined {
  return TEMPLATES.find(
    (template) =>
      template.kind === kind &&
      template.version === version &&
      template.whenParameters === undefined,
  );
}

/**
 * The words of one notification: its kind's second wording if the parameters the notification recorded are the ones that wording is for, else the ordinary one. The notification
 * records its kind, its version and its parameters (and nothing of the words), so this is what reads back what it said. The lane renders a text message with `templateOf` alone, so
 * no text message has a second wording (`message-list.test.ts` holds that); a feed entry is rendered by whoever shows it (the Vendor's feed, SLICE-015), and chooses with this.
 */
export function templateFor(
  kind: string,
  version: number,
  parameters: Readonly<Record<string, string>>,
): Template | undefined {
  const second = TEMPLATES.find(
    (template) =>
      template.kind === kind &&
      template.version === version &&
      template.whenParameters !== undefined &&
      Object.entries(template.whenParameters).every(([name, value]) => parameters[name] === value),
  );
  return second ?? templateOf(kind, version);
}

/**
 * The digest of the words of a template (kind, version, title, wording and placeholders, and the case a second wording is for): what an approval is bound to. A wording that is for
 * no particular case adds nothing to the digest, so the digests of the approvals made before the second wording existed still hold.
 */
export function wordingDigest(
  template: Pick<
    Template,
    'kind' | 'version' | 'title' | 'wording' | 'placeholders' | 'whenParameters'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        template.kind,
        template.version,
        template.title,
        template.wording,
        template.placeholders,
        ...(template.whenParameters === undefined
          ? []
          : [Object.entries(template.whenParameters).toSorted()]),
      ]),
    )
    .digest('hex');
}

/**
 * Whether the Product Owner has approved these very words: the approver, the day and the digest are recorded, and the digest is that of
 * the wording as it is now. Words edited after their approval are a draft again.
 */
export function isApproved(template: Template): boolean {
  return (
    template.approvedBy !== null &&
    template.approvedOn !== null &&
    template.approvedDigest === wordingDigest(template)
  );
}

const MAX_VALUE_LENGTH = 64;
/** Printable ASCII, no line break and no control character. */
const PLAIN_VALUE = /^[\x20-\x7e]+$/;
/** A value that could turn into a link or a lookalike: a scheme, a host-like word, a path. */
const LINK_LIKE = /(?:https?:|www\.|\/\/|\.[a-z]{2,}\/)/i;

/**
 * The words with their values in. Every placeholder of the wording must be named by the template and given a value, and a value that is
 * long, is not plain text, or looks like a link is refused: a template is rendered into a message that is texted to a person.
 */
export function render(template: Template, values: Readonly<Record<string, string>>): string {
  const used = [...template.wording.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1] ?? '');
  for (const name of used) {
    if (!template.placeholders.includes(name)) {
      throw new TemplateError(
        `The wording of ${template.kind} uses a placeholder it does not name.`,
      );
    }
  }
  for (const name of Object.keys(values)) {
    if (!template.placeholders.includes(name)) {
      throw new TemplateError(`${template.kind} has no placeholder called ${name}.`);
    }
  }
  return template.wording.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new TemplateError(`${template.kind} needs a value for ${name}.`);
    }
    if (value.length > MAX_VALUE_LENGTH || !PLAIN_VALUE.test(value) || LINK_LIKE.test(value)) {
      throw new TemplateError(`The value for ${name} cannot go into a message.`);
    }
    return value;
  });
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `2026-11-03` as `Tuesday 3 November`: a date of the hub's calendar, written without a time zone or the year of the current one. */
export function spokenDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new TemplateError('A service date is YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    throw new TemplateError('A service date must be a real date.');
  }
  return `${WEEKDAYS[at.getUTCDay()] ?? ''} ${String(day)} ${MONTHS[month - 1] ?? ''}`;
}
