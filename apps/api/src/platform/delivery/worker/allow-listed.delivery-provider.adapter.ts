import type { DeliveryOutcome } from '../../auth/ports/delivery-queue.port.js';
import type { DeliveryProvider, ProviderMessage } from '../../auth/ports/delivery-provider.port.js';
import { isAllowed, type AllowList } from './delivery-allow-list.js';

/**
 * The guard of the controlled real-provider window (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1), in front of any provider: "enforced by
 * the delivery adapter before any provider call". A message to a destination that is not on the list is refused with the
 * terminal outcome class `DESTINATION_NOT_ALLOWED` and the provider is **never called**; every other message goes through
 * unchanged. A status query is not a send and passes through.
 *
 * The worker composes it whenever an allow-list is configured (and a deployed Staging run with a real provider is refused without
 * one). It is an adapter, imported only by the composition root.
 */
export class AllowListedDeliveryProvider implements DeliveryProvider {
  readonly #inner: DeliveryProvider;
  readonly #list: AllowList;

  constructor(inner: DeliveryProvider, list: AllowList) {
    this.#inner = inner;
    this.#list = list;
  }

  send(message: ProviderMessage): Promise<DeliveryOutcome> {
    if (!isAllowed(this.#list, message.channel, message.destination)) {
      return Promise.resolve({ outcome: 'REJECTED', outcomeClass: 'DESTINATION_NOT_ALLOWED' });
    }
    return this.#inner.send(message);
  }

  status(dedupeId: string): Promise<DeliveryOutcome | null> {
    return this.#inner.status(dedupeId);
  }
}
