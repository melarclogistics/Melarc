import { sql } from 'drizzle-orm';

import { requiredNote } from '../platform/audit/required-note.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import {
  hubOutsideStaffGrant,
  type AuthorizedRequest,
} from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { meetsTier } from '../platform/authorization/tier-policy.js';
import { guardReasonIn, guardRuleIn } from '../platform/database/database-failures.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';
import { loadOrder, orderViewOf } from './order-view.js';
import { orderEtagMatches, orderEtagOf } from './order-reads.service.js';

/** The intent a payer correction proposes: never a portion of a price, which the database resolves (the contract's `PayerAllocationInput`). */
export interface PayerProposal {
  readonly payer_intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT';
  readonly split_basis?: 'FIXED_AMOUNT' | 'PERCENTAGE';
  readonly split_sender_amount?: { readonly amount_minor: number; readonly currency: 'GHS' };
  readonly split_sender_percentage?: number;
}

export interface PayerCorrectionRequestBody {
  readonly proposed: PayerProposal;
  readonly note: string;
}

export interface PayerCorrectionDecisionBody {
  readonly decision: 'APPROVE' | 'REJECT';
  readonly note?: string;
}

export interface Allocation {
  readonly sender_minor: number;
  readonly recipient_minor: number;
}

/** The record of a correction as its row says it: the history is complete, with what was approved (`resulting_allocation`) stored beside what the order had and what was proposed. */
export interface PayerCorrectionView {
  readonly id: string;
  readonly order_id: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly requested_by: string;
  readonly approved_by: string | null;
  readonly previous_allocation: Allocation;
  readonly proposed: PayerProposal;
  /** What the approval wrote to the order, in actual amounts; null until approved (and for a rejection). */
  readonly resulting_allocation: Allocation | null;
  readonly resulting_commercial_state: string | null;
  readonly note: string;
  readonly created_at: string;
  readonly decided_at: string | null;
}

/**
 * What a checker needs to decide, and what a history needs to show, from one read: the correction with its order's code and unchanged total, **the proposal resolved into actual amounts** (never a
 * percentage the reader must work out), the commercial state the order would reach, and the names of the maker and of the checker.
 */
export interface PayerCorrectionDetailView extends PayerCorrectionView {
  readonly order_code: string;
  readonly total: { readonly amount_minor: number; readonly currency: 'GHS' };
  readonly proposed_allocation: Allocation;
  readonly proposed_commercial_state: 'NO_VENDOR_CHARGE' | 'PAYMENT_REQUIRED';
  readonly order_commercial_state: string | null;
  readonly requested_by_name: string | null;
  readonly approved_by_name: string | null;
}

export interface CorrectionAnswer {
  readonly correction: PayerCorrectionDetailView;
  readonly etag: string;
}

export interface CorrectionListFilter {
  readonly state?: string;
  readonly orderId?: string;
  readonly hubId?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface CorrectionPage {
  readonly items: readonly PayerCorrectionDetailView[];
  readonly next_page_token: string | null;
}

export interface PayerCorrectionsOptions {
  readonly runner: Pick<OperationRunner, 'mutate' | 'read'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Pick<Clock, 'now'>;
}

interface CorrectionRow {
  readonly id: string;
  readonly order_id: string;
  readonly responsible_hub_id: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly requested_by: string;
  readonly decided_by: string | null;
  readonly previous_allocation: unknown;
  readonly proposed: unknown;
  readonly resulting_allocation: unknown;
  readonly resulting_commercial_state: string | null;
  readonly note: string;
  readonly created_at: string | Date;
  readonly decided_at: string | Date | null;
  readonly version: number | string;
}

/** A correction row joined to its order, for the detail: the order's code and locked price, and the sender's portion the proposal resolves to. */
interface DetailRow extends CorrectionRow {
  readonly order_code: string;
  readonly locked_price_minor: number;
  readonly order_commercial_state: string | null;
  readonly proposed_sender_minor: number | null;
  readonly position_text: string;
}

const MAX_PESEWAS = 2_000_000_000;
const jsonOf = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);
const isoOf = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

const invalidQuery = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });

/** The columns of a correction with its order's code, locked price and state, and the sender's portion the proposal resolves to (the arithmetic of the freeze: `melarc.payer_portion`). */
const DETAIL_COLUMNS = sql.raw(
  `c.id, c.order_id, c.responsible_hub_id, c.state, c.requested_by, c.decided_by, c.previous_allocation, c.proposed, c.resulting_allocation, c.resulting_commercial_state, c.note, c.created_at, c.decided_at, c.version,
   c.created_at::text AS position_text, o.code AS order_code, o.locked_price_minor, o.commercial_state AS order_commercial_state, melarc.payer_portion(o.locked_price_minor, c.proposed) AS proposed_sender_minor`,
);

const CORRECTION_COLUMNS = sql.raw(
  'id, order_id, responsible_hub_id, state, requested_by, decided_by, previous_allocation, proposed, resulting_allocation, resulting_commercial_state, note, created_at, decided_at, version',
);

/** The view of a correction: what the contract's `PayerCorrection` says, from the row. */
export function correctionViewOf(row: CorrectionRow): PayerCorrectionView {
  const previous = jsonOf(row.previous_allocation) as {
    sender_minor: number;
    recipient_minor: number;
  };
  const proposed = jsonOf(row.proposed) as {
    payer_intent: PayerProposal['payer_intent'];
    split_basis?: PayerProposal['split_basis'];
    split_sender_amount_minor?: number;
    split_sender_percentage?: number;
  };
  return {
    id: row.id,
    order_id: row.order_id,
    state: row.state,
    requested_by: row.requested_by,
    approved_by: row.decided_by,
    previous_allocation: {
      sender_minor: previous.sender_minor,
      recipient_minor: previous.recipient_minor,
    },
    proposed: {
      payer_intent: proposed.payer_intent,
      ...(proposed.split_basis === undefined ? {} : { split_basis: proposed.split_basis }),
      ...(proposed.split_sender_amount_minor === undefined
        ? {}
        : {
            split_sender_amount: {
              amount_minor: proposed.split_sender_amount_minor,
              currency: 'GHS' as const,
            },
          }),
      ...(proposed.split_sender_percentage === undefined
        ? {}
        : { split_sender_percentage: proposed.split_sender_percentage }),
    },
    resulting_allocation:
      row.resulting_allocation === null || row.resulting_allocation === undefined
        ? null
        : allocationOf(jsonOf(row.resulting_allocation)),
    resulting_commercial_state: row.resulting_commercial_state,
    note: row.note,
    created_at: isoOf(row.created_at),
    decided_at: row.decided_at === null ? null : isoOf(row.decided_at),
  };
}

const allocationOf = (value: unknown): Allocation => {
  const given = value as { sender_minor: number; recipient_minor: number };
  return { sender_minor: given.sender_minor, recipient_minor: given.recipient_minor };
};

/** The detail of a correction: its record, its order's code and unchanged total, the proposal in actual amounts and the names of the officers. */
export function correctionDetailOf(
  row: DetailRow,
  names: ReadonlyMap<string, string>,
): PayerCorrectionDetailView {
  const base = correctionViewOf(row);
  const sender = Number(row.proposed_sender_minor);
  const total = row.locked_price_minor;
  return {
    ...base,
    order_code: row.order_code,
    total: { amount_minor: total, currency: 'GHS' },
    proposed_allocation: { sender_minor: sender, recipient_minor: total - sender },
    proposed_commercial_state: sender === 0 ? 'NO_VENDOR_CHARGE' : 'PAYMENT_REQUIRED',
    order_commercial_state: row.order_commercial_state,
    requested_by_name: names.get(row.requested_by) ?? null,
    approved_by_name: row.decided_by === null ? null : (names.get(row.decided_by) ?? null),
  };
}

/** The `ETag` of a correction as it is read: the digest of its view and of its `version`. */
export const correctionEtagOf = (row: CorrectionRow): string =>
  orderEtagOf(correctionViewOf(row), Number(row.version));

/**
 * The payer correction after the price froze (S1.39; `requestPayerCorrection` under `pricing.correction.create`, `approvePayerCorrection` under `pricing.correction.approve`; features/hub/itemization.md section 5.1
 * step 6; state-machines.md section 8; `AC-SLICE-001-55`):
 *
 * - **The maker asks, the checker decides.** An order that is frozen takes one open request at a time (`STATE_CONFLICT`); the request carries the intent the maker proposes (never a portion of a price) and a
 *   reason in words (`REASON_REQUIRED`), keeps the allocation the order had (complete before and after history) and takes the order's `ETag` as `If-Match`.
 * - **The checker is not the maker** (`SELF_APPROVAL_FORBIDDEN`), unless the checker's grant of the key is a Platform Admin's (tier `P`: permissions.md section 6). The database holds the rule for every writer
 *   by the decider and the maker of the row, with the exception told by the service (a setting of the transaction, as the repository's other transaction-scoped facts are).
 * - **Approval re-runs the commercial gate from the new portions** and writes them to the order in one change with the decision (`melarc.decide_payer_correction`): the locked price is never rewritten, the zero
 *   branch is tested first, and the order moves to `NO_VENDOR_CHARGE` or `PAYMENT_REQUIRED` as the new vendor portion warrants (D-12: no reservation to adjust). A rejection changes nothing but the record.
 * - **Events:** `pricing.correction.requested`; `pricing.correction.approved` (enhanced: before and after) with `pricing.correction.applied` and the gate's own event; `pricing.correction.rejected`.
 */
export class PayerCorrections {
  readonly #options: PayerCorrectionsOptions;

  constructor(options: PayerCorrectionsOptions) {
    this.#options = options;
  }

  async request(
    authorized: AuthorizedRequest,
    correlationId: string,
    orderId: string,
    request: {
      readonly body: PayerCorrectionRequestBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CorrectionAnswer> {
    this.#requireStaff(authorized);
    this.#requireKey(request.idempotencyKey);
    const note = requiredNote(request.body.note, '/note');
    const proposed = this.#proposal(request.body.proposed);
    const maker = authorized.session.principalId.toLowerCase();
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: maker,
        operationId: 'requestPayerCorrection',
        key: request.idempotencyKey,
      } as const;
      const replay = await this.#begin(handle, scope, request.fingerprint);
      if (replay !== undefined) return replay;

      const locked = await tx.execute(
        sql`select id, responsible_hub_id, version from "order" where id = ${orderId}::uuid`,
      );
      const held = locked.rows[0] as
        { id: string; responsible_hub_id: string; version: number | string } | undefined;
      if (held === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const row = await loadOrder(tx, orderId);
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const view = orderViewOf(row);
      // The version of the row that was read with it, never a second read (review finding D); the database re-checks it under the row's lock.
      if (!orderEtagMatches(request.ifMatch, orderEtagOf(view, Number(row.version)))) {
        throw ApiException.of(ErrorCode.StateConflict, 'The order has changed since it was read', {
          rule: 'stale',
        });
      }
      const id = randomUUIDv7(this.#options.clock);
      try {
        await tx.execute(
          sql`select melarc.request_payer_correction(${id}::uuid, ${orderId}::uuid, ${JSON.stringify(proposed)}::jsonb, ${note}::text, ${Number(row.version)}::integer)`,
        );
      } catch (error) {
        throw this.#refusal(error) ?? error;
      }
      await this.#options.audit.write(handle, {
        code: 'pricing.correction.requested',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'Order', id: orderId },
        responsibleHubId: held.responsible_hub_id,
        relatedIds: { payer_correction_id: id },
        detail: {
          payer_intent: String(proposed.payer_intent),
          previous_sender_minor: view.payer_allocation?.sender_minor ?? null,
          previous_recipient_minor: view.payer_allocation?.recipient_minor ?? null,
        },
      });
      const answer = await this.#present(tx, id);
      await this.#complete(handle, scope, 201, answer);
      return answer;
    });
  }

  async decide(
    authorized: AuthorizedRequest,
    correlationId: string,
    correctionId: string,
    request: {
      readonly body: PayerCorrectionDecisionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CorrectionAnswer> {
    this.#requireStaff(authorized);
    this.#requireKey(request.idempotencyKey);
    const decision: string = request.body.decision;
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw invalid('/decision', 'enum');
    // A note with the decision is optional, and what the ledger keeps is screened as every note is (never repeated in a refusal).
    const decisionNote =
      request.body.note === undefined || request.body.note.trim() === ''
        ? undefined
        : requiredNote(request.body.note, '/note');
    const checker = authorized.session.principalId.toLowerCase();
    const platformAdmin = meetsTier(authorized.grant?.tier ?? null, 'P');
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: checker,
        operationId: 'approvePayerCorrection',
        key: request.idempotencyKey,
      } as const;
      const replay = await this.#begin(handle, scope, request.fingerprint);
      if (replay !== undefined) return replay;

      // The correction under its lock, then the order it is for (the order of every act that touches both: the maker's request locked the order first, and nothing waits for a correction while holding an order).
      const found = await tx.execute(
        sql`select ${CORRECTION_COLUMNS} from payer_correction where id = ${correctionId}::uuid`,
      );
      const before = found.rows[0] as unknown as CorrectionRow | undefined;
      if (before === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      if (!orderEtagMatches(request.ifMatch, correctionEtagOf(before))) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The correction has changed since it was read',
          { rule: 'stale' },
        );
      }
      if (before.state !== 'REQUESTED') {
        throw ApiException.of(ErrorCode.StateConflict, 'The correction is already decided', {
          rule: 'already_decided',
        });
      }
      // The checker is not the maker, unless the checker is a Platform Admin: told here by name, held by the database.
      if (before.requested_by.toLowerCase() === checker && !platformAdmin) {
        throw ApiException.of(
          ErrorCode.SelfApprovalForbidden,
          'The approver of a correction is not its requester',
        );
      }
      try {
        // The database asks the decider's own bundle for the tier P that lets a Platform Admin decide the correction they asked for (`melarc.staff_holds_at_tier_p`, migration 0118, as 0032 does for a staff
        // identity): it believes no setting this service writes. The name above is the service's own answer, told before the database's.
        await tx.execute(
          sql`select melarc.decide_payer_correction(${correctionId}::uuid, ${decision}::text, ${Number(before.version)}::integer)`,
        );
      } catch (error) {
        throw this.#refusal(error) ?? error;
      }
      const after = await this.#read(tx, correctionId);
      const related = { payer_correction_id: correctionId };
      if (decision === 'REJECT') {
        await this.#options.audit.write(handle, {
          code: 'pricing.correction.rejected',
          enhanced: false,
          outcome: 'SUCCEEDED',
          ...(decisionNote === undefined ? {} : { note: decisionNote }),
          object: { type: 'Order', id: before.order_id },
          responsibleHubId: before.responsible_hub_id,
          relatedIds: related,
          detail: { payer_intent: correctionViewOf(after).proposed.payer_intent },
        });
      } else {
        const allocation = jsonOf(after.resulting_allocation) as {
          sender_minor: number;
          recipient_minor: number;
        };
        const previous = correctionViewOf(before).previous_allocation;
        await this.#options.audit.write(handle, {
          code: 'pricing.correction.approved',
          enhanced: true,
          outcome: 'SUCCEEDED',
          ...(decisionNote === undefined ? {} : { note: decisionNote }),
          object: { type: 'Order', id: before.order_id },
          responsibleHubId: before.responsible_hub_id,
          relatedIds: related,
          beforeAfter: {
            sender_minor: { before: previous.sender_minor, after: allocation.sender_minor },
            recipient_minor: {
              before: previous.recipient_minor,
              after: allocation.recipient_minor,
            },
          },
          detail: { resulting_commercial_state: after.resulting_commercial_state },
        });
        await this.#options.audit.write(handle, {
          code: 'pricing.correction.applied',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'Order', id: before.order_id },
          responsibleHubId: before.responsible_hub_id,
          relatedIds: related,
          detail: {
            sender_minor: allocation.sender_minor,
            recipient_minor: allocation.recipient_minor,
            commercial_state: after.resulting_commercial_state,
          },
        });
      }
      const answer = await this.#present(tx, correctionId);
      await this.#complete(handle, scope, 200, answer);
      return answer;
    });
  }

  /**
   * `listPayerCorrections`: the corrections of the hubs of the grant, a checker's queue (`state=REQUESTED`, the default, oldest first) or a history (`state=APPROVED`, `REJECTED` or `all`, and `order_id` for one
   * order's own), each with what it takes to decide it. A hub outside the grant is an empty page and no statement.
   */
  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: CorrectionListFilter,
  ): Promise<CorrectionPage> {
    this.#requireStaff(authorized);
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalidQuery('page_size', 'range');
    }
    const state = filter.state ?? 'REQUESTED';
    if (!['REQUESTED', 'APPROVED', 'REJECTED', 'all'].includes(state)) {
      throw invalidQuery('state', 'enum');
    }
    if (filter.orderId !== undefined && !isUuid(filter.orderId)) {
      throw invalidQuery('order_id', 'format');
    }
    if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalidQuery('hub_id', 'format');
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalidQuery('page_token', 'format');
    }
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const hubId = filter.hubId ?? null;
        const orderId = filter.orderId ?? null;
        const afterAt = after?.createdAt ?? null;
        const afterId = after?.id ?? null;
        const read = (
          await tx.execute(sql`
            select ${DETAIL_COLUMNS}
              from payer_correction as c join "order" as o on o.id = c.order_id
             where (${state}::text = 'all' or c.state = ${state}::text)
               and (${orderId}::uuid is null or c.order_id = ${orderId}::uuid)
               and (${hubId}::uuid is null or c.responsible_hub_id = ${hubId}::uuid)
               and (${afterAt}::timestamptz is null or (c.created_at, c.id) > (${afterAt}::timestamptz, ${afterId}::uuid))
             order by c.created_at, c.id
             limit ${size + 1}`)
        ).rows as unknown as DetailRow[];
        const page = read.slice(0, size);
        await this.#noteForeignHubs(handle, authorized, page, 'listPayerCorrections');
        const names = await this.#namesOf(tx, page);
        const last = page.at(-1);
        return {
          items: page.map((row) => correctionDetailOf(row, names)),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.id })
              : null,
        };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  /** `getPayerCorrection`: one correction in full, with the `ETag` that `approvePayerCorrection` takes as `If-Match`, so that the checker opens it after a reload or on another device. */
  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    correctionId: string,
  ): Promise<CorrectionAnswer> {
    this.#requireStaff(authorized);
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const found = await this.#detailRow(tx, correctionId);
      if (found === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      await this.#noteForeignHubs(handle, authorized, [found], 'getPayerCorrection');
      const names = await this.#namesOf(tx, [found]);
      return { correction: correctionDetailOf(found, names), etag: correctionEtagOf(found) };
    });
  }

  async #detailRow(
    tx: ReturnType<typeof transactionOf>,
    id: string,
  ): Promise<DetailRow | undefined> {
    const found = await tx.execute(sql`
      select ${DETAIL_COLUMNS}
        from payer_correction as c join "order" as o on o.id = c.order_id
       where c.id = ${id}::uuid`);
    return found.rows[0] as unknown as DetailRow | undefined;
  }

  /** The answer of an act: the correction in full and the `ETag` of the row as it now stands. */
  async #present(tx: ReturnType<typeof transactionOf>, id: string): Promise<CorrectionAnswer> {
    const row = await this.#detailRow(tx, id);
    if (row === undefined) throw new Error('A correction that was made could not be read');
    const names = await this.#namesOf(tx, [row]);
    return { correction: correctionDetailOf(row, names), etag: correctionEtagOf(row) };
  }

  async #namesOf(
    tx: ReturnType<typeof transactionOf>,
    rows: readonly CorrectionRow[],
  ): Promise<Map<string, string>> {
    const book = new Map<string, string>();
    if (rows.length === 0) return book;
    const ids = rows.map((row) => sql`${row.id}::uuid`);
    const found = await tx.execute(
      sql`select staff_id, display_name from melarc.correction_names(array[${sql.join(ids, sql`, `)}]::uuid[])`,
    );
    for (const row of found.rows as unknown as { staff_id: string; display_name: string }[]) {
      book.set(row.staff_id, row.display_name);
    }
    return book;
  }

  /** A read of a correction in a hub that is not the actor's own is audited without contents, as every staff read is. */
  async #noteForeignHubs(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    rows: readonly CorrectionRow[],
    operation: string,
  ): Promise<void> {
    const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
    const foreign = [
      ...new Set(rows.map((row) => row.responsible_hub_id).filter((hub) => hub !== baseline)),
    ].toSorted();
    for (const hubId of foreign) {
      await this.#options.audit.write(handle, {
        code: 'auth.hub_boundary.crossed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'HUB', id: hubId },
        responsibleHubId: hubId,
        relatedIds: { operation_id: operation },
      });
    }
  }

  #requireStaff(authorized: AuthorizedRequest): void {
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
  }

  #requireKey(key: string): void {
    if (!isIdempotencyKey(key)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
  }

  /** The intent of the proposal and the numbers that go with it, as the database stores them: never a portion of a price. */
  #proposal(given: PayerProposal | undefined): Readonly<Record<string, unknown>> {
    if (given === undefined) throw invalid('/proposed', 'required');
    const { payer_intent: intent, split_basis: basis, split_sender_amount: amount } = given;
    const percentage = given.split_sender_percentage;
    if (intent !== 'SPLIT') {
      if (basis !== undefined || amount !== undefined || percentage !== undefined) {
        throw invalid('/proposed', 'split_not_allowed');
      }
      return { payer_intent: intent };
    }
    if (basis === undefined) throw invalid('/proposed/split_basis', 'required');
    if (basis === 'FIXED_AMOUNT') {
      if (percentage !== undefined)
        throw invalid('/proposed/split_sender_percentage', 'not_allowed');
      if (
        amount === undefined ||
        !Number.isSafeInteger(amount.amount_minor) ||
        amount.amount_minor < 1 ||
        amount.amount_minor > MAX_PESEWAS
      ) {
        throw invalid('/proposed/split_sender_amount', 'required');
      }
      return {
        payer_intent: intent,
        split_basis: basis,
        split_sender_amount_minor: amount.amount_minor,
      };
    }
    if (amount !== undefined) throw invalid('/proposed/split_sender_amount', 'not_allowed');
    if (percentage === undefined) throw invalid('/proposed/split_sender_percentage', 'required');
    return { payer_intent: intent, split_basis: basis, split_sender_percentage: percentage };
  }

  async #read(tx: ReturnType<typeof transactionOf>, id: string): Promise<CorrectionRow> {
    const found = await tx.execute(
      sql`select ${CORRECTION_COLUMNS} from payer_correction where id = ${id}::uuid`,
    );
    const row = found.rows[0] as unknown as CorrectionRow | undefined;
    if (row === undefined) throw new Error('A correction that was made could not be read');
    return row;
  }

  async #begin(
    handle: TransactionHandle,
    scope: {
      readonly principalType: 'STAFF';
      readonly principalId: string;
      readonly operationId: string;
      readonly key: string;
    },
    fingerprint: string,
  ): Promise<CorrectionAnswer | undefined> {
    const begun = await this.#options.idempotency.begin(handle, scope, fingerprint);
    if (begun.outcome === 'REPLAY') {
      return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as CorrectionAnswer;
    }
    if (begun.outcome === 'CONFLICT') {
      throw ApiException.of(
        ErrorCode.IdempotencyKeyConflict,
        'That Idempotency-Key was used with a different request',
      );
    }
    if (begun.outcome !== 'NEW')
      throw new Error('An idempotency record of this command is stranded');
    return undefined;
  }

  async #complete(
    handle: TransactionHandle,
    scope: {
      readonly principalType: 'STAFF';
      readonly principalId: string;
      readonly operationId: string;
      readonly key: string;
    },
    status: number,
    answer: CorrectionAnswer,
  ): Promise<void> {
    await this.#options.idempotency.complete(handle, scope, {
      status,
      body: new TextEncoder().encode(JSON.stringify(answer)),
    });
  }

  /** What the database refused, as the answer the contract names. */
  #refusal(error: unknown): ApiException | undefined {
    const rule = guardRuleIn(error);
    switch (guardReasonIn(error)) {
      case 'STATE_CONFLICT':
        return ApiException.of(
          ErrorCode.StateConflict,
          'The correction cannot be made in this state',
          rule === undefined ? undefined : { rule },
        );
      case 'SELF_APPROVAL_FORBIDDEN':
        return ApiException.of(
          ErrorCode.SelfApprovalForbidden,
          'The approver of a correction is not its requester',
        );
      case 'VALIDATION_FAILED':
        return invalid('/proposed', rule ?? 'invalid');
      default:
        return undefined;
    }
  }
}
