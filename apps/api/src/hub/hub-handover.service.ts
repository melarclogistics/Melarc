import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { CollectedRequest, RunAccess } from '../platform/domain-ports/run-access.port.js';
import type { RunCustody } from '../platform/domain-ports/run-custody.port.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { hubCodeOf, operationalCode } from '../platform/records/operational-code.js';
import { momentOf } from '../platform/time/device-moment.js';
import {
  HUB_INTAKE_PRE_COUNT_COLUMNS,
  hubIntakePreCountOf,
  type HubIntakePreCountRow,
  type HubIntakePreCountView,
} from './hub-intake-view.js';

const OPERATION = 'submitHubHandover';

/** The attempts at an operational code that no other intake holds (the table's unique index decides; a draw that collides is drawn again). */
const CODE_ATTEMPTS = 8;

export interface HubHandoverOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the intakes are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
  /** The run, in the `pickup` domain's words: read, locked, versioned, its stops and its completion (`platform/domain-ports/run-access.port.ts`). */
  readonly runs: RunAccess;
  /** The custody of the run's parcels, in the `fleet` domain's words (`platform/domain-ports/run-custody.port.ts`). */
  readonly custody: RunCustody;
}

export interface HubHandoverRowBody {
  readonly pickup_request_id: string;
  readonly declared_count: number;
}

export interface HubHandoverBody {
  readonly rows: readonly HubHandoverRowBody[];
  readonly captured_at: string;
  readonly note?: string;
}

export interface SubmittedHandover {
  readonly intakes: readonly HubIntakePreCountView[];
}

/** What a retry with the same key is answered with, byte for byte. */
type StoredHandover = SubmittedHandover;

/**
 * A run that is not the rider's, and an id that matches nothing, are **one answer** (`errors-and-enums.md`: a rider who acts on work that is not its own is told `NOT_ASSIGNED_RIDER`):
 * the rider's context shows it the run it is assigned to, and the run it holds the parcels of.
 */
const notTheRidersWork = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not work assigned to you');

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * The refusals of the rows, each naming the row. The rows must be exactly the run's collected requests, each once: a row that names a request that was not collected on the run
 * (a failed or skipped one, another run's, one that does not exist) or one that is repeated is named by its place; a collected request that has no row is named by its identifier.
 */
function rowViolations(
  rows: readonly HubHandoverRowBody[],
  collected: readonly CollectedRequest[],
): Record<string, unknown>[] {
  const collectedIds = new Set(collected.map((request) => request.pickupRequestId.toLowerCase()));
  const seen = new Set<string>();
  const violations: Record<string, unknown>[] = [];
  for (const [at, row] of rows.entries()) {
    const id = row.pickup_request_id.toLowerCase();
    const pointer = `/rows/${String(at)}/pickup_request_id`;
    if (!collectedIds.has(id)) violations.push({ in: 'body', pointer, rule: 'not_collected' });
    else if (seen.has(id)) violations.push({ in: 'body', pointer, rule: 'repeated' });
    seen.add(id);
  }
  for (const request of collected) {
    if (!seen.has(request.pickupRequestId.toLowerCase())) {
      violations.push({
        in: 'body',
        pointer: '/rows',
        rule: 'missing',
        pickup_request_id: request.pickupRequestId,
      });
    }
  }
  return violations;
}

/**
 * `submitHubHandover` (S1.31; `hub.handover.submit`; `AC-SLICE-001-17`, `-18` (the server half), `-39`, `-44`, `-45`, `-75`, `-76` (its first half) and `-78`;
 * features/hub/hub-intake.md section 5.1; state-machines.md sections 4 and 7; domain-model.md section 6.6; `MSC-DEC-416`): **the custody holder hands the run's collected parcels
 * to the hub, and that is the run's completion.** One intake opens at `AWAITING_COUNT` for each row, and the run moves `IN_PROGRESS` to `COMPLETED`, in one transaction.
 * Receiving is a distinct act (section 22.1): nothing is counted, received or locked here.
 *
 * - **Judged in this order**, so that a caller learns of its own work first: the principal and the key's format; the body (a moment that names an instant, a note the ledger can keep);
 *   then, in the transaction, the retry (`Idempotency-Key`: a replay is answered before anything about the run is judged, since the first call completed it); the run under its lock
 *   (not the rider's, and an id that matches nothing: `NOT_ASSIGNED_RIDER`, one answer); **the custody holder** (`NOT_CUSTODY_HOLDER`: the assigned rider who has handed custody
 *   over, and the receiver of a handover that is still pending, hold nothing, and so does a run the hub holds, OB-S1-48); the run's `ETag` (`STATE_CONFLICT`: the run changed since
 *   the rider read it); that it is in progress (`STATE_CONFLICT`: a run the system completed, with nothing collected, has no handover and no intake, `AC-SLICE-001-78`); that no custody
 *   handover of it is pending (`STATE_CONFLICT`); that every stop is terminal (`STOPS_UNRESOLVED`, `AC-SLICE-001-45`); and that **the rows are exactly the run's collected requests, each
 *   once** (`VALIDATION_FAILED`, naming each row, `AC-SLICE-001-75`).
 * - **The declaration is the row's number, stored as given.** It is never derived from the collected count (`MSC-DEC-194` part 3), a zero is legal, and it is **read by no one before the
 *   blind count**: the answer is `HubIntakePreCount`, which has no such property, and the database holds the declaration in columns that the application's login cannot read (migration
 *   `0092`). What the rider's form was pre-filled with (the collection record's count, read here) is kept beside it, so that **each correction is a fact** (`AC-SLICE-001-44`) and in a
 *   place that is withheld as the declaration is. **No event carries a count**, the declaration or the pre-fill: before the blind count the ledger says that a handover was made, which
 *   intakes it opened and how many, and nothing a receiver could read a number from.
 * - **The device's moment is kept apart from the receipt.** `captured_at` is stored as `declaration_captured_at`, exactly as given (F-35: the bound on a device's clock is an open value,
 *   so a clock days out is kept and not corrected); the receipt, `handed_over_at`, is the database's, and it is the moment the handover completed the run.
 * - **Idempotent**: a replay returns the original answer and opens no second set; another body under the same key is `IDEMPOTENCY_KEY_CONFLICT` (the fingerprint).
 * - **The locks**: the run's, first, and nothing else (the stops are read after it, as the completion by the system reads them). The database holds the rest for every writer: the
 *   holder, the stops, the pending handover, the completion, and at the end of the transaction that the intakes are exactly the collected requests.
 */
export class HubHandovers {
  readonly #options: HubHandoverOptions;

  constructor(options: HubHandoverOptions) {
    this.#options = options;
  }

  async submit(
    authorized: AuthorizedRequest,
    correlationId: string,
    runId: string,
    request: {
      readonly body: HubHandoverBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<SubmittedHandover> {
    const { runner, audit, idempotency, clock, runs, custody } = this.#options;
    if (authorized.session.principalType !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    // A moment the database could not hold, a date that does not exist: malformed bodies, before anything is read.
    const capturedAt = momentOf(body.captured_at);
    if (capturedAt === undefined) throw invalid('/captured_at', 'format');
    for (const [at, row] of body.rows.entries()) {
      if (!Number.isSafeInteger(row.declared_count) || row.declared_count < 0) {
        throw invalid(`/rows/${String(at)}/declared_count`, 'integer');
      }
    }
    let note: string | undefined;
    if (body.note !== undefined && body.note.trim() !== '') {
      const rule = noteRefusal(body.note);
      if (rule !== undefined) throw invalid('/note', rule);
      note = body.note.trim();
    }
    const riderId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'RIDER',
        principalId: riderId,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as StoredHandover;
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

      // The run, under its lock. The rider's context under the key of the handover shows it the run it is assigned to and the run whose parcels it holds, and no other.
      const run = await runs.lockWithVersion(handle, runId);
      if (run === undefined) throw notTheRidersWork();
      if ((await custody.holderOf(handle, run.id)) !== riderId) {
        throw ApiException.of(
          ErrorCode.NotCustodyHolder,
          'You do not hold the parcels of this run',
        );
      }
      runs.requireCurrentVersion(request.ifMatch, run);
      if (run.state !== 'IN_PROGRESS') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The run is not in progress: a run is handed over once, and one with nothing collected completes itself',
          { rule: 'run_not_in_progress' },
        );
      }
      if (await custody.hasPendingHandover(handle, run.id)) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'A custody handover of this run is pending: the run is not handed over to the hub until it is resolved',
          { rule: 'custody_handover_pending' },
        );
      }
      const facts = await runs.handoverFacts(handle, run.id);
      if (facts.stopsToWork > 0) {
        throw ApiException.of(
          ErrorCode.StopsUnresolved,
          'A stop of this run is still to be worked',
          { stops_to_work: facts.stopsToWork },
        );
      }
      if (facts.collected.length === 0) {
        // The system completes such a run when its last stop turns terminal (AC-SLICE-001-78), so a run in progress with nothing left to work and nothing collected is one that
        // is waiting for nothing but a pending handover, which was judged above: nothing is made for it.
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Nothing was collected on this run: it has no handover and no intake',
          { rule: 'nothing_collected' },
        );
      }
      const violations = rowViolations(body.rows, facts.collected);
      if (violations.length > 0) {
        throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
          violations,
        });
      }

      // The run completes first, by the handover, which gives the intakes the receipt they carry (the moment of the completion); the database holds at the end of the transaction that the
      // intakes are exactly the collected requests.
      await runs.completeByHandover(handle, run.id);

      const hubs = await tx.execute(
        sql`select name from hub where id = ${run.responsibleHubId}::uuid`,
      );
      const hubName = (hubs.rows[0] as { name: string } | undefined)?.name;
      if (hubName === undefined) throw new Error('The hub of a run could not be read');
      const hubCode = hubCodeOf(hubName);
      const prefilled = new Map(
        facts.collected.map((collected) => [
          collected.pickupRequestId.toLowerCase(),
          collected.collectedCount,
        ]),
      );

      const opened: HubIntakePreCountRow[] = [];
      for (const row of body.rows) {
        const requestId = row.pickup_request_id.toLowerCase();
        let made: HubIntakePreCountRow | undefined;
        for (let attempt = 0; attempt < CODE_ATTEMPTS && made === undefined; attempt += 1) {
          const inserted = await tx.execute(sql`
            insert into pickup_intake (id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, declaration_captured_at,
                                       rider_declared_count, prefilled_count)
            values (${randomUUIDv7(clock)}::uuid, ${operationalCode(hubCode, 'IN')}, ${run.responsibleHubId}::uuid, ${requestId}::uuid, ${run.id}::uuid,
                    ${riderId}::uuid, ${capturedAt}::timestamptz, ${row.declared_count}, ${prefilled.get(requestId) ?? 0})
            on conflict (code) do nothing
            returning ${HUB_INTAKE_PRE_COUNT_COLUMNS}`);
          made = inserted.rows[0] as unknown as HubIntakePreCountRow | undefined;
        }
        if (made === undefined) throw new Error('No unused operational code could be drawn');
        opened.push(made);
      }

      // The event of the handover (one for the handover, naming the intakes it opened), then the completion it caused. Neither carries a count.
      await audit.write(handle, {
        code: 'hub.handover.submitted',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: run.id },
        responsibleHubId: run.responsibleHubId,
        ...(note === undefined ? {} : { note }),
        relatedIds: {
          pickup_manifest_id: run.id,
          rider_id: riderId,
          intake_ids: opened.map((intake) => intake.id).toSorted(),
        },
        detail: { intakes_opened: opened.length },
      });
      await runs.recordHandoverCompletion(handle, run, riderId);

      const answer: StoredHandover = { intakes: opened.map(hubIntakePreCountOf) };
      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }
}
