import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';
import { afterCountsOf } from './hub-after-count.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagOf } from './hub-intake-etag.js';
import { INTAKE_STATES } from './hub-intake-schemas.js';
import {
  HUB_INTAKE_READ_COLUMNS,
  hubIntakeViewOf,
  type HubIntakeRow,
  type HubIntakeView,
} from './hub-intake-view.js';

export interface HubIntakesOptions {
  readonly runner: Pick<OperationRunner, 'read' | 'mutate'>;
  readonly audit: AuditWriter;
}

/** What `listHubIntakes` takes from the query, as it was sent: the service judges it. */
export interface HubIntakeFilter {
  readonly state?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface HubIntakePage {
  readonly items: readonly HubIntakeView[];
  readonly next_page_token: string | null;
}

/** The two reads open one `REPEATABLE READ` transaction: the rows, the declaration of the ones that have been counted and the audit of a crossing are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });

/**
 * The intake is Ops's: the guard serves these operations to the Ops Portal's staff under `hub.read` and `hub.intake.count`, and a service that answers about records does not rely on
 * that alone (as the lists of the pickup do not): a Vendor or a Rider is refused here before anything is judged or read.
 */
function refuseNotStaff(authorized: AuthorizedRequest): void {
  if (authorized.session.principalType !== 'STAFF') {
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}

interface ListedRow extends HubIntakeRow {
  /** The moment the list is ordered by, as text, so that no precision is lost in the position of the next page. */
  readonly position_text: string;
}

/** What the lock statement answers: the intake, and whether the caller may take the lock now. */
interface LockableRow extends HubIntakeRow {
  readonly lockable: boolean;
}

/**
 * `listHubIntakes`, `getHubIntake` and `acquireIntakeLock` (S1.32; `hub.read`, `hub.read` and `hub.intake.count`; `AC-SLICE-001-37`, `-43` and `-77`; features/hub/hub-intake.md section 5.1
 * steps 2 and 3; state-machines.md section 7; `MSC-DEC-416`).
 *
 * - **The declaration is not served before the count commits, in any read** (`AC-SLICE-001-37`, `-77`). An intake that has not been counted is built by `hubIntakePreCountOf`, from the named
 *   columns of the row: the application's login cannot read the declaration (migration `0092`) and no statement here names it. An intake that has been counted is `HubIntakePostCount`,
 *   whose declaration the database's own function answers (`melarc.hub_intake_declarations`, migration `0093`) for those rows and no others. No read of this class carries a parcel photo or
 *   their number: nothing in these statements reads the evidence of a collection (`AC-SLICE-001-89`).
 * - **The scope is row-level security and the scope probe, nothing the use case writes.** The statements run in the caller's own context under the authorizing key: staff see the
 *   intakes of the hubs of the grant, a vendor and a rider none. The record a route names is found or refused by the guard before this runs (`HUB_SCOPE_VIOLATION` for a staff caller on an
 *   intake of another hub, `NOT_FOUND` for an id that matches nothing). **An authorised staff read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6).
 * - **The queue is oldest first, then the id** (the order of arrival, `handed_over_at`, which the database gave the run's completion), so that a page does not move under a reader who is
 *   paging; the token is that position and nothing else. `state=AWAITING_COUNT` is the awaiting-receive queue.
 * - **The ETag of `getHubIntake` is the digest of the facts the read returned and of the version, and not of the lock** (`hub-intake-etag.ts`), so that the count of S1.33 takes it back as
 *   `If-Match` and a lock that moves under the receiver never refuses it.
 * - **The lock is advisory and nothing here treats it as a guard** (§22.8, `AC-SLICE-001-43`). `acquireIntakeLock` takes it when no receiver holds it, when the caller holds it already
 *   (a refresh), or when the holder has been idle for the hub's time (`intake_lock_idle_ttl_minutes`, judged by the database on its own clock; a hub with no usable value offers no
 *   takeover); otherwise nothing changes and the intake comes back showing who holds it. It is refused for no other reason: two receivers who both count get one success and one
 *   `STATE_CONFLICT` whatever the lock says (S1.33). An intake that has been counted is shown as it is, and no lock is taken on it.
 */
export class HubIntakes {
  readonly #options: HubIntakesOptions;

  constructor(options: HubIntakesOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: HubIntakeFilter,
  ): Promise<HubIntakePage> {
    refuseNotStaff(authorized);
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalid('page_token', 'format');
    }
    // A filter is judged as it was sent: a value that is not a state is a validation failure naming the parameter, and not an empty queue that would hide the mistake.
    if (
      filter.state !== undefined &&
      !(INTAKE_STATES as readonly string[]).includes(filter.state)
    ) {
      throw invalid('state', 'enum');
    }
    const state = filter.state ?? null;
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const result = await tx.execute(sql`
          select ${HUB_INTAKE_READ_COLUMNS}, handed_over_at::text as position_text
            from pickup_intake
           where (${state}::text is null or state = ${state}::text)
             and (${afterMoment}::timestamptz is null or (handed_over_at, id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
           order by handed_over_at, id
           limit ${size + 1}`);
        const read = result.rows as unknown as ListedRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent (never the row that only says whether another page follows) and that are not the actor's own: one bounded event for each, in the
        // order of the hubs' ids, naming the hub and the operation.
        const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
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
            relatedIds: { operation_id: 'listHubIntakes' },
          });
        }
        const after = await afterCountsOf(tx, page);
        const last = page.at(-1);
        return {
          items: page.map((row) => hubIntakeViewOf(row, after.get(row.id))),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{ readonly intake: HubIntakeView; readonly etag: string }> {
    refuseNotStaff(authorized);
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const found = await tx.execute(
          sql`select ${HUB_INTAKE_READ_COLUMNS} from pickup_intake where id = ${id}::uuid`,
        );
        const row = found.rows[0] as unknown as HubIntakeRow | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        await noteHubCrossing(this.#options.audit, handle, authorized, row);
        const after = await afterCountsOf(tx, [row]);
        const intake = hubIntakeViewOf(row, after.get(row.id));
        return { intake, etag: hubIntakeEtagOf(intake, row.version) };
      },
      ONE_SNAPSHOT,
    );
  }

  async acquireLock(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<HubIntakeView> {
    refuseNotStaff(authorized);
    const receiver = authorized.session.principalId.toLowerCase();
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      // The intake under its lock, and the database's judgement of whether this caller may take the lock now: free, its own, or held past the hub's idle time on the database's clock (the
      // same reading the guard of the table makes for every writer, from the same setting). The row lock orders two receivers who ask at once: the second is judged against the first's.
      const found = await tx.execute(sql`
        select ${HUB_INTAKE_READ_COLUMNS},
               (i.active_receiver_id is null
                or i.active_receiver_id = ${receiver}::uuid
                or (t.minutes is not null and i.lock_acquired_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => t.minutes))) as lockable
          from pickup_intake as i
         cross join lateral (select melarc.intake_lock_idle_ttl_minutes(i.responsible_hub_id) as minutes) as t
         where i.id = ${id}::uuid
           for update of i`);
      let row = found.rows[0] as unknown as LockableRow | undefined;
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      await noteHubCrossing(this.#options.audit, handle, authorized, row);
      if (row.state === 'AWAITING_COUNT' && row.lockable) {
        const taken = await tx.execute(sql`
          update pickup_intake
             set active_receiver_id = ${receiver}::uuid, lock_acquired_at = pg_catalog.clock_timestamp()
           where id = ${id}::uuid
          returning ${HUB_INTAKE_READ_COLUMNS}`);
        const updated = taken.rows[0] as unknown as HubIntakeRow | undefined;
        if (updated === undefined) throw new Error('The lock of an intake could not be taken');
        row = { ...updated, lockable: true };
      }
      const after = await afterCountsOf(tx, [row]);
      return hubIntakeViewOf(row, after.get(row.id));
    });
  }
}
