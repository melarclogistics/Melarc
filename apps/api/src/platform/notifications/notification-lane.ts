import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import type { DeliveryOutcome } from '../auth/ports/delivery-queue.port.js';
import type { Metrics } from '../auth/ports/metrics.port.js';
import type { TextMessageSender } from '../auth/ports/text-message-sender.port.js';
import { serverErrorIn } from '../database/database-failures.js';
import { MAX_ATTEMPTS, retryDelayMs } from '../delivery/delivery-schedule.js';
import {
  HANDSHAKE_REQUESTED,
  messageApplies,
  messageOfKind,
  messageStillTrue,
  messagesFor,
  parametersOf,
  type AggregateFacts,
  type HandshakeFacts,
} from './message-list.js';
import {
  LeaseLostError,
  type AggregateReader,
  type ClaimedEnvelope,
  type ClaimedMessage,
  type NotificationStore,
  type SendLimits,
} from './notification-store.js';
import type { MetricName } from '../metrics/metric-catalogue.js';
import { NOTIFICATION_BATCH, SEND_RECORD_MARGIN_MS } from './notification-parameters.js';
import { GUARD_REFUSALS, type SuppressionReason } from './notification-vocabulary.js';
import { render, spokenDate, templateOf, TemplateError, type Template } from './templates.js';

/**
 * The notification lane of the delivery worker (S1.12a to S1.12e; BACKGROUND_JOBS_AND_EVENTS.md §3; SECURITY_DESIGN.md §14.7). One tick of
 * `runOnce` does three kinds of work, each a short transaction around the one thing that is not a transaction (the provider):
 *
 * 1. **The relay.** It leases an outbox envelope, opens a context from the stored row, reloads the aggregate under that scope (a scope the
 *    aggregate no longer has is a security signal and a dead letter, never a send), and writes the notifications the message list asks
 *    for, in the same transaction that ends the envelope as relayed: an envelope is relayed with its notifications or not at all.
 * 2. **The send.** It leases a due text message, reads the aggregate and the destination in a transaction of its own, decides whether the
 *    message may still go (the kill switches and the approval of the wording; whether events overtook it; the day's limits), makes the
 *    text, and asks the provider with **no transaction open**. What the provider says is recorded against the lease: accepted, refused
 *    (final), or unknown (on the Class 1 schedule, six attempts, then the end). Nothing it writes holds the destination or the text.
 * 3. **The network's word.** It asks the provider, by the reference it gave, what became of messages it accepted, and records delivered
 *    or failed; a message that does not answer is asked on a lengthening schedule and then left as it was sent.
 *
 * **Failure is local.** A unit that fails (a lease lost, a database fault, a template that cannot be rendered) does not stop the others;
 * what a log says of it is its class and code, never its text, which may hold a number or a word of a message (plan S0.18).
 */

/** What the lane decides before it reads a destination: whether this kind of message may go out at all. */
export interface LanePolicy {
  /** Why the message is held back (a kill switch, wording nobody approved), or null. Decided before the destination is read. */
  readonly withhold: (message: {
    readonly kind: string;
    readonly template: Template;
  }) => Promise<SuppressionReason | null>;
  /** The day's limits in force now. */
  readonly limits: () => Promise<SendLimits>;
}

/** No kill switch, no limit and no approval to wait for: for a lane whose sender reaches nobody. */
export const OPEN_POLICY: LanePolicy = {
  withhold: () => Promise.resolve(null),
  limits: () => Promise.resolve({ perNumberPerDay: null, perDay: null }),
};

export interface NotificationLaneOptions {
  readonly store: Pick<
    NotificationStore,
    | 'claimEnvelope'
    | 'inEnvelope'
    | 'retryEnvelope'
    | 'deadLetterEnvelope'
    | 'expireDue'
    | 'claimMessage'
    | 'inMessage'
    | 'reserve'
    | 'recordSent'
    | 'recordRetry'
    | 'recordFailed'
    | 'recordSuppressed'
    | 'claimReceiptChecks'
    | 'recordDelivered'
    | 'recordDeliveryFailed'
    | 'scheduleReceiptCheck'
  >;
  readonly sender: TextMessageSender;
  readonly policy: LanePolicy;
  readonly logger: Logger;
  /** Counts what the lane does, by closed outcome and never by identifier (`metric-catalogue.ts`). Absent in a test that does not look. */
  readonly metrics?: Pick<Metrics, 'increment'>;
  /** The lease a claim asks for: longer than the provider's time-out and the work around it. */
  readonly leaseMs: number;
  /**
   * The longest the provider may take to answer (its time-out). A send starts only while this and the time to record its outcome are still
   * left in the lease; a message whose lease is about to end is left for the next claim and not sent under a lease another lane may take.
   */
  readonly providerTimeoutMs?: number;
  /** The wording of a message by its kind and version: the product's templates, unless a test gives drafts. */
  readonly templates?: (kind: string, version: number) => Template | undefined;
  /**
   * The codes of the collection handshake, for the messages that carry one (S1.27): the lane makes the code of a stop's generation at the send, in
   * memory, from the key it holds, and the text is the only place it goes. Absent where the lane holds no such key: a message that carries a code
   * then fails as one that cannot be made (`CODE_UNAVAILABLE`) and sends nothing.
   */
  readonly handshakeCodes?: {
    codeFor(stopId: string, generation: number, version: number, length: number): string;
  };
  /** The most units of each kind one tick does. */
  readonly batch?: {
    readonly envelopes: number;
    readonly sends: number;
    readonly receipts: number;
  };
  /** How long after a send the network is first asked. */
  readonly firstReceiptCheckMs?: number;
  /** How long a message is left alone after it is asked about, so that no other lane asks at once. */
  readonly receiptHoldMs?: number;
  /** A number in [0, 1), replaceable so that a test holds the jitter still. */
  readonly random?: () => number;
}

/** What one tick did, in counts: never an identifier, a destination or a text. */
export interface LaneReport {
  expired: number;
  relayed: number;
  notificationsWritten: number;
  deadLettered: number;
  scopeMismatches: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  delivered: number;
  deliveryFailed: number;
  receiptsChecked: number;
  leasesLost: number;
  errors: number;
}

export const emptyReport = (): LaneReport => ({
  expired: 0,
  relayed: 0,
  notificationsWritten: 0,
  deadLettered: 0,
  scopeMismatches: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  suppressed: 0,
  delivered: 0,
  deliveryFailed: 0,
  receiptsChecked: 0,
  leasesLost: 0,
  errors: 0,
});

const DEFAULT_FIRST_RECEIPT_CHECK_MS = 30_000;
const DEFAULT_RECEIPT_HOLD_MS = 120_000;
/** The wait before the network is asked again, by the number of times it has been asked; after the last the message is left as it was sent. */
const RECEIPT_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
  21_600_000, 43_200_000,
];
/** The relay's own wait after an unexpected failure of an envelope, before the schedule's. */
const SOON_MS = 5_000;

/** The refusal classes a guard in front of the provider gives, and the reason each is held back for. */
const HELD_FOR: Readonly<Record<string, SuppressionReason>> = {
  [GUARD_REFUSALS.DESTINATION_NOT_ALLOWED]: 'DESTINATION_NOT_ALLOWED',
  [GUARD_REFUSALS.WINDOW_ENDED]: 'WINDOW_LIMIT',
  [GUARD_REFUSALS.WINDOW_CAP]: 'WINDOW_LIMIT',
};

class ScopeMismatch extends Error {
  constructor() {
    super('The aggregate does not have the scope the stored envelope names.');
    this.name = 'ScopeMismatch';
  }
}

/** What a log may say of a failure: its class and, where it has one that is plain, its code. Never its text. */
function describeFailure(error: unknown): { error_type: string; error_code?: string } {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const direct: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  const code: unknown = serverErrorIn(error)?.code ?? direct;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)
    ? { error_type: type, error_code: code }
    : { error_type: type };
}

/** `+233•••••0111`'s ASCII twin: the country part and the last three digits, enough to tell two numbers apart in a log and no more. */
export function destinationHint(destination: string): string {
  return `${destination.slice(0, 4)}${'*'.repeat(Math.max(destination.length - 7, 1))}${destination.slice(-3)}`;
}

/** The key the per-number daily limit counts on. Not a protection: the number is in the business record. */
export function destinationDigest(destination: string): string {
  return createHash('sha256').update(`melarc.sms.destination.v1\u0000${destination}`).digest('hex');
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
const PROVIDER_CLASS = /^[A-Z][A-Z0-9_]{0,47}$/;

const sameVendor = (a: string | null, b: string | null): boolean => (a ?? null) === (b ?? null);

export class NotificationLane {
  readonly #options: NotificationLaneOptions;
  readonly #batch: {
    readonly envelopes: number;
    readonly sends: number;
    readonly receipts: number;
  };

  constructor(options: NotificationLaneOptions) {
    this.#options = options;
    this.#batch = options.batch ?? NOTIFICATION_BATCH;
  }

  /** One tick: the relay, the sends and the receipts, each as far as its batch and the stop signal allow. */
  async runOnce(stop: AbortSignal): Promise<LaneReport> {
    const report = emptyReport();
    const { store, logger, leaseMs } = this.#options;
    /** A unit of work that fails is counted and logged by class, and does not stop the others. */
    const attempt = async <T>(
      work: () => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      try {
        return { ok: true, value: await work() };
      } catch (error) {
        if (error instanceof LeaseLostError) report.leasesLost += 1;
        else {
          report.errors += 1;
          logger.error(describeFailure(error), 'notification lane unit failed');
        }
        return { ok: false };
      }
    };

    const expired = await attempt(() => store.expireDue());
    if (expired.ok) report.expired += expired.value;

    for (let each = 0; each < this.#batch.envelopes && !stop.aborted; each += 1) {
      const claim = await attempt(() => store.claimEnvelope(leaseMs));
      if (!claim.ok || claim.value === null) break;
      const envelope = claim.value;
      await attempt(() => this.#relay(envelope, report));
    }
    for (let each = 0; each < this.#batch.sends && !stop.aborted; each += 1) {
      const claim = await attempt(() => store.claimMessage(leaseMs));
      if (!claim.ok || claim.value === null) break;
      const message = claim.value;
      // The monotonic clock, from the claim's return: the lease runs on the database's clock, and what has been spent of it since is this.
      const claimedAt = performance.now();
      await attempt(() => this.#send(message, report, claimedAt));
    }
    if (!stop.aborted) await attempt(() => this.#receipts(report, stop));

    if (Object.values(report).some((count) => count > 0))
      logger.info({ ...report }, 'notification lane tick');
    return report;
  }

  // ---- the relay -----------------------------------------------------------------------------------------------------------

  async #relay(envelope: ClaimedEnvelope, report: LaneReport): Promise<void> {
    const { store, logger } = this.#options;
    // A schedule that ends: a lease taken over again and again after crashes does not go on for ever.
    if (envelope.attemptCount > MAX_ATTEMPTS) {
      await store.deadLetterEnvelope(envelope, 'SCHEDULE_EXHAUSTED');
      report.deadLettered += 1;
      this.#count('notification_relay_total', { outcome: 'SCHEDULE_EXHAUSTED' });
      logger.error({ outbox_id: envelope.id }, 'notification envelope gave up after every attempt');
      return;
    }
    const messages = messagesFor(envelope.eventType).filter(
      (message) => message.aggregateType === envelope.aggregateType,
    );
    if (messages.length === 0) {
      await store.deadLetterEnvelope(envelope, 'UNKNOWN_EVENT');
      report.deadLettered += 1;
      this.#count('notification_relay_total', { outcome: 'UNKNOWN_EVENT' });
      logger.warn(
        { outbox_id: envelope.id, event_type: envelope.eventType },
        'notification envelope names an event no message answers',
      );
      return;
    }
    try {
      const written = await store.inEnvelope(envelope, async (scope) => {
        const loaded = await loadedBy(scope, envelope.aggregateType);
        // §14.7 steps 6 to 8: the reloaded aggregate against the stored envelope. The policy already shows nothing of another aggregate;
        // the comparison is the second line, and a mismatch means no side effect. A manifest spans vendors and has none.
        if (
          loaded?.facts.id !== envelope.aggregateId ||
          loaded.facts.responsibleHubId !== envelope.responsibleHubId ||
          !sameVendor(vendorOf(loaded), envelope.vendorOrganizationId)
        ) {
          throw new ScopeMismatch();
        }
        let count = 0;
        let planned = 0;
        for (const message of messages) {
          if (!messageApplies(message, loaded)) continue;
          planned += 1;
          const inserted = await scope.insertNotification({
            messageKind: message.kind,
            templateVersion: message.templateVersion,
            audience: message.audience,
            channel: message.channel,
            state: message.channel === 'FEED' ? 'DELIVERED' : 'QUEUED',
            timeToLiveMs: message.timeToLiveMs,
            parameters: parametersOf(message, envelope.payload),
          });
          if (inserted === 'INSERTED') count += 1;
        }
        await scope.relayed(planned > 0 ? 'MATERIALISED' : 'NOTHING_TO_SEND');
        return { count, planned };
      });
      report.relayed += 1;
      report.notificationsWritten += written.count;
      this.#count('notification_relay_total', {
        outcome: written.planned > 0 ? 'MATERIALISED' : 'NOTHING_TO_SEND',
      });
    } catch (error) {
      if (error instanceof ScopeMismatch) {
        // The security signal of §14.7 step 8: nothing was written, the envelope waits for a person, and the log says it plainly.
        await store.deadLetterEnvelope(envelope, 'SCOPE_MISMATCH');
        report.scopeMismatches += 1;
        report.deadLettered += 1;
        this.#count('notification_relay_total', { outcome: 'SCOPE_MISMATCH' });
        logger.error(
          { outbox_id: envelope.id, event_type: envelope.eventType },
          'SECURITY: a notification envelope and its aggregate disagree about scope; nothing was sent',
        );
        return;
      }
      if (error instanceof LeaseLostError) throw error;
      // Anything else rolled the transaction back: the envelope is given back to try again, on the schedule.
      const delay = retryDelayMs(envelope.attemptCount, {
        random: this.#options.random ?? Math.random,
      });
      if (delay === undefined) {
        await store.deadLetterEnvelope(envelope, 'SCHEDULE_EXHAUSTED');
        report.deadLettered += 1;
        this.#count('notification_relay_total', { outcome: 'SCHEDULE_EXHAUSTED' });
        logger.error(
          { outbox_id: envelope.id },
          'notification envelope gave up after every attempt',
        );
      } else {
        await store.retryEnvelope(envelope, Math.max(delay, SOON_MS));
        this.#count('notification_relay_total', { outcome: 'RETRY' });
      }
      throw error;
    }
  }

  // ---- the send ------------------------------------------------------------------------------------------------------------

  async #send(message: ClaimedMessage, report: LaneReport, claimedAt: number): Promise<void> {
    const { store, sender, policy, logger } = this.#options;
    const definition = messageOfKind(message.messageKind);
    const template = (this.#options.templates ?? templateOf)(
      message.messageKind,
      message.templateVersion,
    );
    if (definition === undefined || template === undefined) {
      // A message the list or the wording no longer holds: nothing can be said, and nothing retried will change that.
      await store.recordFailed(message, 'REJECTED', 'UNKNOWN_MESSAGE');
      report.failed += 1;
      this.#count('notification_sends_total', { result: 'REJECTED' });
      return;
    }
    if (message.attemptCount > MAX_ATTEMPTS) {
      await store.recordFailed(message, 'SCHEDULE_EXHAUSTED', null);
      report.failed += 1;
      this.#count('notification_sends_total', { result: 'SCHEDULE_EXHAUSTED' });
      return;
    }

    const withheld = await policy.withhold({ kind: message.messageKind, template });
    if (withheld !== null) {
      await this.#holdBack(message, withheld, report);
      return;
    }

    // The aggregate and the destination, read in a transaction that ends before the provider is asked. A message that carries a code (S1.27) also
    // reads the handshake it carries it for, with the length the code was made with: it is judged by whether that code is still the live one.
    const carriesCode = definition.event === HANDSHAKE_REQUESTED;
    const read = await store.inMessage(message, async (reader) => {
      const aggregate = await loadedBy(reader, definition.aggregateType);
      const phone =
        message.audience === 'AD_HOC_SENDER'
          ? await reader.adHocSenderNumber()
          : message.audience === 'RIDER'
            ? await reader.riderNumber()
            : message.audience === 'VENDOR_NUMBER'
              ? await reader.vendorRegisteredNumber()
              : undefined;
      const handshake = carriesCode ? await reader.collectionHandshake() : undefined;
      return { loaded: withHandshake(aggregate, handshake), handshake, phone };
    });
    if (read.loaded === undefined || !messageStillTrue(definition, read.loaded)) {
      await this.#holdBack(message, 'OVERTAKEN', report);
      return;
    }
    const destination = read.phone;
    if (destination === undefined || !E164.test(destination)) {
      await this.#holdBack(message, 'NO_DESTINATION', report);
      return;
    }

    // The code of a message that carries one, made here in memory before a place in the day is taken for it: a lane that cannot make it (it holds no
    // such key, or the key the code was made under is no longer held) sends nothing and says so, and the code is never stored.
    let handshakeCode: string | undefined;
    if (carriesCode) {
      const codes = this.#options.handshakeCodes;
      const { handshake } = read;
      try {
        if (codes === undefined || handshake === undefined) {
          throw new TemplateError(
            'A message that carries a code needs the code and the handshake.',
          );
        }
        // The length is the one the code was made with, kept on the handshake: a setting changed since is not the length of this code.
        handshakeCode = codes.codeFor(
          handshake.stopId,
          handshake.generation,
          handshake.keyVersion,
          handshake.codeLength,
        );
      } catch (error) {
        report.errors += 1;
        logger.error(describeFailure(error), 'the code of a handshake could not be made');
        await store.recordFailed(message, 'REJECTED', 'CODE_UNAVAILABLE');
        report.failed += 1;
        this.#count('notification_sends_total', { result: 'REJECTED' });
        return;
      }
    }

    const reservation = await store.reserve(
      message,
      {
        // The registered number of a vendor is the recovery channel of a credential, which no member of staff is shown any part of (the Ops view of an account
        // says only that there is one): the log keeps no hint of it. The day's limits count on the digest, which the hint is not needed for.
        hint: message.audience === 'VENDOR_NUMBER' ? null : destinationHint(destination),
        digest: destinationDigest(destination),
      },
      await policy.limits(),
    );
    if (reservation !== 'RESERVED') {
      await this.#holdBack(message, reservation, report);
      return;
    }

    let text: string;
    try {
      text = render(
        template,
        textValues(
          read.loaded,
          template,
          handshakeCode === undefined ? {} : { handshake_code: handshakeCode },
        ),
      );
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      await store.recordFailed(message, 'REJECTED', 'TEMPLATE_UNUSABLE');
      report.failed += 1;
      this.#count('notification_sends_total', { result: 'REJECTED' });
      return;
    }

    // A send starts only with the provider's whole time-out, and the recording of its outcome, still left in the lease. A lane that stalled
    // on the way here (a slow read, a database that hesitated) leaves the message for the next claim: asking the provider under a lease
    // another lane may take over would send the text twice.
    const { leaseMs, providerTimeoutMs } = this.#options;
    if (
      performance.now() - claimedAt >
      leaseMs - (providerTimeoutMs ?? 0) - SEND_RECORD_MARGIN_MS
    ) {
      report.leasesLost += 1;
      return;
    }

    // The provider is asked with no transaction open. The destination and the text exist in clear here, in memory, and nowhere else.
    const outcome = await sender.send({ dedupeId: message.id, destination, text });
    // The provider took a text that carries a code: the handshake is told, so that it stands as delivered. That is the handshake's own bookkeeping
    // and never the reason a send goes unrecorded: a failure of it is logged and the send is recorded all the same.
    if (outcome.outcome === 'ACCEPTED' && read.handshake !== undefined) {
      await this.#codeDelivered(message, read.handshake);
    }
    await this.#record(message, outcome, report, logger);
  }

  /** Tells the handshake that the code of the generation it was sent for was accepted by the provider; a failure is logged and nothing else. */
  async #codeDelivered(message: ClaimedMessage, handshake: HandshakeFacts): Promise<void> {
    const { store, logger } = this.#options;
    try {
      await store.inMessage(message, (reader) =>
        reader.markHandshakeDelivered(handshake.id, handshake.generation),
      );
    } catch (error) {
      logger.error(describeFailure(error), 'a handshake could not be told its code was delivered');
    }
  }

  async #record(
    message: ClaimedMessage,
    outcome: DeliveryOutcome,
    report: LaneReport,
    logger: Logger,
  ): Promise<void> {
    const { store } = this.#options;
    switch (outcome.outcome) {
      case 'ACCEPTED':
        await store.recordSent(
          message,
          outcome.providerMessageRef,
          this.#options.firstReceiptCheckMs ?? DEFAULT_FIRST_RECEIPT_CHECK_MS,
        );
        report.sent += 1;
        this.#count('notification_sends_total', { result: 'SENT' });
        return;
      case 'REJECTED': {
        const guarded = HELD_FOR[outcome.outcomeClass];
        if (guarded !== undefined) {
          await this.#holdBack(message, guarded, report);
          return;
        }
        const kept = PROVIDER_CLASS.test(outcome.outcomeClass)
          ? outcome.outcomeClass
          : 'PROVIDER_REFUSED';
        await store.recordFailed(message, 'REJECTED', kept);
        report.failed += 1;
        this.#count('notification_sends_total', { result: 'REJECTED' });
        logger.warn({ provider_outcome_class: kept }, 'notification refused by the provider');
        return;
      }
      case 'UNKNOWN': {
        const delay = retryDelayMs(message.attemptCount, {
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
          random: this.#options.random ?? Math.random,
        });
        if (delay === undefined) {
          await store.recordFailed(message, 'SCHEDULE_EXHAUSTED', null);
          report.failed += 1;
          this.#count('notification_sends_total', { result: 'SCHEDULE_EXHAUSTED' });
        } else {
          await store.recordRetry(message, delay);
          report.retried += 1;
          this.#count('notification_sends_total', { result: 'RETRY' });
        }
      }
    }
  }

  /** A message held back and never sent: recorded with its reason, counted, and shown in the log. */
  async #holdBack(
    message: ClaimedMessage,
    reason: SuppressionReason,
    report: LaneReport,
  ): Promise<void> {
    await this.#options.store.recordSuppressed(message, reason);
    report.suppressed += 1;
    this.#count('notification_suppressed_total', { reason });
  }

  #count(name: MetricName, labels: Readonly<Record<string, string>>): void {
    this.#options.metrics?.increment(name, labels);
  }

  // ---- the network's word --------------------------------------------------------------------------------------------------

  async #receipts(report: LaneReport, stop: AbortSignal): Promise<void> {
    const { store, sender } = this.#options;
    const due = await store.claimReceiptChecks(
      this.#batch.receipts,
      this.#options.receiptHoldMs ?? DEFAULT_RECEIPT_HOLD_MS,
    );
    for (const check of due) {
      if (stop.aborted) break;
      try {
        const status = await sender.status(check.providerMessageRef);
        report.receiptsChecked += 1;
        if (status.state === 'DELIVERED') {
          if (await store.recordDelivered(check.id)) {
            report.delivered += 1;
            this.#count('notification_receipts_total', { result: 'DELIVERED' });
          }
        } else if (status.state === 'FAILED') {
          const kept =
            status.outcomeClass !== undefined && PROVIDER_CLASS.test(status.outcomeClass)
              ? status.outcomeClass
              : null;
          if (await store.recordDeliveryFailed(check.id, kept)) {
            report.deliveryFailed += 1;
            this.#count('notification_receipts_total', { result: 'FAILED' });
          }
        } else {
          await store.scheduleReceiptCheck(
            check.id,
            RECEIPT_DELAYS_MS[check.receiptChecks - 1] ?? null,
          );
        }
      } catch (error) {
        report.errors += 1;
        this.#options.logger.error(describeFailure(error), 'notification receipt check failed');
      }
    }
  }
}

/** The aggregate the envelope names, loaded under the context the store opened from it; nothing where the policy shows none, or the kind is unknown. */
async function loadedBy(
  reader: AggregateReader,
  aggregateType: string,
): Promise<AggregateFacts | undefined> {
  if (aggregateType === 'PICKUP_REQUEST') {
    const facts = await reader.pickupRequest();
    return facts === undefined ? undefined : { type: 'PICKUP_REQUEST', facts };
  }
  if (aggregateType === 'PICKUP_MANIFEST') {
    const facts = await reader.pickupManifest();
    return facts === undefined ? undefined : { type: 'PICKUP_MANIFEST', facts };
  }
  return undefined;
}

/** The vendor an aggregate belongs to: a request has its own, and a manifest spans vendors and belongs to none. */
const vendorOf = (loaded: AggregateFacts): string | null =>
  loaded.type === 'PICKUP_REQUEST' ? loaded.facts.vendorOrganizationId : null;

/** The aggregate with the handshake the message carries a code for, where it has one: only a request has a stop. */
function withHandshake(
  loaded: AggregateFacts | undefined,
  handshake: HandshakeFacts | undefined,
): AggregateFacts | undefined {
  return loaded?.type === 'PICKUP_REQUEST' && handshake !== undefined
    ? { type: 'PICKUP_REQUEST', facts: { ...loaded.facts, handshake } }
    : loaded;
}

/**
 * The values the wording of a message uses: the code of the request or of the run, the day it is for, in words, and what the message carries beyond
 * them (the code of a handshake). Only the placeholders the template names are offered to it: a kind that has no use for the day does not get one.
 */
function textValues(
  loaded: AggregateFacts,
  template: Template,
  carried: Readonly<Record<string, string>>,
): Record<string, string> {
  const offered: Record<string, string> =
    loaded.type === 'PICKUP_REQUEST'
      ? { code: loaded.facts.code, date: spokenDate(loaded.facts.scheduledServiceDate) }
      : { code: loaded.facts.code, date: spokenDate(loaded.facts.serviceDate) };
  return Object.fromEntries(
    Object.entries({ ...offered, ...carried }).filter(([name]) =>
      template.placeholders.includes(name),
    ),
  );
}
