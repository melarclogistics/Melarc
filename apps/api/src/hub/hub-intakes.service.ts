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
import { noteHubCrossing } from './hub-crossing.js';
import { INTAKE_STATES } from './hub-intake-schemas.js';
import type { HubIntakeView } from './hub-intake-view.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  type HubIntakeCheckInView,
  type LoadedIntakes,
  type ReceivingIntakeRow,
} from './receiving-views.js';

export interface HubIntakesOptions {
  readonly runner: Pick<OperationRunner, 'read' | 'mutate'>;
  readonly audit: AuditWriter;
}

/** What `listHubIntakes` takes from the query, as it was sent: the service judges it. */
export interface HubIntakeFilter {
  readonly state?: string;
  /** `needs_senior` (D-S7-7, narrowed by D-S7-11): the vendors sent back to review by an arrival a senior took back. The only view there is; any other text is `VALIDATION_FAILED`. */
  readonly view?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

/** An intake as a read answers it: a photo intake is `HubIntakeCheckIn` (the door photos are the receiving officer's reference, D-D1), a blind-count intake `HubIntakePreCount` and then `HubIntakePostCount`. */
export type HubIntakeShape = HubIntakeView | HubIntakeCheckInView;

/**
 * What a vendor's row of Orders to make says besides the vendor (D-S7-6 and D-S7-7), for the vendors in the states where orders are made: how many orders stand, how many received parcels still need one (null while a
 * blind count is not committed: nothing is known to have been received), and why a senior officer is needed, if one is. Only `listHubIntakes` carries it.
 */
export interface QueueFacts {
  readonly orders_made?: number;
  readonly parcels_needing_order?: number | null;
  readonly senior_needed?: 'ARRIVAL_TAKEN_BACK';
}

/** The states a vendor is in while orders are made for it, or sent back by an arrival that was taken back: the rows that carry the counts. */
const ORDER_QUEUE_STATES: readonly string[] = [
  'READY_FOR_ITEMIZATION',
  'ITEMIZING',
  'RECONCILIATION_REQUIRED',
];

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

export interface HubIntakePage {
  readonly items: readonly (HubIntakeShape & QueueFacts)[];
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

interface ListedRow extends ReceivingIntakeRow {
  /** The moment the list is ordered by, as text, so that no precision is lost in the position of the next page. */
  readonly position_text: string;
}

/** What the lock statement answers: the intake, and whether the caller may take the lock now. */
interface LockableRow extends ReceivingIntakeRow {
  readonly lockable: boolean;
}

/** The shape one intake is answered in, from what `loadIntakes` loaded for it: its third shape for a photo intake, its own two for a blind-count one. */
function shapeOf(loaded: LoadedIntakes, row: ReceivingIntakeRow): HubIntakeShape {
  const shape = loaded.checkIns.get(row.id)?.view ?? loaded.blind.get(row.id)?.view;
  if (shape === undefined) throw new Error('An intake is loaded in one of its shapes');
  return shape;
}

const etagOf = (loaded: LoadedIntakes, row: ReceivingIntakeRow): string => {
  const etag = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
  if (etag === undefined) throw new Error('An intake is loaded in one of its shapes');
  return etag;
};

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
    if (filter.view !== undefined && filter.view !== 'needs_senior') throw invalid('view', 'enum');
    const state = filter.state ?? null;
    const view = filter.view ?? null;
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const result = await tx.execute(sql`
          select ${RECEIVING_INTAKE_COLUMNS}, handed_over_at::text as position_text
            from pickup_intake
           where (${state}::text is null or state = ${state}::text)
             and (${view}::text is null or (state = 'RECONCILIATION_REQUIRED' and melarc.intake_senior_needed(id) is not null))
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
        const loaded = await loadIntakes(tx, page, authorized.session.principalId.toLowerCase());
        const last = page.at(-1);
        // The counts of the vendors whose orders are made, from the database's own count of the whole intake, in one statement for the page (and the reason a senior is needed, for the ones that need one).
        const queued = page.filter((row) => ORDER_QUEUE_STATES.includes(row.state));
        const facts = new Map<string, QueueFacts>();
        if (queued.length > 0) {
          const counted = await tx.execute(sql`
            select u.id, g.orders, g.needs_order, melarc.intake_senior_needed(u.id) as senior_needed
              from unnest(${uuidArray(queued.map((row) => row.id))}) as u(id)
             cross join lateral melarc.intake_progress(u.id) as g`);
          for (const row of counted.rows as unknown as {
            id: string;
            orders: number | string;
            needs_order: number | string | null;
            senior_needed: 'ARRIVAL_TAKEN_BACK' | null;
          }[]) {
            facts.set(row.id, {
              orders_made: Number(row.orders),
              parcels_needing_order: row.needs_order === null ? null : Number(row.needs_order),
              ...(row.senior_needed === null ? {} : { senior_needed: row.senior_needed }),
            });
          }
        }
        return {
          items: page.map((row) => ({ ...shapeOf(loaded, row), ...facts.get(row.id) })),
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
  ): Promise<{ readonly intake: HubIntakeShape; readonly etag: string }> {
    refuseNotStaff(authorized);
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const found = await tx.execute(
          sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid`,
        );
        const row = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        await noteHubCrossing(this.#options.audit, handle, authorized, row);
        const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
        return { intake: shapeOf(loaded, row), etag: etagOf(loaded, row) };
      },
      ONE_SNAPSHOT,
    );
  }

  async acquireLock(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<HubIntakeShape> {
    refuseNotStaff(authorized);
    const receiver = authorized.session.principalId.toLowerCase();
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      // The intake under its lock, and the database's judgement of whether this caller may take the lock now: free, its own, or held past the hub's idle time on the database's clock (the
      // same reading the guard of the table makes for every writer, from the same setting). The row lock orders two receivers who ask at once: the second is judged against the first's.
      const found = await tx.execute(sql`
        select ${RECEIVING_INTAKE_COLUMNS},
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
          returning ${RECEIVING_INTAKE_COLUMNS}`);
        const updated = taken.rows[0] as unknown as ReceivingIntakeRow | undefined;
        if (updated === undefined) throw new Error('The lock of an intake could not be taken');
        row = { ...updated, lockable: true };
      }
      const loaded = await loadIntakes(tx, [row], receiver);
      return shapeOf(loaded, row);
    });
  }
}
