import { sql } from 'drizzle-orm';

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
 * The staff domain's side of `RecordLookupSource` (task C2; features/operations/global-lookup.md): the staff profiles a name finds. Read under
 * `staff.read` (withheld from Ops Staff), in the transaction of the caller, whose context is that grant's: row-level security
 * (`staff_identity_staff_read`) shows a staff member the profiles of the hubs of the grant, and one with no primary hub only to a grant of all
 * hubs, so a source writes no predicate on hubs. **The name only**: the work email and the phone of a profile are not searched, and are never in
 * a result. An operational code and a phone number find no staff member.
 */
interface StaffRow {
  readonly id: string;
  readonly full_name: string;
  readonly status: string;
  readonly primary_hub_id: string | null;
}

async function searchStaff(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  if (strategyOf(query) !== 'name') return [];
  const result = await transactionOf(handle).execute(sql`
    select id, full_name, status, primary_hub_id
      from staff_identity
     where ${nameMatches('full_name', query.text)}
     order by full_name, id
     limit ${limit}`);
  return (result.rows as unknown as StaffRow[]).map((row) => ({
    id: row.id,
    title: row.full_name,
    state: row.status,
    hubId: row.primary_hub_id,
  }));
}

export function staffRecordLookupSources(): readonly RecordLookupSource[] {
  return [
    {
      kind: 'STAFF_IDENTITY',
      readKey: 'staff.read',
      // A staff profile is found by name alone.
      answers: (query) => strategyOf(query) === 'name',
      search: searchStaff,
    },
  ];
}
