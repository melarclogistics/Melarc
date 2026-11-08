import type { components } from '@melarc/api-client';

import { instantOf, isOneOf, isRecord, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the message log (S1.12e) believes of an answer, judged field by field before anything is drawn, as the identity, vendor, rider and pickup
 * screens' are (`staff-shape.ts`, `pickup-shape.ts`). The types are the contract's, narrowed to the fields the screen reads; a field the contract
 * adds and this does not read goes nowhere, and an answer that is not the API's (a proxy's page, another version's list, an entry that carries a
 * number in clear) is refused whole rather than shown in part. `test/notification-contract.test.ts` holds every list below to the contract.
 *
 * **An entry holds no destination in clear, no text and no code** (the contract says so, and the API's role has no column that could). This has
 * no place to put one either: the only number it keeps is the masked hint, judged to be one (`DESTINATION_HINT`), and the wording only as its
 * version. `test/notification-no-destination.test.ts` fails on any read of a field the lists below do not name.
 */
type EntryBody = components['schemas']['NotificationLogEntry'];

export type NotificationState = EntryBody['state'];
export type NotificationAudience = EntryBody['audience'];
export type NotificationChannel = EntryBody['channel'];
export type SuppressionReason = NonNullable<EntryBody['suppression_reason']>;
export type OutcomeClass = NonNullable<EntryBody['outcome_class']>;
/** The kinds of record a message can be about. */
export type SubjectType = EntryBody['subject']['type'];

/** A record's fields as the guard hands them on: a field the answer left out or sent as null is left out, so null is never one of its values. */
type Present<Body> = { readonly [Key in keyof Body]: Exclude<Body[Key], null> };

/**
 * One message of the log, with the fields the screen reads and no other. The destination is the hint alone, and the wording is its version:
 * there is no field for a number in clear, a text or a code.
 */
export type NotificationEntryView = Present<
  Pick<
    EntryBody,
    | 'id'
    | 'message_kind'
    | 'template_version'
    | 'audience'
    | 'channel'
    | 'state'
    | 'suppression_reason'
    | 'outcome_class'
    | 'provider_outcome_class'
    | 'destination_hint'
    | 'attempt_count'
    | 'subject'
    | 'created_at'
  >
>;

export interface NotificationPageView {
  readonly items: readonly NotificationEntryView[];
  /** The token of the next page, or nothing when this is the last. */
  readonly nextPageToken: string | null;
}

export const NOTIFICATION_STATES = [
  'QUEUED',
  'LEASED',
  'RETRYABLE',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SUPPRESSED',
  'EXPIRED',
] as const satisfies readonly NotificationState[];

export const NOTIFICATION_AUDIENCES = [
  'AD_HOC_SENDER',
  'VENDOR_NUMBER',
  'RIDER',
  'RECIPIENT',
  'VENDOR_FEED',
  'OPS_FEED',
] as const satisfies readonly NotificationAudience[];

export const NOTIFICATION_CHANNELS = [
  'SMS',
  'FEED',
] as const satisfies readonly NotificationChannel[];

export const SUPPRESSION_REASONS = [
  'KILL_SWITCH',
  'NUMBER_LIMIT',
  'DAY_LIMIT',
  'WINDOW_LIMIT',
  'DESTINATION_NOT_ALLOWED',
  'DESTINATION_REFUSED',
  'NO_DESTINATION',
  'OVERTAKEN',
  'WORDING_NOT_APPROVED',
] as const satisfies readonly SuppressionReason[];

export const OUTCOME_CLASSES = [
  'ACCEPTED',
  'UNKNOWN',
  'REJECTED',
  'DELIVERY_FAILED',
  'SCHEDULE_EXHAUSTED',
  'EXPIRED',
  'RELINQUISHED',
] as const satisfies readonly OutcomeClass[];

/** The records a message can be about. A later slice adds its own, with the reader of it. */
export const SUBJECT_TYPES = [
  'PICKUP_REQUEST',
  'PICKUP_MANIFEST',
] as const satisfies readonly EntryBody['subject']['type'][];

/** The fields each guard reads, held to the contract by `test/notification-contract.test.ts`. */
export const NOTIFICATION_FIELDS = {
  NotificationLogEntry: {
    required: [
      'id',
      'message_kind',
      'template_version',
      'audience',
      'channel',
      'state',
      'subject',
      'responsible_hub_id',
      'attempt_count',
      'expires_at',
      'created_at',
    ],
    optional: [
      'suppression_reason',
      'outcome_class',
      'provider_outcome_class',
      'destination_hint',
      'sent_at',
      'delivered_at',
    ],
    enums: {
      audience: NOTIFICATION_AUDIENCES,
      channel: NOTIFICATION_CHANNELS,
      state: NOTIFICATION_STATES,
      suppression_reason: SUPPRESSION_REASONS,
      outcome_class: OUTCOME_CLASSES,
    },
  },
} as const;

/** The record a message is about, an object of the entry that the contract does not name as a schema of its own. */
export const SUBJECT_FIELDS = {
  required: ['type', 'id'],
  enums: { type: SUBJECT_TYPES },
} as const;

/** The most a page of the log can hold (the contract's largest `page_size`). */
const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;

/** The contract's own pattern of a message's kind: a stable name, never wording. */
export const MESSAGE_KIND = /^[A-Z][A-Z0-9_]{2,63}$/;
/** The contract's own pattern of the provider's closed word. A word that breaks it is not one the server sends, and is never drawn. */
export const PROVIDER_OUTCOME_CLASS = /^[A-Z][A-Z0-9_]{0,47}$/;
/** The contract's `maxLength` of the hint. */
export const MAX_DESTINATION_HINT = 24;
/**
 * A masked number as the contract describes it (`+233******111`): the country part (at most four figures), stars, and the last three
 * digits. **It is a pattern that no whole number can match**: a number is at least eight figures, and a hint shows at most seven and hides at
 * least one, so an entry whose "hint" is a number in clear is refused (with the page it came in) and is never drawn.
 */
export const DESTINATION_HINT = /^\+[0-9]{1,4}\*+[0-9]{3}$/;

const wholeAtLeast = (value: unknown, least: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least ? value : undefined;

/** An enumerated value of one of the lists above, or nothing. */
const oneOf =
  <const List extends readonly string[]>(list: List) =>
  (value: unknown): List[number] | undefined =>
    isOneOf(list, value) ? value : undefined;

const messageKindOf = (value: unknown): string | undefined =>
  typeof value === 'string' && MESSAGE_KIND.test(value) ? value : undefined;

const providerWordOf = (value: unknown): string | undefined =>
  typeof value === 'string' && PROVIDER_OUTCOME_CLASS.test(value) ? value : undefined;

const hintOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_DESTINATION_HINT && DESTINATION_HINT.test(value)
    ? value
    : undefined;

/** A state, an audience or a channel from the address, or nothing: an address is the person's to edit, and a value that is not one is no filter. */
export const notificationStateOf = (text: string | null): NotificationState | undefined =>
  NOTIFICATION_STATES.find((state) => state === text);
export const audienceOf = (text: string | null): NotificationAudience | undefined =>
  NOTIFICATION_AUDIENCES.find((audience) => audience === text);
export const channelOf = (text: string | null): NotificationChannel | undefined =>
  NOTIFICATION_CHANNELS.find((channel) => channel === text);
/** The record asked about, from the address: an identifier, or nothing. */
export const subjectIdOf = (text: string | null): string | undefined => uuidOf(text);
/**
 * The kind of record asked about, from the address (`subject_type`): exactly a kind the contract has, or nothing. The log is asked for by the
 * identifier alone (`subject_id`) and never by the kind; the kind is for what the page says it is about, in every state it can be in, so it is
 * read from the address and from nothing the server answers.
 */
export const subjectTypeOf = (text: string | null): SubjectType | undefined =>
  SUBJECT_TYPES.find((type) => type === text);
/** The address of the log narrowed to one record: its identifier and its kind, so that the page knows what it is about before it has read anything. */
export const subjectLogPath = (type: SubjectType, id: string): string =>
  `/messages?subject=${id}&subject_type=${type}`;

function parseSubject(body: unknown): NotificationEntryView['subject'] | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  if (id === undefined || !isOneOf(SUBJECT_TYPES, body.type)) return undefined;
  return { type: body.type, id };
}

/**
 * One entry of the log, or nothing when it is not one the screen may show. The eleven fields the contract requires must be there and sound;
 * every other field is judged when it is there (`optional`: absent and null are nothing, anything else is judged), and one that is there and
 * not sound makes the whole entry unusable. A held-back message has its reason, and no other has one (the contract: "present exactly when the
 * state is `SUPPRESSED`", which the table's own constraint enforces too).
 */
export function parseNotificationEntry(body: unknown): NotificationEntryView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const kind = messageKindOf(body.message_kind);
  const version = wholeAtLeast(body.template_version, 1);
  const attempts = wholeAtLeast(body.attempt_count, 0);
  const subject = parseSubject(body.subject);
  const createdAt = instantOf(body.created_at);
  // Required by the contract and not drawn: an entry without them is not one of the API's.
  const hub = uuidOf(body.responsible_hub_id);
  const expiresAt = instantOf(body.expires_at);
  const reason = optional(body.suppression_reason, oneOf(SUPPRESSION_REASONS));
  const outcome = optional(body.outcome_class, oneOf(OUTCOME_CLASSES));
  const providerWord = optional(body.provider_outcome_class, providerWordOf);
  const hint = optional(body.destination_hint, hintOf);
  const sentAt = optional(body.sent_at, instantOf);
  const deliveredAt = optional(body.delivered_at, instantOf);
  if (
    id === undefined ||
    kind === undefined ||
    version === undefined ||
    attempts === undefined ||
    subject === undefined ||
    createdAt === undefined ||
    hub === undefined ||
    expiresAt === undefined ||
    reason === undefined ||
    outcome === undefined ||
    providerWord === undefined ||
    hint === undefined ||
    sentAt === undefined ||
    deliveredAt === undefined ||
    !isOneOf(NOTIFICATION_AUDIENCES, body.audience) ||
    !isOneOf(NOTIFICATION_CHANNELS, body.channel) ||
    !isOneOf(NOTIFICATION_STATES, body.state) ||
    (body.state === 'SUPPRESSED') !== (reason !== null)
  ) {
    return undefined;
  }

  // A field the answer left out, or sent as null, is left out: the screen says what it can without it.
  return {
    id,
    message_kind: kind,
    template_version: version,
    audience: body.audience,
    channel: body.channel,
    state: body.state,
    ...(reason === null ? {} : { suppression_reason: reason }),
    ...(outcome === null ? {} : { outcome_class: outcome }),
    ...(providerWord === null ? {} : { provider_outcome_class: providerWord }),
    ...(hint === null ? {} : { destination_hint: hint }),
    attempt_count: attempts,
    subject,
    created_at: createdAt,
  };
}

/** A page of `listNotifications`. One entry that is not a message makes the whole page unusable, and a message listed twice is not the API's. */
export function parseNotificationPage(body: unknown): NotificationPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: NotificationEntryView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const message = parseNotificationEntry(entry);
    if (message === undefined || seen.has(message.id.toLowerCase())) return undefined;
    seen.add(message.id.toLowerCase());
    items.push(message);
  }
  return { items, nextPageToken: token };
}
