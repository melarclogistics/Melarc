import { randomInt, randomUUID } from 'node:crypto';

import type pg from 'pg';

import { backendPidOf } from './lock-wait.js';
import { clientFor, type TestDatabase } from './test-database.js';

/**
 * Pickup rows arranged **as the administrator**, for the tests that read, judge or change them (S1.13 onward). The operations that make
 * a request are under test through the routes; these rows are what a test needs to exist first: another vendor's request, a request of
 * another hub, a confirmed or cancelled one. Past row-level security, as `vendors.ts` is, and asserted from a second connection.
 */
type Query = Pick<pg.Client, 'query'>;

/** The alphabet of an operational code (MSC-DEC-202): no 0, O, 1, I or L. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function pickupCode(prefix = 'ACC'): string {
  let tail = '';
  for (let at = 0; at < 6; at += 1) tail += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  return `${prefix}-PR-${tail}`;
}

export interface PickupRequestRow {
  readonly id: string;
  readonly code: string;
  readonly vendorOrganizationId: string | null;
  readonly adHocSenderId: string | null;
  readonly hubId: string;
  readonly intent: 'OWN_PACKAGES' | 'COLLECT_FOR_VENDOR' | 'ADHOC_SENDER';
  readonly state: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'CANCELLED';
  readonly packages: number;
  readonly serviceDate: string;
  readonly createdBy: string;
  /** Facts a few tests arrange; left out, the row is an ordinary booking (no cutoff state, the first attempt, no exception). */
  readonly cutoffState?: 'PENDING_OPS_REVIEW' | 'SAME_DAY_APPROVED' | 'RESCHEDULED';
  readonly attemptNumber?: number;
  /** An extension arranged for **this** request (the row is inserted, then the extension, then the link), permitting its own attempt number. */
  readonly attemptExtensionId?: string;
  /** The moment Ops escalated the request: only a request that was confirmed has one. */
  readonly escalatedAt?: Date;
  /** The moment a confirmed request was confirmed (a fixed one when left out), for a test of which request has waited the longest. */
  readonly confirmedAt?: Date;
  readonly onePackageExceptionId?: string;
  /** The request this one replaces (its chain), which must exist. */
  readonly replacesRequestId?: string;
}

/** The actor of arranged rows: nobody a test signs in as. */
export const ARRANGER = '5eed0000-0000-4000-8000-0000000000e1';

/** A `PENDING` request of three packages by a vendor to its own location, for the next Monday-to-Saturday service date given. */
export function pickupRequestRow(
  vendorOrganizationId: string,
  hubId: string,
  overrides: Partial<PickupRequestRow> = {},
): PickupRequestRow {
  return {
    id: randomUUID(),
    code: pickupCode(),
    vendorOrganizationId,
    adHocSenderId: null,
    hubId,
    intent: 'OWN_PACKAGES',
    state: 'PENDING',
    packages: 3,
    serviceDate: '2026-11-03',
    createdBy: ARRANGER,
    ...overrides,
  };
}

export async function insertPickupRequest(
  client: Query,
  row: PickupRequestRow,
): Promise<PickupRequestRow> {
  const confirmed = row.state === 'CONFIRMED';
  const cancelled = row.state === 'CANCELLED';
  await client.query(
    `insert into pickup_request (id, code, vendor_organization_id, ad_hoc_sender_id, sender_name, responsible_hub_id, pickup_intent, state,
                                 declared_package_count, resolved_pickup_location, primary_phone, scheduled_service_date,
                                 default_payer_intent, created_by, confirmed_at, confirmed_by, cancelled_at, cancelled_by,
                                 cutoff_exception_state, attempt_number, one_package_exception_id, replaces_request_id, escalated_at)
     values ($1, $2, $3, $4, 'Fixture Sender', $5, $6, $7, $8, '{"address":"Fixture shop"}'::jsonb, '+233200000001', $9, 'RECIPIENT_PAYS', $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      row.id,
      row.code,
      row.vendorOrganizationId,
      row.adHocSenderId,
      row.hubId,
      row.intent,
      row.state,
      row.packages,
      row.serviceDate,
      row.createdBy,
      confirmed || cancelled ? (row.confirmedAt ?? new Date('2026-11-02T09:00:00Z')) : null,
      confirmed || cancelled ? row.createdBy : null,
      cancelled ? new Date('2026-11-02T10:00:00Z') : null,
      cancelled ? row.createdBy : null,
      row.cutoffState ?? null,
      row.attemptNumber ?? 1,
      row.onePackageExceptionId ?? null,
      row.replacesRequestId ?? null,
      row.escalatedAt ?? null,
    ],
  );
  if (row.attemptExtensionId !== undefined) {
    // The request and its extension name each other: the request first, then the extension raised for it, then the link.
    const ceilingAfter = Math.max(row.attemptNumber ?? 1, 4);
    await insertAttemptExtension(client, {
      id: row.attemptExtensionId,
      requestId: row.id,
      ceilingBefore: ceilingAfter - 1,
      ceilingAfter,
    });
    await client.query(`update pickup_request set attempt_extension_id = $2 where id = $1`, [
      row.id,
      row.attemptExtensionId,
    ]);
  }
  return row;
}

/** A Senior Ops extension of a request's attempt ceiling, as the administrator arranges it (the operation is under test through the routes). */
export async function insertAttemptExtension(
  client: Query,
  extension: {
    readonly requestId: string;
    readonly id?: string;
    readonly ceilingBefore?: number;
    readonly ceilingAfter?: number;
    readonly extendedBy?: string;
    readonly reason?: string;
  },
): Promise<string> {
  const id = extension.id ?? randomUUID();
  await client.query(
    `insert into pickup_attempt_extension (id, pickup_request_id, ceiling_before, ceiling_after, extended_by, reason)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      extension.requestId,
      extension.ceilingBefore ?? 3,
      extension.ceilingAfter ?? 4,
      extension.extendedBy ?? ARRANGER,
      extension.reason ?? 'The vendor asked for one more visit',
    ],
  );
  return id;
}

/**
 * The next version of a hub setting, in force from now: a hub setting is never edited, so a test that needs another value (a cutoff
 * that has passed, a grace window long enough to be seen) enters the next version of it, as the administration will.
 */
export async function setHubSetting(
  client: Query,
  hubId: string,
  key: string,
  value: unknown,
  unit: string,
  scopeRef = '',
): Promise<void> {
  await client.query(
    `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
     select $1, $2, $3, $4, coalesce(max(version), 0) + 1, $5::jsonb, $6, now(), $7
       from hub_setting where hub_id = $2 and setting_key = $3 and scope_ref = $4`,
    [randomUUID(), hubId, key, scopeRef, JSON.stringify(value), unit, ARRANGER],
  );
}

/** A vendor's financial standing, as the statement of SLICE-011 will set it (nothing in this slice does). */
export async function setFinancialStanding(
  client: Query,
  vendorOrganizationId: string,
  status: 'GOOD' | 'OVERDUE',
): Promise<void> {
  await client.query(
    `insert into vendor_financial_standing (vendor_organization_id, financial_status) values ($1, $2)
     on conflict (vendor_organization_id) do update set financial_status = excluded.financial_status, updated_at = now()`,
    [vendorOrganizationId, status],
  );
}

/**
 * A transaction of its own that holds a pickup request's row, as a competing operation would, and has not ended (a race on a business
 * rule, `lock-wait.ts`): the test starts the operation, waits until the server reports it waiting for this backend
 * (`waitUntilBlockedBy`), changes the row here and ends the transaction, and the operation then reads what this one left, which is
 * what its own lock is for. The caller ends the connection.
 */
export async function holdingPickupRequest(
  database: TestDatabase,
  id: string,
): Promise<{ readonly client: pg.Client; readonly pid: number }> {
  return holdingRow(database, 'pickup_request', id);
}

/** The same for the row of a one-package exception: a writer that decides it without holding its request. */
export async function holdingOnePackageException(
  database: TestDatabase,
  id: string,
): Promise<{ readonly client: pg.Client; readonly pid: number }> {
  return holdingRow(database, 'one_package_exception', id);
}

async function holdingRow(
  database: TestDatabase,
  table: 'pickup_request' | 'one_package_exception',
  id: string,
): Promise<{ readonly client: pg.Client; readonly pid: number }> {
  const client = clientFor(database.urlFor('postgres'));
  await client.connect();
  await client.query('begin');
  await client.query(`select id from ${table} where id = $1 for update`, [id]);
  return { client, pid: await backendPidOf(client) };
}

/**
 * A service date relative to today **as the database reads the hub's clock** (the cutoff is judged on it), always a Monday-to-Saturday
 * day: `days` from today, moved off a Sunday away from today (the Saturday before for a date that has passed, the Monday after for one
 * ahead). A negative count is a date that has passed and a positive one is a date ahead, whatever the day of the week the test runs on:
 * the two verdicts that do not depend on the time of the day.
 */
export async function operatingDay(client: Query, days: number): Promise<string> {
  if (days === 0) throw new Error('today is not a date that has passed or is ahead');
  const found = await client.query<{ day: string }>(
    `select to_char(d + case when extract(isodow from d) = 7 then (case when $1::int < 0 then -1 else 1 end) else 0 end, 'YYYY-MM-DD') as day
       from (select (now() at time zone 'Africa/Accra')::date + $1::int as d) t`,
    [days],
  );
  const day = found.rows[0]?.day;
  if (day === undefined) throw new Error('the database gave no date');
  return day;
}

export async function insertAdHocSender(
  client: Query,
  overrides: {
    id?: string;
    name?: string;
    phone?: string;
    state?: 'PROVISIONAL' | 'REUSABLE';
  } = {},
): Promise<{ id: string; phone: string }> {
  const id = overrides.id ?? randomUUID();
  const phone = overrides.phone ?? `+23324${String(randomInt(1_000_000, 9_999_999))}`;
  await client.query(
    `insert into ad_hoc_sender (id, name, phone, phone_as_entered, state, created_by) values ($1, $2, $3, $3, $4, $5)`,
    [id, overrides.name ?? 'Ama Walk-in', phone, overrides.state ?? 'PROVISIONAL', ARRANGER],
  );
  return { id, phone };
}

export async function insertVendorLocation(
  client: Query,
  vendorOrganizationId: string,
  overrides: {
    id?: string;
    label?: string;
    address?: string;
    isDefault?: boolean;
    active?: boolean;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await client.query(
    `insert into vendor_pickup_location (id, vendor_organization_id, label, location, is_default, active, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      id,
      vendorOrganizationId,
      overrides.label ?? 'Shop',
      JSON.stringify({ address: overrides.address ?? 'Fixture shop, Community 1' }),
      overrides.isDefault ?? false,
      overrides.active ?? true,
      ARRANGER,
    ],
  );
  return id;
}

/** A second arranged actor, who decides what `ARRANGER` requested. */
export const ARRANGED_CHECKER = '5eed0000-0000-4000-8000-0000000000e2';

export interface ExceptionRow {
  readonly id: string;
  readonly pickupRequestId: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly note: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly recipientLocation: { readonly address: string; readonly landmark?: string };
  /** The fee as the approval snapshotted it, for an approved exception that has one. */
  readonly feeSnapshot: {
    readonly amount_minor: number;
    readonly setting_key: string;
    readonly effective_version: string;
  } | null;
}

/** A requested one-package exception for the request, with a recipient (section 21.1) and the note the approver reads. */
export function exceptionRow(
  pickupRequestId: string,
  overrides: Partial<ExceptionRow> = {},
): ExceptionRow {
  return {
    id: randomUUID(),
    pickupRequestId,
    state: 'REQUESTED',
    requestedBy: ARRANGER,
    approvedBy: null,
    note: 'Customer asked for a single parcel by phone',
    recipientName: 'Kofi Recipient',
    recipientPhone: '+233244000111',
    recipientLocation: { address: 'House 7, Adenta Housing Down' },
    feeSnapshot: null,
    ...overrides,
  };
}

/**
 * Arranged as the administrator. A decided row gets its checker and the moment of the decision, and an approved one the fee snapshot
 * it is given; none of the three is a thing the runtime can write at an insert.
 */
export async function insertOnePackageException(
  client: Query,
  row: ExceptionRow,
): Promise<ExceptionRow> {
  const decided = row.state !== 'REQUESTED';
  await client.query(
    `insert into one_package_exception (id, pickup_request_id, state, requested_by, approved_by, decided_at, note, recipient_name,
                                        recipient_phone, recipient_location, single_package_fee_snapshot)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
    [
      row.id,
      row.pickupRequestId,
      row.state,
      row.requestedBy,
      decided ? (row.approvedBy ?? ARRANGED_CHECKER) : row.approvedBy,
      decided ? new Date('2026-11-02T09:30:00Z') : null,
      row.note,
      row.recipientName,
      row.recipientPhone,
      JSON.stringify(row.recipientLocation),
      row.feeSnapshot === null ? null : JSON.stringify(row.feeSnapshot),
    ],
  );
  return row;
}
