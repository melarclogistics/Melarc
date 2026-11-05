import type { Clock } from '../auth/ports/clock.port.js';
import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import type {
  TextMessage,
  TextMessageSender,
  TextStatus,
} from '../auth/ports/text-message-sender.port.js';
import { GUARD_REFUSALS } from './notification-vocabulary.js';
import {
  WindowCounterBusyError,
  WindowCounterUnreadableError,
  type WindowCounter,
} from './window-counter.js';

/**
 * The guards of the controlled window, in front of the real provider (S1.12d; DEPLOYMENT_AND_ENVIRONMENTS.md §4.1; SECURITY_DESIGN.md
 * §13.9a; the Product Owner's decision of 29 October 2026 amending the decision of 11 October 2026). A real text message from a local run
 * is allowed only inside a window the owner opened: an approval reference, an allow-list of the numbers the owner controls, the most
 * messages the window may send, and the moment it ends. This adapter is that window, and it is **enforced before any provider call**:
 *
 * 1. at or after the end of the window, nothing is sent (`WINDOW_ENDED`);
 * 2. a number that is not on the allow-list is never sent to (`DESTINATION_NOT_ALLOWED`), whatever the message;
 * 3. the cap holds across restarts and processes (`WINDOW_CAP`): a slot is taken from the window's counter **before** the provider is
 *    asked, and a slot is not given back when the provider refuses or does not answer, so that the cap bounds the attempts and not only
 *    the successes. A count that cannot be read stops the sending (the counter fails closed), as `UNKNOWN`: nothing was asked of the
 *    provider, and the message is tried again on its schedule.
 *
 * A refusal here is a `REJECTED` outcome with one of the closed classes of `GUARD_REFUSALS`; the lane reads it as a message held back and
 * not as a failure of the provider. The status of an earlier send is asked of the provider as it is: it sends nothing and costs nothing.
 *
 * The capture adapter reaches nobody and is never put behind this. It is an adapter, imported only by the composition root.
 */
export interface GuardedTextMessageSenderOptions {
  readonly inner: TextMessageSender;
  readonly clock: Pick<Clock, 'now'>;
  /** The numbers the window may text, in E.164, exactly. */
  readonly allowList: ReadonlySet<string>;
  /** The moment the window ends: no message is sent at or after it. */
  readonly endsAt: Date;
  readonly counter: WindowCounter;
}

/** How long a message waits when the window's count could not be taken: nothing was asked of the provider. */
const COUNTER_RETRY_MS = 60_000;

export class GuardedTextMessageSender implements TextMessageSender {
  readonly #options: GuardedTextMessageSenderOptions;

  constructor(options: GuardedTextMessageSenderOptions) {
    this.#options = options;
  }

  async send(message: TextMessage): Promise<DeliveryOutcome> {
    const { inner, clock, allowList, endsAt, counter } = this.#options;
    if (clock.now().getTime() >= endsAt.getTime()) {
      return { outcome: 'REJECTED', outcomeClass: GUARD_REFUSALS.WINDOW_ENDED };
    }
    if (!allowList.has(message.destination)) {
      return { outcome: 'REJECTED', outcomeClass: GUARD_REFUSALS.DESTINATION_NOT_ALLOWED };
    }
    try {
      if (!(await counter.take())) {
        return { outcome: 'REJECTED', outcomeClass: GUARD_REFUSALS.WINDOW_CAP };
      }
    } catch (error) {
      // A count that cannot be read or taken is the one failure in which the cap must hold: nothing is sent. Anything else is a defect.
      if (
        error instanceof WindowCounterUnreadableError ||
        error instanceof WindowCounterBusyError
      ) {
        return { outcome: 'UNKNOWN', retryAfterMs: COUNTER_RETRY_MS };
      }
      throw error;
    }
    return inner.send(message);
  }

  status(providerMessageRef: string): Promise<TextStatus> {
    return this.#options.inner.status(providerMessageRef);
  }
}
