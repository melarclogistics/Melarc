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
import { hubToday } from './pickup-hub-day.js';
import { PICKUP_REQUEST_STATES } from './pickup-request.schema.js';

/**
 * The pickup domain's side of `RecordLookupSource` (task C2; features/operations/global-lookup.md): the pickup requests and the pickup runs a
 * code, a name or a phone number typed in full finds. Both kinds are read under `pickup.read`, in the transaction of the caller, whose context
 * is that grant's: row-level security (`pickup_request_read`, `pickup_manifest_read`) shows a staff member the records of the hubs of the grant, so
 * a source writes no predicate on hubs, vendors or ownership.
 *
 * - **A request** is found by its operational code (`PR`), by a contact phone typed in full (the request's own `primary_phone` or `secondary_phone`:
 *   never through the ad-hoc sender, whose policy is global to staff and would tell which hub a sender is booked in) and by the word-prefix of its
 *   sender's name. Newest first, then the id. **A code and a phone number find a request whatever its age; a name finds it only while it is current
 *   work** (the Product Owner's decision D3, option (c), 6 November 2026; {@link currentWork}).
 * - **A run** is found by its operational code (`MF`) alone.
 *
 * A hit states **facts** and no wording: the record's own `state` as the value of its enumeration, its hub, the service date (the request's
 * `scheduled_service_date`, the run's `service_date`) and, for a request, its sender's name exactly as the request's own read shows it.
 */

/** The terminal states of a request (state-machines.md section 3: `DECLINED` and `CANCELLED`; no state is reversible). */
export const TERMINAL_REQUEST_STATES: readonly string[] = ['DECLINED', 'CANCELLED'];

/**
 * How far back the service date of a **terminal** request may be for a name to still find it (the Product Owner's decision D3, option (c),
 * 6 November 2026). A constant of the code and not a setting: `contracts/settings.md` has no such setting and none is invented.
 */
export const NAME_SEARCH_WINDOW_DAYS = 30;

/**
 * The first service date, as a `YYYY-MM-DD` day, that still counts as recent for the hub's `today`: today minus {@link NAME_SEARCH_WINDOW_DAYS}
 * (a request with that date is in; one a day older is out). Plain calendar arithmetic on the day, with no zone and no daylight saving in it: the
 * hub's clock decided what `today` is.
 */
export function nameSearchWindowStart(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) throw new Error(`${today} is not a calendar day`);
  day.setUTCDate(day.getUTCDate() - NAME_SEARCH_WINDOW_DAYS);
  return day.toISOString().slice(0, 10);
}

/**
 * The condition that says a request is **current work** (`features/operations/global-lookup.md` section 5): its state is not terminal, or its
 * service date is on or after `windowStart`. It is written with the comparisons the planner may run before the row-level security policy (an
 * equality on the state, a comparison of two dates), and the non-terminal states are those of the closed list that are not terminal, so that a
 * state added later is current work until it is declared terminal.
 */
export function currentWork(windowStart: string): SQL {
  const open = PICKUP_REQUEST_STATES.filter((state) => !TERMINAL_REQUEST_STATES.includes(state));
  const states = sql.join(
    open.map((state) => sql`${state}::text`),
    sql`, `,
  );
  return sql`(state in (${states}) or scheduled_service_date >= ${windowStart}::date)`;
}

const requestPredicate = (query: LookupQuery, windowStart: string | undefined): SQL | undefined => {
  switch (strategyOf(query)) {
    case 'code':
      return query.codeType === 'PR' ? sql`code = ${query.code}::text` : undefined;
    case 'phone':
      return sql`(primary_phone = ${query.phone}::text or secondary_phone = ${query.phone}::text)`;
    case 'name':
      return windowStart === undefined
        ? undefined
        : sql`${nameMatches('sender_name', query.text)} and ${currentWork(windowStart)}`;
  }
};

interface RequestRow {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly service_date: string;
  readonly sender_name: string;
}

async function searchRequests(
  handle: TransactionHandle,
  query: LookupQuery,
  limit: number,
): Promise<readonly LookupHit[]> {
  // Only a name is windowed, and only a name needs the hub's today: a code and a number are index probes that no age bounds.
  const windowStart =
    strategyOf(query) === 'name' ? nameSearchWindowStart(await hubToday(handle)) : undefined;
  const predicate = requestPredicate(query, windowStart);
  if (predicate === undefined) return [];
  const result = await transactionOf(handle).execute(sql`
    select id, code, state, responsible_hub_id, scheduled_service_date::text as service_date, sender_name
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
    senderName: row.sender_name,
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
