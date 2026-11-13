import { sql, type SQL } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import {
  hubOutsideStaffGrant,
  type AuthorizedRequest,
} from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import {
  disputeViewOf,
  failureViewOf,
  opsHandshakeViewOf,
  shortfallViewOf,
  type CollectionDisputeView,
  type CollectionShortfallView,
  type ListedRow,
  type OpsHandshakeView,
  type PickupFailureView,
} from './ops-work-list-views.js';

/** What the four lists take from the query: the same four, as strings, exactly as they were sent (the service judges them). */
export interface WorkListFilter {
  /** `true`: only what still waits for Ops; `false`: only what no longer does; left out: all of it. What "waits" means is each list's own rule. */
  readonly open?: string;
  /** Only the items of this hub: a filter that narrows what the caller may read and never widens it (task C3, `AC-HUBF-01`). */
  readonly hubId?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface WorkListPage<View> {
  readonly items: readonly View[];
  readonly next_page_token: string | null;
}

export interface PickupOpsWorkListsOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** Every read opens one `REPEATABLE READ` transaction: the rows, and the audit of a crossing, are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

/**
 * The four lists are Ops's: the guard serves them to the Ops Portal's staff under an existing key, and a service that answers about records does not rely on
 * that alone (as `listPickupRequests` and `lookupRecords` do not): a Vendor or a Rider is refused here before anything is judged or read.
 */
function refuseNotStaff(authorized: AuthorizedRequest): void {
  if (authorized.session.principalType !== 'STAFF') {
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}

/** What a statement is built from, once the query has been judged. */
interface Parts {
  readonly hubId: string | null;
  readonly open: boolean | null;
  readonly afterMoment: string | null;
  readonly afterId: string | null;
  /** One more than a page, so that a page knows whether another follows. */
  readonly limit: number;
}

/** The hub as a condition of the statement: a filter, never a scope (the row-level security of the transaction decides which rows may be read at all). */
const hubIs = (column: string, hubId: string | null): SQL =>
  hubId === null ? sql`true` : sql`${sql.raw(column)} = ${hubId}::uuid`;

/** The rows after the position of the last row of the previous page, in the order of the list (the moment, then the id). */
const after = (column: string, idColumn: string, parts: Parts): SQL =>
  parts.afterMoment === null
    ? sql`true`
    : sql`(${sql.raw(column)}, ${sql.raw(idColumn)}) > (${parts.afterMoment}::timestamptz, ${parts.afterId}::uuid)`;

/** `open` as a condition: `waiting` is the list's own rule for what still waits for Ops, and `false` is exactly its complement. */
const openIs = (waiting: string, parts: Parts): SQL =>
  parts.open === null
    ? sql`true`
    : parts.open
      ? sql`${sql.raw(waiting)}`
      : sql`not (${sql.raw(waiting)})`;

/**
 * The reads Ops works from at the door and at the failure (D-A3, OB-S1-70; the Product Owner's decision of 11 November 2026; plan S1.30). Four lists of one shape:
 *
 * - **A list for Ops staff only, by the hubs of the session's grant.** The statement runs in the caller's own context with the authorizing key, and the
 *   policy of each table shows a staff member the rows of the hubs of that grant and no other (`pickup`, and for the record, the handshake and the dispute,
 *   `fleet`, keys), a vendor and a rider none; the service refuses them as well (`refuseNotStaff`). Nothing the use case writes widens that.
 * - **An authorised staff read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as every staff read is: one
 *   `auth.hub_boundary.crossed` for each foreign hub the page represents, naming the operation. A page that is empty writes none.
 * - **`hub_id` narrows and never widens** (task C3): one more condition of the statement, never in the security context; a hub outside the grant or that names
 *   no hub is an empty page and **no transaction, no statement** (task A1), so the time of the answer tells nothing of whether the hub exists or what it holds.
 * - **`open` is a boolean that each list defines on its own state**: `true` is what still waits for Ops, `false` is the rest of what the list holds, and left
 *   out is all of it. The definitions are the lists' and are stated beside each.
 * - **The order is the oldest first, then the id** (as `listPickupRequests` is), by the moment the list is about, so that a page does not move under a reader
 *   who is paging; the token is that position and nothing else.
 * - **Every figure is the table's or the database's clock's.** The waiting time of a failure and whether a handshake's code has run out are judged by the
 *   database at the moment of the read, never by the browser.
 */
export class PickupOpsWorkLists {
  readonly #options: PickupOpsWorkListsOptions;

  constructor(options: PickupOpsWorkListsOptions) {
    this.#options = options;
  }

  /**
   * `listCollectionDisputes`: the reconciliation items vendors raised (S1.29, `AC-SLICE-001-27`). **Open is an item still `OPEN`**: no operation resolves one
   * in this slice, so every item is open until the reconciliation workflow exists. The item says what was counted, so that Ops sees what is disputed
   * beside what the vendor says.
   */
  listCollectionDisputes(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: WorkListFilter,
  ): Promise<WorkListPage<CollectionDisputeView>> {
    return this.#list(
      authorized,
      correlationId,
      filter,
      'listCollectionDisputes',
      (parts) => sql`
        select d.id, d.pickup_stop_id, s.pickup_manifest_id, s.pickup_request_id, d.responsible_hub_id, d.vendor_organization_id,
               r.code as request_code, r.sender_name, d.state, d.note, d.created_at, d.resolved_at, s.state as stop_state,
               c.declared_count, c.collected_count, c.variance,
               d.created_at::text as position_text, d.id as position_id
          from collection_dispute d
          join pickup_stop s on s.id = d.pickup_stop_id
          join pickup_request r on r.id = s.pickup_request_id
          join collection_record c on c.pickup_stop_id = d.pickup_stop_id
         where ${hubIs('d.responsible_hub_id', parts.hubId)}
           and ${openIs(`d.state = 'OPEN'`, parts)}
           and ${after('d.created_at', 'd.id', parts)}
         order by d.created_at, d.id
         limit ${parts.limit}`,
      disputeViewOf,
    );
  }

  /**
   * `listHandshakesForOps`: the collection handshakes that route to Ops (`AC-SLICE-001-24`, `-26`; pickup-collection.md, "TTL expired", "Attempts exhausted", "SMS
   * fallback exhausted"), and the ones Ops has settled. **Open is a handshake that needs Ops now**, as the database judges it at the moment of the read:
   * its state is `EXPIRED` or `EXHAUSTED`; or its code is still live by state but its life has passed on the database's clock (the state is moved only
   * when someone asks, so a code nobody tried is expired all the same); or the SMS fallback has sent the platform's cap (`sms_fallback_max_per_pickup`) and the
   * rider has no more to ask. The first that applies is `routed_because`. **Not open** is the handshakes Ops settled (an override, or a hand resolution), which
   * the list keeps so that Ops can see what it did (both record the channel `OPS_OVERRIDE`, so the channel is what says it). A handshake that closed through the portal or the SMS fallback is in neither: it never needed Ops. The cap
   * and the attempt limit are read from the platform's settings as they stand; where one holds no usable value it is `null` and judges nothing (a default
   * is never invented), and that is the only way an unusable setting is told.
   */
  listHandshakesForOps(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: WorkListFilter,
  ): Promise<WorkListPage<OpsHandshakeView>> {
    return this.#list(
      authorized,
      correlationId,
      filter,
      'listHandshakesForOps',
      (parts) => sql`
        with limits as (
          select (select case when (v.value #>> '{}') ~ '^[0-9]+$' then (v.value #>> '{}')::integer end
                    from setting v where v.key = 'handshake_max_wrong_attempts') as attempt_limit,
                 (select case when (v.value #>> '{}') ~ '^[0-9]+$' then (v.value #>> '{}')::integer end
                    from setting v where v.key = 'sms_fallback_max_per_pickup') as fallback_limit
        ), judged as (
          select h.id, h.pickup_stop_id, h.pickup_request_id, h.responsible_hub_id, h.direction, h.state, h.expires_at, h.attempts,
                 h.fallback_sends, h.channel, h.confirmed_at, h.authorised_by, h.created_at, limits.attempt_limit, limits.fallback_limit,
                 case
                   when h.state = 'EXHAUSTED' then 'ATTEMPTS_EXHAUSTED'
                   when h.state = 'EXPIRED' then 'CODE_EXPIRED'
                   when h.state in ('CODE_GENERATED', 'CODE_DELIVERED') and h.expires_at <= clock_timestamp() then 'CODE_EXPIRED'
                   when h.state in ('CODE_GENERATED', 'CODE_DELIVERED') and limits.fallback_limit >= 1
                        and h.fallback_sends >= limits.fallback_limit then 'FALLBACK_LIMIT_REACHED'
                 end as routed_because
            from collection_handshake h cross join limits
           where ${hubIs('h.responsible_hub_id', parts.hubId)}
             and ${after('h.created_at', 'h.id', parts)}
        )
        select j.id, j.pickup_stop_id, s.pickup_manifest_id, j.pickup_request_id, j.responsible_hub_id, r.code as request_code, r.sender_name,
               j.direction, j.state, s.state as stop_state, j.routed_because, j.expires_at, j.attempts, j.attempt_limit, j.fallback_sends,
               j.fallback_limit, j.channel, j.confirmed_at, j.authorised_by, j.created_at,
               j.created_at::text as position_text, j.id as position_id
          from judged j
          join pickup_stop s on s.id = j.pickup_stop_id
          join pickup_request r on r.id = j.pickup_request_id
         where (j.routed_because is not null or j.channel = 'OPS_OVERRIDE')
           and ${openIs('j.routed_because is not null', parts)}
         order by j.created_at, j.id
         limit ${parts.limit}`,
      opsHandshakeViewOf,
    );
  }

  /**
   * `listCollectionShortfalls`: the short counts flagged to the office (`AC-SLICE-001-21`; OB-S1-51), so that Ops finds in the system what the rider also tells
   * it by phone: what was declared, what was counted, the reason and the rider's note. **Open is a shortfall whose run is still in progress** (the rider is
   * still out with the parcels the office was told are missing); not open is the shortfalls of runs that have ended. Nothing yet marks a shortfall as read or
   * worked (no acknowledgement is built, R67), so this is the one distinction the data supports; it is the owner's to replace with a marker.
   */
  listCollectionShortfalls(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: WorkListFilter,
  ): Promise<WorkListPage<CollectionShortfallView>> {
    return this.#list(
      authorized,
      correlationId,
      filter,
      'listCollectionShortfalls',
      (parts) => sql`
        select c.id, c.pickup_stop_id, s.pickup_manifest_id, s.pickup_request_id, c.responsible_hub_id, r.code as request_code, r.sender_name,
               c.declared_count, c.collected_count, c.variance_reason_snapshot, c.office_notified_at, c.recorded_at, c.recorded_by,
               s.state as stop_state, m.state as run_state,
               c.recorded_at::text as position_text, c.id as position_id
          from collection_record c
          join pickup_stop s on s.id = c.pickup_stop_id
          join pickup_manifest m on m.id = s.pickup_manifest_id
          join pickup_request r on r.id = s.pickup_request_id
         where c.variance = 'SHORT'
           and ${hubIs('c.responsible_hub_id', parts.hubId)}
           and ${openIs(`m.state = 'IN_PROGRESS'`, parts)}
           and ${after('c.recorded_at', 'c.id', parts)}
         order by c.recorded_at, c.id
         limit ${parts.limit}`,
      shortfallViewOf,
    );
  }

  /**
   * `listPickupFailures`: the failure decision queue (S1.28, `AC-SLICE-001-30` to `-35`; pickup-failure.md): one item for each stop that failed, with what the
   * rider reported and what became of its request. **Open is a failure whose request is still `CONFIRMED`**, escalated or not: the office has yet to cancel it or
   * reschedule it (an escalation is a marker and decides nothing, OB-S1-15). Not open is a failure the office decided: its request is `CANCELLED`, with a
   * replacement when it was rescheduled. **The waiting time is the database's:** from the moment the failure was reported until the decision where there
   * is one, and until the read where there is not. **`photo_count`** is how many photos the rider attached to the failure (`pickup_stop_evidence`, read under the
   * same key and hub scope as the stop): a count and never an address, the photo itself being read with `createEvidenceRetrievalAuthorization`.
   */
  listPickupFailures(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: WorkListFilter,
  ): Promise<WorkListPage<PickupFailureView>> {
    return this.#list(
      authorized,
      correlationId,
      filter,
      'listPickupFailures',
      (parts) => sql`
        select s.id as pickup_stop_id, s.pickup_manifest_id, s.pickup_request_id, s.responsible_hub_id, r.code as request_code, r.sender_name,
               s.failure_category, s.failure_reason_snapshot, s.resolved_at as failed_at,
               greatest(0, floor(extract(epoch from (coalesce(r.cancelled_at, clock_timestamp()) - s.resolved_at))))::integer as waiting_seconds,
               r.state as request_state,
               case
                 when r.state = 'CANCELLED' and r.replacement_request_id is not null then 'RESCHEDULED'
                 when r.state = 'CANCELLED' then 'CANCELLED'
                 when r.escalated_at is not null then 'ESCALATED'
                 else 'PENDING'
               end as decision,
               r.attempt_number, (r.attempt_extension_id is not null) as attempt_extended, r.escalated_at, r.cancelled_at as decided_at,
               r.replacement_request_id, m.assigned_rider_id as rider_id,
               (select count(*) from pickup_stop_evidence e where e.pickup_stop_id = s.id)::integer as photo_count,
               s.resolved_at::text as position_text, s.id as position_id
          from pickup_stop s
          join pickup_request r on r.id = s.pickup_request_id
          join pickup_manifest m on m.id = s.pickup_manifest_id
         where s.state = 'FAILED'
           and ${hubIs('s.responsible_hub_id', parts.hubId)}
           and ${openIs(`r.state = 'CONFIRMED'`, parts)}
           and ${after('s.resolved_at', 's.id', parts)}
         order by s.resolved_at, s.id
         limit ${parts.limit}`,
      failureViewOf,
    );
  }

  /** The judging, the shortcut for a hub outside the grant, the read, the audit of the crossings and the position of the next page: the same for the four. */
  async #list<View>(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: WorkListFilter,
    operationId: string,
    statement: (parts: Parts) => SQL,
    view: (row: never) => View,
  ): Promise<WorkListPage<View>> {
    refuseNotStaff(authorized);
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    if (filter.open !== undefined && filter.open !== 'true' && filter.open !== 'false') {
      throw invalid('open', 'type');
    }
    if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalid('hub_id', 'format');
    const position = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && position === undefined) {
      throw invalid('page_token', 'format');
    }
    // A hub the staff session's grant does not reach is an empty page and **no transaction, no statement** (task A1, `AC-HUBF-05`): the database would walk that
    // hub's index and discard every row, and how long that takes says whether the hub exists and how much it holds. Judged after every validation, so a value
    // that is not a hub is still refused first.
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }
    const parts: Parts = {
      hubId: filter.hubId ?? null,
      open: filter.open === undefined ? null : filter.open === 'true',
      afterMoment: position?.createdAt ?? null,
      afterId: position?.id ?? null,
      limit: size + 1,
    };
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(statement(parts));
        const read = result.rows as unknown as ListedRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent (never the row that only says whether another page follows) and that are not the actor's own: one bounded
        // event for each, in the order of the hubs' ids, naming the hub and the operation.
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined) {
          const foreign = [
            ...new Set(page.map((row) => row.responsible_hub_id).filter((hub) => hub !== baseline)),
          ].toSorted();
          for (const hubId of foreign) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hubId },
              responsibleHubId: hubId,
              relatedIds: { operation_id: operationId },
            });
          }
        }
        const last = page.at(-1);
        return {
          items: page.map((row) => view(row as never)),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.position_id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  /** The actor's primary hub, which is the baseline of a crossing: `null` for a staff actor with none (every hub it reads is foreign). */
  async #primaryHubOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
  ): Promise<string | null | undefined> {
    if (authorized.session.principalType !== 'STAFF') return undefined;
    const own = await transactionOf(handle).execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    return (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
  }
}
