import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import { nextOperatingDay } from './booking-rules.js';
import { hubLocal } from './cutoff.js';
import { operationalCode } from './operational-code.js';
import { insertReplacement } from './pickup-request-clone.js';
import type { PickupRequestRow } from './pickup-request-view.js';

const CODE_ATTEMPTS = 8;

export interface ReplacementOrder {
  /** The request being replaced, as the caller holds it locked. */
  readonly source: PickupRequestRow;
  /** The staff member who makes the clone. */
  readonly actor: string;
  readonly clock: Clock;
  /** The instant of the act, the database's: the day the clone is counted from is the hub's today at this instant. */
  readonly instant: Date;
  /** `SAME` for a late booking (nothing was attempted), `NEXT` for a failed attempt's reschedule. */
  readonly attempt: 'SAME' | 'NEXT';
}

/**
 * The cancel-plus-clone of section 21.6 as far as the clone: a new `PENDING` request that is the same booking (`pickup-request-clone.ts`
 * says which columns it carries) for **the next operating day after the later of the source's service date and today on the hub's clock**,
 * Monday to Saturday, so that a request is never rescheduled into the past. Returns the identifier of the clone.
 *
 * The caller then cancels the source in the same transaction, naming the clone: the clone first (it names the source, which exists), then the
 * source (which names the clone). The two are never active together, and the database holds it where the transaction ends
 * (`pickup_request_source_cancelled`). The source is read, and the clone inserted, under the caller's own context and row-level security.
 *
 * **The day is provisional where the cause is a failed attempt**: the contract names the day only for a late booking ("the next operating
 * day", section 21.1) and says nothing of the day of a failed attempt's clone (the body of `cancelPickupRequest` carries none), so the same
 * rule is used and the Product Owner's answer changes this function only.
 */
export async function replaceRequest(
  tx: DatabaseTransaction,
  order: ReplacementOrder,
): Promise<string> {
  const { source } = order;
  const today = hubLocal(order.instant).date;
  const target = nextOperatingDay(
    source.scheduled_service_date > today ? source.scheduled_service_date : today,
  );
  const replacementId = randomUUIDv7(order.clock);
  // The hub code of the clone is the source's own (the first three letters of an operational code).
  const hubCode = source.code.slice(0, 3);
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const inserted = await insertReplacement(tx, {
      sourceId: source.id,
      id: replacementId,
      code: operationalCode(hubCode, 'PR'),
      serviceDate: target,
      attempt: order.attempt,
      actor: order.actor,
    });
    if (inserted) return replacementId;
  }
  throw new Error('No unused operational code could be drawn');
}

/**
 * The replacement's own timeline: `pickup.request.created` against the new request, naming the one it replaces. The act that made it
 * (the cancellation of a failed attempt, the decision on a late booking) has its own event against the source.
 */
export async function auditReplacementCreated(
  audit: AuditWriter,
  handle: TransactionHandle,
  source: PickupRequestRow,
  replacementId: string,
): Promise<void> {
  await audit.write(handle, {
    code: 'pickup.request.created',
    enhanced: false,
    outcome: 'SUCCEEDED',
    object: { type: 'PickupRequest', id: replacementId },
    responsibleHubId: source.responsible_hub_id,
    ...(source.vendor_organization_id === null
      ? {}
      : { vendorOrganizationId: source.vendor_organization_id }),
    resultingState: 'PENDING',
    relatedIds: {
      replaces_request_id: source.id,
      ...(source.ad_hoc_sender_id === null ? {} : { ad_hoc_sender_id: source.ad_hoc_sender_id }),
    },
    detail: {
      pickup_intent: source.pickup_intent,
      declared_package_count: source.declared_package_count,
    },
  });
}
