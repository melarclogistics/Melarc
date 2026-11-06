import { sql, type SQL } from 'drizzle-orm';

/**
 * Which pickup requests the list of requests contains, written once (task C1; reporting-data-dictionary.md section 5.5). `listPickupRequests`
 * and the counts of the queues that are filters of it (`getQueueSummary`) both call `pickupRequestCriteria`, so a queue's count is the number
 * of requests its list returns **by construction** and not by two predicates that have to be kept alike. The position of a page (the keyset)
 * is not a criterion: it says where a page starts, not what the list holds, and stays in the list.
 *
 * Every statement that uses these criteria selects `from pickup_request` and no alias, because the criteria refer to its columns and
 * correlate with it by name.
 *
 * **The shape of the conditions is written for the planner, and their meaning is not changed by it** (measured at 400,000 requests, task C1):
 * a filter that is not asked for adds no condition at all (rather than `$1 is null or ...`, which the planner cannot take out of the
 * way of a join), so that `manifested` is a plain `exists` or `not exists` that becomes a semi or an anti join, and the filter on an
 * exception's state first names the requests that can possibly show an exception in that state (a small set, from an index) and only then
 * asks the exact question of each of them. The exact question is unchanged and stays the judge.
 */
export interface PickupRequestCriteria {
  /** Only the requests in this state, or all of them. */
  readonly state: string | null;
  /** Only the requests whose exception (the one they carry, else the latest raised for them) is in this state. */
  readonly exceptionState: string | null;
  /** Only the requests scheduled for this day (`YYYY-MM-DD`). */
  readonly serviceDate: string | null;
  /** `true`: only the requests that have a stop no one has released; `false`: only those that have none. */
  readonly manifested: boolean | null;
}

/**
 * A column of the exception a request shows: **the one it carries** (an approval travels with the booking into its clones) **or else the
 * latest raised for it** (S1.16). It is a scalar subquery of the request, so it is read once for each request and never joins two
 * exceptions of one request into two rows. It is the judge of what a request shows; `requestsThatCanShowAnExceptionIn` only narrows
 * the requests it is asked of.
 */
export function shownException(column: 'state' | 'requested_at'): SQL {
  return sql`(
            select e.${sql.raw(column)} from one_package_exception e
             where e.id = pickup_request.one_package_exception_id or e.pickup_request_id = pickup_request.id
             order by (e.id = pickup_request.one_package_exception_id) desc, e.requested_at desc, e.id desc
             limit 1)`;
}

/**
 * The requests that **can** show an exception in this state: those it was raised for, and those that carry it. A request that shows an
 * exception in the state shows either one it carries (then that exception is in the state, and the request is in the second part) or one
 * raised for it (then that exception is in the state, and the request is in the first), so no request that does is left out. It is a
 * necessary condition and never a sufficient one: a request may be raised an exception in the state and show another (the one it
 * carries), and `shownException` decides. Its use is that it starts from the exceptions in the state, which are few and indexed
 * (`one_package_exception_state_idx`, `pickup_request_carried_exception_idx`), instead of from every request.
 */
function requestsThatCanShowAnExceptionIn(state: string): SQL {
  return sql`pickup_request.id in (
            select x.pickup_request_id from one_package_exception x where x.state = ${state}::text
            union all
            select r.id from pickup_request r join one_package_exception c on c.id = r.one_package_exception_id where c.state = ${state}::text)`;
}

/**
 * The conditions of the list, joined with `and` (a `where` clause carries them, and a count of a queue does the same).
 *
 * **The manifest pool is a rule of the combination**: the confirmed requests that no manifest holds, **less the ones awaiting the review of
 * their cutoff** (the Product Owner, 29 to 30 October 2026), which the plain list of confirmed requests still shows. It applies to
 * `state=CONFIRMED` with `manifested=false` and to nothing else, so that an operational queue does not lose a request to the pool's rule.
 */
export function pickupRequestCriteria(criteria: PickupRequestCriteria): SQL {
  const { state, exceptionState, serviceDate, manifested } = criteria;
  const pool = manifested === false && state === 'CONFIRMED';
  const conditions: SQL[] = [sql`true`];
  if (state !== null) conditions.push(sql`state = ${state}::text`);
  if (exceptionState !== null) {
    conditions.push(
      requestsThatCanShowAnExceptionIn(exceptionState),
      sql`${shownException('state')} = ${exceptionState}::text`,
    );
  }
  if (serviceDate !== null) conditions.push(sql`scheduled_service_date = ${serviceDate}::date`);
  if (manifested !== null) {
    conditions.push(
      manifested
        ? sql`exists (select 1 from pickup_stop s where s.pickup_request_id = pickup_request.id and s.released_at is null)`
        : sql`not exists (select 1 from pickup_stop s where s.pickup_request_id = pickup_request.id and s.released_at is null)`,
    );
  }
  if (pool) conditions.push(sql`cutoff_exception_state is distinct from 'PENDING_OPS_REVIEW'`);
  return sql.join(conditions, sql` and `);
}

/** No filter at all: the criteria that every request meets. A queue counts from here by naming the filter it is. */
export const ANY_PICKUP_REQUEST: PickupRequestCriteria = Object.freeze({
  state: null,
  exceptionState: null,
  serviceDate: null,
  manifested: null,
});

/**
 * The confirmed requests whose booking passed the hub's cutoff and which Ops has yet to resolve (`AC-SLICE-001-04`: "a late booking
 * queues, it does not fail"). **The list has no parameter for it**: the plain list of confirmed requests shows each of these with
 * `cutoff_exception_state` `PENDING_OPS_REVIEW`, and the count is held to that list through that field.
 */
export const CUTOFF_REVIEW_CRITERIA: SQL = sql`state = 'CONFIRMED' and cutoff_exception_state = 'PENDING_OPS_REVIEW'`;
