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
import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import { pickupManifestCriteria } from './pickup-manifest-criteria.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  stopViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
  type PickupStopView,
} from './pickup-manifest-view.js';
import { isCalendarDay } from './calendar-day.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';
import { PICKUP_MANIFEST_STATES } from './pickup-manifest.schema.js';

export type { PickupManifestView, PickupStopView };

/** A stop as its read returns it: the columns of the representation, the version its token is made of, and the hub it is judged against. */
interface StopReadRow extends PickupStopRow {
  readonly version: number;
  readonly responsible_hub_id: string;
}

export interface PickupManifestListFilter {
  readonly pageSize?: number;
  readonly pageToken?: string;
  /** Only the manifests in this state (OB-S1-25); one of the five, exactly. */
  readonly state?: string;
  /** Only the manifests worked on this day (OB-S1-25): `YYYY-MM-DD`, a day that exists. */
  readonly serviceDate?: string;
  /** Only the manifests of this hub (task C3, `AC-HUBF-02`): a filter that narrows what the caller may read and never widens it. */
  readonly hubId?: string;
}

export interface PickupManifestsServiceOptions {
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
 * What a Rider owns, **named in the statement** (task A1): `assigned_rider_id = melarc.current_rider_id()`, the test its row-level-security policy
 * applies (beside `dispatched_at IS NOT NULL`, which stays the policy's). The policy is one `CASE` expression, which the planner cannot use as an index
 * condition, so a statement that names a hub reads the hub's runs through `pickup_manifest_hub_idx` and lets the policy discard every one that is not
 * the Rider's: 50 milliseconds for a hub of 20,000 runs, and a Rider that asks for a hub where it has no run can tell from the time that the hub
 * exists and how much it holds. With the Rider named in the statement, the planner starts from `pickup_manifest_rider_idx` (the Rider's own runs, and
 * the hub is a filter on them): 0.06 milliseconds at that scale, whatever the hub holds. It only restates the policy, which still decides; it can
 * narrow and never widen. A staff session adds nothing (`true` is dropped by the planner).
 */
function ownedByCaller(authorized: AuthorizedRequest): SQL {
  return authorized.session.principalType === 'RIDER'
    ? sql`assigned_rider_id = melarc.current_rider_id()`
    : sql`true`;
}

/**
 * `getPickupManifest` and `listPickupManifests` (S1.20; `pickup.read`; `AC-SLICE-001-11`; domain-model.md sections 6.3 and 6.4).
 *
 * - **The scope is row-level security and the scope probe, nothing the use case writes.** The reads run in the caller's own context with
 *   the authorizing key: a staff member sees the manifests of the hubs of the grant, a rider only the manifests **assigned to it that have
 *   been dispatched** (assignment, never the hub, and from dispatch, never while a draft), a vendor none. The record a route names is found
 *   or refused by the guard before this runs (`HUB_SCOPE_VIOLATION` by the scope probe for a staff caller on a manifest of another hub,
 *   `NOT_FOUND` for everyone else and for an id that matches nothing: a rider is never told that a colleague's run exists, `AC-SLICE-001-79`
 *   in the same code path as for a request); a manifest that has gone since is `NOT_FOUND` here.
 * - **An authorised staff read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as the request
 *   reads are: one `auth.hub_boundary.crossed` for a manifest of another hub, and one for each foreign hub the **rows of a list** represent.
 *   A list of the rows the caller is authorised to see, none of which is outside its hubs, writes nothing: it is not an attempt on a hub.
 * - **The ETag is the digest of what the read returned**, the stops in their order included, and of the manifest's version
 *   (`pickup-manifest-etag.ts`); a list carries none and shows no stops.
 * - **A stop shows what the stops' acts have written, and no `pickup_summary`**: what a rider is shown at the door is a required dependency
 *   of dispatch (OB-S1-21), and no manifest is visible to a rider before it is dispatched.
 * - **The list is ordered by the moment of creation, then the id**, so that a page does not move under a reader who is paging, and is paged
 *   by the opaque position of the pickup request's list.
 * - **A hub outside a staff session's set of hubs is answered with no transaction and no statement** (task A1, `AC-HUBF-05`): the database would
 *   walk that hub's index before row-level security discarded every row, and the time that takes tells a caller whether the hub exists and how
 *   much it holds. A hub inside the grant and an all-hub grant read as before. A rider's statement **names its own assignment**
 *   (`ownedByCaller`), so that the database starts from the rider's index and not the hub's and a foreign hub costs what the rider's own runs cost.
 */
export class PickupManifestsService {
  readonly #options: PickupManifestsServiceOptions;

  constructor(options: PickupManifestsServiceOptions) {
    this.#options = options;
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{ readonly manifest: PickupManifestView; readonly etag: string }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const found = await tx.execute(
          sql`select ${MANIFEST_COLUMNS} from pickup_manifest where id = ${id}::uuid`,
        );
        const row = found.rows[0] as unknown as PickupManifestRow | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const stops = await tx.execute(sql`
          select ${STOP_COLUMNS} from pickup_stop
           where pickup_manifest_id = ${row.id}::uuid
           order by sequence, id`);
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined && row.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'PickupManifest', id: row.id },
            responsibleHubId: row.responsible_hub_id,
          });
        }
        const view = manifestViewOf(row, stops.rows as unknown as PickupStopRow[]);
        return { manifest: view, etag: pickupManifestEtagOf(view, row.version) };
      },
      ONE_SNAPSHOT,
    );
  }

  /**
   * `getPickupStop` (S1.22; `pickup.read`): one stop, and **the `ETag` the stop's operations take as `If-Match`** (collection, failure and
   * skip build on it; the arrival hands back the same token for the stop it moved). It is the stop of the manifest read, from the same
   * function (`stopViewOf`) and so with the same closed projection: a rider's stop detail has exactly the privacy boundary of its manifest
   * read, and nothing of the request, the vendor, the payer or the price is added to it.
   *
   * The scope is row-level security and the scope probe, as for the manifest: a staff member sees the stops of the hubs of the grant and a
   * rider only the stops of the runs **assigned to it and dispatched** (assignment, never the hub); a vendor none (the vendor's read of its own
   * stop is a deferred capability, OB-S1-23). The route's guard tells `HUB_SCOPE_VIOLATION` (a staff caller, a stop of another hub) from the
   * rest; for everyone else, a colleague's stop, a draft's, a stop of a run cancelled before it went out and an id that matches nothing are
   * **one answer**, `NOT_FOUND`. An authorised staff read outside the actor's own hub is audited, without contents.
   */
  async getStop(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{ readonly stop: PickupStopView; readonly etag: string }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const found = await transactionOf(handle).execute(sql`
          select ${STOP_COLUMNS}, version, responsible_hub_id from pickup_stop where id = ${id}::uuid`);
        const row = found.rows[0] as unknown as StopReadRow | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined && row.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'PickupStop', id: row.id },
            responsibleHubId: row.responsible_hub_id,
          });
        }
        const view = stopViewOf(row);
        return { stop: view, etag: pickupStopEtagOf(view, row.version) };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: PickupManifestListFilter,
  ): Promise<{
    readonly items: readonly PickupManifestView[];
    readonly next_page_token: string | null;
  }> {
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined)
      throw invalid('page_token', 'format');

    // A filter is judged as it was sent: a value that is not one is a validation failure naming the parameter, and not an empty list that would hide
    // the mistake.
    if (
      filter.state !== undefined &&
      !(PICKUP_MANIFEST_STATES as readonly string[]).includes(filter.state)
    ) {
      throw invalid('state', 'enum');
    }
    if (filter.serviceDate !== undefined && !isCalendarDay(filter.serviceDate)) {
      throw invalid('service_date', 'format');
    }
    // The hub is a filter, as the others are: judged as it was sent, and added to the one statement. It is never put in the security context, so a
    // hub outside the reader's grant (or none at all) is an empty page and never `HUB_SCOPE_VIOLATION` (task C3, `AC-HUBF-02`, `-06`).
    if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalid('hub_id', 'format');
    // A hub the staff session's grant does not reach is an empty page and **no transaction, no statement** (task A1, `AC-HUBF-05`): the database
    // would walk that hub's index and discard every row, and how long that takes says whether the hub exists and how much it holds. The answer is
    // the one row-level security gives, since `authorized.scope` is the very set the transaction would run under; a hub that does not exist takes
    // the same path, and so the same time. A rider's runs are scoped by assignment, not by a hub, and are read as they were.
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }
    // What the list contains is written once, in `pickupManifestCriteria`, which the count of the runs in progress calls as well (task C1).
    const criteria = pickupManifestCriteria({
      state: filter.state ?? null,
      serviceDate: filter.serviceDate ?? null,
      hubId: filter.hubId ?? null,
    });
    const owned = ownedByCaller(authorized);
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
          select ${MANIFEST_COLUMNS} from pickup_manifest
           where ${criteria}
             and ${owned}
             and (${afterMoment}::timestamptz is null or (created_at, id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
           order by created_at, id
           limit ${size + 1}`);
        const read = result.rows as unknown as PickupManifestRow[];
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
              relatedIds: { operation_id: 'listPickupManifests' },
            });
          }
        }
        const last = page.at(-1);
        return {
          items: page.map((row) => manifestViewOf(row)),
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
   * `undefined` for a rider, whose reads are not hub-scoped and cross no hub.
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
