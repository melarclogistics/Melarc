import type { LeasedJob } from '../auth/ports/delivery-queue.port.js';

/**
 * The conditions the delivery queue raises, by the names its port descriptor gives under `raises` (`delivery-queue.port.ts`). Each
 * message is fixed text built from nothing that was supplied: what a request or a job holds is a destination and a token, and an
 * error is the likeliest way for either to reach a log.
 */

/** Why a message could not be queued. The issuing operation answers the platform's generic operational failure for any of them. */
export type NotQueueableReason =
  /** A field of the request is not usable: a kind, a channel, a principal, an identifier, a destination or a link. */
  | 'REQUEST_INVALID'
  /** The redemption record already has its one message. */
  | 'ALREADY_QUEUED'
  /** The redemption record has already ended: a message that could only arrive after its credential expired is never queued. */
  | 'ENDED';

/**
 * `DELIVERY_NOT_QUEUEABLE`: the message was not queued. It is raised inside the issuing operation's transaction, so the act that
 * issues the credential does not happen either: a job that cannot be persisted is an operational failure and never a successful
 * acceptance (SECURITY_DESIGN.md §13.9a).
 */
export class DeliveryNotQueueableError extends Error {
  readonly code = 'DELIVERY_NOT_QUEUEABLE';
  constructor(
    readonly reason: NotQueueableReason,
    /** Which field, when it is a field: a name from the request and never its value. */
    readonly field?: string,
  ) {
    super('The credential message could not be queued');
    this.name = 'DeliveryNotQueueableError';
  }
}

/**
 * `LEASE_LOST`: the outcome was written against a lease that is no longer the job's. Another worker took the job over after this
 * one's lease ended, or the job was cancelled, expired or finished while the provider was being called. Nothing was written. The
 * holder of a stale lease does not retry: the later outcome, or the later state, is the truth.
 */
export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor() {
    super('The lease of this delivery job is no longer the worker’s');
    this.name = 'LeaseLostError';
  }
}

/**
 * Why a claimed job's payload would not open. `UNREADABLE`: no worker ever will (it does not authenticate as this row's, or it is not
 * what is written), so the job ends. `NOT_HELD`: this worker lacks the key, or the key version, or the envelope or payload layout it
 * was sealed in (a rotation or a release it has not been given yet); another worker can open it, so the payload is kept.
 */
export type UnreadableReason = 'UNREADABLE' | 'NOT_HELD';

/**
 * `PAYLOAD_UNREADABLE`, from a claim: the job was leased and its sealed payload would not open. The worker holds the lease and owes
 * an outcome, so the error carries the leased job and why, and nothing of the payload.
 */
export class UnreadableClaimError extends Error {
  readonly code = 'PAYLOAD_UNREADABLE';
  constructor(
    readonly leased: LeasedJob,
    readonly reason: UnreadableReason = 'UNREADABLE',
  ) {
    super('The payload of a leased delivery job would not open');
    this.name = 'UnreadableClaimError';
  }
}

/**
 * `DELIVERY_CONTEXT_INVALID`: a message was queued, or a job cancelled, in a transaction that is not the issuing capability's (a
 * `SYSTEM` context under `authentication`). It is a defect of the caller and is raised before anything is written: a cancellation
 * under another context would find no row to change and report that it had cancelled none, which reads as "nothing was live".
 */
export class DeliveryContextError extends Error {
  readonly code = 'DELIVERY_CONTEXT_INVALID';
  constructor() {
    super('The delivery queue is written to by the issuing capability only');
    this.name = 'DeliveryContextError';
  }
}

/** The adapter was built without a database for the worker side, as the API's is: `claim` and `recordOutcome` are the worker's. */
export class DeliveryWorkerSideUnavailableError extends Error {
  readonly code = 'DELIVERY_WORKER_SIDE_UNAVAILABLE';
  constructor() {
    super('This delivery queue was built without a worker database, so it cannot claim or record');
    this.name = 'DeliveryWorkerSideUnavailableError';
  }
}
