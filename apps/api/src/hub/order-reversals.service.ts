import { sql } from 'drizzle-orm';

import { requiredNote } from '../platform/audit/required-note.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { receivingRefusalOf } from './check-in.service.js';
import { noteHubCrossing } from './hub-crossing.js';
import { orderEtagMatches, orderEtagOf } from './order-reads.service.js';
import { loadOrder, orderViewOf } from './order-view.js';

export interface OrderReversalsOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Pick<Clock, 'now'>;
}

export interface ReversalBody {
  readonly note: string;
}

/** What a reversal did: the order that is now `REVERSED` (its locked price and portions kept), the parcel that is now missing or taken back, and where the intake went. */
export interface ReversalView {
  readonly id: string;
  readonly order_id: string;
  readonly intake_id: string;
  readonly parcel_id: string;
  readonly previous_commercial_state: string;
  readonly commercial_state: 'REVERSED';
  readonly parcel_state: 'MISSING' | 'VOID';
  readonly previous_intake_state: string;
  readonly intake_state: string;
  readonly received_before: number;
  readonly received_after: number;
  readonly note: string;
  readonly reversed_at: string;
}

interface ReversedRow {
  readonly intake_id: string;
  readonly previous_intake_state: string;
  readonly resulting_intake_state: string;
  readonly parcel_id: string;
  readonly resulting_parcel_state: 'MISSING' | 'VOID';
  readonly old_received: number | null;
  readonly new_received: number;
  readonly previous_commercial_state: string;
}

/**
 * `reverseOrderArrival` (Stage 7; the external review of 19 November 2026, finding E; `hub.osd.adjudicate`, Senior Ops and the Platform Admin; itemization.md section 5.1): **a mistaken arrival is corrected, never
 * erased.** An officer finishes a check-in with the wrong parcel marked present; the price froze; a senior discovers the parcel is not there. The order **keeps its locked price, its portions and its trail** and
 * moves to `REVERSED`; the parcel moves to `MISSING` (a door parcel) or `VOID` (an extra), so that it is searched for as any missing parcel is; the intake's count is recomputed from its parcels and the intake goes
 * back to reconciliation (`RECONCILIATION_REQUIRED`), even from `ITEMIZING`.
 *
 * - **A reason in words is mandatory** (`REASON_REQUIRED`), on the version of the order that was read (`If-Match`, the `ETag` of `getOrder`: `STATE_CONFLICT`, rule `stale`), with an `Idempotency-Key`.
 * - **Only while nothing downstream has happened**: the order is confirmed and still `PRICED`, `NO_VENDOR_CHARGE` or `PAYMENT_REQUIRED` (never paid for, reserved or dispatched: `order_progressed`,
 *   `order_dispatched`), has no payer correction waiting (`correction_open`), and its intake is not closed (`intake_closed`: reopening an intake is a task of its own). An order that is not yet confirmed is
 *   amended, not reversed (`order_not_confirmed`); an intake counted blind has no parcel to take back (`blind_count_intake`).
 * - **Held by the database for every writer**: the record of the reversal (`order_reversal`, appended once for an order) must stand in the same transaction beside the move of the order, of the parcel and of
 *   the intake, whose guards refuse each of the three without it (migration 0115). The audit event `order.arrival.reversed` is enhanced and records the states before and after.
 */
export class OrderReversals {
  readonly #options: OrderReversalsOptions;

  constructor(options: OrderReversalsOptions) {
    this.#options = options;
  }

  async reverse(
    authorized: AuthorizedRequest,
    correlationId: string,
    orderId: string,
    request: {
      readonly body: ReversalBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<ReversalView> {
    const { runner, audit, idempotency, clock } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const note = requiredNote(request.body.note, '/note');
    const staff = authorized.session.principalId.toLowerCase();
    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: staff,
        operationId: 'reverseOrderArrival',
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as ReversalView;
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        throw new Error('An idempotency record of this command is stranded');
      }
      const row = await loadOrder(tx, orderId);
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      if (!orderEtagMatches(request.ifMatch, orderEtagOf(orderViewOf(row), Number(row.version)))) {
        throw ApiException.of(ErrorCode.StateConflict, 'The order has changed since it was read', {
          rule: 'stale',
        });
      }
      await noteHubCrossing(audit, handle, authorized, {
        id: row.pickup_intake_id,
        responsible_hub_id: row.responsible_hub_id,
      });
      const reversalId = randomUUIDv7(clock);
      let done: ReversedRow | undefined;
      try {
        const result = await tx.execute(
          sql`select intake_id, previous_intake_state, resulting_intake_state, parcel_id, resulting_parcel_state, old_received, new_received, previous_commercial_state
                from melarc.reverse_order_arrival(${orderId}::uuid, ${Number(row.version)}::integer, ${reversalId}::uuid, ${note}::text)`,
        );
        done = result.rows[0] as unknown as ReversedRow | undefined;
      } catch (error) {
        throw receivingRefusalOf(error, '/note') ?? error;
      }
      if (done === undefined) throw new Error('An arrival that was reversed left no record');
      const recorded = (
        await tx.execute(
          sql`select reversed_at::text as reversed_at from order_reversal where id = ${reversalId}::uuid`,
        )
      ).rows[0] as { reversed_at: string } | undefined;
      await audit.write(handle, {
        code: 'order.arrival.reversed',
        enhanced: true,
        outcome: 'SUCCEEDED',
        note,
        object: { type: 'Order', id: orderId },
        responsibleHubId: row.responsible_hub_id,
        previousState: done.previous_commercial_state,
        resultingState: 'REVERSED',
        relatedIds: {
          pickup_intake_id: done.intake_id,
          intake_parcel_id: done.parcel_id,
          order_reversal_id: reversalId,
        },
        beforeAfter: {
          commercial_state: { before: done.previous_commercial_state, after: 'REVERSED' },
          parcel_state: { before: 'ARRIVED', after: done.resulting_parcel_state },
          intake_state: { before: done.previous_intake_state, after: done.resulting_intake_state },
          received_count: { before: done.old_received ?? 0, after: done.new_received },
        },
        detail: { locked_price_minor: row.locked_price_minor },
      });
      const answer: ReversalView = {
        id: reversalId,
        order_id: orderId,
        intake_id: done.intake_id,
        parcel_id: done.parcel_id,
        previous_commercial_state: done.previous_commercial_state,
        commercial_state: 'REVERSED',
        parcel_state: done.resulting_parcel_state,
        previous_intake_state: done.previous_intake_state,
        intake_state: done.resulting_intake_state,
        received_before: done.old_received ?? 0,
        received_after: done.new_received,
        note,
        reversed_at: timestampOf(recorded?.reversed_at ?? new Date()).toISOString(),
      };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }
}
