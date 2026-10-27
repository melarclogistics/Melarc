import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * A vendor account as the reads answer it (`VendorAccountSummary`, `VendorAccountDetail`, `RegisteredDevice`; domain-model.md section 6.8):
 * **authentication status only**. What the account and its organisation say; *whether* a secret and each recovery channel exist, which
 * channel messages go by, and how many browsers are `ACTIVE`, from the credential facts (`melarc.vendor_credential_facts`, migration 0034),
 * which give booleans and the channel's name and never an address, a number or a hash. The administrative acts (S0.47b, S0.51) build the
 * same view from the same columns, so the ETag they recompute under the credential's lock is the one the read gave.
 */
export interface VendorAccountView {
  readonly id: string;
  readonly account_identifier: string;
  readonly vendor_organization_id: string;
  readonly legal_name: string;
  readonly responsible_hub_id: string;
  readonly status: string;
  readonly credential_established: boolean;
  readonly active_device_count: number;
  readonly has_recovery_email: boolean;
  readonly has_recovery_phone: boolean;
  readonly delivery_channel: string | null;
}

/** A browser the account has held. Neither the credential nor its hash is a column the runtime can select. */
export interface RegisteredDeviceView {
  readonly id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly device_kind: string;
  readonly status: string;
  readonly registered_at: string;
  readonly registered_by: string | null;
}

/** The columns of an account and its organisation a representation is made of, with the moment a page position uses. */
export interface AccountRow {
  readonly id: string;
  readonly account_identifier: string;
  readonly vendor_organization_id: string;
  readonly legal_name: string;
  readonly responsible_hub_id: string;
  readonly status: string;
  readonly active_device_count: number;
  readonly created_at_text: string;
}

/** `a` is `vendor_account`, `o` its `vendor_organization`: the statement that reads them names both. */
export const ACCOUNT_COLUMNS = sql.raw(
  `a.id, a.account_identifier, a.vendor_organization_id, o.legal_name, o.responsible_hub_id, a.status,
   (select count(*)::int from registered_device d where d.vendor_account_id = a.id and d.status = 'ACTIVE') as active_device_count,
   a.created_at::text as created_at_text`,
);

export const ACCOUNT_SOURCE = sql.raw(
  `vendor_account a join vendor_organization o on o.id = a.vendor_organization_id`,
);

/** What the credential of one account is, as `melarc.vendor_credential_facts` answers it. */
export interface CredentialFacts {
  readonly credential_established: boolean;
  readonly has_recovery_email: boolean;
  readonly has_recovery_phone: boolean;
  readonly delivery_channel: string | null;
  readonly credential_generation: number;
}

/**
 * The credential facts of the accounts read, from the same snapshot (the function refuses any isolation but `REPEATABLE READ`), keyed
 * by account. The function answers for the accounts the caller's scope shows, and the accounts were read under that scope.
 */
export async function credentialFactsOf(
  handle: TransactionHandle,
  ids: readonly string[],
): Promise<ReadonlyMap<string, CredentialFacts>> {
  if (ids.length === 0) return new Map();
  const result = await transactionOf(handle).execute(
    sql`select * from melarc.vendor_credential_facts(${`{${ids.join(',')}}`}::uuid[])`,
  );
  const rows = result.rows as unknown as (CredentialFacts & {
    readonly vendor_account_id: string;
  })[];
  return new Map(rows.map((row) => [row.vendor_account_id, row]));
}

export function viewOf(row: AccountRow, facts: CredentialFacts): VendorAccountView {
  return {
    id: row.id,
    account_identifier: row.account_identifier,
    vendor_organization_id: row.vendor_organization_id,
    legal_name: row.legal_name,
    responsible_hub_id: row.responsible_hub_id,
    status: row.status,
    credential_established: facts.credential_established,
    active_device_count: row.active_device_count,
    has_recovery_email: facts.has_recovery_email,
    has_recovery_phone: facts.has_recovery_phone,
    delivery_channel: facts.delivery_channel,
  };
}

/** Every browser an account has held, `REVOKED` and `REPLACED` included, newest first (then by id, so the order is total). */
export async function devicesOf(
  handle: TransactionHandle,
  accountId: string,
): Promise<RegisteredDeviceView[]> {
  const result = await transactionOf(handle).execute(
    sql`select id, principal_type, principal_id, device_kind, status, registered_at, registered_by
          from registered_device
         where principal_type = 'VENDOR' and principal_id = ${accountId}::uuid
         order by registered_at desc, id`,
  );
  const rows = result.rows as unknown as (Omit<RegisteredDeviceView, 'registered_at'> & {
    readonly registered_at: Date | string;
  })[];
  return rows.map((row) => ({
    id: row.id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    device_kind: row.device_kind,
    status: row.status,
    registered_at: new Date(row.registered_at).toISOString(),
    registered_by: row.registered_by,
  }));
}
