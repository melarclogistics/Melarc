import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { pickupRequestEtagOf } from './pickup-request-etag.js';
import { loadRequest, requireCurrent } from './pickup-request-loader.js';
import { auditReplacementCreated, replaceRequest } from './pickup-request-replacement.js';
import {
  REQUEST_COLUMNS,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

const OPERATION = 'resolveCutoffException';

/** The body of `resolveCutoffException` as the contract's schema has validated it (the interceptor ran before this). */
export interface CutoffResolutionBody {
  readonly decision: 'APPROVE_SAME_DAY' | 'RESCHEDULE_NEXT_DAY';
  readonly note: string;
}

export interface CutoffExceptionResolutionOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
}

export interface ResolvedRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

/** What a replay of the command answers: the representation and the token it was answered with, as they were. */
interface StoredAnswer {
  readonly etag: string;
  readonly request: PickupRequestView;
}

/**
 * `resolveCutoffException` (S1.15; `pickup.request.confirm`; state-machines.md section 3, "resolve cutoff exception"; pickup-request.md
 * section 5.2, "Past the hub booking cutoff"): Ops decides a request that was confirmed past the hub's cutoff and is waiting in
 * `PENDING_OPS_REVIEW`, under a mandatory note.
 *
 * - **`APPROVE_SAME_DAY`**: the request stays `CONFIRMED` for its day and its exception becomes `SAME_DAY_APPROVED`.
 * - **`RESCHEDULE_NEXT_DAY`**: the cancel-plus-clone of section 21.6 in one act and one transaction. The source becomes `CANCELLED`
 *   (cancelled by Ops, carrying `RESCHEDULED` and the id of the clone) and a new `PENDING` request is inserted for **the next operating
 *   day after the later of the service date and today on the hub's clock**, Monday to Saturday (a request confirmed days late is not
 *   rescheduled into the past). The clone is the same booking (`pickup-request-clone.ts` says which columns it carries) and **keeps the
 *   attempt number**: no pickup was attempted, so the cap cannot refuse it, which is why the operation names no such refusal. The two are
 *   never both active: they change together or not at all.
 * - **Under the request's lock and its version** (`If-Match`, recomputed by the function a read uses); a request that is not
 *   `CONFIRMED` and in `PENDING_OPS_REVIEW` is `STATE_CONFLICT`, so a decision is taken once. **Once however many times it is sent**
 *   (`Idempotency-Key`): the same key and body replay the original answer and make no second clone.
 * - **One enhanced event records the act** (`pickup.request.cutoff_exception_resolved`: the decision, the actor, the note and the
 *   replacement link); a reschedule also opens the clone's own timeline with `pickup.request.created`. The answer is the source request
 *   as it now is; a reschedule's carries `replacement_request_id`, which names the request to go on with.
 */
export class CutoffExceptionResolution {
  readonly #options: CutoffExceptionResolutionOptions;

  constructor(options: CutoffExceptionResolutionOptions) {
    this.#options = options;
  }

  async resolve(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: CutoffResolutionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<ResolvedRequest> {
    const { runner, audit, idempotency } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { decision } = request.body;
    const note = requiredNote(request.body.note);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: actor,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StoredAnswer;
        return { request: stored.request, etag: stored.etag };
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }

      const loaded = await loadRequest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      requireCurrent(request.ifMatch, loaded);
      const { row } = loaded;
      if (row.state !== 'CONFIRMED' || row.cutoff_exception_state !== 'PENDING_OPS_REVIEW') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The request is not waiting for a decision on its cutoff',
        );
      }

      const resolved =
        decision === 'APPROVE_SAME_DAY'
          ? await this.#approve(tx, id)
          : await this.#reschedule(tx, row, actor);

      const hubId = resolved.source.responsible_hub_id;
      const vendor =
        resolved.source.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: resolved.source.vendor_organization_id };
      await audit.write(handle, {
        code: 'pickup.request.cutoff_exception_resolved',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: hubId,
        ...vendor,
        previousState: 'CONFIRMED',
        resultingState: resolved.source.state,
        note,
        // What the decision changed, as a safe diff (audit.md section 6): the exception always, the state and the link when rescheduled.
        beforeAfter: {
          cutoff_exception_state: {
            before: 'PENDING_OPS_REVIEW',
            after: resolved.source.cutoff_exception_state,
          },
          ...(resolved.source.state === 'CONFIRMED'
            ? {}
            : { state: { before: 'CONFIRMED', after: resolved.source.state } }),
          ...(resolved.replacementId === null
            ? {}
            : { replacement_request_id: { before: null, after: resolved.replacementId } }),
        },
        relatedIds:
          resolved.replacementId === null ? {} : { replacement_request_id: resolved.replacementId },
        detail: { decision, cutoff_exception_state: resolved.source.cutoff_exception_state },
      });
      if (resolved.replacementId !== null) {
        await auditReplacementCreated(audit, handle, row, resolved.replacementId);
      }

      // The exception the request shows is unchanged by the decision, and it is part of the representation and so of the token.
      const view = viewOf(resolved.source, { exception: loaded.view.one_package_exception });
      const etag = pickupRequestEtagOf(view, resolved.source.version);
      const answer: StoredAnswer = { etag, request: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { request: view, etag };
    });
  }

  /** The request stays confirmed for its day; only its exception is settled. */
  async #approve(
    tx: DatabaseTransaction,
    id: string,
  ): Promise<{ source: PickupRequestRow; replacementId: null }> {
    const updated = await tx.execute(sql`
      update pickup_request set cutoff_exception_state = 'SAME_DAY_APPROVED'
       where id = ${id}::uuid and state = 'CONFIRMED' and cutoff_exception_state = 'PENDING_OPS_REVIEW'
      returning ${REQUEST_COLUMNS}`);
    const source = updated.rows[0] as unknown as PickupRequestRow | undefined;
    // Under the lock and having read the row in that state, the update cannot miss it.
    if (source === undefined)
      throw new Error('A locked request waiting for a decision was not settled');
    return { source, replacementId: null };
  }

  /** The clone first (it names the source, which exists), then the source (which names the clone), in the one transaction. */
  async #reschedule(
    tx: DatabaseTransaction,
    row: PickupRequestRow,
    actor: string,
  ): Promise<{ source: PickupRequestRow; replacementId: string }> {
    const instant = await this.#now(tx);
    // A request confirmed days late has a service date that has passed: the next operating day is counted from the later of the two, and the
    // attempt is the same one (nothing was attempted).
    const replacementId = await replaceRequest(tx, {
      source: row,
      actor,
      clock: this.#options.clock,
      instant,
      attempt: 'SAME',
    });

    const updated = await tx.execute(sql`
      update pickup_request
         set state = 'CANCELLED', cancelled_at = ${instant.toISOString()}::timestamptz, cancelled_by = ${actor}::uuid,
             cancelled_by_actor_type = 'OPS', cutoff_exception_state = 'RESCHEDULED', replacement_request_id = ${replacementId}::uuid
       where id = ${row.id}::uuid and state = 'CONFIRMED' and cutoff_exception_state = 'PENDING_OPS_REVIEW'
      returning ${REQUEST_COLUMNS}`);
    const source = updated.rows[0] as unknown as PickupRequestRow | undefined;
    if (source === undefined)
      throw new Error('A locked request waiting for a decision was not settled');
    return { source, replacementId };
  }

  /** The instant of the decision: the database's, as the cutoff and the settings are read on it. */
  async #now(tx: DatabaseTransaction): Promise<Date> {
    const found = await tx.execute(sql`select clock_timestamp() as instant`);
    const instant = (found.rows[0] as { instant: string | Date } | undefined)?.instant;
    if (instant === undefined) throw new Error('The database gave no time');
    return instant instanceof Date ? instant : new Date(instant);
  }
}
