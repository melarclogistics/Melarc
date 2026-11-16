import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { receivingRefusalOf } from './check-in.service.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches } from './hub-intake-etag.js';
import type { HubIntakePostCountView } from './hub-intake-view.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  type HubIntakeCheckInView,
  type ReceivingIntakeRow,
} from './receiving-views.js';

const CONDITION_OPERATION = 'recordIntakeCondition';

export interface IntakeFindingsOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the findings are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
}

/** The body of `recordIntakeCondition` as the contract's schema has validated it (the interceptor ran before this). */
export interface IntakeConditionBody {
  readonly condition: 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER';
  readonly note?: string;
  readonly evidence_ids?: readonly string[];
  /** The parcel the condition is a finding of: required for a photo intake, not allowed for a blind-count one. */
  readonly parcel_id?: string;
}

/** The body of `adjudicateDiscrepancy` as the contract's schema has validated it. */
export interface DiscrepancyBody {
  readonly outcome: 'ACCEPTED' | 'ESCALATED' | 'WRITTEN_OFF' | 'VENDOR_NOTIFIED';
  readonly condition?: 'OK' | 'DAMAGED' | 'TAMPERED' | 'OTHER';
  readonly evidence_ids?: readonly string[];
  readonly note: string;
}

/**
 * The answer of both operations, and what a retry of the condition with the same key is answered with, byte for byte: the intake as it is now, and its `ETag`. A photo intake is answered as
 * `HubIntakeCheckIn` and a blind-count one as `HubIntakePostCount` (a finding is made after its count).
 */
export interface FoundIntake {
  readonly intake: HubIntakePostCountView | HubIntakeCheckInView;
  readonly etag: string;
}

/** What the database says of the move it made. */
interface Moved {
  readonly previous_state: string;
  readonly resulting_state: string;
}

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

const evidenceOf = (ids: readonly string[] | undefined): readonly string[] => {
  const given = (ids ?? []).map((id) => id.toLowerCase());
  if (new Set(given).size !== given.length) throw invalid('/evidence_ids', 'unique');
  return given;
};

const needsEvidence = (condition: string | undefined): boolean =>
  condition === 'DAMAGED' || condition === 'TAMPERED';

/** The array literal of identifiers, bound as one parameter and cast, so that nothing is concatenated into a statement. */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** The number the hub counted, in whichever shape the intake is answered in (a photo intake's is its `received_count`, a blind-count intake's its `physical_count`). */
const countedOf = (intake: HubIntakePostCountView | HubIntakeCheckInView): number | null =>
  intake.count_phase === 'CHECK_IN' ? intake.received_count : intake.physical_count;

/**
 * `recordIntakeCondition` and `adjudicateDiscrepancy` (S1.34 and S1.35b; `hub.intake.count` and `hub.osd.adjudicate`; `AC-SLICE-001-41`, `-42`, `-76`, `-96`, `-99` and `-100`; features/hub/hub-intake.md
 * sections 5.1, 5.2, 5.6 and 5.7; state-machines.md section 7; `MSC-DEC-416`, D-05, D-07, D-14, D-D4): what is found at an intake, and what Senior Ops decides of it. A photo intake answers both as
 * `HubIntakeCheckIn` and a blind-count intake as `HubIntakePostCount`, with its `condition_findings`.
 *
 * - **A finding explains a discrepancy; it never changes a count.** The declared count, the hub count and the variance survive every finding unchanged: the database writes the finding and moves the intake
 *   in one change (`melarc.record_intake_condition`, `melarc.adjudicate_discrepancy`, migrations `0096` and `0105`), and the guard of the table holds that no count moves.
 * - **The condition is the receiver's, and independent of the count and of the dispute** (§22.5, §35.5.4). **A blind-count intake** records it after the count and before itemization starts, **once for the
 *   intake**: the finding history says so, never what the condition is now (a recording of OK leaves it as it was, and Senior Ops may put it back to OK, which gives the receiver no second turn). **A photo
 *   intake** records it **on one parcel** (`parcel_id`, required: `VALIDATION_FAILED`, rule `parcel_required`), a parcel that has arrived (`parcel_not_arrived`), **once for each parcel**
 *   (`condition_already_recorded`), whether or not the vendor is finished and before itemizing starts: the database judges all of it. `DAMAGED` and `TAMPERED` carry stored evidence of the intake
 *   (`REASON_REQUIRED` when none is attached, `EVIDENCE_NOT_STORED` for a record that is not stored or is not this intake's), and route the case to Senior Ops: an intake cleared for itemization goes back to
 *   reconciliation (OB-S1-98), and `hub.osd.opened` says so. `OK` is a finding and moves nothing.
 * - **The adjudication is Senior Ops's** (and the Platform Admin's): the key `hub.osd.adjudicate` is not Ops Staff's, who are refused `PERMISSION_DENIED` at the guard, whatever they send. It needs a reason in words
 *   (`REASON_REQUIRED`; there is no reason catalogue for it, D-05) and an intake in reconciliation (`STATE_CONFLICT`). `ACCEPTED` and `WRITTEN_OFF` resolve the case and clear the intake for itemization;
 *   `ESCALATED` (*Still searching*) records the act and leaves the case open (OB-S1-100). **`VENDOR_NOTIFIED` (*Vendor told*) is a record and nothing else** (D-D4): accepted after an earlier `WRITTEN_OFF` of the
 *   intake, once, in any state past the count; it moves no state, sets no condition and sends nothing. A condition an adjudication gives sets the intake's condition. `hub.osd.resolved` is written, enhanced, for every
 *   adjudication.
 * - **Judged in this order**: the principal (and the key's format, for the condition); the body, the note included; then, in the transaction, the retry (the condition only: a replay is answered before anything is
 *   judged; the adjudication has no key and is made safe by its state), the intake under its lock (`NOT_FOUND`; the route's guard has told `HUB_SCOPE_VIOLATION` for another hub's), the `ETag` the receiver read
 *   (`STATE_CONFLICT`, rule `stale`: missing, weak, another intake's and out of date are one answer), the state (`STATE_CONFLICT`, rule `intake_not_counted`, `itemization_started`,
 *   `condition_already_recorded`, `parcel_not_arrived`, `not_awaiting_resolution`, `not_written_off` or `vendor_already_told`), the reason (`REASON_REQUIRED`) and the evidence (`EVIDENCE_NOT_STORED`). The database
 *   repeats every rule for every writer and names the rule of each refusal.
 */
export class HubIntakeFindings {
  readonly #options: IntakeFindingsOptions;

  constructor(options: IntakeFindingsOptions) {
    this.#options = options;
  }

  async recordCondition(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: IntakeConditionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<FoundIntake> {
    const { runner, audit, idempotency, clock } = this.#options;
    this.#requireStaff(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    const evidence = evidenceOf(body.evidence_ids);
    let note: string | null = null;
    if (body.note !== undefined && body.note.trim() !== '') {
      const rule = noteRefusal(body.note);
      if (rule !== undefined) throw invalid('/note', rule);
      note = body.note.trim();
    }
    const staff = authorized.session.principalId.toLowerCase();
    const parcel = body.parcel_id === undefined ? null : body.parcel_id.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: staff,
        operationId: CONDITION_OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as FoundIntake;
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

      const row = await this.#lock(handle, authorized, id, request.ifMatch);
      if (row.receiving_mode === 'PHOTO_CHECK_IN') {
        // A photo intake's condition is a parcel's; the database judges the parcel, its state, the once and the evidence, in its own order.
        if (parcel === null) throw invalid('/parcel_id', 'parcel_required');
      } else {
        if (parcel !== null) throw invalid('/parcel_id', 'not_allowed');
        if (row.state === 'AWAITING_COUNT') {
          throw ApiException.of(ErrorCode.StateConflict, 'The intake has not been counted', {
            rule: 'intake_not_counted',
          });
        }
        if (row.state !== 'READY_FOR_ITEMIZATION' && row.state !== 'RECONCILIATION_REQUIRED') {
          throw ApiException.of(ErrorCode.StateConflict, 'Itemization has started', {
            rule: 'itemization_started',
          });
        }
        // Once, judged by the history under the intake's lock (the row is locked by `#lock`): a recording of OK leaves the condition as it was and an adjudication may put it back, so what the intake's
        // condition is now cannot say whether the receiver has recorded. A condition that is not OK stands until it is adjudicated, recorded by the receiver or not. The database holds both (migration 0097).
        const recorded = await tx.execute(
          sql`select 1 from pickup_intake_finding where pickup_intake_id = ${id}::uuid and kind = 'CONDITION' limit 1`,
        );
        if (recorded.rows.length > 0 || row.condition !== 'OK') {
          throw ApiException.of(ErrorCode.StateConflict, 'A condition has been recorded', {
            rule: 'condition_already_recorded',
          });
        }
        if (needsEvidence(body.condition) && evidence.length === 0) {
          throw ApiException.of(
            ErrorCode.ReasonRequired,
            'Supporting evidence is required for damage or tampering',
          );
        }
      }

      const finding = randomUUIDv7(clock);
      let moved: Moved | undefined;
      try {
        const done = await tx.execute(sql`
          select previous_state, resulting_state
            from melarc.record_intake_condition(${id}::uuid, ${finding}::uuid, ${body.condition}, ${note}, ${uuidArray(evidence)}, ${parcel}::uuid)`);
        moved = done.rows[0] as unknown as Moved | undefined;
      } catch (error) {
        throw receivingRefusalOf(error, '/parcel_id') ?? error;
      }
      if (moved === undefined) throw new Error('A locked intake was not given its condition');

      const found = await this.#read(tx, id, staff);
      await audit.write(handle, {
        code: 'hub.intake.condition_recorded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: found.row.responsible_hub_id,
        previousState: moved.previous_state,
        resultingState: moved.resulting_state,
        ...(note === null ? {} : { note }),
        relatedIds: {
          pickup_manifest_id: found.row.pickup_manifest_id,
          pickup_request_id: found.row.pickup_request_id,
          finding_id: finding,
          ...(parcel === null ? {} : { parcel_id: parcel }),
        },
        detail: { condition: body.condition, evidence_count: evidence.length },
      });
      if (moved.previous_state !== moved.resulting_state) {
        // The condition sent a case that was cleared for itemization to Senior Ops: the OS&D case opens here (§22.5).
        await audit.write(handle, {
          code: 'hub.osd.opened',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupIntake', id },
          responsibleHubId: found.row.responsible_hub_id,
          previousState: moved.previous_state,
          resultingState: moved.resulting_state,
          relatedIds: {
            pickup_manifest_id: found.row.pickup_manifest_id,
            pickup_request_id: found.row.pickup_request_id,
            finding_id: finding,
          },
          detail: { dimension: 'CONDITION', condition: body.condition },
        });
      }

      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(found.answer)),
      });
      return found.answer;
    });
  }

  async adjudicate(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly body: DiscrepancyBody; readonly ifMatch: string | undefined },
  ): Promise<FoundIntake> {
    const { runner, audit, clock } = this.#options;
    this.#requireStaff(authorized);
    const { body } = request;
    // A blank reason explains nothing and is REASON_REQUIRED, not a malformed body; then the ledger's own screening of what a person wrote.
    const note = requiredNote(body.note).trim();
    const evidence = evidenceOf(body.evidence_ids);
    const staff = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const row = await this.#lock(handle, authorized, id, request.ifMatch);
      if (body.outcome === 'VENDOR_NOTIFIED') {
        // A record of what was said to the vendor: it sets no condition (the database holds the rest: after a write-off, once).
        if (body.condition !== undefined) throw invalid('/condition', 'not_allowed');
      } else if (row.state !== 'RECONCILIATION_REQUIRED') {
        throw ApiException.of(ErrorCode.StateConflict, 'The intake is not awaiting a resolution', {
          rule: 'not_awaiting_resolution',
        });
      }
      if (needsEvidence(body.condition) && evidence.length === 0) {
        throw ApiException.of(
          ErrorCode.ReasonRequired,
          'Supporting evidence is required for damage or tampering',
        );
      }

      const finding = randomUUIDv7(clock);
      let moved: Moved | undefined;
      try {
        const done = await tx.execute(sql`
          select previous_state, resulting_state
            from melarc.adjudicate_discrepancy(${id}::uuid, ${finding}::uuid, ${body.outcome}, ${body.condition ?? null}, ${note}, ${uuidArray(evidence)})`);
        moved = done.rows[0] as unknown as Moved | undefined;
      } catch (error) {
        throw receivingRefusalOf(error, '/outcome') ?? error;
      }
      if (moved === undefined) throw new Error('A locked intake was not adjudicated');

      const found = await this.#read(tx, id, staff);
      const resolved = body.outcome === 'ACCEPTED' || body.outcome === 'WRITTEN_OFF';
      await audit.write(handle, {
        code: 'hub.osd.resolved',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: found.row.responsible_hub_id,
        previousState: moved.previous_state,
        resultingState: moved.resulting_state,
        note,
        beforeAfter: {
          state: { before: moved.previous_state, after: moved.resulting_state },
          condition: { before: row.condition, after: found.row.condition },
        },
        relatedIds: {
          pickup_manifest_id: found.row.pickup_manifest_id,
          pickup_request_id: found.row.pickup_request_id,
          finding_id: finding,
        },
        // The comparison the adjudication explains is carried unchanged: it is the first place the three OS&D dimensions are told together.
        detail: {
          outcome: body.outcome,
          resolved,
          ...(body.condition === undefined ? {} : { condition: body.condition }),
          physical_count: countedOf(found.answer.intake),
          rider_declared_count: found.answer.intake.rider_declared_count,
          count_variance: found.answer.intake.count_variance,
          count_difference: found.answer.intake.count_difference,
          evidence_count: evidence.length,
        },
      });
      return found.answer;
    });
  }

  /** The staff of the Ops Portal alone: a vendor and a rider never reach the service (the route's surface and key), and this does not rely on that alone. */
  #requireStaff(authorized: AuthorizedRequest): void {
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
  }

  /**
   * The intake under its lock, as the receiver read it: `NOT_FOUND` for one that is not in the caller's hubs or does not exist, a hub crossing audited, and the `ETag` of the read compared with the one
   * recomputed here (`STATE_CONFLICT`, rule `stale`). The representation is the one a read answers in the intake's own shape, so that the token the receiver holds is the one compared.
   */
  async #lock(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    id: string,
    ifMatch: string | undefined,
  ): Promise<ReceivingIntakeRow> {
    const tx = transactionOf(handle);
    const found = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid for update`,
    );
    const row = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    await noteHubCrossing(this.#options.audit, handle, authorized, row);
    const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
    const current = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
    if (current === undefined || !hubIntakeEtagMatches(ifMatch, current)) {
      throw ApiException.of(ErrorCode.StateConflict, 'The intake has changed since it was read', {
        rule: 'stale',
      });
    }
    return row;
  }

  /** The intake as it is now, in the shape its mode calls for, with its `ETag`: the answer of both operations. A blind-count intake that has been found about is `HubIntakePostCount`. */
  async #read(
    tx: ReturnType<typeof transactionOf>,
    id: string,
    caller: string,
  ): Promise<{ readonly row: ReceivingIntakeRow; readonly answer: FoundIntake }> {
    const reread = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid`,
    );
    const row = reread.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw new Error('An intake that was found could not be read');
    const loaded = await loadIntakes(tx, [row], caller);
    const photo = loaded.checkIns.get(id);
    if (photo !== undefined) return { row, answer: { intake: photo.view, etag: photo.etag } };
    const blind = loaded.blind.get(id);
    if (blind?.view.count_phase !== 'POST_COUNT') {
      throw new Error('An intake that was found is counted');
    }
    return { row, answer: { intake: blind.view, etag: blind.etag } };
  }
}
