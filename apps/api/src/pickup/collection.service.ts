import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import {
  COLLECTION_RECORD_COLUMNS,
  collectionRecordViewOf,
  type CollectionRecordRow,
  type CollectionRecordView,
} from './collection-record-view.js';
import { momentOf } from './device-moment.js';
import { stopViewOf, STOP_COLUMNS, type PickupStopRow } from './pickup-manifest-view.js';
import { reasonRefusedByGuard, validatedReason } from './pickup-reason-validation.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';
import { pickupReasonRequest } from './pickup-vocabulary.js';

const OPERATION = 'recordCollection';

export interface CollectionOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the records are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
}

export interface CollectionBody {
  readonly collected_count: number;
  readonly variance_reason_code?: string;
  readonly variance_note?: string;
  readonly evidence_ids?: readonly string[];
  readonly captured_at?: string;
}

export interface RecordedCollection {
  readonly record: CollectionRecordView;
}

interface StoredCollection {
  readonly record: CollectionRecordView;
}

/** The stop as the act reads it under its lock: the columns of its representation, its version, its hub, and the dispatch-time summary's count. */
interface LockedStop extends PickupStopRow {
  readonly version: number;
  readonly responsible_hub_id: string;
}

const invalid = (name: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: `/${name}`, rule }],
  });

/** A stop that is not the rider's, and an id that matches nothing, are one answer: a rider who acts on work that is not its own is told so. */
const notTheRidersWork = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not work assigned to you');

/**
 * `recordCollection` (S1.26; `pickup.collection.confirm`; `AC-SLICE-001-20`, `-21`, `-28` and `-29`; pickup-collection.md; state-machines.md section 5;
 * domain-model.md section 6.5): the rider says what it **counted** at the door. Written for the Product Owner's decision of 29 October 2026, "count,
 * then confirm" (D-04 option 1): the count makes the record, **the stop stays `ARRIVED`**, and the handshake (the next task) is what closes it.
 *
 * - **Judged in this order**, so that a caller learns of its own work first: the principal and the key's format; a count of zero, which is a failed
 *   pickup (`ZERO_COLLECTION_IS_FAILURE`: nothing is made, no sender is promoted, no handover is touched); then, in the transaction, the retry
 *   (`Idempotency-Key`); the stop under its lock (not the rider's: `NOT_ASSIGNED_RIDER`, one answer); the run (`MANIFEST_NOT_STARTED`,
 *   `STATE_CONFLICT`); the stop's `ETag`; that the stop was arrived at and has no record; the evidence (none can be `STORED` yet: this task builds no
 *   evidence, so a reference is `EVIDENCE_NOT_STORED`); and the count against what the stop declared.
 * - **The actual count, never the declared one.** The declared count is what the stop's dispatch-time summary said (the rider was shown it, and it is
 *   the one request fact the rider's context reads as itself). Fewer is a `SHORT` count and needs a reason of the `PICKUP_SHORT_COUNT` catalogue
 *   with the note and the photo its metadata asks for (`REASON_REQUIRED`); equal is `MATCH`, which has no reason; **more than was declared is not a
 *   variance either section names and is refused** (`VALIDATION_FAILED`, OB-S1-50). `variance` is recorded on every collection.
 * - **A shortfall raises the office flag in the same transaction**: `office_notified_at` is the database's own instant, taken with `recorded_at` once the
 *   stop's lock is held (the record's guard, migration 0069, OB-S1-60: this act gives the database neither), and the count's event says that it was
 *   raised (`office_notified`). The reason of the record is held to the catalogue by the same guard, at the insert: a catalogue that changed after this
 *   act read it is `REASON_NOT_ACTIVE` (or `REASON_REQUIRED`), the act is undone and the same key is a retry. No message is queued: no document defines
 *   the office message (OB-S1-51).
 * - **One event, the count's own** (`pickup.collection.recorded`, OB-S1-54), the same for a clean count and a short one: its object is the record, it
 *   names the stop, its run and request, the rider and the hub, carries the counts, the variance, the flag and the direction, and says the stop is
 *   still `ARRIVED`. It carries no note. `pickup.stop.collected` and `pickup.stop.partially_collected` are the handshake's, written when it closes
 *   the stop (S1.27), and the ledger admits neither to the counting key.
 * - **An individual sender is promoted** (`PROVISIONAL` to `REUSABLE`, `pickup.sender.promoted`) by the count, without waiting for the handshake. The
 *   direction of the handshake is fixed by the kind of sender and is kept on the record (and the record's guard holds that it is the direction the
 *   sender fixes, for every writer under this key); nothing of the handshake is run here. **This act reads no request and no sender, updates no sender
 *   and writes no event of the promotion**: the database answers the direction (`melarc.collection_handshake_type`) and makes the promotion
 *   (`melarc.promote_collected_sender`, which refuses a stop this rider has not counted and writes the promotion's event in the same change), the two
 *   narrow operations of migration 0068 (OB-S1-53). The ledger admits that event to the operation alone, so no marker or claim of this act could write it.
 * - **The locks**: the stop alone, as the arrival does, and nothing else is locked. A collection that commits first is kept: the cancellation of the
 *   request and Ops's skip lock the stop, look for a record and are refused (`STATE_CONFLICT`), and the database holds it for every writer
 *   (`pickup_stop_collection_kept`; the record's own guard takes the stop's lock before it judges the stop, so a direct insert and a skip meet in
 *   either order). A cancellation that commits first has skipped the stop, which is then not `ARRIVED`.
 * - **Idempotent**: a replay returns the original answer and makes no second record (the unique key of the stop is the backstop); another body under the
 *   same key is `IDEMPOTENCY_KEY_CONFLICT` (the fingerprint).
 * - **It does not seed anything**: the count is kept on the record and read by nothing that counts; the hub's declared count at intake is the
 *   hand-over's, captured separately (`MSC-DEC-194` part 3).
 */
export class Collections {
  readonly #options: CollectionOptions;

  constructor(options: CollectionOptions) {
    this.#options = options;
  }

  async record(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: {
      readonly body: CollectionBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<RecordedCollection> {
    const { runner, audit, idempotency, clock, reasons } = this.#options;
    if (authorized.session.principalType !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    if (!Number.isSafeInteger(body.collected_count) || body.collected_count < 0) {
      throw invalid('collected_count', 'integer');
    }
    // A count of zero is a failed pickup, whatever else is true: nothing is made.
    if (body.collected_count === 0) {
      throw ApiException.of(
        ErrorCode.ZeroCollectionIsFailure,
        'A count of zero is a failed pickup: report the failure',
      );
    }
    // What the ledger could not keep, and a moment the database could not hold, are malformed bodies, before anything is read.
    if (body.variance_note !== undefined && body.variance_note.trim() !== '') {
      const rule = noteRefusal(body.variance_note);
      if (rule !== undefined) throw invalid('variance_note', rule);
    }
    let capturedAt: string | undefined;
    if (body.captured_at !== undefined) {
      capturedAt = momentOf(body.captured_at);
      if (capturedAt === undefined) throw invalid('captured_at', 'format');
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
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StoredCollection;
        return { record: stored.record };
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

      // The stop, under its lock and nothing else. A rider is shown the stops of its own dispatched runs and no other, so one that comes back is its own.
      const found = await tx.execute(sql`
        select ${STOP_COLUMNS}, version, responsible_hub_id from pickup_stop where id = ${stopId}::uuid for update`);
      const stop = found.rows[0] as unknown as LockedStop | undefined;
      if (stop === undefined) throw notTheRidersWork();

      const runs = await tx.execute(
        sql`select state from pickup_manifest where id = ${stop.pickup_manifest_id}::uuid`,
      );
      const run = runs.rows[0] as unknown as { state: string } | undefined;
      if (run === undefined) throw notTheRidersWork();
      if (run.state === 'DISPATCHED') {
        throw ApiException.of(ErrorCode.ManifestNotStarted, 'The run has not been started');
      }
      if (run.state !== 'IN_PROGRESS') {
        throw ApiException.of(ErrorCode.StateConflict, 'The run is over', {
          rule: 'run_not_in_progress',
        });
      }
      if (request.ifMatch !== pickupStopEtagOf(stopViewOf(stop), stop.version)) {
        throw ApiException.of(ErrorCode.StateConflict, 'The stop has changed since it was read');
      }
      if (stop.state === 'PENDING') {
        throw ApiException.of(ErrorCode.StateConflict, 'The rider has not arrived at this stop', {
          rule: 'stop_not_arrived',
        });
      }
      if (stop.state !== 'ARRIVED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The stop has been worked or skipped and is not counted',
          { rule: 'stop_resolved' },
        );
      }
      const earlier = await tx.execute(
        sql`select id from collection_record where pickup_stop_id = ${stop.id}::uuid`,
      );
      if (earlier.rows.length > 0) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'A collection is already recorded for this stop',
          {
            rule: 'collection_recorded',
          },
        );
      }

      // The evidence: none can be `STORED` in this slice yet, so a reference to any is exactly what the code says.
      if (body.evidence_ids !== undefined && body.evidence_ids.length > 0) {
        throw ApiException.of(
          ErrorCode.EvidenceNotStored,
          'A referenced evidence record is not stored',
        );
      }

      const declared = Number(stop.pickup_summary?.declared_package_count);
      if (!Number.isSafeInteger(declared) || declared < 1) {
        throw new Error('A dispatched stop carries no declared count');
      }
      if (body.collected_count > declared) {
        throw invalid('collected_count', 'above_declared');
      }
      const short = body.collected_count < declared;
      if (!short && (body.variance_reason_code !== undefined || body.variance_note !== undefined)) {
        // A count that matches has no variance, so it has no reason: one sent with it would be kept nowhere, and a record must say what was sent.
        throw invalid(
          body.variance_reason_code !== undefined ? 'variance_reason_code' : 'variance_note',
          'not_short',
        );
      }
      const reason = short
        ? await validatedReason(
            reasons,
            handle,
            pickupReasonRequest(OPERATION, body.variance_reason_code, body.variance_note),
          )
        : undefined;
      if (reason?.requiresPhoto === true) {
        // The photo the reason demands is evidence, and evidence cannot be stored yet (S1.11 builds it): the requirement is unmet, and said so.
        throw ApiException.of(ErrorCode.ReasonRequired, 'This reason needs a photo', {
          rule: 'photo',
        });
      }

      // The kind of sender fixes the direction of the handshake. The rider's context reads no request: the database answers the one word for a stop
      // this rider has arrived at (`melarc.collection_handshake_type`, migration 0068), and the request's rows are not read by this act.
      const directions = await tx.execute(
        sql`select melarc.collection_handshake_type(${stop.id}::uuid) as handshake_type`,
      );
      const handshakeType = (directions.rows[0] as { handshake_type: string } | undefined)
        ?.handshake_type;
      if (
        handshakeType !== 'VENDOR_ENTERED_RIDER_DISPLAYED' &&
        handshakeType !== 'SENDER_SMS_RIDER_ENTERED'
      ) {
        throw new Error('The database gave no direction for the handshake of a locked stop');
      }

      const note =
        body.variance_note === undefined || body.variance_note.trim() === ''
          ? undefined
          : body.variance_note;
      const snapshot =
        reason === undefined
          ? null
          : {
              reason_code: reason.code,
              label: reason.label,
              attribution: reason.attribution,
              ...(note === undefined ? {} : { note }),
            };
      const id = randomUUIDv7(clock);
      // The act gives the record **no instant**: the recording and the office flag are the database's own, taken once the stop's lock is held (the guard
      // of migration 0069, OB-S1-60), and the device's own moment is `captured_at`. The guard also holds the snapshot to the catalogue as it stands at
      // the insert, so a catalogue that changed after this act read the reason (its label, its attribution, its being active) is refused there, as the
      // reason it is, and not as a server error: the act is undone with the refusal and the same key and body are a retry that reads the catalogue again.
      const written = await (async () => {
        try {
          return await tx.execute(sql`
            insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot,
                                           handshake_type, recorded_by, captured_at)
            values (${id}::uuid, ${stop.id}::uuid, ${stop.responsible_hub_id}::uuid, ${declared}, ${body.collected_count},
                    ${short ? 'SHORT' : 'MATCH'}, ${snapshot === null ? null : JSON.stringify(snapshot)}::jsonb,
                    ${handshakeType}, ${riderId}::uuid, ${capturedAt ?? null}::timestamptz)
            returning ${COLLECTION_RECORD_COLUMNS}`);
        } catch (error) {
          throw reasonRefusedByGuard(error) ?? error;
        }
      })();
      const row = written.rows[0] as unknown as CollectionRecordRow | undefined;
      if (row === undefined) throw new Error('A collection record was not made');

      // The count's own event (OB-S1-54), the same for a clean count and a short one: it says that a count was recorded and that the stop is still
      // `ARRIVED`. It is built from **the stored record**, not from what this act read before the insert, and the ledger admits it only when every member
      // agrees with that record and its stop. The two events of the close of a stop (`pickup.stop.collected`, `pickup.stop.partially_collected`) are the
      // handshake's (S1.27): an abandoned handshake never reads as a completed collection. The rider's note is on the record and not in the event.
      const kept = row.variance_reason_snapshot;
      await audit.write(handle, {
        code: 'pickup.collection.recorded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'CollectionRecord', id: row.id },
        responsibleHubId: row.responsible_hub_id,
        previousState: 'ARRIVED',
        resultingState: 'ARRIVED',
        ...(kept === null ? {} : { reason: { code: kept.reason_code, label: kept.label } }),
        relatedIds: {
          pickup_stop_id: row.pickup_stop_id,
          pickup_manifest_id: stop.pickup_manifest_id,
          pickup_request_id: stop.pickup_request_id,
          rider_id: row.recorded_by,
        },
        detail: {
          declared_count: row.declared_count,
          collected_count: row.collected_count,
          variance: row.variance,
          office_notified: row.office_notified_at !== null,
          handshake_type: row.handshake_type,
        },
      });

      // An individual sender becomes reusable when a count is recorded for it, without waiting for the handshake. The database makes the one change
      // and writes its event in the same change (`pickup.sender.promoted`: this act has no right to update a sender and none to write that event); a
      // vendor's request and a sender already reusable promote nobody and write nothing. The operation refuses a stop that has no count of this rider,
      // and an event the ledger cannot take undoes the promotion with the rest of the act.
      await tx.execute(sql`select melarc.promote_collected_sender(${stop.id}::uuid)`);

      const view = collectionRecordViewOf(row);
      const answer: StoredCollection = { record: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { record: view };
    });
  }
}
