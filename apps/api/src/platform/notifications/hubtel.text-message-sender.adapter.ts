import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import type {
  TextMessage,
  TextMessageSender,
  TextStatus,
} from '../auth/ports/text-message-sender.port.js';
import type { HubtelSendResult, HubtelSmsClient } from './hubtel-sms-client.js';

/** How long to wait before asking again when the account has no funds: the owner may fund it, and the wait is not the provider's. */
const UNFUNDED_ACCOUNT_RETRY_MS = 300_000;
/** The most of a wait the provider asks for that is heeded: a provider cannot hold a message for longer than ten minutes by asking. */
const LONGEST_PROVIDER_WAIT_MS = 600_000;

/** What the adapter needs of the client: the two calls. A test gives it a stand-in for the client when the mapping alone is in question. */
export type HubtelSender = Pick<HubtelSmsClient, 'send' | 'status'>;

/**
 * The `TextMessageSender` over Hubtel (`hubtel-sms-client.ts`, whose header writes down the contract this is built on, and marks it
 * UNVERIFIED). It decides what a result of the exchange means to the notification lane; the exchange itself is the client's.
 *
 * A send that was wrong, or that Hubtel refuses for what the message is, is `REJECTED` with a closed class and is not retried: a number
 * or a text Hubtel cannot take (`REQUEST_INVALID`, also the answer to a message that is checked before anything is sent), credentials it
 * does not know (`PROVIDER_AUTHENTICATION`), any other refusal (`PROVIDER_REFUSED`). Everything that may be put right by waiting, or that
 * says nothing certain about whether the message was taken, is `UNKNOWN`: an account without funds (HTTP 402, asked again after five
 * minutes), a provider that is busy or at fault (429, with its own wait where it gave one, never more than ten minutes; any 5xx), no
 * answer at all, and an answer that is not an acceptance though its status is a success.
 *
 * It sends the destination and the text and nothing else of the message; the identity of the message is not forwarded, as the contract
 * has no place for it. No outcome, error or log line holds a destination, a text, a credential, a header, an address or a word of the
 * provider: the only thing of the provider's that comes out is the reference of a message it accepted. It is an adapter, imported only by
 * the composition root.
 */
export class HubtelTextMessageSender implements TextMessageSender {
  readonly #client: HubtelSender;

  constructor(client: HubtelSender) {
    this.#client = client;
  }

  async send(message: TextMessage): Promise<DeliveryOutcome> {
    return outcomeOf(
      await this.#client.send({ destination: message.destination, text: message.text }),
    );
  }

  status(providerMessageRef: string): Promise<TextStatus> {
    return this.#client.status(providerMessageRef);
  }
}

function outcomeOf(result: HubtelSendResult): DeliveryOutcome {
  switch (result.kind) {
    case 'ACCEPTED':
      return { outcome: 'ACCEPTED', providerMessageRef: result.messageId };
    case 'INVALID_REQUEST':
      return { outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' };
    case 'UNUSABLE_ANSWER':
    case 'NO_ANSWER':
      return { outcome: 'UNKNOWN' };
    case 'HTTP_REFUSED':
      return refusalOutcome(result.status, result.retryAfterMs);
  }
}

/** The outcome of an answer whose HTTP status is not a success. */
function refusalOutcome(status: number, retryAfterMs: number | undefined): DeliveryOutcome {
  switch (status) {
    case 400:
    case 404:
    case 422:
      return { outcome: 'REJECTED', outcomeClass: 'REQUEST_INVALID' };
    case 401:
    case 403:
      return { outcome: 'REJECTED', outcomeClass: 'PROVIDER_AUTHENTICATION' };
    case 402:
      return { outcome: 'UNKNOWN', retryAfterMs: UNFUNDED_ACCOUNT_RETRY_MS };
    case 429:
      return retryAfterMs !== undefined && retryAfterMs > 0
        ? { outcome: 'UNKNOWN', retryAfterMs: Math.min(retryAfterMs, LONGEST_PROVIDER_WAIT_MS) }
        : { outcome: 'UNKNOWN' };
    default:
      return status >= 500
        ? { outcome: 'UNKNOWN' }
        : { outcome: 'REJECTED', outcomeClass: 'PROVIDER_REFUSED' };
  }
}
