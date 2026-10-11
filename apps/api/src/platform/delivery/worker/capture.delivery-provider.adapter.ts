import type { Clock } from '../../auth/ports/clock.port.js';
import type { DeliveryOutcome } from '../../auth/ports/delivery-queue.port.js';
import type { DeliveryProvider, ProviderMessage } from '../../auth/ports/delivery-provider.port.js';
import type { CaptureSink } from './capture-sink.js';

export interface CaptureDeliveryProviderOptions {
  readonly sink: CaptureSink;
  readonly clock: Pick<Clock, 'now'>;
}

/**
 * The capture adapter (DEPLOYMENT_AND_ENVIRONMENTS.md §4; SECURITY_DESIGN.md §13.9a): the `DeliveryProvider` of Local and CI, and
 * of Staging by default. It reaches nobody. It writes each message to a restricted sink outside the repository, where a
 * developer follows the link by hand, and answers `ACCEPTED` with a reference that names the message and holds none of it.
 *
 * It behaves as a provider that deduplicates: the same deduplication identity is one message, so a retry of the same job leaves one
 * file, and `status` says whether the message is there, which is what a provider with a status query does. A sink that cannot
 * be written is an `UNKNOWN` outcome, never a success and never a rejection: nothing is known about the message, and the job is
 * tried again on its schedule.
 *
 * The message is held in clear by design, here and nowhere else (the sink says so), so this adapter is refused in production. It
 * is an adapter, imported only by the composition root.
 */
export class CaptureDeliveryProvider implements DeliveryProvider {
  readonly #sink: CaptureSink;
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: CaptureDeliveryProviderOptions) {
    this.#sink = options.sink;
    this.#clock = options.clock;
  }

  async send(message: ProviderMessage): Promise<DeliveryOutcome> {
    try {
      await this.#sink.write({
        capturedAt: this.#clock.now().toISOString(),
        dedupeId: message.dedupeId,
        kind: message.kind,
        channel: message.channel,
        destination: message.destination,
        link: message.link,
      });
    } catch {
      return { outcome: 'UNKNOWN' };
    }
    return { outcome: 'ACCEPTED', providerMessageRef: captureReference(message.dedupeId) };
  }

  async status(dedupeId: string): Promise<DeliveryOutcome | null> {
    try {
      return (await this.#sink.has(dedupeId))
        ? { outcome: 'ACCEPTED', providerMessageRef: captureReference(dedupeId) }
        : null;
    } catch {
      return null;
    }
  }
}

/** Names the captured message. The deduplication identity is a random identifier: it carries no destination and no token. */
const captureReference = (dedupeId: string): string => `capture-${dedupeId}`;
