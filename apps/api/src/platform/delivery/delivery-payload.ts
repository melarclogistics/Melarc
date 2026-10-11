import { sealedContext } from '../auth/crypto/sealed-context.js';
import type { DeliveryChannel } from '../auth/ports/delivery-queue.port.js';
import { isUuid } from '../database/transaction-context.js';
import {
  DELIVERY_PAYLOAD_VERSION,
  type DeliveryKind,
  type RedemptionRecordType,
} from './delivery-vocabulary.js';

/**
 * The sealed payload of a delivery job (SECURITY_DESIGN.md §13.9a) and what it is bound to. **A persisted format**: a payload sealed
 * today is opened by the worker of a later release, so the layout is versioned (`DELIVERY_PAYLOAD_VERSION`, stored in the text
 * and by the envelope), the associated data is pinned by a test, and neither changes in place.
 *
 * **What the payload holds is the least a send needs**: the destination and the link, which carries the raw token. The kind, the
 * channel and the principal are columns of the row and are not repeated inside it; the message's wording belongs to the provider
 * adapter. The destination and the token exist in clear nowhere else in Melarc, apart from the capture sink of a non-production
 * environment, which holds the message in clear by design.
 *
 * **What it is bound to.** The associated data names the job, the kind, the principal and the redemption record, as the document
 * says, so a ciphertext copied to another row, another kind of message, another person or another credential does not open. It is
 * built here from the row's own columns by `sealedContext` and never from a request, for sealing and for opening alike.
 */

const MAX_DESTINATION_CHARACTERS = 320;
const MAX_LINK_CHARACTERS = 2048;
// Any white space or control character: an address or a link has none, and one is how a second address hides inside the first.
const CONTROL_OR_SPACE = /[\s\p{Cc}]/u;

export interface DeliveryPayloadContent {
  readonly destination: string;
  readonly link: string;
}

/**
 * Why a payload could not be read: it is `MALFORMED` (no reader will ever make sense of it), or it is in a layout this reader
 * does not support (`VERSION_UNSUPPORTED`: a newer writer made it, and a reader that is newer can open it).
 */
export type PayloadProblem = 'MALFORMED' | 'VERSION_UNSUPPORTED';

/** A payload that cannot be made or read. It names nothing of what was in it: it may hold a destination and a token. */
export class PayloadUnreadableError extends Error {
  readonly code = 'PAYLOAD_UNREADABLE';
  constructor(readonly reason: PayloadProblem = 'MALFORMED') {
    super('The payload of a delivery job is not readable');
    this.name = 'PayloadUnreadableError';
  }
}

/** Why a destination or a link is not acceptable, in a word that holds none of it. */
export type TextProblem = 'EMPTY' | 'SHAPE';

const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+\.[^\s@,;:<>()[\]\\"]+$/u;
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Whether `destination` is something the channel can send to: an address for email, a number in the form of E.164 for SMS. The
 * destination was resolved by the issuing service from the principal's registered channel, never from a request
 * (SECURITY_DESIGN.md §13.9a); this only refuses one that could not be an address or a number at all.
 */
export function destinationProblem(
  channel: DeliveryChannel,
  destination: string,
): TextProblem | undefined {
  if (destination === '') return 'EMPTY';
  if (destination.length > MAX_DESTINATION_CHARACTERS) return 'SHAPE';
  if (CONTROL_OR_SPACE.test(destination)) return 'SHAPE';
  return (channel === 'EMAIL' ? EMAIL : E164).test(destination) ? undefined : 'SHAPE';
}

/**
 * Whether `link` is a web address a person can open from a message: http or https, no user information, no white space. The
 * origins are never taken from a request (SECURITY_DESIGN.md §13.9a); which origin a link may have is the issuing service's rule.
 */
export function linkProblem(link: string): TextProblem | undefined {
  if (link === '') return 'EMPTY';
  if (link.length > MAX_LINK_CHARACTERS || CONTROL_OR_SPACE.test(link)) return 'SHAPE';
  if (!URL.canParse(link)) return 'SHAPE';
  const url = new URL(link);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'SHAPE';
  if (url.username !== '' || url.password !== '' || url.host === '') return 'SHAPE';
  return undefined;
}

/** What is wrong with the content as text, whatever the channel: the channel's own shape is judged where the channel is known. */
function contentProblem(content: DeliveryPayloadContent): TextProblem | undefined {
  const { destination, link } = content;
  if (typeof destination !== 'string' || typeof link !== 'string') return 'SHAPE';
  if (destination === '') return 'EMPTY';
  if (destination.length > MAX_DESTINATION_CHARACTERS || CONTROL_OR_SPACE.test(destination)) {
    return 'SHAPE';
  }
  return linkProblem(link);
}

/** The bytes to seal. Refuses a destination or a link that is not usable, so that nothing unreadable is ever queued. */
export function encodeDeliveryPayload(content: DeliveryPayloadContent): Uint8Array {
  if (contentProblem(content) !== undefined) throw new PayloadUnreadableError();
  return new TextEncoder().encode(
    JSON.stringify({
      v: DELIVERY_PAYLOAD_VERSION,
      destination: content.destination,
      link: content.link,
    }),
  );
}

/** The destination and the link out of opened bytes, or `PayloadUnreadableError`: it reads exactly what `encode` writes. */
export function decodeDeliveryPayload(bytes: Uint8Array): DeliveryPayloadContent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PayloadUnreadableError();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PayloadUnreadableError();
  }
  const record = value as Record<string, unknown>;
  // A layout from a newer writer is not garbage, whatever else it adds: a reader that is newer can open it.
  const written = record.v;
  if (
    typeof written === 'number' &&
    Number.isInteger(written) &&
    written > DELIVERY_PAYLOAD_VERSION
  ) {
    throw new PayloadUnreadableError('VERSION_UNSUPPORTED');
  }
  if (Object.keys(record).sort().join(',') !== 'destination,link,v') {
    throw new PayloadUnreadableError();
  }
  const { v, destination, link } = record;
  if (v !== DELIVERY_PAYLOAD_VERSION) throw new PayloadUnreadableError();
  if (typeof destination !== 'string' || typeof link !== 'string') {
    throw new PayloadUnreadableError();
  }
  const content: DeliveryPayloadContent = { destination, link };
  if (contentProblem(content) !== undefined) throw new PayloadUnreadableError();
  return content;
}

/** The row a payload belongs to, as the columns that name it. */
export interface PayloadBinding {
  readonly jobId: string;
  readonly kind: DeliveryKind;
  readonly principal: { readonly type: string; readonly id: string };
  readonly redemption: { readonly type: RedemptionRecordType; readonly id: string };
}

const canonicalId = (id: string): string => {
  if (!isUuid(id)) throw new TypeError('A payload is bound to identifiers.');
  return id.toLowerCase();
};

/**
 * The associated data for `DELIVERY_PAYLOAD`: the principal (its type and identity), the kind of message as the operation, and as
 * the record the job, the type of redemption record and its identity. Identifiers are lower case, so an identifier written in
 * capitals seals under the same context as the one in lower case.
 */
export function deliveryPayloadContext(binding: PayloadBinding): Uint8Array {
  return sealedContext({
    principal: `${binding.principal.type}:${canonicalId(binding.principal.id)}`,
    operation: binding.kind,
    record: `${canonicalId(binding.jobId)}/${binding.redemption.type}/${canonicalId(binding.redemption.id)}`,
  });
}
