import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { guardReasonIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunAccess } from '../platform/domain-ports/run-access.port.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import { SettingMissingError } from '../platform/settings/settings-reader.js';
import { momentOf } from './device-moment.js';
import { MAX_CONTACT_ATTEMPTS } from './pickup-failure-schemas.js';
import {
  STOP_COLUMNS,
  stopViewOf,
  type PickupStopRow,
  type PickupStopView,
  type StopContactAttempt,
} from './pickup-manifest-view.js';
import { reasonRefusedByGuard, validatedReason } from './pickup-reason-validation.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';
import {
  CONTACT_ATTEMPT_METHODS,
  DOOR_WAIT_CATEGORIES,
  PICKUP_FAILURE_CATEGORIES,
  pickupReasonRequest,
  type ContactAttemptMethod,
  type PickupFailureCategory,
} from './pickup-vocabulary.js';

const OPERATION = 'reportPickupFailure';

export interface PickupFailureOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The completion of the run by the system, in the transaction of the failure: the run port, which this domain implements (`pickup-run-access.adapter.ts`). */
  readonly runs: Pick<RunAccess, 'completeIfSettled'>;
}

export interface FailureBody {
  readonly category: string;
  readonly reason_code: string;
  readonly note?: string;
  readonly evidence_ids?: readonly string[];
  readonly contact_attempts?: readonly {
    readonly method: string;
    readonly attempted_at: string;
    readonly outcome: string;
    readonly note?: string;
  }[];
}

export interface FailedStop {
  readonly stop: PickupStopView;
  readonly etag: string;
}

/** The stop as the act reads it under its lock: the columns of its representation, its version and its hub. */
interface LockedStop extends PickupStopRow {
  readonly version: number;
  readonly responsible_hub_id: string;
}

/** What is kept of a report so that a retry with the same key is answered with it, byte for byte. */
interface StoredFailure {
  readonly etag: string;
  readonly stop: PickupStopView;
}

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/** A stop that is not the rider's, and an id that matches nothing, are one answer: a rider who acts on work that is not its own is told so. */
const notTheRidersWork = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not work assigned to you');

/**
 * The contact attempts the rider made, in the form the table keeps them: each with its method (a call, a text, in person), its moment as an instant in UTC (a day of the
 * calendar, and not one the language would roll over), its outcome and, where the rider gave one, a note; the outcome and the note are lines the ledger's own screening
 * would keep. At most `MAX_CONTACT_ATTEMPTS`. **The wait is not reported**: how long the rider had waited at the door is the server's to derive (the moment of the attempt less the
 * arrival the server recorded), and a device that could report it could report anything.
 */
function contactAttemptsOf(attempts: FailureBody['contact_attempts']): StopContactAttempt[] {
  if (attempts === undefined) return [];
  if (attempts.length > MAX_CONTACT_ATTEMPTS) throw invalid('/contact_attempts', 'maxItems');
  return attempts.map((attempt, index) => {
    const at = `/contact_attempts/${String(index)}`;
    if (!(CONTACT_ATTEMPT_METHODS as readonly string[]).includes(attempt.method)) {
      throw invalid(`${at}/method`, 'enum');
    }
    const attemptedAt = momentOf(attempt.attempted_at);
    if (attemptedAt === undefined) throw invalid(`${at}/attempted_at`, 'format');
    if (attempt.outcome.trim() === '') throw invalid(`${at}/outcome`, 'minLength');
    const outcomeRule = noteRefusal(attempt.outcome);
    if (outcomeRule !== undefined) throw invalid(`${at}/outcome`, outcomeRule);
    // A note the rider leaves blank is no note; one it gives is held to the ledger's screening, as every note is.
    let note: string | undefined;
    if (attempt.note !== undefined && attempt.note.trim() !== '') {
      const noteRule = noteRefusal(attempt.note);
      if (noteRule !== undefined) throw invalid(`${at}/note`, noteRule);
      note = attempt.note;
    }
    return {
      method: attempt.method as ContactAttemptMethod,
      attempted_at: attemptedAt,
      outcome: attempt.outcome,
      ...(note === undefined ? {} : { note }),
    };
  });
}

/**
 * What the door wait of a stop is: the wait the hub requires, the moment the report is allowed, and how long that is from the database's now (at or below zero once it has
 * passed). Read once, before the write, so that a refusal can be made from it later without asking the database anything.
 */
export interface DoorWait {
  readonly minutes: number;
  readonly availableAt: Date;
  readonly remaining: number;
}

/**
 * The door wait of the category (the hub's `rider_door_wait_minutes`, read by the database for the rider's key): `undefined` where the category carries no wait, and otherwise
 * the wait, by the database's clock and the arrival the database recorded. The instant is the one the stop's guard judges by (the database's clock to the millisecond), so
 * that a report this check lets through is not one the guard then refuses at the boundary. A setting the database cannot read is an operational failure and not an invented
 * wait (`SettingMissingError`), and so is a stop that has been arrived at and holds no arrival, which the guard of the stop does not allow to come about.
 */
export async function doorWaitOf(
  tx: ReturnType<typeof transactionOf>,
  stop: LockedStop,
  category: PickupFailureCategory,
): Promise<DoorWait | undefined> {
  if (!DOOR_WAIT_CATEGORIES.includes(category)) return undefined;
  let found;
  try {
    found = await tx.execute(sql`
      with held as (select melarc.rider_door_wait_minutes(${stop.responsible_hub_id}::uuid) as minutes)
      select held.minutes,
             extract(epoch from (s.arrived_at + make_interval(mins => held.minutes) - date_trunc('milliseconds', clock_timestamp()))) as remaining,
             s.arrived_at + make_interval(mins => held.minutes) as available_at
        from pickup_stop as s, held where s.id = ${stop.id}::uuid`);
  } catch (error) {
    if (guardReasonIn(error) === 'SETTING_MISSING') {
      throw new SettingMissingError('rider_door_wait_minutes');
    }
    throw error;
  }
  const row = found.rows[0] as
    | { minutes: number; remaining: string | number | null; available_at: string | Date | null }
    | undefined;
  if (row === undefined) throw new Error('A locked stop was not found for its door wait');
  if (row.available_at === null || row.remaining === null) {
    throw new Error('A stop that has been arrived at holds no moment of arrival');
  }
  return {
    minutes: row.minutes,
    availableAt: row.available_at instanceof Date ? row.available_at : new Date(row.available_at),
    remaining: Number(row.remaining),
  };
}

/**
 * The refusal of a report made before the wait has passed, with the moment it is allowed. `atLeastSeconds` is the shortest wait it may tell: a report the stop's guard refused
 * after the check let it through (the wait moved between the two, or the boundary fell between them) is told to try again in a second, because the check cannot be repeated.
 */
export function doorWaitRefusal(wait: DoorWait, atLeastSeconds = 0): ApiException {
  const seconds = Math.max(wait.remaining, atLeastSeconds);
  return ApiException.of(
    ErrorCode.PickupDoorWaitNotElapsed,
    'The rider has not waited at the door as long as the hub requires',
    {
      door_wait_minutes: wait.minutes,
      available_at: new Date(
        wait.availableAt.getTime() + (seconds - wait.remaining) * 1000,
      ).toISOString(),
      retry_after_seconds: Math.ceil(seconds),
    },
  );
}

/**
 * What a statement the stop's guard refused is told as. **Nothing is asked of the database here**: the statement failed inside the act's transaction, which the server has
 * aborted, and the code base keeps no savepoint, so any further statement would be refused as `25P02` and the rider would be answered with a server error. The refusal of the
 * door wait is made from what the check read before the write.
 */
export function refusalOfFailedWrite(error: unknown, wait: DoorWait | undefined): unknown {
  if (guardReasonIn(error) === 'PICKUP_DOOR_WAIT_NOT_ELAPSED') {
    return wait === undefined
      ? ApiException.of(
          ErrorCode.PickupDoorWaitNotElapsed,
          'The rider has not waited at the door as long as the hub requires',
        )
      : doorWaitRefusal(wait, 1);
  }
  return reasonRefusedByGuard(error) ?? error;
}

/**
 * The write of the failure: the stop becomes `FAILED` with its category and the snapshot of its reason; the moment is the database's own (the stop's guard). **When the guard
 * refuses it, nothing more is asked of the database**: the statement failed inside the act's transaction, which the server has aborted, so the refusal is told from what the
 * check read before the write (`refusalOfFailedWrite`). The guard repeats the door wait for every writer, so a refusal here means the wait was not over when the write came
 * after all (the setting moved, or the boundary fell between the two).
 */
export async function failTheStop(
  tx: ReturnType<typeof transactionOf>,
  stop: Pick<LockedStop, 'id'>,
  category: string,
  snapshot: Readonly<Record<string, unknown>>,
  wait: DoorWait | undefined,
): Promise<{ readonly rows: readonly unknown[] }> {
  try {
    return await tx.execute(sql`
      update pickup_stop
         set state = 'FAILED', failure_category = ${category}, failure_reason_snapshot = ${JSON.stringify(snapshot)}::jsonb
       where id = ${stop.id}::uuid and state = 'ARRIVED'
      returning ${STOP_COLUMNS}, version, responsible_hub_id`);
  } catch (error) {
    throw refusalOfFailedWrite(error, wait);
  }
}

/**
 * `reportPickupFailure` (S1.28; `pickup.failure.report`; `AC-SLICE-001-30` to `-33` and `-36`; pickup-failure.md; state-machines.md section 5): the rider
 * says that the stop it has arrived at **failed**, with one of the four fixed categories, a reason of the `PICKUP_FAILURE` catalogue, a note, and optionally
 * what it did to reach the sender. **The stop becomes `FAILED`, which is terminal**: nothing moves it back (the stop's guard freezes it), and the only way
 * forward is a new request cloned from the source, by the office. This is the part of S1.28 that stands alone; the evidence photo (S1.11), the scheduled
 * backstop, the narrowing of the escalation and the messages of a failure are not built (the plan's S1.28 paragraph says why).
 *
 * - **Judged in this order**, so that a caller learns of its own work first: the principal and the key's format; the body (a category outside the four, a
 *   note or an outcome the ledger could not keep, a method outside the three, a moment that is not a day of the calendar, too many attempts); then, in the transaction, the retry
 *   (`Idempotency-Key`); the stop under its lock (not the rider's: `NOT_ASSIGNED_RIDER`, one answer); the run (`MANIFEST_NOT_STARTED`, `STATE_CONFLICT`);
 *   the stop's `ETag`; that the stop was arrived at and is still unresolved and has no record of a count; the evidence (none can be `STORED` yet: this task
 *   builds no evidence, so a reference is `EVIDENCE_NOT_STORED`); and the reason, which is the catalogue's and whose metadata decides what else is mandatory
 *   (`REASON_REQUIRED`, `REASON_NOT_ACTIVE`): the note, a contact attempt where the reason asks for one, and a photo, which cannot be given yet (so a reason that
 *   asks for one is refused until evidence can be stored, and said so); and, last, **the door wait**: a failure of the category `VENDOR_UNAVAILABLE` is accepted only once the
 *   hub's `rider_door_wait_minutes` have passed since the rider arrived (`PICKUP_DOOR_WAIT_NOT_ELAPSED`, with when it is allowed), by the database's clock and the arrival it
 *   recorded. The other categories carry no wait. The stop's guard holds the same rule for every writer.
 * - **What it writes**, in one transaction: the stop `FAILED` with the category and the snapshot of the reason (its label and attribution as the catalogue
 *   holds them, the note, the contact attempts), and nothing else of it; the moment of the failure is the database's own, taken once the stop's lock is held, and
 *   the snapshot names it (the stop's guard, migration 0072, judges the snapshot against the catalogue for every writer); `pickup.stop.failed`, built from the
 *   stored row and admitted by the ledger only when every member agrees with it; and, if this was the last stop to be worked and nothing was collected, the
 *   completion of the run by the system (`completeIfSettled`, with the cause `LAST_STOP_FAILED`). **The request is not written**: it stays `CONFIRMED` with
 *   its claim held, and the office decides (reschedule, cancel or escalate); a refused collection can be rescheduled only after a force-extension
 *   (`attempt-ceiling.ts`).
 * - **The messages of the failure** (drafts in wording, OQ-037): one outbox envelope, `pickup.failure.reported`, written by the database from the stop just failed
 *   (`melarc.failure_envelope`: the act gives it the stop and nothing it says), in this transaction, so it is kept or undone with the failure. The notification lane makes
 *   from it the text to an individual sender (`PICKUP_FAILED_SENDER`, no reason and no note), the registered vendor's feed entry (`PICKUP_FAILED_VENDOR_FEED`) and the
 *   Ops feed entry (`PICKUP_FAILED_OPS_FEED`), the last two with the category and the reason as closed tokens and none of the rider's note. It is written before the
 *   run is completed, and a text it causes is bounded by the provider-initiating ceiling the route declares.
 * - **A retry is not a second failure**: the `Idempotency-Key` replays the answer, the same key for another stop or body is `IDEMPOTENCY_KEY_CONFLICT`, and
 *   another key for a stop already failed is `STATE_CONFLICT`.
 * - **Locks**: the stop alone, and the manifest only when the run is settled by this act, after the stop (`pickup-run-completion.ts` gives the order and
 *   why it holds). Nothing here reads the request or the sender.
 */
export class PickupFailures {
  readonly #options: PickupFailureOptions;

  constructor(options: PickupFailureOptions) {
    this.#options = options;
  }

  async report(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: {
      readonly body: FailureBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<FailedStop> {
    const { runner, audit, idempotency, reasons, runs } = this.#options;
    if (authorized.session.principalType !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    // The category is one of the four, whatever the schema said: the table's check and this are the same list.
    if (!(PICKUP_FAILURE_CATEGORIES as readonly string[]).includes(body.category)) {
      throw invalid('/category', 'enum');
    }
    // What the ledger could not keep, and a moment the database could not hold, are malformed bodies, before anything is read.
    if (body.note !== undefined && body.note.trim() !== '') {
      const rule = noteRefusal(body.note);
      if (rule !== undefined) throw invalid('/note', rule);
    }
    const attempts = contactAttemptsOf(body.contact_attempts);
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
        ) as StoredFailure;
        return { stop: stored.stop, etag: stored.etag };
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

      const runRows = await tx.execute(
        sql`select state from pickup_manifest where id = ${stop.pickup_manifest_id}::uuid`,
      );
      const run = runRows.rows[0] as unknown as { state: string } | undefined;
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
        // Physical failure is terminal, and so is every other end of a stop (AC-SLICE-001-32): a stop already failed is not failed again.
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The stop has been worked or skipped and cannot be failed',
          { rule: 'stop_resolved' },
        );
      }
      const counted = await tx.execute(
        sql`select 1 from collection_record where pickup_stop_id = ${stop.id}::uuid`,
      );
      if (counted.rows.length > 0) {
        // The parcels were taken at the door and the handshake closes the stop (S1.26): a stop that has a count is not failed. The database holds it too.
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The pickup has been collected and cannot be failed',
          { rule: 'collection_recorded' },
        );
      }

      // The evidence: none can be `STORED` in this slice yet, so a reference to any is exactly what the code says.
      if (body.evidence_ids !== undefined && body.evidence_ids.length > 0) {
        throw ApiException.of(
          ErrorCode.EvidenceNotStored,
          'A referenced evidence record is not stored',
        );
      }

      const reason = await validatedReason(
        reasons,
        handle,
        pickupReasonRequest(OPERATION, body.reason_code, body.note),
      );
      if (reason.requiresContactAttempt && attempts.length === 0) {
        throw ApiException.of(ErrorCode.ReasonRequired, 'This reason needs a contact attempt', {
          rule: 'contact_attempt',
        });
      }
      if (reason.requiresPhoto) {
        // The photo the reason demands is evidence, and evidence cannot be stored yet (S1.11): the requirement is unmet, and said so.
        throw ApiException.of(ErrorCode.ReasonRequired, 'This reason needs a photo', {
          rule: 'photo',
        });
      }
      // The door wait comes last: the rider is told what is wrong with what it sent before it is told to wait.
      const wait = await doorWaitOf(tx, stop, body.category as PickupFailureCategory);
      if (wait !== undefined && wait.remaining > 0) throw doorWaitRefusal(wait);

      const note = body.note === undefined || body.note.trim() === '' ? undefined : body.note;
      const snapshot = {
        reason_code: reason.code,
        label: reason.label,
        attribution: reason.attribution,
        ...(note === undefined ? {} : { note }),
        ...(attempts.length === 0 ? {} : { contact_attempts: attempts }),
      };
      // The act gives the stop **no instant**: the moment of the failure is the database's own, taken once the stop's lock is held, and the snapshot names the
      // same one (the guard of migration 0072). The guard also holds the snapshot to the catalogue as it stands at the write, so a catalogue that changed after
      // this act read the reason is refused there, as the reason it is, and not as a server error: the act is undone with the refusal and the same key and body
      // are a retry that reads the catalogue again.
      const failed = await failTheStop(tx, stop, body.category, snapshot, wait);
      const row = failed.rows[0] as LockedStop | undefined;
      // Under the lock and having read the stop as arrived, the update cannot miss it.
      if (row === undefined) throw new Error('A locked stop was not failed');
      const kept = row.failure_reason_snapshot;
      if (kept === null || row.failure_category === null) {
        throw new Error('A failed stop holds no failure');
      }

      // The event is built from **the stored stop**, not from what this act read before the write, and the ledger admits it only when every member agrees
      // with that stop (migration 0072). The rider's note is on the stop and not in the event.
      await audit.write(handle, {
        code: 'pickup.stop.failed',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupStop', id: row.id },
        responsibleHubId: row.responsible_hub_id,
        previousState: 'ARRIVED',
        resultingState: 'FAILED',
        reason: { code: kept.reason_code, label: kept.label },
        relatedIds: {
          pickup_manifest_id: row.pickup_manifest_id,
          pickup_request_id: row.pickup_request_id,
          rider_id: riderId,
        },
        detail: {
          failure_category: row.failure_category,
          contact_attempts: kept.contact_attempts?.length ?? 0,
        },
      });
      // The messages of the failure (S1.28): the envelope of the notification lane, written by the database from the stop just failed and in this transaction, so it is
      // kept or undone with the failure. The act chooses nothing the envelope says. It comes before the completion of the run below.
      await tx.execute(sql`select melarc.failure_envelope(${row.id}::uuid)`);
      // A stop turned terminal in a run in progress is the moment the system completes the run if this was its last stop and nothing was collected (S1.23).
      await runs.completeIfSettled(handle, row.pickup_manifest_id, 'LAST_STOP_FAILED');

      const view = stopViewOf(row);
      const etag = pickupStopEtagOf(view, row.version);
      const answer: StoredFailure = { etag, stop: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { stop: view, etag };
    });
  }
}
