/**
 * The closed sets of the outbox and of the notification (S1.12a; BACKGROUND_JOBS_AND_EVENTS.md §3.7; SECURITY_DESIGN.md §14.7;
 * data-scope-registry.md `Outbox` and `Notification`). The two tables repeat every set as a CHECK, and a test compares the two, so
 * the code and the database cannot drift apart.
 *
 * **What is the documents' and what is chosen here.** The envelope's fields and the relay's narrow bookkeeping are the documents'.
 * The states of a notification (queued, leased, retryable, sent, delivered, failed, suppressed) and the way a send ends are the
 * smallest set that tells an operator what became of a message and what the alerts count; they follow the credential-delivery job
 * (state-machines.md §22) where the two machines are alike, and the sets below are listed for the Product Owner in the plan. A
 * value never carries a destination, a text, a code or a provider's message.
 */

/**
 * The aggregates a notification may be raised about. A later slice adds its own, in the migration that adds the reader of it. The pickup
 * manifest is the second (S1.21, migration 0063): the rider's text on dispatch is about the run, and not about any one request in it.
 */
export const OUTBOX_AGGREGATE_TYPES = ['PICKUP_REQUEST', 'PICKUP_MANIFEST'] as const;
export type OutboxAggregateType = (typeof OUTBOX_AGGREGATE_TYPES)[number];

/** Who did the act the envelope describes: the originating principal (§14.7). */
export const OUTBOX_PRINCIPAL_TYPES = ['STAFF', 'VENDOR', 'RIDER', 'SYSTEM'] as const;
export type OutboxPrincipalType = (typeof OUTBOX_PRINCIPAL_TYPES)[number];

/**
 * The relay's bookkeeping. `PENDING` is due, or waiting for its next attempt; `LEASED` is held by a lane; `RELAYED` has produced its
 * notifications (or found there were none to produce); `DEAD` is dead-lettered and waits for a person (BJE §3.3).
 */
export const OUTBOX_RELAY_STATES = ['PENDING', 'LEASED', 'RELAYED', 'DEAD'] as const;
export type OutboxRelayState = (typeof OUTBOX_RELAY_STATES)[number];

/**
 * How the relay's last attempt ended: a closed, non-secret word. `SCOPE_MISMATCH` is the security signal of §14.7 step 8 (the stored
 * envelope and the reloaded aggregate disagree); `UNKNOWN_EVENT` is an event type that no message of the list answers.
 */
export const OUTBOX_OUTCOMES = [
  'MATERIALISED',
  'NOTHING_TO_SEND',
  'SCOPE_MISMATCH',
  'UNKNOWN_EVENT',
  'SCHEDULE_EXHAUSTED',
  'RETRY',
  'RELINQUISHED',
] as const;
export type OutboxOutcome = (typeof OUTBOX_OUTCOMES)[number];

/** Over which channel a notification travels: a text message, or the in-app feed (the Ops feed now, the Vendor's in SLICE-015). */
export const NOTIFICATION_CHANNELS = ['SMS', 'FEED'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Who a notification is for. The first four are people who are not principals of a feed, reached by text: the ad-hoc sender, the
 * registered vendor's registered number (for the handshake fallback only), the rider, and the recipient of a parcel (the heads-up, once
 * per parcel). The last two are feeds.
 */
export const NOTIFICATION_AUDIENCES = [
  'AD_HOC_SENDER',
  'VENDOR_NUMBER',
  'RIDER',
  'RECIPIENT',
  'VENDOR_FEED',
  'OPS_FEED',
] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

/**
 * The states of a notification. `QUEUED` and `RETRYABLE` are due at `next_attempt_at`; `LEASED` is held by a lane; `SENT` is accepted
 * by the provider and waits for the network's word; `DELIVERED`, `FAILED`, `SUPPRESSED` and `EXPIRED` are final. A feed entry is
 * `DELIVERED` when it is written: it is there to be read.
 */
export const NOTIFICATION_STATES = [
  'QUEUED',
  'LEASED',
  'RETRYABLE',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SUPPRESSED',
  'EXPIRED',
] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export const FINAL_NOTIFICATION_STATES = ['DELIVERED', 'FAILED', 'SUPPRESSED', 'EXPIRED'] as const;

/**
 * Why a message was held back and never sent. A limit, a kill switch, the allow-list of a controlled window, a destination that
 * Hubtel refuses, a person with no number, a message that events overtook (the request it announced was cancelled first), or wording
 * the owner has not approved (no real provider is asked to send it: OQ-037, OB-S1-06).
 */
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
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * How an attempt or a notification ended, as a closed, non-secret word (`outcome_class`). `ACCEPTED` is the provider's yes; `UNKNOWN`
 * is every answer that cannot be read; `REJECTED` is a refusal that retrying cannot change; `DELIVERY_FAILED` is the network's no after
 * the provider's yes; `SCHEDULE_EXHAUSTED` and `EXPIRED` are the end of the retry schedule and of the message's usefulness.
 */
export const NOTIFICATION_OUTCOME_CLASSES = [
  'ACCEPTED',
  'UNKNOWN',
  'REJECTED',
  'DELIVERY_FAILED',
  'SCHEDULE_EXHAUSTED',
  'EXPIRED',
  'RELINQUISHED',
] as const;
export type NotificationOutcomeClass = (typeof NOTIFICATION_OUTCOME_CLASSES)[number];

/**
 * The closed classes of a refusal by the guards of the controlled window, which stand in front of a real provider and answer as a
 * provider would (`REJECTED` with a class). The lane reads each as a message held back, never as a failure of the provider.
 */
export const GUARD_REFUSALS = {
  DESTINATION_NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED',
  WINDOW_ENDED: 'WINDOW_ENDED',
  WINDOW_CAP: 'WINDOW_CAP',
} as const;

/** The kinds of subject a notification is about, as the envelope's aggregate. */
export const NOTIFICATION_SUBJECT_TYPES = OUTBOX_AGGREGATE_TYPES;
