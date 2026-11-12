import { sql, type SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type {
  LookupHit,
  LookupQuery,
  RecordLookupSource,
} from '../platform/domain-ports/record-lookup.port.js';
import { strategyOf } from '../platform/lookup/lookup-query.js';
import { nameMatches } from '../platform/lookup/name-match.js';

/**
 * The vendor domain's side of `RecordLookupSource` (task C2; features/operations/global-lookup.md): the vendor accounts a name, or the account's
 * identifier, finds. The record Ops opens is the **account** (its page is addressed by the account's id), read through the organisation it
 * belongs to, as `listVendorAccounts` reads it (`vendor_account a join vendor_organization o`): the account is the hub-scoped row
 * (`vendor_account_select`, under `vendor.read`), so a source writes no predicate on hubs, vendors or ownership.
 *
 * - **A name** is the word-prefix of the organisation's legal or trading name.
 * - **The vendor's code is its account identifier** (eight characters, the sign-in identifier), matched exactly **in addition to** the name when
 *   the text has its shape: an eight-letter name can have the same shape.
 * - **An operational code and a phone number find no vendor**: a vendor has neither, and a number is never searched on a vendor.
 */
interface AccountRow {
  readonly id: string;
  readonly account_identifier: string;
  readonly legal_name: string;
  readonly responsible_hub_id: string;
  readonly status: string;
}

const accountPredicate = (query: LookupQuery): SQL | undefined => {
  if (strategyOf(query) !== 'name') return undefined;
  const name = sql`(${nameMatches('o.legal_name', query.text)} or ${nameMatches('o.trading_name', query.text)})`;
  return query.accountIdentifier === undefined
    ? name
    : sql`(a.account_identifier = ${query.accountIdentifier}::text or ${name})`;
};

async function searchAccounts(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  const predicate = accountPredicate(query);
  if (predicate === undefined) return [];
  const result = await transactionOf(handle).execute(sql`
    select a.id, a.account_identifier, o.legal_name, o.responsible_hub_id, a.status
      from vendor_account a join vendor_organization o on o.id = a.vendor_organization_id
     where ${predicate}
     order by o.legal_name, a.id
     limit ${limit}`);
  return (result.rows as unknown as AccountRow[]).map((row) => ({
    id: row.id,
    code: row.account_identifier,
    title: row.legal_name,
    state: row.status,
    hubId: row.responsible_hub_id,
  }));
}

export function vendorRecordLookupSources(): readonly RecordLookupSource[] {
  return [
    {
      kind: 'VENDOR_ACCOUNT',
      readKey: 'vendor.read',
      // A vendor has neither an operational code nor a phone number to be found by.
      answers: (query) => strategyOf(query) === 'name',
      search: searchAccounts,
    },
  ];
}
