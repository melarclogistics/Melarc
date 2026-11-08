import type { DeliveryOutcome } from './delivery-queue.port.js';
import type { PortDescriptor } from './port-descriptor.js';

/**
 * A business text message: a confirmation, a handshake code, a rider's run notice. It carries text and no link, which is what tells it
 * from a credential message (`ProviderMessage` of the delivery provider, whose link is required). The destination and the text exist
 * in clear only here and at the send; no outcome, error or log line of an adapter repeats either.
 */
export interface TextMessage {
  /** Stable across every attempt of the same message, so that an adapter that can deduplicate treats a retry as the same message. */
  readonly dedupeId: string;
  /** E.164, with the leading plus: `+233244000111`. */
  readonly destination: string;
  /** The words of the message. A provider may refuse a text it cannot take (Hubtel's: 1 to 1000 characters). */
  readonly text: string;
}

/**
 * What the provider says about a message it accepted earlier. Only the mobile network's final word is final: `PENDING` (sent, queued,
 * submitted) may still become `DELIVERED` or `FAILED`, and `UNKNOWN` is every answer that cannot be read, including no answer at all.
 * `outcomeClass` is present for `FAILED` only, and is a closed, non-secret word.
 */
export interface TextStatus {
  readonly state: 'PENDING' | 'DELIVERED' | 'FAILED' | 'UNKNOWN';
  readonly outcomeClass?: string;
}

/**
 * The text-message provider, called by the notification lane and by nothing else, with no transaction open. It answers with the
 * delivery queue's own `DeliveryOutcome`: a timeout or a lost acknowledgement is `UNKNOWN`, not a failure, and `retryAfterMs` is the
 * provider's own request to wait, which may lengthen the wait and never removes the bound of the schedule. `REJECTED` is deterministic.
 * Nothing is thrown for what a provider can do (refuse, stall, answer rubbish): an adapter that was built wrongly fails when it is built.
 */
export interface TextMessageSender {
  send(message: TextMessage): Promise<DeliveryOutcome>;
  /** The state of an earlier accepted send, by the reference the provider gave when it accepted it. */
  status(providerMessageRef: string): Promise<TextStatus>;
}

export const TEXT_MESSAGE_SENDER = Symbol('TEXT_MESSAGE_SENDER');

export const TEXT_MESSAGE_SENDER_DESCRIPTOR: PortDescriptor<TextMessageSender> = {
  port: 'TextMessageSender',
  owner: { kind: 'platform', area: 'notifications' },
  operations: {
    send: {
      inputs: 'the message: deduplication identity, destination in E.164 and text',
      outputs:
        "accepted with the provider's reference; rejected with a closed, non-secret outcome class (REQUEST_INVALID for a destination or text the provider cannot take, PROVIDER_AUTHENTICATION, PROVIDER_REFUSED); or unknown, which a timeout, a lost acknowledgement, an unfunded account and a temporary provider fault are, with the provider's own wait where it gave one",
      outcomes: ['REJECTED', 'UNKNOWN'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
    status: {
      inputs: "the provider's reference of an earlier accepted send",
      outputs:
        'the state the provider reports (pending, delivered, or failed with a closed outcome class), or unknown when it cannot be read or the provider did not answer',
      outcomes: ['UNKNOWN'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
  },
};
