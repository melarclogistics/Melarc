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
 * The dispatch domain's side of `RecordLookupSource` (task C2; features/operations/global-lookup.md): the riders a name, or a phone number typed
 * in full, finds. Read under `dispatch.read`, in the transaction of the caller, whose context is that grant's: row-level security
 * (`rider_identity_staff_read`) shows a staff member the riders of the hubs of the grant, so a source writes no predicate on hubs.
 *
 * - **A name** is the word-prefix of the rider's name, by name then id.
 * - **A phone number typed in full** is matched exactly against the rider's phone, which is held in its normal (E.164) form.
 * - **An operational code finds no rider**: a rider has none.
 */
interface RiderRow {
  readonly id: string;
  readonly full_name: string;
  readonly status: string;
  readonly primary_hub_id: string;
}

const riderPredicate = (query: LookupQuery): SQL | undefined => {
  switch (strategyOf(query)) {
    case 'code':
      return undefined;
    case 'phone':
      return sql`phone = ${query.phone}::text`;
    case 'name':
      return nameMatches('full_name', query.text);
  }
};

async function searchRiders(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  const predicate = riderPredicate(query);
  if (predicate === undefined) return [];
  const result = await transactionOf(handle).execute(sql`
    select id, full_name, status, primary_hub_id
      from rider_identity
     where ${predicate}
     order by full_name, id
     limit ${limit}`);
  const phone = strategyOf(query) === 'phone' ? query.phone : undefined;
  return (result.rows as unknown as RiderRow[]).map((row) => ({
    id: row.id,
    title: row.full_name,
    state: row.status,
    hubId: row.primary_hub_id,
    ...(phone === undefined ? {} : { matchedPhone: phone }),
  }));
}

export function riderRecordLookupSources(): readonly RecordLookupSource[] {
  return [
    {
      kind: 'RIDER',
      readKey: 'dispatch.read',
      // A rider has no operational code: a phone number typed in full and a name find one.
      answers: (query) => strategyOf(query) !== 'code',
      search: searchRiders,
    },
  ];
}
