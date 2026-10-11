import type { PortDescriptor } from './port-descriptor.js';
import type { PrincipalRef } from './identity-directory.port.js';
import type { TransactionHandle } from './unit-of-work.port.js';

export type DeliveryChannel = 'EMAIL' | 'SMS';

/** The record a message serves: a hash-only redemption record such as a setup grant or a recovery request. */
export interface RedemptionRef {
  readonly type: string;
  readonly id: string;
}

/** What the queue is asked to send. The adapter encrypts it; the destination and the link exist in clear only here and at the send. */
export interface DeliveryRequest {
  readonly kind: string;
  readonly redemption: RedemptionRef;
  readonly principal: PrincipalRef;
  readonly channel: DeliveryChannel;
  readonly destination: string;
  readonly link: string;
  /** The end of the redemption record: a job is never retried past it. */
  readonly expiresAt: Date;
}

export interface DeliveryJobRef {
  readonly id: string;
  /** Stable across every attempt of the job, so a retry is the same message to the provider. */
  readonly providerDedupeId: string;
}

/**
 * A job a worker holds the lease of, with what it needs to record an outcome and to count one: nothing secret. A claim whose payload
 * would not open reports one of these (`PayloadUnreadableError`), because the lease is held and an outcome is still owed.
 */
export interface LeasedJob {
  readonly job: DeliveryJobRef;
  /** Fences a stale worker: an outcome recorded with an older version than the job's is refused. */
  readonly leaseVersion: number;
  /**
   * Which send this claim is, counting this one: the claims so far less the ones that were recorded as ended before any provider was
   * asked (a deferral). The schedule counts these, not claims: a claim that found the worker unable to open the payload is not a send.
   * A claim whose worker said nothing (it crashed) still counts, because it may have sent.
   */
  readonly attempt: number;
  /** How many deferrals the job had before this claim: what the wait after the next one grows from. */
  readonly deferrals: number;
  readonly kind: string;
  readonly channel: DeliveryChannel;
}

export interface ClaimedDelivery extends LeasedJob {
  /** True when this claim took over a lease that had ended with no outcome: a worker crashed, or was too slow. */
  readonly reclaimed: boolean;
  readonly request: DeliveryRequest;
}

/**
 * What the provider said, or that it said nothing. `UNKNOWN` is a normal case: a timeout, a lost acknowledgement, a 429 or a
 * temporary 5xx all mean the message may or may not have been accepted, and the job is tried again with the same link and the same
 * deduplication identity. `retryAfterMs` is a provider's own request to wait (HTTP `Retry-After`): it may lengthen the wait and
 * never removes the bound of the schedule. `REJECTED` is deterministic: nothing is retried blindly.
 */
export type DeliveryOutcome =
  | { readonly outcome: 'ACCEPTED'; readonly providerMessageRef: string | null }
  | { readonly outcome: 'REJECTED'; readonly outcomeClass: string }
  | { readonly outcome: 'UNKNOWN'; readonly retryAfterMs?: number };

/**
 * What a worker records about a job it holds: the provider's answer, or why it did not ask the provider. The redemption record
 * having ended (consumed, superseded, cancelled or expired) means nothing was sent and the job ends; not being able to confirm
 * that it is still pending means nothing was sent and the job waits (a deferral, which gives its claim back); a sealed payload that no
 * worker can open ends the job, because no retry can change that, and one that only this worker cannot open (a key, envelope or
 * layout version it has not been given) is a deferral too; a job claimed after the last attempt of the schedule ends without a send;
 * and giving a job back because the worker is stopping is not a failure of the provider.
 */
export type RecordedOutcome =
  | DeliveryOutcome
  | { readonly outcome: 'REDEMPTION_CLOSED' }
  | { readonly outcome: 'REDEMPTION_UNCONFIRMED' }
  | { readonly outcome: 'PAYLOAD_UNREADABLE' }
  | { readonly outcome: 'PAYLOAD_DEFERRED' }
  | { readonly outcome: 'SCHEDULE_EXHAUSTED' }
  | { readonly outcome: 'RELINQUISHED' };

/**
 * Where a job stands once an outcome has been recorded: the state it moved to and the non-secret class that says why. The worker
 * counts a terminal failure by this, because whether a job ran out of schedule or of time is decided by the database, on its clock,
 * in the statement that records the outcome.
 */
export interface JobEnd {
  readonly state: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  readonly outcomeClass: string;
}

export type DeliverySelector =
  | { readonly by: 'redemption'; readonly redemption: RedemptionRef }
  | { readonly by: 'principal'; readonly principal: PrincipalRef };

/**
 * The durable credential-delivery queue (SECURITY_DESIGN.md §13.9, §13.9a). A message is enqueued **in the transaction of the
 * act that issues the credential**, beside the hash-only redemption record, and a separate worker sends it. No provider is
 * called on a request's response path. The worker side, `claim` and `recordOutcome`, opens short transactions of its own and is
 * called with none open, and the worker holds no transaction while it calls the provider.
 */
export interface DeliveryQueue {
  enqueue(transaction: TransactionHandle, request: DeliveryRequest): Promise<DeliveryJobRef>;
  cancel(transaction: TransactionHandle, selector: DeliverySelector): Promise<number>;
  claim(workerId: string, leaseMilliseconds: number): Promise<ClaimedDelivery | null>;
  recordOutcome(leased: LeasedJob, outcome: RecordedOutcome): Promise<JobEnd>;
}

export const DELIVERY_QUEUE = Symbol('DELIVERY_QUEUE');

export const DELIVERY_QUEUE_DESCRIPTOR: PortDescriptor<DeliveryQueue> = {
  port: 'DeliveryQueue',
  owner: { kind: 'platform', area: 'delivery' },
  operations: {
    enqueue: {
      inputs:
        'the transaction and the request: kind, redemption record, principal, channel, destination, link and end',
      outputs: 'the job and its stable provider dedupe identity',
      outcomes: 'none',
      raises: ['DELIVERY_NOT_QUEUEABLE', 'DELIVERY_CONTEXT_INVALID'],
      transaction: 'inside-callers-transaction',
    },
    cancel: {
      inputs:
        'the transaction (under the issuing capability) and which jobs: those of a redemption record or of a principal',
      outputs:
        'how many jobs were cancelled; a send already in flight is dead because redemption refuses it',
      outcomes: 'none',
      raises: ['DELIVERY_CONTEXT_INVALID'],
      transaction: 'inside-callers-transaction',
    },
    claim: {
      inputs: "the worker's identity and the lease length",
      outputs:
        'the next due job with its lease and its payload opened in memory, or null when none is due; a lease whose earlier holder left no outcome is taken over, and the claim says so; a payload that would not open is reported with the lease and why (no worker can open it, or only this one cannot)',
      outcomes: ['NOTHING_DUE'],
      raises: ['PAYLOAD_UNREADABLE'],
      transaction: 'outside-any-transaction',
    },
    recordOutcome: {
      inputs:
        'the leased job and the outcome: accepted, rejected or unknown from the provider, or that the redemption record ended, could not be confirmed, the payload would not open, the schedule has no attempt left, or the worker is stopping',
      outputs:
        "where the job now stands, its state and its non-secret outcome class: the job moves to its next state, and the payload of a job that has ended is erased; an unknown outcome waits on the bounded schedule or, when it has run out or would fall past the record's expiry, ends the job",
      outcomes: 'none',
      raises: ['LEASE_LOST'],
      transaction: 'outside-any-transaction',
    },
  },
};
