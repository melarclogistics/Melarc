import type { DeliveryChannel } from '../../auth/ports/delivery-queue.port.js';
import { destinationProblem } from '../delivery-payload.js';

/**
 * The recipient allow-list of the controlled real-provider window (DEPLOYMENT_AND_ENVIRONMENTS.md §4.1): "addresses and numbers
 * that Melarc staff control, enforced by the delivery adapter before any provider call". A message to any other destination is a
 * terminal failure of its own non-secret outcome class, `DESTINATION_NOT_ALLOWED`, and nothing is sent.
 *
 * An entry is an email address or a number in the form of E.164, judged by the same rules as a destination being queued, so a
 * list can name nothing a message could not be addressed to. Addresses are compared without regard to case; numbers exactly. The
 * list is bounded: a window is a handful of people, and a long list is a mistake.
 */
export const MAX_ALLOW_LIST_ENTRIES = 50;

export interface AllowList {
  readonly addresses: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
}

/**
 * The list a comma-separated setting spells, or `undefined` when it is empty, longer than the bound, has an entry that is not an
 * address or a number, or names the same destination twice. It says nothing about why, and keeps nothing of what it was given: an
 * entry is a person's address or number.
 */
export function parseAllowList(text: string): AllowList | undefined {
  const entries = text.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.length > MAX_ALLOW_LIST_ENTRIES) return undefined;

  const addresses = new Set<string>();
  const numbers = new Set<string>();
  for (const entry of entries) {
    const channel: DeliveryChannel = entry.includes('@') ? 'EMAIL' : 'SMS';
    if (destinationProblem(channel, entry) !== undefined) return undefined;
    const target = channel === 'EMAIL' ? addresses : numbers;
    const key = channel === 'EMAIL' ? entry.toLowerCase() : entry;
    if (target.has(key)) return undefined;
    target.add(key);
  }
  return { addresses, numbers };
}

/** Whether a message to `destination` over `channel` may be sent: the destination is on the list, for that channel. */
export function isAllowed(list: AllowList, channel: DeliveryChannel, destination: string): boolean {
  return channel === 'EMAIL'
    ? list.addresses.has(destination.toLowerCase())
    : list.numbers.has(destination);
}
