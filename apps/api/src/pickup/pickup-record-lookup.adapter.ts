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
 * The pickup domain's side of `RecordLookupSource` (task C2; features/operations/global-lookup.md): the pickup requests and the pickup runs a
 * code, a name or a phone number typed in full finds. Both kinds are read under `pickup.read`, in the transaction of the caller, whose context
 * is that grant's: row-level security (`pickup_request_read`, `pickup_manifest_read`) shows a staff member the records of the hubs of the grant, so
 * a source writes no predicate on hubs, vendors or ownership.
 *
 * - **A request** is found by its operational code (`PR`), by a contact phone typed in full (the request's own `primary_phone` or `secondary_phone`:
 *   never through the ad-hoc sender, whose policy is global to staff and would tell which hub a sender is booked in) and by the word-prefix of its
 *   sender's name. Newest first, then the id.
 * - **A run** is found by its operational code (`MF`) alone.
 *
 * A hit states **facts** and no wording: the record's own `state` as the value of its enumeration, its hub, and the service date (the request's
 * `scheduled_service_date`, the run's `service_date`).
 */
const requestPredicate = (query: LookupQuery): SQL | undefined => {
  switch (strategyOf(query)) {
    case 'code':
      return query.codeType === 'PR' ? sql`code = ${query.code}::text` : undefined;
    case 'phone':
      return sql`(primary_phone = ${query.phone}::text or secondary_phone = ${query.phone}::text)`;
    case 'name':
      return nameMatches('sender_name', query.text);
  }
};

interface RequestRow {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly service_date: string;
}

async function searchRequests(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  const predicate = requestPredicate(query);
  if (predicate === undefined) return [];
  const result = await transactionOf(handle).execute(sql`
    select id, code, state, responsible_hub_id, scheduled_service_date::text as service_date
      from pickup_request
     where ${predicate}
     order by created_at desc, id
     limit ${limit}`);
  const phone = strategyOf(query) === 'phone' ? query.phone : undefined;
  return (result.rows as unknown as RequestRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    title: row.code,
    state: row.state,
    hubId: row.responsible_hub_id,
    serviceDate: row.service_date,
    ...(phone === undefined ? {} : { matchedPhone: phone }),
  }));
}

interface ManifestRow {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly service_date: string;
}

async function searchManifests(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  if (strategyOf(query) !== 'code' || query.codeType !== 'MF') return [];
  const result = await transactionOf(handle).execute(sql`
    select id, code, state, responsible_hub_id, service_date::text as service_date
      from pickup_manifest
     where code = ${query.code}::text
     order by service_date desc, id
     limit ${limit}`);
  return (result.rows as unknown as ManifestRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    title: row.code,
    state: row.state,
    hubId: row.responsible_hub_id,
    serviceDate: row.service_date,
  }));
}

export function pickupRecordLookupSources(): readonly RecordLookupSource[] {
  return [
    {
      kind: 'PICKUP_REQUEST',
      readKey: 'pickup.read',
      // A code finds a request only when it is a request's (`PR`); a phone number typed in full and a name always may.
      answers: (query) => strategyOf(query) !== 'code' || query.codeType === 'PR',
      search: searchRequests,
    },
    {
      kind: 'PICKUP_MANIFEST',
      readKey: 'pickup.read',
      // A run is found by its code alone.
      answers: (query) => strategyOf(query) === 'code' && query.codeType === 'MF',
      search: searchManifests,
    },
  ];
}
