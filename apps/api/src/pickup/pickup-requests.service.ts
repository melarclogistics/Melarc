import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isCalendarDay } from './calendar-day.js';
import { exceptionViewOf, exceptionsShownFor } from './one-package-exception-view.js';
import { loadRequest } from './pickup-request-loader.js';
import { pickupRequestCriteria } from './pickup-request-criteria.js';
import { CUTOFF_EXCEPTION_STATES } from './pickup-request.schema.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import {
  REQUEST_COLUMNS,
  exceptionAudienceOf,
  forAudience,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

export type { PickupRequestView };

export const EXCEPTION_STATES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;

export interface PickupListFilter {
  readonly state?: string;
  readonly serviceDate?: string;
  readonly manifested?: string;
  readonly exceptionState?: string;
  readonly cutoffExceptionState?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface PickupRequestsServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** Both reads open one `REPEATABLE READ` transaction: the rows, and the audit of a crossing, are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

/**
 * `getPickupRequest` and `listPickupRequests` (S1.13; `pickup.read`; `AC-SLICE-001-79`; domain-model.md section 6.2).
 *
 * - **The scope is row-level security and the scope probe, nothing the use case writes.** The reads run in the caller's own context with
 *   the authorizing key: a staff member sees the requests of the hubs of the grant, a vendor its own organisation's and never by hub, a
 *   rider none. The record a route names is found or refused (`HUB_SCOPE_VIOLATION` by the scope probe for a staff caller on a request of
 *   another hub, `NOT_FOUND` for everyone else and for an id that matches nothing) by the guard before this runs, by one code path for a
 *   vendor and for an id that does not exist; a request that has gone since is `NOT_FOUND` here.
 * - **An authorised staff read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as the staff
 *   reads are: one `auth.hub_boundary.crossed` for a request of another hub, and one for each foreign hub a list represents.
 * - **The ETag is the digest of what the read returned** (`pickup-request-etag.ts`) and of the request's version; a list carries none.
 * - **A read carries no estimate** (S1.13): the estimate is the answer of the operations that compute it, and a read is not one of them.
 * - **The list is ordered by the moment of creation, then the id**, so that a page does not move under a reader who is paging, and is
 *   paged by an opaque token that is only a position.
 * - **`manifested` is the manifest pool** (S1.20; `AC-SLICE-001-11`): `true` lists the requests that have a stop no one has released, and
 *   `false` the requests that have none. With `state=CONFIRMED` it is the pool the contract names, and **a request that is awaiting the
 *   review of its cutoff is not in the pool** until Ops decides it (the Product Owner, 29 to 30 October 2026): the plain list of confirmed
 *   requests still shows it, because an operational queue must not lose a request to the pool's rule. The filter reads the stops, which
 *   only staff read (a vendor reads none in this slice, OB-S1-23; a rider none of a request), so a caller who is not staff is told
 *   `PERMISSION_DENIED` ("authorization-checked like every filter") and never given what a caller who cannot see stops would get.
 * - **A request shows its exception** (S1.16): the one it carries (an approval travels with the booking into its clones) or the latest
 *   raised for it, in the representation of `getPickupRequest` and so in its ETag. The approver's queue is the list filtered by the state
 *   of that exception (`one_package_exception_state=REQUESTED`), **of the pending requests alone** (`AC-QSUM-12`: task C1.1 left out the
 *   cancelled ones and the decision of 6 November 2026 made it exactly the approval guard): the exception of any other request can no longer
 *   be decided.
 * - **The late bookings are the list filtered by the cut-off state** (`cutoff_exception_state`, task C1.1, `AC-QSUM-10`): with
 *   `state=CONFIRMED` and `PENDING_OPS_REVIEW`, the requests waiting for Ops's cut-off decision, which `getQueueSummary` counts.
 */
export class PickupRequestsService {
  readonly #options: PickupRequestsServiceOptions;

  constructor(options: PickupRequestsServiceOptions) {
    this.#options = options;
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{ readonly request: PickupRequestView; readonly etag: string }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const loaded = await loadRequest(handle, id, {
          audience: exceptionAudienceOf(authorized.session.principalType),
        });
        if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const { row } = loaded;
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined && row.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'PickupRequest', id: row.id },
            responsibleHubId: row.responsible_hub_id,
          });
        }
        return { request: loaded.view, etag: loaded.etag };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: PickupListFilter,
  ): Promise<{
    readonly items: readonly PickupRequestView[];
    readonly next_page_token: string | null;
  }> {
    // The authorization of a filter comes before the validation of its value, as the authorization of a route does.
    if (filter.manifested !== undefined && authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    if (filter.serviceDate !== undefined && !isCalendarDay(filter.serviceDate)) {
      throw invalid('service_date', 'format');
    }
    if (
      filter.manifested !== undefined &&
      filter.manifested !== 'true' &&
      filter.manifested !== 'false'
    ) {
      throw invalid('manifested', 'type');
    }
    if (
      filter.exceptionState !== undefined &&
      !(EXCEPTION_STATES as readonly string[]).includes(filter.exceptionState)
    ) {
      throw invalid('one_package_exception_state', 'enum');
    }
    if (
      filter.cutoffExceptionState !== undefined &&
      !(CUTOFF_EXCEPTION_STATES as readonly string[]).includes(filter.cutoffExceptionState)
    ) {
      throw invalid('cutoff_exception_state', 'enum');
    }
    if (filter.state !== undefined && (filter.state === '' || filter.state.length > 32)) {
      throw invalid('state', 'format');
    }
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined)
      throw invalid('page_token', 'format');

    // What the list contains is written once, in `pickupRequestCriteria`, which the counts of the queues call as well (task C1): the pool
    // (the confirmed requests that no manifest holds, less the ones awaiting the review of their cutoff, see above) is a rule of it.
    const criteria = pickupRequestCriteria({
      state: filter.state ?? null,
      exceptionState: filter.exceptionState ?? null,
      cutoffExceptionState: filter.cutoffExceptionState ?? null,
      serviceDate: filter.serviceDate ?? null,
      manifested: filter.manifested === undefined ? null : filter.manifested === 'true',
    });
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
        select ${REQUEST_COLUMNS} from pickup_request
         where ${criteria}
           and (${afterMoment}::timestamptz is null or (created_at, id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
         order by created_at, id
         limit ${size + 1}`);
        const read = result.rows as unknown as PickupRequestRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent (never the row that only says whether another page follows) and that are not the
        // actor's own: one bounded event for each, in the order of the hubs' ids, naming the hub and the operation.
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
              relatedIds: { operation_id: 'listPickupRequests' },
            });
          }
        }
        const last = page.at(-1);
        const shown = await exceptionsShownFor(
          handle,
          page.map((row) => row.id),
        );
        const audience = exceptionAudienceOf(authorized.session.principalType);
        return {
          items: page.map((row) => {
            const exception = shown.get(row.id);
            return forAudience(
              viewOf(row, {
                exception: exception === undefined ? null : exceptionViewOf(exception),
              }),
              audience,
            );
          }),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.created_at_text, id: last.id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  /**
   * The actor's primary hub, which is the baseline of a crossing: `null` for a staff actor with none (every hub it reads is foreign),
   * `undefined` for a vendor or a rider, whose reads are not hub-scoped and cross no hub.
   */
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
