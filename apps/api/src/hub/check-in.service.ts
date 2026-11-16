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
import {
  guardReasonIn,
  guardRuleIn,
  serverErrorIn,
} from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches } from './hub-intake-etag.js';
import type { HubIntakePostCountView } from './hub-intake-view.js';
import {
  RECEIVING_INTAKE_COLUMNS,
  loadIntakes,
  parcelAnswerOf,
  type HubIntakeCheckInView,
  type IntakeCountsView,
  type IntakeParcelView,
  type ReceivingIntakeRow,
} from './receiving-views.js';

export interface HubCheckInsOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the extra parcels are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
}

export interface ParcelArrivalBody {
  readonly arrived: boolean;
}

export interface CheckInFinishBody {
  readonly all_arrived: boolean;
  readonly confirmed_count?: number;
}

export interface ExtraParcelBody {
  readonly photo_evidence_id: string;
  readonly note?: string;
}

export interface IntakeCorrectionBody {
  readonly reason: string;
  readonly parcel_changes?: readonly { readonly parcel_id: string; readonly state: string }[];
  readonly physical_count?: number;
}

/** The answer of the act on one parcel (`IntakeParcelAnswer`). */
export interface ParcelAnswer {
  readonly parcel: IntakeParcelView;
  readonly intake_etag: string;
  readonly counts: IntakeCountsView;
}

/** The answer of the acts on a whole vendor, and what a retry with the same key is answered with, byte for byte: the intake as it is now, and its `ETag`. */
export interface CheckedIntake {
  readonly intake: HubIntakeCheckInView | HubIntakePostCountView;
  readonly etag: string;
}

const OPERATIONS = {
  finish: 'finishCheckIn',
  extra: 'addExtraParcel',
  correct: 'correctIntakeCount',
} as const;

const MAX_PHYSICAL_COUNT = 2_147_483_647;

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * What the database refused, as the answer the contract names: a guard or an operation of the database states its refusal as SQLSTATE 23514 with the code in the DETAIL (`reason=STATE_CONFLICT`) and the
 * `details.rule` in the HINT (`rule=check_in_finished`); a shape it cannot read is 22023; an intake or a parcel the caller's hubs do not show is 42501 (the route's guard has told a miss on another hub's
 * from one that does not exist, so what comes here is `NOT_FOUND`). Anything else is not a refusal the database means and is rethrown.
 */
export function receivingRefusalOf(error: unknown, pointer: string): ApiException | undefined {
  const rule = guardRuleIn(error);
  switch (guardReasonIn(error)) {
    case 'STATE_CONFLICT':
      return ApiException.of(
        ErrorCode.StateConflict,
        'The check-in has changed or is finished',
        rule === undefined ? undefined : { rule },
      );
    case 'REASON_REQUIRED':
      return ApiException.of(ErrorCode.ReasonRequired, 'A reason is required');
    case 'EVIDENCE_NOT_STORED':
      return ApiException.of(
        ErrorCode.EvidenceNotStored,
        'The photo is not stored, or is not this intake’s',
      );
    case 'VALIDATION_FAILED':
      return invalid(pointer, rule ?? 'invalid');
    default:
      break;
  }
  const server = serverErrorIn(error);
  if (server?.code === '22023') return invalid(pointer, 'invalid');
  if (server?.code === '42501') return ApiException.of(ErrorCode.NotFound, 'Not found');
  return undefined;
}

/**
 * The acts of the check-in of a vendor's parcels (Run D, S1.35b; `hub.intake.count`, and `hub.osd.adjudicate` for the correction; features/hub/hub-intake.md sections 5.1, 5.4, 5.6 and 5.8;
 * `AC-SLICE-001-93` to `-96` and `-100`): a tap on a parcel's photo (`recordParcelArrival`), "All N here" or as tapped (`finishCheckIn`), an extra on the table with no door photo (`addExtraParcel`) and
 * a senior officer's correction (`correctIntakeCount`).
 *
 * - **Every change is one operation of the database** (`melarc.record_parcel_arrival`, `finish_check_in`, `add_extra_parcel`, `correct_intake_count`, migration 0104): the machine of the parcel, the
 *   count, the variance and the System's move are the database's, held by the guards for every writer, and this layer judges the retry, the intake under its lock, the `ETag` and the shape of
 *   what was sent, asks the operation, and writes the events. **No number is ever typed for a vendor with photos**: the count is the parcels checked in.
 * - **Judged in this order** (the repo's): the principal and the key's format; the body; then, in the transaction, the retry (`Idempotency-Key`: a replay is answered before anything about the intake is judged),
 *   the intake under its lock (`NOT_FOUND`; the route's guard has told `HUB_SCOPE_VIOLATION` for another hub's), the `ETag` the officer read (`STATE_CONFLICT`, rule `stale`), then the database's own rules,
 *   answered with the `details.rule` the contract names.
 * - **A tap takes no key and no `ETag`** (it states the parcel's desired state and is idempotent by nature) and does not move the intake's `ETag`; an extra takes a key and no `ETag` (two extras are two parcels).
 * - **The lock is advisory and is no guard** (§22.8): no act is refused for it, and none takes or refreshes it (the page takes it on the officer's first act).
 * - **Events:** `hub.intake.counted` (once, when the vendor is finished: the expected, received, missing and extra numbers and the rider's declaration, which a photo intake hides from no one) and `hub.osd.opened`
 *   when a case opens; `hub.parcel.found` for a missing parcel that is checked in; `hub.parcel.extra_added`; `hub.intake.corrected` (enhanced, the reason as its note, the old and the new numbers and the parcels
 *   changed). There is no event for a tap or an untap: the parcel's row says who and when.
 */
export class HubCheckIns {
  readonly #options: HubCheckInsOptions;

  constructor(options: HubCheckInsOptions) {
    this.#options = options;
  }

  async recordArrival(
    authorized: AuthorizedRequest,
    correlationId: string,
    parcelId: string,
    body: ParcelArrivalBody,
  ): Promise<ParcelAnswer> {
    this.#requireStaff(authorized);
    if (typeof body.arrived !== 'boolean') throw invalid('/arrived', 'type');
    const caller = authorized.session.principalId.toLowerCase();
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const owner = await tx.execute(
        sql`select pickup_intake_id from intake_parcel where id = ${parcelId}::uuid`,
      );
      const intakeId = (owner.rows[0] as { pickup_intake_id: string } | undefined)
        ?.pickup_intake_id;
      if (intakeId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      // The intake first, then the parcel: the order of every act of the database layer.
      const before = await this.#lock(handle, authorized, intakeId);
      let moved: { parcel_previous_state: string; parcel_resulting_state: string } | undefined;
      try {
        const done = await tx.execute(
          sql`select parcel_previous_state, parcel_resulting_state from melarc.record_parcel_arrival(${parcelId}::uuid, ${body.arrived})`,
        );
        moved = done.rows[0] as typeof moved;
      } catch (error) {
        throw receivingRefusalOf(error, '/arrived') ?? error;
      }
      if (moved === undefined) throw new Error('A locked parcel was not asked about its arrival');
      const after = await this.#reload(tx, intakeId, caller);
      if (moved.parcel_previous_state === 'MISSING' && moved.parcel_resulting_state === 'ARRIVED') {
        await this.#options.audit.write(handle, {
          code: 'hub.parcel.found',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupIntake', id: intakeId },
          responsibleHubId: after.row.responsible_hub_id,
          previousState: before.state,
          resultingState: after.row.state,
          relatedIds: {
            pickup_manifest_id: after.row.pickup_manifest_id,
            pickup_request_id: after.row.pickup_request_id,
            parcel_id: parcelId,
          },
          detail: {
            received_count_before: before.physical_count ?? 0,
            received_count_after: after.row.physical_count ?? 0,
            count_variance_before: before.count_variance ?? 'NONE',
            count_variance_after: after.row.count_variance ?? 'NONE',
          },
        });
      }
      return parcelAnswerOf(after.view, after.etag, parcelId);
    });
  }

  async finish(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: CheckInFinishBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CheckedIntake> {
    this.#requireStaff(authorized);
    this.#requireKey(request.idempotencyKey);
    const caller = authorized.session.principalId.toLowerCase();
    const { body } = request;
    if (typeof body.all_arrived !== 'boolean') throw invalid('/all_arrived', 'type');
    if (body.all_arrived && body.confirmed_count === undefined) {
      throw invalid('/confirmed_count', 'required');
    }
    if (!body.all_arrived && body.confirmed_count !== undefined) {
      throw invalid('/confirmed_count', 'not_allowed');
    }
    if (
      body.confirmed_count !== undefined &&
      (!Number.isSafeInteger(body.confirmed_count) ||
        body.confirmed_count < 1 ||
        body.confirmed_count > MAX_PHYSICAL_COUNT)
    ) {
      throw invalid('/confirmed_count', 'range');
    }
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const { replay, scope } = await this.#begin(handle, authorized, OPERATIONS.finish, request);
      if (replay !== undefined) return replay;
      const row = await this.#lock(handle, authorized, id);
      await this.#requirePhotoAndCurrent(tx, row, request.ifMatch, authorized);
      let moved:
        | {
            previous_state: string;
            resulting_state: string;
            expected_count: number;
            received_count: number;
            missing_count: number;
            extra_count: number;
            resulting_variance: string;
          }
        | undefined;
      try {
        const done = await tx.execute(sql`
          select previous_state, resulting_state, expected_count, received_count, missing_count, extra_count, resulting_variance
            from melarc.finish_check_in(${id}::uuid, ${body.all_arrived}, ${body.confirmed_count ?? null}::integer)`);
        moved = done.rows[0] as typeof moved;
      } catch (error) {
        throw receivingRefusalOf(error, '/confirmed_count') ?? error;
      }
      if (moved === undefined) throw new Error('A locked vendor was not finished');
      const after = await this.#reload(tx, id, caller);
      const declared = after.view.rider_declared_count;
      await this.#options.audit.write(handle, {
        code: 'hub.intake.counted',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: after.row.responsible_hub_id,
        previousState: 'AWAITING_COUNT',
        resultingState: after.row.state,
        relatedIds: {
          pickup_manifest_id: after.row.pickup_manifest_id,
          pickup_request_id: after.row.pickup_request_id,
        },
        // A photo intake hides nothing (D-D1): the expected, received, missing and extra numbers and the rider's declaration, once, when the vendor is finished.
        detail: {
          receiving_mode: 'PHOTO_CHECK_IN',
          all_arrived: body.all_arrived,
          expected_count: moved.expected_count,
          received_count: moved.received_count,
          missing_count: moved.missing_count,
          extra_count: moved.extra_count,
          rider_declared_count: declared,
          count_variance: moved.resulting_variance,
          count_difference: after.row.count_difference ?? 0,
        },
      });
      if (after.row.state === 'RECONCILIATION_REQUIRED') {
        await this.#opened(handle, after.row, 'COUNTED', {
          dimension:
            moved.resulting_variance !== 'MATCH'
              ? 'VARIANCE'
              : moved.missing_count > 0 || moved.extra_count > 0
                ? 'PARCELS'
                : declared === 0
                  ? 'ZERO_DECLARATION'
                  : 'CONDITION',
          count_variance: moved.resulting_variance,
          missing_count: moved.missing_count,
          extra_count: moved.extra_count,
        });
      }
      const answer: CheckedIntake = { intake: after.view, etag: after.etag };
      await this.#complete(handle, scope, answer);
      return answer;
    });
  }

  async addExtra(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: ExtraParcelBody;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<ParcelAnswer> {
    this.#requireStaff(authorized);
    this.#requireKey(request.idempotencyKey);
    const caller = authorized.session.principalId.toLowerCase();
    const { body } = request;
    let note: string | undefined;
    if (body.note !== undefined && body.note.trim() !== '') {
      const rule = noteRefusal(body.note);
      if (rule !== undefined) throw invalid('/note', rule);
      note = body.note.trim();
    }
    const parcelId = randomUUIDv7(this.#options.clock);
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const { replay, scope } = await this.#begin(handle, authorized, OPERATIONS.extra, request);
      if (replay !== undefined) return replay as unknown as ParcelAnswer;
      const row = await this.#lock(handle, authorized, id);
      if (row.receiving_mode !== 'PHOTO_CHECK_IN') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'An intake counted blind has no parcels to add to',
          { rule: 'blind_count_intake' },
        );
      }
      let added: { extra_parcel_ordinal: number; extra_counted: boolean } | undefined;
      try {
        const done = await tx.execute(sql`
          select extra_parcel_ordinal, extra_counted
            from melarc.add_extra_parcel(${id}::uuid, ${parcelId}::uuid, ${body.photo_evidence_id}::uuid)`);
        added = done.rows[0] as typeof added;
      } catch (error) {
        throw receivingRefusalOf(error, '/photo_evidence_id') ?? error;
      }
      if (added === undefined) throw new Error('A locked intake was not given its extra parcel');
      const after = await this.#reload(tx, id, caller);
      await this.#options.audit.write(handle, {
        code: 'hub.parcel.extra_added',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: after.row.responsible_hub_id,
        previousState: row.state,
        resultingState: after.row.state,
        ...(note === undefined ? {} : { note }),
        relatedIds: {
          pickup_manifest_id: after.row.pickup_manifest_id,
          pickup_request_id: after.row.pickup_request_id,
          parcel_id: parcelId,
          evidence_id: body.photo_evidence_id.toLowerCase(),
        },
        detail: {
          extra_counted: added.extra_counted,
          received_count: after.row.physical_count ?? 0,
          extra_count: after.view.extra_count,
        },
      });
      const answer = parcelAnswerOf(after.view, after.etag, parcelId);
      await this.#complete(handle, scope, answer as unknown as CheckedIntake);
      return answer;
    });
  }

  async correct(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: IntakeCorrectionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CheckedIntake> {
    this.#requireStaff(authorized);
    this.#requireKey(request.idempotencyKey);
    const caller = authorized.session.principalId.toLowerCase();
    const { body } = request;
    // A blank reason explains nothing and is REASON_REQUIRED, not a malformed body; then the ledger's own screening of what a person wrote.
    const reason = requiredNote(body.reason).trim();
    if (body.parcel_changes !== undefined && body.physical_count !== undefined) {
      throw invalid('/', 'mode_mismatch');
    }
    if (body.parcel_changes === undefined && body.physical_count === undefined) {
      throw invalid('/', 'mode_mismatch');
    }
    if (
      body.physical_count !== undefined &&
      (!Number.isSafeInteger(body.physical_count) ||
        body.physical_count < 0 ||
        body.physical_count > MAX_PHYSICAL_COUNT)
    ) {
      throw invalid('/physical_count', 'range');
    }
    return this.#options.runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const { replay, scope } = await this.#begin(handle, authorized, OPERATIONS.correct, request);
      if (replay !== undefined) return replay;
      const row = await this.#lock(handle, authorized, id);
      await this.#requireCurrent(tx, row, request.ifMatch, authorized);
      let moved:
        | {
            previous_state: string;
            resulting_state: string;
            old_received: number;
            new_received: number;
            old_variance: string;
            new_variance: string;
            changed: unknown;
          }
        | undefined;
      try {
        const done = await tx.execute(sql`
          select previous_state, resulting_state, old_received, new_received, old_variance, new_variance, changed
            from melarc.correct_intake_count(${id}::uuid, ${reason}, ${body.parcel_changes === undefined ? null : JSON.stringify(body.parcel_changes)}::jsonb, ${body.physical_count ?? null}::integer)`);
        moved = done.rows[0] as typeof moved;
      } catch (error) {
        throw (
          receivingRefusalOf(
            error,
            body.parcel_changes === undefined ? '/physical_count' : '/parcel_changes',
          ) ?? error
        );
      }
      if (moved === undefined) throw new Error('A locked intake was not corrected');
      const after = await this.#reload(tx, id, caller);
      const changed = Array.isArray(moved.changed)
        ? (moved.changed as Record<string, unknown>[])
        : [];
      await this.#options.audit.write(handle, {
        code: 'hub.intake.corrected',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: after.row.responsible_hub_id,
        previousState: moved.previous_state,
        resultingState: moved.resulting_state,
        note: reason,
        beforeAfter: {
          state: { before: moved.previous_state, after: moved.resulting_state },
          physical_count: { before: moved.old_received, after: moved.new_received },
          count_variance: { before: moved.old_variance, after: moved.new_variance },
          ...(changed.length === 0
            ? {}
            : {
                parcels: changed.map((each) => ({
                  parcel_id: String(each['parcel_id']),
                  from: String(each['from']),
                  to: String(each['to']),
                })),
              }),
        },
        relatedIds: {
          pickup_manifest_id: after.row.pickup_manifest_id,
          pickup_request_id: after.row.pickup_request_id,
        },
        detail: {
          receiving_mode: row.receiving_mode,
          parcels_changed: changed.length,
        },
      });
      if (
        moved.previous_state !== 'RECONCILIATION_REQUIRED' &&
        moved.resulting_state === 'RECONCILIATION_REQUIRED'
      ) {
        await this.#opened(handle, after.row, moved.previous_state, {
          dimension: 'CORRECTION',
          count_variance: moved.new_variance,
        });
      }
      const answer: CheckedIntake = { intake: after.view, etag: after.etag };
      await this.#complete(handle, scope, answer);
      return answer;
    });
  }

  /** The staff of the Ops Portal alone: a vendor and a rider never reach the service (the route's surface and key), and this does not rely on that alone. */
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

  /** The retry: a replay is answered before anything about the intake is judged, another body under the same key is a conflict, and a record that began and did not complete is stranded. */
  async #begin(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    operationId: string,
    request: { readonly idempotencyKey: string; readonly fingerprint: string },
  ): Promise<{
    readonly replay: CheckedIntake | undefined;
    readonly scope: {
      readonly principalType: 'STAFF';
      readonly principalId: string;
      readonly operationId: string;
      readonly key: string;
    };
  }> {
    const scope = {
      principalType: 'STAFF',
      principalId: authorized.session.principalId.toLowerCase(),
      operationId,
      key: request.idempotencyKey,
    } as const;
    const begun = await this.#options.idempotency.begin(handle, scope, request.fingerprint);
    if (begun.outcome === 'REPLAY') {
      return {
        replay: JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as CheckedIntake,
        scope,
      };
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
    return { replay: undefined, scope };
  }

  async #complete(
    handle: TransactionHandle,
    scope: {
      readonly principalType: 'STAFF';
      readonly principalId: string;
      readonly operationId: string;
      readonly key: string;
    },
    answer: CheckedIntake,
  ): Promise<void> {
    await this.#options.idempotency.complete(handle, scope, {
      status: 200,
      body: new TextEncoder().encode(JSON.stringify(answer)),
    });
  }

  /** The intake under its lock: `NOT_FOUND` for one that is not in the caller's hubs or does not exist, and a hub crossing audited. */
  async #lock(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
    id: string,
  ): Promise<ReceivingIntakeRow> {
    const tx = transactionOf(handle);
    const found = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid for update`,
    );
    const row = found.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    await noteHubCrossing(this.#options.audit, handle, authorized, row);
    return row;
  }

  /** A photo intake only (a blind-count intake is counted, not checked in), and the `ETag` of the read the officer made (`stale`: missing, weak, another intake's and out of date are one answer). */
  async #requirePhotoAndCurrent(
    tx: ReturnType<typeof transactionOf>,
    row: ReceivingIntakeRow,
    ifMatch: string | undefined,
    authorized: AuthorizedRequest,
  ): Promise<void> {
    if (row.receiving_mode !== 'PHOTO_CHECK_IN') {
      throw ApiException.of(
        ErrorCode.StateConflict,
        'An intake counted blind is counted, not checked in',
        { rule: 'blind_count_intake' },
      );
    }
    await this.#requireCurrent(tx, row, ifMatch, authorized);
  }

  async #requireCurrent(
    tx: ReturnType<typeof transactionOf>,
    row: ReceivingIntakeRow,
    ifMatch: string | undefined,
    authorized: AuthorizedRequest,
  ): Promise<void> {
    const loaded = await loadIntakes(tx, [row], authorized.session.principalId.toLowerCase());
    const current = loaded.checkIns.get(row.id)?.etag ?? loaded.blind.get(row.id)?.etag;
    if (current === undefined || !hubIntakeEtagMatches(ifMatch, current)) {
      throw ApiException.of(ErrorCode.StateConflict, 'The intake has changed since it was read', {
        rule: 'stale',
      });
    }
  }

  /** The intake as it is now, in the shape its mode calls for, with its `ETag`: what every act answers from. The photo shape is what the acts on parcels need. */
  async #reload(
    tx: ReturnType<typeof transactionOf>,
    id: string,
    caller: string,
  ): Promise<{
    readonly row: ReceivingIntakeRow;
    readonly view: HubIntakeCheckInView;
    readonly etag: string;
  }> {
    const reread = await tx.execute(
      sql`select ${RECEIVING_INTAKE_COLUMNS} from pickup_intake where id = ${id}::uuid`,
    );
    const row = reread.rows[0] as unknown as ReceivingIntakeRow | undefined;
    if (row === undefined) throw new Error('An intake that was found could not be read');
    // The caller is the officer who acts: whose lock it is shown as is the officer's own.
    const loaded = await loadIntakes(tx, [row], caller);
    const photo = loaded.checkIns.get(id);
    if (photo !== undefined) return { row, view: photo.view, etag: photo.etag };
    const blind = loaded.blind.get(id);
    if (blind === undefined) throw new Error('An intake is loaded in one of its shapes');
    // A blind-count intake answers `HubIntakePostCount` (the correction of a blind count): the view is that shape and the parcel helpers are never asked of it.
    return { row, view: blind.view as unknown as HubIntakeCheckInView, etag: blind.etag };
  }

  /** The OS&D case opens (`hub.osd.opened`): by a finished vendor that lands in reconciliation, or by a correction that sends a cleared intake back. */
  async #opened(
    handle: TransactionHandle,
    row: ReceivingIntakeRow,
    previous: string,
    detail: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    await this.#options.audit.write(handle, {
      code: 'hub.osd.opened',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'PickupIntake', id: row.id },
      responsibleHubId: row.responsible_hub_id,
      previousState: previous,
      resultingState: row.state,
      relatedIds: {
        pickup_manifest_id: row.pickup_manifest_id,
        pickup_request_id: row.pickup_request_id,
      },
      detail,
    });
  }
}
