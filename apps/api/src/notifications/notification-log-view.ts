import { sql, type SQL } from 'drizzle-orm';

/**
 * A row of the Ops message log as the statement reads it, and the representation the contract names (`NotificationLogEntry`,
 * S1.12e). **The columns are those the API role is granted and no others** (migration 0055): the count digest, the provider's reference
 * and the lease are not granted to it, so a view could not show them if it tried, and `notification-log-routes.db.test.ts` holds the
 * closed list of fields to the contract's.
 */
export interface NotificationLogRow {
  readonly id: string;
  readonly message_kind: string;
  readonly template_version: number;
  readonly audience: string;
  readonly channel: string;
  readonly state: string;
  readonly suppression_reason: string | null;
  readonly outcome_class: string | null;
  readonly provider_outcome_class: string | null;
  readonly destination_hint: string | null;
  readonly attempt_count: number;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly responsible_hub_id: string;
  readonly sent_at: string | Date | null;
  readonly delivered_at: string | Date | null;
  readonly expires_at: string | Date;
  readonly created_at: string | Date;
  /** The moment as the database prints it, with its microseconds: the position a page token holds. */
  readonly created_at_text: string;
}

export interface NotificationLogEntry {
  readonly id: string;
  readonly message_kind: string;
  readonly template_version: number;
  readonly audience: string;
  readonly channel: string;
  readonly state: string;
  readonly suppression_reason: string | null;
  readonly outcome_class: string | null;
  readonly provider_outcome_class: string | null;
  readonly destination_hint: string | null;
  readonly attempt_count: number;
  readonly subject: { readonly type: string; readonly id: string };
  readonly responsible_hub_id: string;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

export const LOG_COLUMNS: SQL = sql.raw(`
  id, message_kind, template_version, audience, channel, state, suppression_reason, outcome_class, provider_outcome_class,
  destination_hint, attempt_count, subject_type, subject_id, responsible_hub_id, sent_at, delivered_at, expires_at, created_at,
  created_at::text as created_at_text`);

const iso = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = (value: string | Date | null): string | null =>
  value === null ? null : iso(value);

export function entryOf(row: NotificationLogRow): NotificationLogEntry {
  return {
    id: row.id,
    message_kind: row.message_kind,
    template_version: row.template_version,
    audience: row.audience,
    channel: row.channel,
    state: row.state,
    suppression_reason: row.suppression_reason,
    outcome_class: row.outcome_class,
    provider_outcome_class: row.provider_outcome_class,
    destination_hint: row.destination_hint,
    attempt_count: row.attempt_count,
    subject: { type: row.subject_type, id: row.subject_id },
    responsible_hub_id: row.responsible_hub_id,
    sent_at: isoOrNull(row.sent_at),
    delivered_at: isoOrNull(row.delivered_at),
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
  };
}
