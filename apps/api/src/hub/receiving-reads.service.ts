import { sql } from 'drizzle-orm';

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
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  namesOf,
  vendorViewOf,
  type ReceivingIntakeRow,
  type ReceivingVendorView,
} from './receiving-views.js';

export interface ReceivingReadsOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** What the lists take from the query, as it was sent: the service judges it. */
export interface ReceivingListFilter {
  readonly hubId?: string;
  readonly q?: string;
  readonly view?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface ReceivingRunSummaryView {
  readonly run_id: string;
  readonly run_code: string;
  readonly hub_id: string;
  readonly hub_name: string;
  readonly rider_name: string;
  readonly vendor_names: readonly string[];
  readonly vendors_total: number;
  readonly vendors_waiting: number;
  readonly vendors_needing_decision: number;
  readonly blind_count_vendors: number;
  readonly parcels_expected: number;
  readonly missing_searching: number;
  readonly handed_over_at: string;
  readonly checking_in: readonly { readonly name: string; readonly is_you: boolean }[];
}

export interface ReceivingRunView {
  readonly run: {
    readonly id: string;
    readonly code: string;
    readonly hub_id: string;
    readonly hub_name: string;
    readonly service_date: string;
  };
  readonly rider_name: string;
  readonly handed_over_at: string;
  readonly vendors: readonly ReceivingVendorView[];
}

export interface MissingParcelView {
  readonly parcel_id: string;
  readonly photo_evidence_id: string;
  readonly intake_id: string;
  readonly intake_code: string;
  readonly run_id: string;
  readonly run_code: string;
  readonly vendor_name: string;
  readonly missing_since: string;
  readonly written_off_at: string | null;
}

export interface ReceivingPage<T> {
  readonly items: readonly T[];
  readonly next_page_token: string | null;
}

/** The two reads open one `REPEATABLE READ` transaction: the rows, the names and the audit of a crossing are one picture of the data. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

const NAME_MISSING = '(name not available)';

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });

/** The receiving side is Ops's: a Vendor or a Rider is refused here before anything is judged or read, as the guard refuses them first. */
function refuseNotStaff(authorized: AuthorizedRequest): void {
  if (authorized.session.principalType !== 'STAFF') {
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}

interface RunRow {
  readonly run_id: string;
  readonly run_code: string;
  readonly hub_id: string;
  readonly hub_name: string;
  readonly service_date: string;
  readonly rider_id: string;
  readonly handed_over_at: string | Date;
  readonly position_text: string;
  readonly vendors_total: number;
  readonly vendors_waiting: number;
  readonly vendors_needing_decision: number;
  readonly blind_count_vendors: number;
  readonly parcels_expected: number;
  readonly missing_searching: number;
}

interface MissingRow {
  readonly parcel_id: string;
  readonly photo_evidence_id: string;
  readonly intake_id: string;
  readonly intake_code: string;
  readonly run_id: string;
  readonly run_code: string;
  readonly hub_id: string;
  readonly vendor_name: string | null;
  readonly missing_since: string | Date;
  readonly written_off_at: string | Date | null;
  readonly position_text: string;
}

const isoOf = (value: string | Date): string => new Date(value).toISOString();

/** Judges the paging and the hub filter of a list as they were sent, before anything is read. */
function judged(filter: ReceivingListFilter): {
  readonly size: number;
  readonly afterAt: string | null;
  readonly afterId: string | null;
} {
  const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw invalid('page_size', 'range');
  }
  const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
  if (filter.pageToken !== undefined && after === undefined) throw invalid('page_token', 'format');
  if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalid('hub_id', 'format');
  return { size, afterAt: after?.createdAt ?? null, afterId: after?.id ?? null };
}

/** An authorised staff read of a hub that is not the actor's own is audited without contents (audit.md sections 5.4 and 6): one event for each foreign hub the answer represents. */
async function noteForeignHubs(
  audit: AuditWriter,
  handle: TransactionHandle,
  authorized: AuthorizedRequest,
  hubs: readonly string[],
  operation: string,
): Promise<void> {
  const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
  const foreign = [...new Set(hubs.filter((hub) => hub !== baseline))].toSorted();
  for (const hubId of foreign) {
    await audit.write(handle, {
      code: 'auth.hub_boundary.crossed',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'HUB', id: hubId },
      responsibleHubId: hubId,
      relatedIds: { operation_id: operation },
    });
  }
}

/**
 * `listReceivingRuns`, `getReceivingRun` and `listMissingParcels` (Run D, S1.35b; `hub.read`; features/hub/hub-intake.md sections 5.1 and 5.6 to 5.7; `AC-SLICE-001-92`, `-97`, `-99`): the receiving side's
 * reads by run.
 *
 * - **One criteria for the list and for its count.** The queue by run and the missing parcels are each ONE function of the database (`melarc.receiving_runs`, `melarc.missing_parcels`, migration 0107),
 *   which `getQueueSummary` calls for the counts of the two queues, so that a count is what its list returns and the two cannot drift. The hub is a statement parameter that narrows and never widens: a hub
 *   outside the grant is an empty page with **no transaction and no statement**.
 * - **Names, never numbers.** A rider, a vendor and an officer are said by display name (`melarc.receiving_names`); no phone number is read by any statement here, and a blind-count vendor is counted and
 *   given no number of the rider's (D-D3): its expected number is `null`.
 * - **An authorised read of another hub is audited, without contents**, once for each foreign hub the answer represents, as every staff read is.
 */
export class ReceivingReads {
  readonly #options: ReceivingReadsOptions;

  constructor(options: ReceivingReadsOptions) {
    this.#options = options;
  }

  async listRuns(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: ReceivingListFilter,
  ): Promise<ReceivingPage<ReceivingRunSummaryView>> {
    refuseNotStaff(authorized);
    const { size, afterAt, afterId } = judged(filter);
    const view = filter.view ?? 'waiting';
    if (!['waiting', 'needs_decision', 'all'].includes(view)) throw invalid('view', 'enum');
    let q: string | null = null;
    if (filter.q !== undefined) {
      const trimmed = filter.q.trim();
      if (trimmed.length < 2 || trimmed.length > 64) throw invalid('q', 'length');
      q = trimmed;
    }
    // A hub outside the grant, or one that does not exist, is an empty page and no statement (task A1): the time of the answer tells nothing of whether the hub exists.
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }
    const hubId = filter.hubId ?? null;
    const caller = authorized.session.principalId.toLowerCase();
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const result = await tx.execute(sql`
          select r.*, r.handed_over_at::text as position_text, r.service_date::text as service_date
            from melarc.receiving_runs(${hubId}::uuid, ${view}::text, ${q}::text, ${afterAt}::timestamptz, ${afterId}::uuid, ${size + 1}::integer) as r`);
        const read = result.rows as unknown as RunRow[];
        const page = read.slice(0, size);
        await noteForeignHubs(
          this.#options.audit,
          handle,
          authorized,
          page.map((row) => row.hub_id),
          'listReceivingRuns',
        );
        // The intakes of the runs of the page: their vendors, and who holds the lock of a vendor that is still waiting.
        const runIds = page.map((row) => row.run_id);
        const intakes =
          runIds.length === 0
            ? []
            : ((
                await tx.execute(sql`
                  select id, pickup_manifest_id, active_receiver_id, state, handed_over_by
                    from pickup_intake
                   where pickup_manifest_id = any(array[${sql.join(
                     runIds.map((id) => sql`${id}::uuid`),
                     sql`, `,
                   )}]::uuid[])
                   order by handed_over_at, id`)
              ).rows as unknown as {
                id: string;
                pickup_manifest_id: string;
                active_receiver_id: string | null;
                state: string;
                handed_over_by: string;
              }[]);
        const book = await namesOf(
          tx,
          intakes.map((intake) => intake.id),
        );
        const items = page.map((row): ReceivingRunSummaryView => {
          const own = intakes.filter((intake) => intake.pickup_manifest_id === row.run_id);
          const holders = [
            ...new Set(
              own
                .filter(
                  (intake) =>
                    intake.state === 'AWAITING_COUNT' && intake.active_receiver_id !== null,
                )
                .map((intake) => intake.active_receiver_id as string),
            ),
          ];
          return {
            run_id: row.run_id,
            run_code: row.run_code,
            hub_id: row.hub_id,
            hub_name: row.hub_name,
            rider_name: book.rider.get(row.rider_id) ?? NAME_MISSING,
            vendor_names: own.map((intake) => book.vendor.get(intake.id) ?? NAME_MISSING),
            vendors_total: row.vendors_total,
            vendors_waiting: row.vendors_waiting,
            vendors_needing_decision: row.vendors_needing_decision,
            blind_count_vendors: row.blind_count_vendors,
            parcels_expected: row.parcels_expected,
            missing_searching: row.missing_searching,
            handed_over_at: isoOf(row.handed_over_at),
            checking_in: holders.map((holder) => ({
              name: book.staff.get(holder) ?? NAME_MISSING,
              is_you: holder.toLowerCase() === caller,
            })),
          };
        });
        const last = page.at(-1);
        return {
          items,
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.run_id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  async getRun(
    authorized: AuthorizedRequest,
    correlationId: string,
    manifestId: string,
  ): Promise<ReceivingRunView> {
    refuseNotStaff(authorized);
    const caller = authorized.session.principalId.toLowerCase();
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const found = await tx.execute(sql`
          select r.*, r.service_date::text as service_date
            from melarc.receiving_runs(null::uuid, 'all'::text, null::text, null::timestamptz, null::uuid, 1::integer, ${manifestId}::uuid) as r`);
        const run = found.rows[0] as unknown as RunRow | undefined;
        if (run === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        await noteForeignHubs(
          this.#options.audit,
          handle,
          authorized,
          [run.hub_id],
          'getReceivingRun',
        );
        // The vendors are in the order the handover opened them (the contract's order): every intake of a run has the moment the run completed, so the identifier orders them, and the handover draws the
        // identifiers in the order of its rows (`orderedUUIDv7`). A total order, the same at every read.
        const intakes = (
          await tx.execute(sql`
            select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where pickup_manifest_id = ${manifestId}::uuid order by handed_over_at, id`)
        ).rows as unknown as ReceivingIntakeRow[];
        const loaded = await loadIntakes(tx, intakes, caller);
        return {
          run: {
            id: run.run_id,
            code: run.run_code,
            hub_id: run.hub_id,
            hub_name: run.hub_name,
            service_date: run.service_date,
          },
          rider_name: loaded.book.rider.get(run.rider_id) ?? NAME_MISSING,
          handed_over_at: isoOf(run.handed_over_at),
          vendors: intakes.map((intake) => vendorViewOf(intake, loaded, caller)),
        };
      },
      ONE_SNAPSHOT,
    );
  }

  async listMissing(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: ReceivingListFilter,
  ): Promise<ReceivingPage<MissingParcelView>> {
    refuseNotStaff(authorized);
    const { size, afterAt, afterId } = judged(filter);
    const view = filter.view ?? 'searching';
    if (!['searching', 'vendor_to_tell'].includes(view)) throw invalid('view', 'enum');
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }
    const hubId = filter.hubId ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const result = await tx.execute(sql`
          select m.*, m.missing_since::text as position_text
            from melarc.missing_parcels(${hubId}::uuid, ${view}::text, ${afterAt}::timestamptz, ${afterId}::uuid, ${size + 1}::integer) as m`);
        const read = result.rows as unknown as MissingRow[];
        const page = read.slice(0, size);
        await noteForeignHubs(
          this.#options.audit,
          handle,
          authorized,
          page.map((row) => row.hub_id),
          'listMissingParcels',
        );
        const last = page.at(-1);
        return {
          items: page.map((row): MissingParcelView => ({
            parcel_id: row.parcel_id,
            photo_evidence_id: row.photo_evidence_id,
            intake_id: row.intake_id,
            intake_code: row.intake_code,
            run_id: row.run_id,
            run_code: row.run_code,
            vendor_name: row.vendor_name ?? NAME_MISSING,
            missing_since: isoOf(row.missing_since),
            written_off_at: row.written_off_at === null ? null : isoOf(row.written_off_at),
          })),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.parcel_id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }
}
