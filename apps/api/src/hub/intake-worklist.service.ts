import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';
import { NOT_AVAILABLE, namesOf } from './receiving-views.js';

export interface IntakeWorklistOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** What the list takes from the query, as it was sent: the service judges it. */
export interface WorklistFilter {
  readonly view?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export const WORKLIST_VIEWS = [
  'all',
  'needs_order',
  'awaiting_arrival',
  'prepared',
  'itemized',
  'payment_required',
  'missing',
  'waiting_for_vendor',
] as const;

/** The state of a parcel and its order, as one: the officer's next action in a word. */
export type WorkState = 'NEEDS_ORDER' | 'AWAITING_ARRIVAL' | 'PREPARED' | 'ITEMIZED' | 'MISSING';

/**
 * The counts of the whole intake, never of a page. **Each count is the number of rows the view of its name opens** (`awaiting_arrival` is every parcel still expected, whether or not an order was made for it
 * early, and so can also be counted in `prepared`; the review of 20 November 2026, finding 5). `received` and `needs_order` are null for an intake counted blind whose count is not committed: nothing is known
 * to have been received, which is not zero.
 */
export interface IntakeProgressView {
  readonly received: number | null;
  readonly awaiting_arrival: number;
  readonly needs_order: number | null;
  readonly prepared: number;
  readonly itemized: number;
  readonly payment_required: number;
  readonly missing: number;
  readonly orders: number;
  /** The parcels the officer is waiting on the vendor's details for (D-S7-12): a live mark on a parcel that still needs its order, the rows the view `waiting_for_vendor` opens; zero for a vendor counted blind. */
  readonly waiting_for_vendor: number;
}

/** One row of the worklist: a parcel, the order made for it, and their state together. **No price, no portion and no phone**: the money is `getOrder`'s, under `pricing.read`. */
export interface WorklistRowView {
  readonly work_state: WorkState;
  readonly parcel: {
    readonly id: string;
    readonly ordinal: number;
    readonly origin: string;
    readonly state: string;
    readonly door_photo_evidence_id: string | null;
    readonly hub_photo_evidence_id: string | null;
    /** The officer is waiting on the vendor's details for this parcel (D-S7-12): since when, and the officer's note; null when it is not waiting. */
    readonly waiting_for_vendor: { readonly since: string; readonly note: string | null } | null;
  } | null;
  /** The order of this parcel whose arrival was reversed, kept as history (its locked price and trail are `getOrder`'s): the parcel may stand with another order now. */
  readonly reversed_order: { readonly id: string; readonly code: string } | null;
  readonly order: {
    readonly id: string;
    readonly code: string;
    readonly recipient_name: string | null;
    readonly service_area: string | null;
    readonly size_class: string;
    readonly commercial_state: string | null;
    readonly confirmed: boolean;
    readonly payment_required: boolean;
  } | null;
}

export interface IntakeWorklistView {
  readonly intake_id: string;
  readonly intake_state: string;
  readonly receiving_mode: string;
  readonly progress: IntakeProgressView;
  readonly items: readonly WorklistRowView[];
  readonly next_page_token: string | null;
}

/**
 * What a close would find, read before the act that cannot be taken back. `outstanding_parcels` names the first hundred by their place (a display limit: the whole outstanding count is `outstanding_count`
 * and every parcel is reached through the worklist's `needs_order` view, a page at a time), and **`assessment_token` covers every one of them**.
 */
export interface ClosureAssessmentView {
  readonly intake_id: string;
  readonly intake_state: string;
  readonly receiving_mode: string;
  /** Null for an intake counted blind whose count is not committed. */
  readonly received: number | null;
  readonly ordered: number;
  readonly unpriced: number;
  readonly payment_required: number;
  readonly missing: number;
  readonly outstanding_count: number | null;
  /** The orders there are beyond the parcels the hub received (a blind count with more orders than its count): never closed over, with the exception or without it. Zero for a photo intake. */
  readonly excess_count: number;
  /** The digest of the assessment, which the approved exception is closed against (`closeHubIntake`, `reviewed_assessment`). */
  readonly assessment_token: string;
  readonly outstanding_parcels: readonly {
    readonly parcel_id: string;
    readonly ordinal: number;
    readonly origin: string;
    readonly door_photo_evidence_id: string | null;
    readonly hub_photo_evidence_id: string | null;
  }[];
  readonly closed_at: string | null;
  readonly parity_exception_note: string | null;
  /** Whether the intake can be closed now, with no exception. */
  readonly can_close: boolean;
  /** Whether it can be closed only by the approved exception (the orders are not as many as the parcels received). */
  readonly needs_exception: boolean;
  /** What stops a close now, by rule name: `intake_not_ready`, `orders_exceed_received`, `order_unpriced`. Empty when the close, or the exception, is open. */
  readonly blockers: readonly string[];
  /** Always true while any order awaits payment: closing the intake is not payment clearance and not a dispatch authorization. */
  readonly payment_still_required: boolean;
}

interface WorklistRow {
  readonly n: string | number;
  readonly row_id: string;
  readonly parcel_id: string | null;
  readonly parcel_ordinal: number | null;
  readonly parcel_origin: string | null;
  readonly parcel_state: string | null;
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
  readonly order_id: string | null;
  readonly order_code: string | null;
  readonly recipient_name: string | null;
  readonly service_area: string | null;
  readonly size_class: string | null;
  readonly commercial_state: string | null;
  readonly order_confirmed: boolean;
  readonly payment_required: boolean;
  readonly work_state: WorkState;
  readonly reversed_order_id: string | null;
  readonly reversed_order_code: string | null;
  readonly waiting_since: string | Date | null;
  readonly waiting_note: string | null;
}

interface ProgressRow extends IntakeProgressView {
  readonly state: string;
  readonly receiving_mode: string;
}

/** What the database finds a close would find (`melarc.intake_closure_assessment`). */
export interface ClosureRow {
  readonly state: string;
  readonly receiving_mode: string;
  readonly received: number | null;
  readonly ordered: number;
  readonly unpriced: number;
  readonly payment_required: number;
  readonly missing: number;
  readonly outstanding_count: number | null;
  readonly outstanding_parcels: unknown;
  readonly outstanding_digest: string | null;
  readonly closed_at: string | Date | null;
  readonly parity_exception_note: string | null;
}

const CLOSURE_DOMAIN = 'melarc.closure-assessment.v1';

/**
 * The token of an assessment: a digest of the facts a senior's reason is written for, **with the digest of every outstanding parcel** and not of the hundred that are named. An order added, a parcel found, a
 * count corrected or an outstanding parcel replaced by another changes it, and the close the officer asked for is then refused for the officer to read again (the review of 20 November 2026, finding 6).
 */
export function closureTokenOf(intakeId: string, row: ClosureRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        CLOSURE_DOMAIN,
        intakeId.toLowerCase(),
        row.state,
        row.receiving_mode,
        row.received,
        row.ordered,
        row.unpriced,
        row.payment_required,
        row.missing,
        row.outstanding_count,
        row.outstanding_digest,
      ]),
      'utf8',
    )
    .digest('hex');
}

/** What the database says a close would find, in the caller's transaction and under the caller's key (`hub.intake.close` or `hub.intake.close_exception`). */
export async function readClosureRow(
  tx: ReturnType<typeof transactionOf>,
  intakeId: string,
): Promise<ClosureRow | undefined> {
  const found = await tx.execute(
    sql`select a.* from melarc.intake_closure_assessment(${intakeId}::uuid) as a`,
  );
  return found.rows[0] as unknown as ClosureRow | undefined;
}

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });

const jsonOf = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);
const isoOf = (value: string | Date): string => new Date(value).toISOString();

/**
 * A position in the worklist: the place of a row (a parcel's ordinal, or the order of a blind-count intake's orders) and the row's identifier, as URL-safe text and nothing else. It reaches the statement
 * only as a whole number and a UUID, after it has been checked to be exactly that.
 */
export function encodeWorklistToken(n: number, id: string): string {
  if (!Number.isSafeInteger(n) || n < 0 || !isUuid(id)) {
    throw new TypeError('A worklist position is a place and a UUID');
  }
  return Buffer.from(JSON.stringify([n, id.toLowerCase()])).toString('base64url');
}

export function decodeWorklistToken(token: string): { n: number; id: string } | undefined {
  if (token.length === 0 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [n, id] = parsed as [unknown, unknown];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return undefined;
    if (typeof id !== 'string' || !isUuid(id)) return undefined;
    return { n, id };
  } catch {
    return undefined;
  }
}

function refuseNotStaff(authorized: AuthorizedRequest): void {
  if (authorized.session.principalType !== 'STAFF') {
    throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
  }
}

/**
 * The receiving officer's way into an intake's work (Stage 7; the external review of 19 November 2026, OB-S1-147; itemization.md sections 5.1 to 5.3):
 *
 * - **`listIntakeOrders`** (`hub.read`): the parcel worklist with **the counts of the whole intake** beside the page, from the database (`melarc.intake_progress`, `melarc.intake_worklist`, migration 0114).
 *   A page of 20 is never evidence of how many orders the intake holds. The rows carry no price, no portion and no phone: **`hub.read` does not open the money**, which is `getOrder`'s under `pricing.read`.
 * - **`getIntakeClosure`** (`hub.intake.close`): what the close would find, before the act: received, ordered, not yet priced, awaiting payment, missing, and **the received parcels that still have no order,
 *   named**. It says in so many words that closing is not payment clearance and not a dispatch authorization.
 *
 * Both read in one `REPEATABLE READ` snapshot, so the counts and the page are one picture of the data, and a foreign hub's read is audited without contents, as every staff read is.
 */
export class IntakeWorklist {
  readonly #options: IntakeWorklistOptions;

  constructor(options: IntakeWorklistOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    intakeId: string,
    filter: WorklistFilter,
  ): Promise<IntakeWorklistView> {
    refuseNotStaff(authorized);
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const view = filter.view ?? 'all';
    if (!(WORKLIST_VIEWS as readonly string[]).includes(view)) throw invalid('view', 'enum');
    const after =
      filter.pageToken === undefined ? undefined : decodeWorklistToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined)
      throw invalid('page_token', 'format');
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const progressed = await tx.execute(
          sql`select p.* from melarc.intake_progress(${intakeId}::uuid) as p`,
        );
        const progress = progressed.rows[0] as unknown as ProgressRow | undefined;
        if (progress === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const hub = (
          await tx.execute(
            sql`select responsible_hub_id from pickup_intake where id = ${intakeId}::uuid`,
          )
        ).rows[0] as { responsible_hub_id: string } | undefined;
        if (hub !== undefined) {
          const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
          if (hub.responsible_hub_id !== baseline) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hub.responsible_hub_id },
              responsibleHubId: hub.responsible_hub_id,
              relatedIds: { operation_id: 'listIntakeOrders' },
            });
          }
        }
        const afterN = after?.n ?? null;
        const afterId = after?.id ?? null;
        const read = (
          await tx.execute(sql`
            select w.* from melarc.intake_worklist(${intakeId}::uuid, ${view}::text, ${afterN}::bigint, ${afterId}::uuid, ${size + 1}::integer) as w`)
        ).rows as unknown as WorklistRow[];
        const page = read.slice(0, size);
        const last = page.at(-1);
        return {
          intake_id: intakeId,
          intake_state: progress.state,
          receiving_mode: progress.receiving_mode,
          progress: {
            received: progress.received,
            awaiting_arrival: progress.awaiting_arrival,
            needs_order: progress.needs_order,
            prepared: progress.prepared,
            itemized: progress.itemized,
            payment_required: progress.payment_required,
            missing: progress.missing,
            orders: progress.orders,
            waiting_for_vendor: progress.waiting_for_vendor,
          },
          items: page.map((row): WorklistRowView => ({
            work_state: row.work_state,
            reversed_order:
              row.reversed_order_id === null
                ? null
                : { id: row.reversed_order_id, code: row.reversed_order_code ?? '' },
            parcel:
              row.parcel_id === null
                ? null
                : {
                    id: row.parcel_id,
                    ordinal: Number(row.parcel_ordinal),
                    origin: String(row.parcel_origin),
                    state: String(row.parcel_state),
                    door_photo_evidence_id: row.door_photo_evidence_id,
                    hub_photo_evidence_id: row.hub_photo_evidence_id,
                    waiting_for_vendor:
                      row.waiting_since === null
                        ? null
                        : {
                            since: timestampOf(row.waiting_since).toISOString(),
                            note: row.waiting_note,
                          },
                  },
            order:
              row.order_id === null
                ? null
                : {
                    id: row.order_id,
                    code: String(row.order_code),
                    recipient_name: row.recipient_name,
                    service_area: row.service_area,
                    size_class: String(row.size_class),
                    commercial_state: row.commercial_state,
                    confirmed: row.order_confirmed,
                    payment_required: row.payment_required,
                  },
          })),
          next_page_token:
            read.length > size && last !== undefined
              ? encodeWorklistToken(Number(last.n), last.row_id)
              : null,
        };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  /**
   * `listClosedIntakeExceptions` (OB-S1-151; the review of 20 November 2026; `hub.intake.close_exception`): **the closes that left work**, so that it is found again after a reload or on the next shift: the intakes
   * closed with the approved exception that still have received parcels without an order, newest first, in the hubs of the grant, each with what remained, the reason and who closed it. What is left is counted
   * now. Nothing here resolves the work: the reopen and the report of a parcel found after the close are not built (OB-S1-151). A hub that is not the caller's own is audited, once for each.
   */
  async exceptions(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: { readonly pageSize?: number; readonly pageToken?: string },
  ): Promise<ClosedExceptionPageView> {
    refuseNotStaff(authorized);
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const after =
      filter.pageToken === undefined ? undefined : decodeExceptionToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalid('page_token', 'format');
    }
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const read = (
          await tx.execute(
            sql`select e.* from melarc.closed_intake_exceptions(${after?.moment ?? null}::timestamptz, ${after?.id ?? null}::uuid, ${size + 1}::integer) as e`,
          )
        ).rows as unknown as ClosedExceptionRow[];
        const page = read.slice(0, size);
        const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
        for (const hub of new Set(page.map((row) => row.responsible_hub_id))) {
          if (hub !== baseline) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hub },
              responsibleHubId: hub,
              relatedIds: { operation_id: 'listClosedIntakeExceptions' },
            });
          }
        }
        const names = await namesOf(
          tx,
          page.map((row) => row.intake_id),
        );
        const last = page.at(-1);
        return {
          items: page.map((row): ClosedExceptionView => ({
            intake_id: row.intake_id,
            intake_code: row.intake_code,
            vendor_name: names.vendor.get(row.intake_id) ?? NOT_AVAILABLE,
            pickup_request_id: row.pickup_request_id,
            responsible_hub_id: row.responsible_hub_id,
            receiving_mode: row.receiving_mode,
            closed_at: isoOf(row.closed_at),
            closed_by: row.closed_by,
            exception_note: row.exception_note,
            received: row.received,
            ordered: row.ordered,
            outstanding_count: row.outstanding_count,
          })),
          next_page_token:
            read.length > size && last !== undefined
              ? encodeExceptionToken(last.closed_at_cursor, last.intake_id)
              : null,
        };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  /**
   * The zones of the hub an intake belongs to, for the form that must offer one for an address no zone matches (D-S7-5, OB-S1-165): the hub's **active** zones by name, and nothing else of a zone. The hub is the
   * intake's; the staff's own policy on the zones reads the hubs of the grant alone, so another hub's zones are never in the answer, and a foreign intake is audited as every staff read is.
   */
  async destinationZones(
    authorized: AuthorizedRequest,
    correlationId: string,
    intakeId: string,
  ): Promise<DestinationZonesView> {
    refuseNotStaff(authorized);
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const hub = (
          await tx.execute(
            sql`select responsible_hub_id from pickup_intake where id = ${intakeId}::uuid`,
          )
        ).rows[0] as { responsible_hub_id: string } | undefined;
        if (hub === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
        if (hub.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'HUB', id: hub.responsible_hub_id },
            responsibleHubId: hub.responsible_hub_id,
            relatedIds: { operation_id: 'listDestinationZones' },
          });
        }
        const zones = (
          await tx.execute(
            sql`select id, name from service_zone where hub_id = ${hub.responsible_hub_id}::uuid and active order by name, id`,
          )
        ).rows as unknown as { id: string; name: string }[];
        return { items: zones.map((zone) => ({ zone_id: zone.id, name: zone.name })) };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  async closure(
    authorized: AuthorizedRequest,
    correlationId: string,
    intakeId: string,
  ): Promise<ClosureAssessmentView> {
    refuseNotStaff(authorized);
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const row = await readClosureRow(tx, intakeId);
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const hub = (
          await tx.execute(
            sql`select responsible_hub_id from pickup_intake where id = ${intakeId}::uuid`,
          )
        ).rows[0] as { responsible_hub_id: string } | undefined;
        if (hub !== undefined) {
          const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
          if (hub.responsible_hub_id !== baseline) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hub.responsible_hub_id },
              responsibleHubId: hub.responsible_hub_id,
              relatedIds: { operation_id: 'getIntakeClosure' },
            });
          }
        }
        return closureViewOf(intakeId, row);
      },
      { isolation: 'REPEATABLE READ' },
    );
  }
}

/** The zones of an intake's hub, as the form offers them (`DestinationZoneList`). */
export interface DestinationZonesView {
  readonly items: readonly { readonly zone_id: string; readonly name: string }[];
}

/** One intake that was closed with the approved exception and still has received parcels without an order. */
export interface ClosedExceptionView {
  readonly intake_id: string;
  readonly intake_code: string;
  /** The vendor, by name, as receiving names a vendor (Run G1, Part 1, item 4). */
  readonly vendor_name: string;
  readonly pickup_request_id: string;
  readonly responsible_hub_id: string;
  readonly receiving_mode: string;
  readonly closed_at: string;
  readonly closed_by: string;
  readonly exception_note: string | null;
  readonly received: number;
  readonly ordered: number;
  readonly outstanding_count: number;
}

export interface ClosedExceptionPageView {
  readonly items: readonly ClosedExceptionView[];
  readonly next_page_token: string | null;
}

interface ClosedExceptionRow {
  readonly intake_id: string;
  readonly intake_code: string;
  readonly pickup_request_id: string;
  readonly responsible_hub_id: string;
  readonly receiving_mode: string;
  readonly closed_at: string | Date;
  readonly closed_at_cursor: string;
  readonly closed_by: string;
  readonly exception_note: string | null;
  readonly received: number;
  readonly ordered: number;
  readonly outstanding_count: number;
}

const CURSOR_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A position in the queue of closes that left work: the moment of the close as the database keeps it, and the intake. It reaches the statement only as a moment and a UUID, after both are checked. */
export function encodeExceptionToken(moment: string, id: string): string {
  if (!CURSOR_MOMENT.test(moment) || !isUuid(id)) {
    throw new TypeError('A position in the queue is a moment and a UUID');
  }
  return Buffer.from(JSON.stringify([moment, id.toLowerCase()])).toString('base64url');
}

export function decodeExceptionToken(token: string): { moment: string; id: string } | undefined {
  if (token.length === 0 || token.length > 160 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [moment, id] = parsed as [unknown, unknown];
    if (typeof moment !== 'string' || !CURSOR_MOMENT.test(moment)) return undefined;
    if (typeof id !== 'string' || !isUuid(id)) return undefined;
    return { moment, id };
  } catch {
    return undefined;
  }
}

/** What a close would find, as the read answers it and as a close that was asked against another assessment answers it (`current_assessment`). */
export function closureViewOf(intakeId: string, row: ClosureRow): ClosureAssessmentView {
  const stateOk = row.state === 'READY_FOR_ITEMIZATION' || row.state === 'ITEMIZING';
  const blockers: string[] = [];
  if (!stateOk) blockers.push('intake_not_ready');
  // A surplus is told before what is unpriced: it is corrected first, and nothing is closed over it.
  const excess =
    row.received !== null && row.ordered > row.received ? row.ordered - row.received : 0;
  if (stateOk && excess > 0) blockers.push('orders_exceed_received');
  if (stateOk && row.unpriced > 0) blockers.push('order_unpriced');
  // A count that is not committed has no parity to meet.
  const parity = row.received !== null && row.ordered === row.received;
  const parcels = jsonOf(row.outstanding_parcels) as {
    parcel_id: string;
    ordinal: number;
    origin: string;
    door_photo_evidence_id: string | null;
    hub_photo_evidence_id: string | null;
  }[];
  return {
    intake_id: intakeId,
    intake_state: row.state,
    receiving_mode: row.receiving_mode,
    received: row.received,
    ordered: row.ordered,
    unpriced: row.unpriced,
    payment_required: row.payment_required,
    missing: row.missing,
    outstanding_count: row.outstanding_count,
    excess_count: excess,
    assessment_token: closureTokenOf(intakeId, row),
    outstanding_parcels: parcels,
    closed_at: row.closed_at === null ? null : isoOf(row.closed_at),
    parity_exception_note: row.parity_exception_note,
    can_close: blockers.length === 0 && parity,
    needs_exception: blockers.length === 0 && !parity,
    blockers,
    payment_still_required: row.payment_required > 0,
  };
}
