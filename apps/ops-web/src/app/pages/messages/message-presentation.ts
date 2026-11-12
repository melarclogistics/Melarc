import type { StatusMap } from '../../../components/ui/status-badge/StatusBadge';
import {
  subjectLogPath,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationEntryView,
  type NotificationState,
  type OutcomeClass,
  type SubjectType,
  type SuppressionReason,
} from '../../../platform/notifications/notification-shape';

/**
 * How the message log says things (S1.12e): what a state, an audience, a channel, a message and an outcome are called. **All of these words are
 * provisional, for the Product Owner to reword**, and they are the only place the log's words are kept. The words belong to the screen and not
 * to the server; every mapping is typed over its whole enumeration, so a value the contract adds is a compile error here until someone decides
 * how it reads. Nothing here names a number, a text or a code: the log has none to show.
 */
export const NOTIFICATION_STATE_MAP: StatusMap<NotificationState> = {
  QUEUED: { tone: 'neutral', label: 'Waiting to be sent' },
  LEASED: { tone: 'info', label: 'Being sent' },
  RETRYABLE: { tone: 'warning', label: 'Will try again' },
  SENT: { tone: 'info', label: 'Sent, waiting for the network' },
  DELIVERED: { tone: 'success', label: 'Delivered' },
  FAILED: { tone: 'danger', label: 'Failed' },
  SUPPRESSED: { tone: 'warning', label: 'Held back' },
  EXPIRED: { tone: 'neutral', label: 'Too late to send' },
};

/** A feed entry is `DELIVERED` when it is written: it is there to be read, and is told so. */
export const FEED_STATE_MAP: StatusMap<NotificationState> = {
  ...NOTIFICATION_STATE_MAP,
  DELIVERED: { tone: 'success', label: 'In the feed' },
};

/** The words of a state for the channel the message travelled over. */
export const stateMapFor = (channel: NotificationChannel): StatusMap<NotificationState> =>
  channel === 'FEED' ? FEED_STATE_MAP : NOTIFICATION_STATE_MAP;

export const AUDIENCE_LABELS: Readonly<Record<NotificationAudience, string>> = {
  AD_HOC_SENDER: 'Ad-hoc sender',
  VENDOR_NUMBER: 'Vendor’s registered number',
  RIDER: 'Rider',
  RECIPIENT: 'Recipient',
  VENDOR_FEED: 'Vendor’s feed',
  OPS_FEED: 'Ops feed',
};

export const CHANNEL_LABELS: Readonly<Record<NotificationChannel, string>> = {
  SMS: 'Text message',
  FEED: 'In-app feed',
};

/** Why a message was held back and never sent. */
export const SUPPRESSION_REASON_LABELS: Readonly<Record<SuppressionReason, string>> = {
  KILL_SWITCH: 'Switched off',
  NUMBER_LIMIT: 'This number reached its daily limit',
  DAY_LIMIT: 'The daily limit for all messages was reached',
  WINDOW_LIMIT: 'The test window’s message limit was reached',
  DESTINATION_NOT_ALLOWED: 'The number is not on the test window’s list',
  DESTINATION_REFUSED: 'The provider would not take this number',
  NO_DESTINATION: 'There was no number to send to',
  OVERTAKEN: 'The request changed before this was sent',
  WORDING_NOT_APPROVED: 'The wording is not yet approved for real sending',
};

/** How the last attempt, or the message, ended. */
export const OUTCOME_LABELS: Readonly<Record<OutcomeClass, string>> = {
  ACCEPTED: 'The provider accepted it',
  UNKNOWN: 'The provider gave no clear answer',
  REJECTED: 'The provider refused it',
  DELIVERY_FAILED: 'The network said it did not arrive',
  SCHEDULE_EXHAUSTED: 'Gave up after every retry',
  EXPIRED: 'Too old to send',
  RELINQUISHED: 'Handed back',
};

/**
 * What the record a message is about is called, and where its page is. Typed over every kind of record the contract has, so a kind it adds is a
 * compile error here until someone decides how it reads and where it goes. An identifier is only ever the end of an address, never text.
 */
export const SUBJECT_LABELS: Readonly<Record<SubjectType, string>> = {
  PICKUP_REQUEST: 'Pickup request',
  PICKUP_MANIFEST: 'Pickup run',
};

/**
 * What the log says of the record it is narrowed to, by the kind of record it is (the Product Owner, 2 November 2026): a request keeps its
 * words, and a run is a pickup run. Typed over every kind, as the two mappings beside it are, so a kind the contract adds is a compile error
 * until someone decides how it reads. The kind is learned from the entries the narrowed log shows, which are all about the one record asked for.
 */
export const SUBJECT_HEADINGS: Readonly<Record<SubjectType, string>> = {
  PICKUP_REQUEST: 'Messages about one request',
  PICKUP_MANIFEST: 'Messages about this pickup run',
};

/**
 * A pickup run has no page of its own yet (the manifest screens are not built), so its subject opens the messages about it: the same log, narrowed
 * to the run. A page is added here when the screen is (a presentation choice of S1.21, not a decision about the run).
 */
export const SUBJECT_PATHS: Readonly<Record<SubjectType, (id: string) => string>> = {
  PICKUP_REQUEST: (id) => `/pickup-requests/${id}`,
  PICKUP_MANIFEST: (id) => subjectLogPath('PICKUP_MANIFEST', id),
};

/**
 * The messages the API's list holds (`apps/api/src/platform/notifications/message-list.ts`: the two that are wired and the ones planned), in
 * the plain words of what the message is about. The audience and the channel are told by their own columns, so a message sent twice over two
 * channels reads the same in both rows. `test/message-kinds.test.ts` holds this list to that one, so a message added there is labelled here;
 * a kind this list does not know is still shown, in sentence case (`messageKindLabel`).
 */
export const MESSAGE_KIND_LABELS = {
  PICKUP_CONFIRMED_SENDER: 'Pickup request confirmed',
  PICKUP_CONFIRMED_VENDOR_FEED: 'Pickup request confirmed',
  PICKUP_DECLINED_SENDER: 'Pickup request declined',
  PICKUP_DECLINED_VENDOR_FEED: 'Pickup request declined',
  HANDSHAKE_CODE_SENDER: 'Collection handshake code',
  HANDSHAKE_CODE_VENDOR_NUMBER: 'Collection handshake code, sent as a fallback',
  PICKUP_FAILED_SENDER: 'Pickup failed',
  PICKUP_FAILED_VENDOR_FEED: 'Pickup failed',
  PICKUP_FAILED_OPS_FEED: 'Pickup failed',
  COLLECTION_SHORT_OPS_FEED: 'Pickup counted short',
  PICKUP_SKIPPED_VENDOR_FEED: 'Pickup stop skipped',
  PICKUP_FAILURE_ESCALATED_OPS_FEED: 'Pickup failure escalated',
  HUB_HANDOVER_SUBMITTED_OPS_FEED: 'Hub handover submitted',
  INTAKE_COMPLETED_SENDER: 'Intake completed',
  INTAKE_COMPLETED_VENDOR_FEED: 'Intake completed',
  RECIPIENT_HEADS_UP: 'Delivery heads-up',
  RUN_DISPATCHED_RIDER: 'Pickup run dispatched',
  DELIVERY_RUN_DISPATCHED_RIDER: 'Delivery run dispatched',
  RUN_REASSIGNED_RIDER: 'Run reassigned',
} as const satisfies Record<string, string>;

export type KnownMessageKind = keyof typeof MESSAGE_KIND_LABELS;

const isKnownKind = (kind: string): kind is KnownMessageKind =>
  Object.hasOwn(MESSAGE_KIND_LABELS, kind);

/**
 * What a message is, in words. A kind the list above does not know (a newer server's) is never hidden and never shown as the raw name: it is the
 * name in sentence case, `NEW_KIND_SENDER` as "New kind sender".
 */
export function messageKindLabel(kind: string): string {
  if (isKnownKind(kind)) return MESSAGE_KIND_LABELS[kind];
  const words = kind.toLowerCase().replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * What became of a message, in words: the reason a held-back one was held back, and otherwise how it ended. Nothing for a message that has
 * not ended in any way yet, or a feed entry, which is written and not sent.
 */
export function whatHappenedText(entry: NotificationEntryView): string | undefined {
  if (entry.state === 'SUPPRESSED') {
    return entry.suppression_reason === undefined
      ? undefined
      : SUPPRESSION_REASON_LABELS[entry.suppression_reason];
  }
  return entry.outcome_class === undefined ? undefined : OUTCOME_LABELS[entry.outcome_class];
}

/**
 * The version of the wording a message was rendered from: a later edit never rewrites what was said. The wording itself is not in the log. The
 * number is held to its word by a no-break space, so that a narrow column never leaves it alone on a line.
 */
/** A space that never breaks a line: it holds a number to the word before it. */
export const NO_BREAK_SPACE = String.fromCharCode(0xa0);

export const wordingVersionText = (version: number): string =>
  `Wording version${NO_BREAK_SPACE}${String(version)}`;

/** The provider's own closed word for a refusal, as supporting text. */
export const providerWordText = (word: string): string => `Provider’s word: ${word}`;

/** What a cell with nothing to say says to assistive technology, where the eye sees a dash. */
export const NO_NUMBER = 'No number';
export const NOTHING_TO_REPORT = 'Nothing to report';
