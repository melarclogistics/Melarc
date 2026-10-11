/**
 * The closed sets of the durable credential-delivery job (SECURITY_DESIGN.md §13.9a; state-machines.md §22; plan S0.17). The
 * table repeats every set as a CHECK, and a test compares the two, so the code and the database cannot drift apart.
 *
 * **What is the contract's and what is chosen here.** The seven states, the four kinds, the two channels and the two redemption
 * records are the documents'. The set of *outcome classes* is the one thing the documents leave to the build ("a closed,
 * non-secret `outcome_class`"; `DESTINATION_NOT_ALLOWED` is the only class they name, approved 9 October 2026): the rest are the
 * smallest set that tells an operator why a job ended and what the alerts count, and they are listed for the Product Owner in
 * plan section 7.14. A class never carries a destination, a link, a token, a provider's message or an identifier.
 */

/** What the message is for (SECURITY_DESIGN.md §13.9a: `SETUP_GRANT`, `RECOVERY_LINK`, `DEVICE_GRANT` or `MFA_REENROLMENT`). */
export const DELIVERY_KINDS = [
  'SETUP_GRANT',
  'RECOVERY_LINK',
  'DEVICE_GRANT',
  'MFA_REENROLMENT',
] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** The hash-only redemption record a job serves: the one thing whose validity decides whether the credential works. */
export const REDEMPTION_RECORD_TYPES = ['SETUP_GRANT', 'RECOVERY_REQUEST'] as const;
export type RedemptionRecordType = (typeof REDEMPTION_RECORD_TYPES)[number];

/**
 * A recovery link serves a `RecoveryRequest`; every other kind serves a `SetupGrant` (state-machines.md §18, §19, §22). The table
 * holds the same pairing as a CHECK, so a job cannot name a record of the wrong machine.
 */
export const REDEMPTION_TYPE_OF_KIND: Readonly<Record<DeliveryKind, RedemptionRecordType>> = {
  SETUP_GRANT: 'SETUP_GRANT',
  RECOVERY_LINK: 'RECOVERY_REQUEST',
  DEVICE_GRANT: 'SETUP_GRANT',
  MFA_REENROLMENT: 'SETUP_GRANT',
};

/**
 * Who a message can be for. A rider's two device grants are returned in the response and shown as a QR, and never enter this port
 * (§13.9a), so a rider is not a principal of a job.
 */
export const DELIVERY_PRINCIPAL_TYPES = ['STAFF', 'VENDOR'] as const;
export type DeliveryPrincipalType = (typeof DELIVERY_PRINCIPAL_TYPES)[number];

export const DELIVERY_CHANNELS = ['EMAIL', 'SMS'] as const;

export const JOB_STATES = [
  'QUEUED',
  'LEASED',
  'ACCEPTED',
  'RETRYABLE',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** The states a job can still leave: the ones that hold a payload and can still be claimed, finished or cancelled. */
export const LIVE_STATES = ['QUEUED', 'LEASED', 'RETRYABLE'] as const;
/** The states a job never leaves. The payload is erased on the way in, and the database holds the two together. */
export const TERMINAL_STATES = ['ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;

/**
 * Why a job is where it is, by the last thing that happened to it. Closed and non-secret: the alerts count these and nothing else
 * of a job (OBSERVABILITY_AND_RECOVERY.md §3).
 *
 * - `ACCEPTED`: the provider took the message (never that the recipient got it).
 * - `UNKNOWN`: no answer, or an answer that says try again (a timeout, a lost acknowledgement, a 429 or a temporary 5xx): the
 *   same link and the same deduplication identity are tried again on the schedule.
 * - `REJECTED`: a deterministic refusal (an invalid number, a malformed request): no blind retry.
 * - `DESTINATION_NOT_ALLOWED`: a destination outside the controlled validation window (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1).
 * - `SCHEDULE_EXHAUSTED`: the bounded schedule ended, or its next attempt would fall after the redemption record's expiry.
 * - `PAYLOAD_UNREADABLE`: the sealed payload does not authenticate as its row's, or is not what is written: no worker can open it, no
 *   retry can change that, and the job ends.
 * - `PAYLOAD_DEFERRED`: this worker does not hold the key, the envelope or the layout version the payload was sealed in (a rotation or a
 *   release under way). Nothing was sent and the message is live: the job waits, on a schedule of its own, for a worker that can open
 *   it, and the claim is not counted against the sends the schedule allows (`deferred_claims`).
 * - `EXPIRED` and `CANCELLED`: the redemption record ended, by time or by the act that consumed, superseded or invalidated it.
 * - `RELINQUISHED`: a worker that was stopping gave the job back without finishing it.
 * - `REDEMPTION_UNCONFIRMED`: the worker could not confirm that the redemption record is still pending, so it sent nothing.
 */
export const OUTCOME_CLASSES = [
  'ACCEPTED',
  'UNKNOWN',
  'REJECTED',
  'DESTINATION_NOT_ALLOWED',
  'SCHEDULE_EXHAUSTED',
  'PAYLOAD_UNREADABLE',
  'PAYLOAD_DEFERRED',
  'EXPIRED',
  'CANCELLED',
  'RELINQUISHED',
  'REDEMPTION_UNCONFIRMED',
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** The classes a job that ended in `FAILED` may carry: a failure that will not be sent, and is counted and alerts. */
export const TERMINAL_FAILURE_CLASSES = [
  'REJECTED',
  'DESTINATION_NOT_ALLOWED',
  'SCHEDULE_EXHAUSTED',
  'PAYLOAD_UNREADABLE',
] as const;
export type TerminalFailureClass = (typeof TERMINAL_FAILURE_CLASSES)[number];

/** The classes a job that is waiting for another attempt may carry. */
export const RETRY_CLASSES = [
  'UNKNOWN',
  'RELINQUISHED',
  'REDEMPTION_UNCONFIRMED',
  'PAYLOAD_DEFERRED',
] as const;

/**
 * The classes of an outcome that was recorded before any provider was asked, because the worker could not do what a send needs (open
 * the payload, confirm the record). The claim that led to it is given back: it is not one of the sends the schedule allows.
 */
export const DEFERRAL_CLASSES = ['PAYLOAD_DEFERRED', 'REDEMPTION_UNCONFIRMED'] as const;
export type DeferralClass = (typeof DEFERRAL_CLASSES)[number];

/** The states a lease belongs to. */
export const isLiveState = (state: JobState): boolean =>
  (LIVE_STATES as readonly string[]).includes(state);

/**
 * The envelope the sealed payload is stored in has a fixed layout, and so has the text inside it (`delivery-payload.ts`). A
 * reader selects the layout from the record and never by trial.
 */
export const DELIVERY_PAYLOAD_VERSION = 1;
