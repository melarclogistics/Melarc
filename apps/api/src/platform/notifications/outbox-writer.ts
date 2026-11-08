import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { outbox } from '../database/schema/notifications.js';
import { securityContextOf, transactionOf } from '../database/transaction-handle.js';
import type { OutboxAggregateType } from './notification-vocabulary.js';

/**
 * The writer of the outbox envelope (S1.12a; BACKGROUND_JOBS_AND_EVENTS.md §3.7; SECURITY_DESIGN.md §14.7). A business act calls `write`
 * **inside its own transaction**, beside its audit event: if the act rolls back, so does the envelope, and if the act commits, the lane
 * of the delivery worker will find the envelope. That is the whole point of an outbox, and it is why this takes the transaction's handle
 * and never opens a transaction of its own.
 *
 * **The scope of the envelope is the aggregate's, not the caller's.** The caller names the aggregate and the hub (and the vendor) it read
 * from the row it just changed; the database then compares them with that row, in the writer's own transaction and under the writer's own
 * context (the insert guard of migration 0055), and refuses an envelope that names another scope. The originating principal and the
 * correlation id are the transaction's (`securityContextOf`), never a caller's: the same rule as the audit writer's (OB-47).
 *
 * **The payload is the minimum, and may not be personal or secret.** It exists for a rare case where a message needs a fact the aggregate
 * does not hold; the lane reloads the aggregate for everything else. Its keys are plain names, its values short text, numbers or flags, and
 * a key that names a number, an address, a code, a token or a credential is refused outright: a dead-letter queue is a durable store.
 */

export type OutboxPayload = Readonly<Record<string, string | number | boolean>>;

export interface OutboxEvent {
  /** What happened, spelled as an audit event code (`pickup.request.confirmed`): the lane's message list answers it. */
  readonly eventType: string;
  readonly aggregate: { readonly type: OutboxAggregateType; readonly id: string };
  /** The hub the aggregate is responsible to, from the row the act just read or changed. */
  readonly responsibleHubId: string;
  /** The vendor organisation of the aggregate, where it has one. */
  readonly vendorOrganizationId?: string | null;
  /** The OpenAPI operation that did the act. */
  readonly operationId: string;
  readonly payload?: OutboxPayload;
}

/** The event is not one the table would accept. A programming error: the act fails with it, as it fails for an audit event it cannot write. */
export class OutboxEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxEventError';
  }
}

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PAYLOAD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** A key that names what a payload may not carry. */
const FORBIDDEN_KEY =
  /phone|number|msisdn|address|code|token|secret|password|otp|email|credential|link|url|name/i;
const MAX_PAYLOAD_KEYS = 8;
const MAX_VALUE_LENGTH = 64;

function checkedPayload(payload: OutboxPayload | undefined): OutboxPayload {
  if (payload === undefined) return {};
  const keys = Object.keys(payload);
  if (keys.length > MAX_PAYLOAD_KEYS)
    throw new OutboxEventError('An envelope payload has at most eight members.');
  for (const key of keys) {
    if (!PAYLOAD_KEY.test(key) || FORBIDDEN_KEY.test(key)) {
      throw new OutboxEventError('An envelope payload member has a name it may not have.');
    }
    const value = payload[key];
    const fits =
      (typeof value === 'string' && value.length <= MAX_VALUE_LENGTH) ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean';
    if (!fits)
      throw new OutboxEventError('An envelope payload member is short text, a number or a flag.');
  }
  return payload;
}

export class OutboxWriter {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(clock: Pick<Clock, 'now'>) {
    this.#clock = clock;
  }

  async write(handle: TransactionHandle, event: OutboxEvent): Promise<void> {
    if (!EVENT_TYPE.test(event.eventType) || event.eventType.length > 64) {
      throw new OutboxEventError('An envelope event is an audit event code.');
    }
    if (event.operationId.length < 1 || event.operationId.length > 96) {
      throw new OutboxEventError('An envelope names the operation that did the act.');
    }
    const payload = checkedPayload(event.payload);
    const context = securityContextOf(handle);
    await transactionOf(handle)
      .insert(outbox)
      .values({
        id: randomUUIDv7(this.#clock),
        eventType: event.eventType,
        aggregateType: event.aggregate.type,
        aggregateId: event.aggregate.id,
        responsibleHubId: event.responsibleHubId,
        vendorOrganizationId: event.vendorOrganizationId ?? null,
        riderId: null,
        originatingPrincipalType: context.principalType,
        originatingPrincipalId: context.principalId,
        operationId: event.operationId,
        correlationId: context.correlationId,
        payload,
      });
  }
}
