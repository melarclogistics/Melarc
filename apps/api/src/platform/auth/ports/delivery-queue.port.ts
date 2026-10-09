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

export interface ClaimedDelivery {
  readonly job: DeliveryJobRef;
  /** Fences a stale worker: an outcome recorded with an older version than the job's is refused. */
  readonly leaseVersion: number;
  readonly attempt: number;
  readonly request: DeliveryRequest;
}

/** What the provider said, or that it said nothing. `UNKNOWN` is a normal case: a timeout may mean the message was accepted. */
export type DeliveryOutcome =
  | { readonly outcome: 'ACCEPTED'; readonly providerMessageRef: string | null }
  | { readonly outcome: 'REJECTED'; readonly outcomeClass: string }
  | { readonly outcome: 'UNKNOWN' };

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
  recordOutcome(claimed: ClaimedDelivery, outcome: DeliveryOutcome): Promise<void>;
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
      raises: ['DELIVERY_NOT_QUEUEABLE'],
      transaction: 'inside-callers-transaction',
    },
    cancel: {
      inputs: 'the transaction and which jobs: those of a redemption record or of a principal',
      outputs:
        'how many jobs were cancelled; a send already in flight is dead because redemption refuses it',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    claim: {
      inputs: "the worker's identity and the lease length",
      outputs: 'the next due job with its lease, or null when none is due',
      outcomes: ['NOTHING_DUE'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
    recordOutcome: {
      inputs: 'the claimed job and the outcome: accepted, rejected or unknown',
      outputs: "nothing: the job moves to its next state and an accepted job's payload is erased",
      outcomes: 'none',
      raises: ['LEASE_LOST'],
      transaction: 'outside-any-transaction',
    },
  },
};
