import type { DeliveryChannel, DeliveryOutcome } from './delivery-queue.port.js';
import type { PortDescriptor } from './port-descriptor.js';

export interface ProviderMessage {
  /** Stable across every attempt, so the provider can treat a retry as the same message. */
  readonly dedupeId: string;
  readonly kind: string;
  readonly channel: DeliveryChannel;
  readonly destination: string;
  readonly link: string;
}

/**
 * The email or SMS provider, called by the delivery worker and by nothing else, with no transaction open. A timeout or a lost
 * acknowledgement is `UNKNOWN`, not a failure: the job is retried with the same identity or reconciled by `status`
 * (SECURITY_DESIGN.md §13.9a). A destination outside the controlled validation window is refused with the terminal
 * outcome class `DESTINATION_NOT_ALLOWED` before anything is sent.
 */
export interface DeliveryProvider {
  send(message: ProviderMessage): Promise<DeliveryOutcome>;
  /** The state of an earlier send, where the provider offers a status query; null where it does not or does not know it. */
  status(dedupeId: string): Promise<DeliveryOutcome | null>;
}

export const DELIVERY_PROVIDER = Symbol('DELIVERY_PROVIDER');

export const DELIVERY_PROVIDER_DESCRIPTOR: PortDescriptor<DeliveryProvider> = {
  port: 'DeliveryProvider',
  owner: { kind: 'platform', area: 'delivery' },
  operations: {
    send: {
      inputs: 'the message: dedupe identity, kind, channel, destination and link',
      outputs:
        "accepted with the provider's reference; rejected with a non-secret outcome class, DESTINATION_NOT_ALLOWED among them for a destination outside the validation window; or unknown, which a timeout or a lost acknowledgement is",
      outcomes: ['REJECTED', 'UNKNOWN'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
    status: {
      inputs: 'the dedupe identity of an earlier send',
      outputs: 'the outcome the provider reports, or null when it offers no status query',
      outcomes: ['NO_STATUS_QUERY', 'UNKNOWN'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
  },
};
