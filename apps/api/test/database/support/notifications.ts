import { randomUUID } from 'node:crypto';

import type pg from 'pg';

/**
 * A notification and the envelope it came from, arranged by the administrator for a test of what reads them (S1.12e): the Ops message
 * log. Test support. The application writes these rows only in the lane of the delivery worker, with no transaction a route can open;
 * a test of the read arranges them directly, with the guards of the two tables off for the one statement (the constraints stay on, so
 * a row that could not exist cannot be arranged), and a test of the lane itself runs the lane.
 */
export interface NotificationArrangement {
  readonly hubId: string;
  /** The pickup request the message is about (no foreign key: the log only names it). */
  readonly subjectId: string;
  readonly messageKind?: string;
  readonly audience?:
    'AD_HOC_SENDER' | 'VENDOR_NUMBER' | 'RIDER' | 'RECIPIENT' | 'VENDOR_FEED' | 'OPS_FEED';
  readonly channel?: 'SMS' | 'FEED';
  readonly state?:
    'QUEUED' | 'LEASED' | 'RETRYABLE' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED' | 'EXPIRED';
  readonly suppressionReason?: string;
  readonly outcomeClass?: string;
  readonly providerOutcomeClass?: string;
  /** The masked hint; `null` for a feed entry or a message that never had a number. */
  readonly destinationHint?: string | null;
  /** The count digest the daily limits use and no read may show: arranged so that a test can look for it. */
  readonly destinationDigest?: string | null;
  readonly providerMessageRef?: string | null;
  readonly attemptCount?: number;
  /** When the row was made, as a timestamp the database reads; the list is ordered by it. */
  readonly createdAt?: string;
  /** When the provider took the text and when the network said it arrived, where a test must tell the two apart. */
  readonly sentAt?: string;
  readonly deliveredAt?: string;
  /** The closed parameters of the message (migration 0066), as the lane would write them; none unless a test is about them. */
  readonly parameters?: unknown;
}

export interface ArrangedNotification {
  readonly id: string;
  readonly outboxId: string;
}

/** The digest the arranged rows carry unless told another: a 64-digit lower-case hex string, so that a test can search a body for it. */
export const ARRANGED_DIGEST = 'd1'.repeat(32);

export async function insertNotification(
  admin: Pick<pg.Client, 'query'>,
  over: NotificationArrangement,
): Promise<ArrangedNotification> {
  const id = randomUUID();
  const outboxId = randomUUID();
  const channel = over.channel ?? 'SMS';
  const state = over.state ?? 'DELIVERED';
  const outcomeClass =
    over.outcomeClass ??
    (state === 'DELIVERED' && channel === 'SMS'
      ? 'ACCEPTED'
      : state === 'FAILED'
        ? 'DELIVERY_FAILED'
        : null);
  const left =
    channel === 'SMS' &&
    (state === 'SENT' ||
      state === 'DELIVERED' ||
      (state === 'FAILED' && outcomeClass === 'DELIVERY_FAILED'));
  const delivered = channel === 'SMS' && state === 'DELIVERED';
  const leased = state === 'LEASED';
  const created = over.createdAt ?? null;

  await admin.query('BEGIN');
  try {
    await admin.query('alter table outbox disable trigger user');
    await admin.query('alter table notification disable trigger user');
    await admin.query(
      `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type,
                           originating_principal_id, operation_id, correlation_id, relay_state, relayed_at, last_outcome,
                           attempt_count, lease_version)
       values ($1, 'pickup.request.confirmed', 'PICKUP_REQUEST', $2, $3, 'STAFF', $4, 'confirmPickupRequest', $5,
               'RELAYED', clock_timestamp(), 'MATERIALISED', 1, 1)`,
      [outboxId, over.subjectId, over.hubId, '5eed0000-0000-4000-8000-0000000000e1', randomUUID()],
    );
    await admin.query(
      `insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id,
                                 subject_type, subject_id, state, suppression_reason, outcome_class, provider_outcome_class,
                                 destination_hint, destination_digest, provider_message_ref, attempt_count, expires_at,
                                 lease_owner, lease_version, lease_expires_at, sent_at, delivered_at, created_at, parameters)
       values ($1, $2, $3, 1, $4, $5, $6, 'PICKUP_REQUEST', $7, $8, $9, $10, $11, $12, $13, $14, $15,
               coalesce($16::timestamptz, clock_timestamp()) + interval '6 hours',
               $17, $18, $19, $20, $21, coalesce($16::timestamptz, clock_timestamp()), $22::jsonb)`,
      [
        id,
        outboxId,
        over.messageKind ?? 'PICKUP_CONFIRMED_SENDER',
        over.audience ?? 'AD_HOC_SENDER',
        channel,
        over.hubId,
        over.subjectId,
        state,
        over.suppressionReason ?? (state === 'SUPPRESSED' ? 'KILL_SWITCH' : null),
        outcomeClass,
        over.providerOutcomeClass ?? null,
        over.destinationHint === undefined
          ? channel === 'SMS'
            ? '+233******111'
            : null
          : over.destinationHint,
        over.destinationDigest === undefined
          ? channel === 'SMS'
            ? ARRANGED_DIGEST
            : null
          : over.destinationDigest,
        over.providerMessageRef === undefined
          ? left
            ? 'provider-ref-arranged'
            : null
          : over.providerMessageRef,
        over.attemptCount ?? (left || leased ? 1 : 0),
        created,
        leased ? 'arranged-lane' : null,
        leased ? 1 : 0,
        leased ? new Date(Date.now() + 30_000).toISOString() : null,
        left ? (over.sentAt ?? new Date().toISOString()) : null,
        delivered ? (over.deliveredAt ?? new Date().toISOString()) : null,
        JSON.stringify(over.parameters ?? {}),
      ],
    );
    await admin.query('alter table outbox enable trigger user');
    await admin.query('alter table notification enable trigger user');
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return { id, outboxId };
}
