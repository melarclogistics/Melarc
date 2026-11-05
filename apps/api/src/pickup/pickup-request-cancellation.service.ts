import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { noteRefusal } from '../platform/audit/audit-record.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunAccess } from '../platform/domain-ports/run-access.port.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import type { ReasonValidator, ValidatedReason } from '../platform/settings/reason-validator.js';
import { SettingInvalidError, SettingMissingError } from '../platform/settings/settings-reader.js';
import {
  attemptLimitOf,
  permitsAnotherAttempt,
  refusalReleasedFor,
  refusedCollectionOf,
  type SettingAnomaly,
} from './attempt-ceiling.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { validatedReason } from './pickup-reason-validation.js';
import { pickupRequestEtagOf } from './pickup-request-etag.js';
import { loadRequest, requireCurrent } from './pickup-request-loader.js';
import { auditReplacementCreated, replaceRequest } from './pickup-request-replacement.js';
import {
  REQUEST_COLUMNS,
  exceptionAudienceOf,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
  type SettingSnapshotView,
} from './pickup-request-view.js';
import { auditSkippedStops, skipStopsOfCancelledRequest } from './pickup-stop-resolution.js';

const CANCEL = 'cancelPickupRequest';
const REASON_DOMAIN = 'PICKUP_CANCELLATION';
const CHARGE_SETTING = 'cancellation_charge_amount';
const CHARGEABLE = 'pickup.request.cancel_chargeable';
const WAIVE = 'pickup.cancellation_charge.waive';

/** The body of `cancelPickupRequest` as the contract's schema has validated it (the interceptor ran before this). */
export interface CancelBody {
  readonly reason_code: string;
  readonly note?: string;
  readonly create_replacement?: boolean;
  readonly apply_charge?: boolean;
  readonly charge_reason_code?: string;
}

/** The body of `waiveCancellationCharge`: a note, and no amount (a waiver is total or it is not a waiver). */
export interface WaiverBody {
  readonly note: string;
}

export interface PickupRequestCancellationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The clock of the identifier of a replacement. */
  readonly clock: Clock;
  /** The completion of the run by the system, in the transaction of the cancellation: the run port, which this domain implements. */
  readonly runs: Pick<RunAccess, 'completeIfSettled'>;
}

export interface CancelledRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

/** What a replay of the command answers: the representation and the token it was answered with, as they were. */
interface StoredAnswer {
  readonly etag: string;
  readonly request: PickupRequestView;
}

/** The recorded outcome of the charge decision of a cancellation after a rider was assigned (domain-model.md section 6.2). */
type ChargeOutcome = 'APPLIED' | 'NOT_APPLIED' | 'UNAVAILABLE' | 'EXEMPT';

interface ChargeDecision {
  readonly outcome: ChargeOutcome;
  readonly snapshot: SettingSnapshotView | null;
  readonly reason: ValidatedReason;
}

const violation = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * `cancelPickupRequest` and `waiveCancellationCharge` (S1.17; `AC-SLICE-001-05`, `-60` to `-64`, `-79`; pickup-request.md sections 5.2 to 5.4;
 * state-machines.md section 3; `MSC-DEC-196`, `-197`, `-388`).
 *
 * **`cancelPickupRequest`** (`pickup.request.cancel`; `Idempotency-Key` and `If-Match`).
 * - **Who, and what.** A vendor cancels only its **own `PENDING`** request (a confirmed one is `PERMISSION_DENIED`, which the office can
 *   still cancel; another vendor's is `NOT_FOUND` by the guard, as an id that matches nothing). Ops cancels a `PENDING` or a `CONFIRMED`
 *   request in its hubs at any point. Anything else is `STATE_CONFLICT`. The request is read, then locked, then compared with `If-Match`
 *   under the lock, so that two callers who read one request are put in a line.
 * - **The reason** is validated against the catalogue (domain `PICKUP_CANCELLATION`, whose codes are the Product Owner's to supply) and
 *   snapshotted with its label; a reason whose metadata requires a note needs one.
 * - **No charge before a rider is committed**: a cancellation of a request no rider holds records no charge outcome, and a charge decision
 *   offered for it is refused (a member that decides nothing is not stored as if it did). **A rider holds the request while its current,
 *   unreleased claim sits on a manifest that has a rider** (the Product Owner's decision of 2 November 2026, OB-S1-35), and the mark the
 *   request carries (`rider_assigned`) is that fact: it is read from the request locked here, never from a read of the stop or the manifest
 *   that row-level security could hide, and a rider who was once assigned to a manifest that has since been cancelled holds nothing. The
 *   assignment of a rider raises the mark and the cancellation of the manifest lowers it, each in its own transaction
 *   (`pickup-manifest-planning.service.ts`); this operation never changes it.
 * - **After assignment the charge is discretionary and always a recorded outcome** (never a null, never `SETTING_MISSING`): Ops must
 *   say whether to charge (`apply_charge`) and why (`charge_reason_code`), either way, or `REASON_REQUIRED`. `EXEMPT` when the selected
 *   reason is attributed to Melarc, whatever was sent (no charge is permitted, and the cancellation proceeds); `NOT_APPLIED` when Ops
 *   elects none; `APPLIED` with the amount, the setting key and the version snapshotted; `UNAVAILABLE` when the hub has no amount. Electing
 *   a charge needs `pickup.request.cancel_chargeable`. The charge reason is a reason of the same domain.
 * - **A replacement** (`create_replacement`, S1.18; `AC-SLICE-001-06`, `-07`) is the reschedule of a failed attempt and Ops's: a vendor is
 *   `PERMISSION_DENIED`, and only a `CONFIRMED` request is rescheduled (`STATE_CONFLICT`). In the same transaction the source is
 *   `CANCELLED` and a new `PENDING` request of the next attempt is made (`pickup-request-replacement.ts`), so that the two are never active
 *   together; the next attempt past the hub's cap and the extension the request carries is `PICKUP_ATTEMPT_LIMIT_REACHED`, and nothing is
 *   written. A cap that is unset or invalid blocks nothing (the audit event says it was not applied). The charge of the cancellation is decided
 *   as for any cancellation.
 * - **The stop that holds the request is skipped in the same transaction** (S1.20 closeout; `pickup-stop-resolution.ts`): a cancellation by
 *   Ops takes effect at once on a draft manifest and on a dispatched one, a `PENDING` or `ARRIVED` stop becoming `SKIPPED` with the
 *   system's reason `REQUEST_CANCELLED` (the arrival kept, the place and the claim kept), and a stop already collected, failed or skipped
 *   being left as it is. The rider's acknowledgement decides nothing, and no notification is the guarantee: the rider's next read shows
 *   the skipped stop, and an act of the rider on it afterwards is refused by the stop's own state.
 * - **Recorded** as `pickup.request.cancelled` (free of charge) or `pickup.request.cancelled_chargeable` (after assignment, whatever the
 *   outcome), with the reason and the actor type (and the number of stops it skipped, when it skipped any), then one
 *   `pickup.stop.skipped` for each stop skipped, and for a replacement the link to it and the replacement's own `pickup.request.created`;
 *   once however many times it is sent.
 *
 * **`waiveCancellationCharge`** (`pickup.cancellation_charge.waive`, Senior Ops and above; `If-Match`). Relieves an `APPLIED` charge in full
 * under a mandatory note; the snapshot stays readable. A cancellation whose outcome is anything else has nothing to waive
 * (`NO_CHARGE_APPLIED`, and no event is written); a request that is not cancelled is `STATE_CONFLICT`. One enhanced event per waiver, because
 * the waiver frequency is the control that makes the discretion observable.
 *
 * The configuration (the charge amount, the attempt cap) is read before the transaction that cancels, as the confirmation reads it, and
 * only when a charge is elected or a replacement is asked for.
 */
export class PickupRequestCancellation {
  readonly #options: PickupRequestCancellationOptions;

  constructor(options: PickupRequestCancellationOptions) {
    this.#options = options;
  }

  async cancel(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: CancelBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CancelledRequest> {
    const { runner, audit, idempotency, configuration, reasons, runs } = this.#options;
    const principalType = authorized.session.principalType;
    if (principalType !== 'STAFF' && principalType !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;

    // Judged before the transaction, where a malformed body is judged and from the request alone.
    if (principalType === 'VENDOR' && body.create_replacement === true) {
      throw ApiException.of(ErrorCode.PermissionDenied, 'A vendor does not reschedule');
    }
    if (
      principalType === 'VENDOR' &&
      (body.apply_charge !== undefined || body.charge_reason_code !== undefined)
    ) {
      throw ApiException.of(ErrorCode.PermissionDenied, 'A vendor does not elect a charge');
    }
    if (body.apply_charge === true && !holds(authorized, CHARGEABLE)) {
      throw ApiException.of(
        ErrorCode.PermissionDenied,
        'Electing a charge needs the permission to',
      );
    }
    const note =
      body.note === undefined || body.note.trim() === '' ? undefined : screened(body.note);

    // The amount of the charge, only where one is elected, and the attempt cap, only where a replacement is asked for: the hub is found in a
    // short transaction of its own (the platform allows one connection to a request), the configuration is read next, and the cancelling
    // transaction re-checks that the hub is the same.
    let config: HubConfiguration | undefined;
    if (body.apply_charge === true || body.create_replacement === true) {
      const hubId = await runner.mutate(authorized, correlationId, async (handle) => {
        const found = await transactionOf(handle).execute(
          sql`select responsible_hub_id from pickup_request where id = ${id}::uuid`,
        );
        return (found.rows[0] as { responsible_hub_id: string } | undefined)?.responsible_hub_id;
      });
      if (hubId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      config = await configuration.forHub(hubId);
    }

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType,
        principalId: actor,
        operationId: CANCEL,
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

      // Read before it is locked: a vendor cannot lock (and so cannot see as lockable) what is no longer pending, and is told so as the
      // contract says, `PERMISSION_DENIED`, and not as a request that has gone.
      const audience = exceptionAudienceOf(principalType);
      const peek = await loadRequest(handle, id, { audience });
      if (peek === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      if (principalType === 'VENDOR' && peek.row.state !== 'PENDING') {
        throw ApiException.of(
          ErrorCode.PermissionDenied,
          'A vendor cancels only a pending request of its own',
        );
      }
      const loaded = await loadRequest(handle, id, { lock: true, audience });
      // What the caller could lock a moment ago it can no longer (a vendor's request that was confirmed meanwhile): not the one it read.
      if (loaded === undefined) {
        throw ApiException.of(ErrorCode.StateConflict, 'The request has changed since it was read');
      }
      requireCurrent(request.ifMatch, loaded);
      const { row } = loaded;
      if (row.state !== 'PENDING' && row.state !== 'CONFIRMED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Only a pending or a confirmed request can be cancelled',
        );
      }

      if (
        config !== undefined &&
        config.hubId.toLowerCase() !== row.responsible_hub_id.toLowerCase()
      ) {
        // The request moved to another hub between the two transactions (a reassignment): nothing was written, and the cancellation is sent again.
        throw new Error('The hub of the request changed while it was being cancelled');
      }
      // Only a request that was confirmed can have been attempted, and so be rescheduled; the next attempt is judged against the cap.
      const replacing = body.create_replacement === true;
      let capCheck: SettingAnomaly | undefined;
      if (replacing) {
        if (row.state !== 'CONFIRMED') {
          throw ApiException.of(ErrorCode.StateConflict, 'Only a confirmed request is rescheduled');
        }
        capCheck = await this.#requireAnotherAttempt(tx, config, row);
      }

      const reason = await validatedReason(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: CANCEL,
        domain: REASON_DOMAIN,
        note: body.note,
      });
      const postAssignment = row.state === 'CONFIRMED' && row.rider_assigned;
      const decision = await this.#decision(handle, { body, reason, config, postAssignment });

      // The clone first (it names the source, which exists), then the source (which names the clone), in the one transaction.
      const replacementId = replacing
        ? await replaceRequest(tx, {
            source: row,
            actor,
            clock: this.#options.clock,
            instant: await this.#now(tx),
            attempt: 'NEXT',
          })
        : null;

      const updated = await tx.execute(sql`
        update pickup_request
           set state = 'CANCELLED', cancelled_at = now(), cancelled_by = ${actor}::uuid,
               cancelled_by_actor_type = ${principalType === 'VENDOR' ? 'VENDOR' : 'OPS'},
               cancellation_reason_code = ${reason.code}, cancellation_reason_label = ${reason.label},
               cancellation_charge_outcome = ${decision?.outcome ?? null},
               cancellation_charge_snapshot = ${decision?.snapshot === null || decision === undefined ? null : JSON.stringify(decision.snapshot)}::jsonb,
               cancellation_charge_reason_code = ${decision?.reason.code ?? null},
               cancellation_charge_reason_label = ${decision?.reason.label ?? null},
               replacement_request_id = ${replacementId}::uuid
         where id = ${id}::uuid and state = ${row.state}
        returning ${REQUEST_COLUMNS}`);
      const cancelled = updated.rows[0] as unknown as PickupRequestRow | undefined;
      // Under the lock and having read the row in that state, the update cannot miss it.
      if (cancelled === undefined) throw new Error('A locked request was not cancelled');

      // The stop that holds the request, if it is still to be worked, is skipped here, in the transaction of the cancellation and whether or
      // not a rider has been told. A vendor cancels only a request that is still pending, which no stop holds.
      const skippedStops =
        principalType === 'STAFF' ? await skipStopsOfCancelledRequest(handle, id) : [];

      const actorType = principalType === 'VENDOR' ? 'VENDOR' : 'OPS';
      await audit.write(handle, {
        code:
          decision === undefined
            ? 'pickup.request.cancelled'
            : 'pickup.request.cancelled_chargeable',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: cancelled.responsible_hub_id,
        ...(cancelled.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: cancelled.vendor_organization_id }),
        previousState: row.state,
        resultingState: 'CANCELLED',
        reason: { code: reason.code, label: reason.label },
        ...(note === undefined ? {} : { note }),
        ...(replacementId === null
          ? {}
          : { relatedIds: { replacement_request_id: replacementId } }),
        detail: {
          cancelled_by_actor_type: actorType,
          ...(decision === undefined
            ? {}
            : {
                charge_outcome: decision.outcome,
                charge_reason_code: decision.reason.code,
                charge_reason_label: decision.reason.label,
              }),
          ...(capCheck === undefined ? {} : { attempt_cap_check: capCheck }),
          ...(skippedStops.length === 0 ? {} : { stops_skipped: skippedStops.length }),
        },
      });
      await auditSkippedStops(audit, handle, id, skippedStops);
      if (replacementId !== null) await auditReplacementCreated(audit, handle, row, replacementId);
      // A stop turned terminal in a run in progress is the moment the system completes the run if this was its last pickup and nothing was
      // collected (S1.23); its event follows the cancellation's own, the skip's and the replacement's.
      for (const manifestId of new Set(skippedStops.map((stop) => stop.pickup_manifest_id))) {
        await runs.completeIfSettled(handle, manifestId, 'LAST_PICKUP_CANCELLED');
      }

      const view = viewOf(cancelled, { exception: loaded.view.one_package_exception });
      const etag = pickupRequestEtagOf(view, cancelled.version);
      const answer: StoredAnswer = { etag, request: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { request: view, etag };
    });
  }

  /**
   * The next attempt against the hub's cap and the extension the request carries (`attempt-ceiling.ts`): refused as
   * `PICKUP_ATTEMPT_LIMIT_REACHED` when it would pass the ceiling. A cap that is unset or invalid blocks nothing, and the condition is
   * returned to be recorded.
   */
  async #requireAnotherAttempt(
    tx: DatabaseTransaction,
    config: HubConfiguration | undefined,
    row: PickupRequestRow,
  ): Promise<SettingAnomaly | undefined> {
    if (config === undefined) throw new Error('The configuration of a reschedule was not read');
    // A refused collection is escalation-only (S1.28, AC-SLICE-001-33): it is not rescheduled by ordinary action, whatever the cap or its setting says, and only a
    // force-extension by hub Senior Ops for its next attempt opens it. The answer is the one of an exhausted request.
    if ((await refusedCollectionOf(tx, row.id)) && !(await refusalReleasedFor(tx, row))) {
      throw ApiException.of(
        ErrorCode.PickupAttemptLimitReached,
        'The collection was refused; the pickup is escalated, and only a force-extension by hub Senior Ops allows another attempt',
      );
    }
    const limit = await attemptLimitOf(tx, config, row);
    if (limit.kind === 'UNAVAILABLE') return limit.anomaly;
    if (!permitsAnotherAttempt(limit, row.attempt_number)) {
      throw ApiException.of(
        ErrorCode.PickupAttemptLimitReached,
        'The pickup has reached its attempts; only a force-extension by hub Senior Ops allows another',
      );
    }
    return undefined;
  }

  /** The instant of the act: the database's, as the day of a replacement is counted on it. */
  async #now(tx: DatabaseTransaction): Promise<Date> {
    const found = await tx.execute(sql`select clock_timestamp() as instant`);
    const instant = (found.rows[0] as { instant: string | Date } | undefined)?.instant;
    if (instant === undefined) throw new Error('The database gave no time');
    return instant instanceof Date ? instant : new Date(instant);
  }

  /**
   * The charge decision of a cancellation: none before a rider is assigned (and a decision offered then is refused), and after it the
   * explicit election and its reason, the four recorded outcomes, and the amount read from the hub's setting as it stands.
   */
  async #decision(
    handle: TransactionHandle,
    input: {
      readonly body: CancelBody;
      readonly reason: ValidatedReason;
      readonly config: HubConfiguration | undefined;
      readonly postAssignment: boolean;
    },
  ): Promise<ChargeDecision | undefined> {
    const { body, reason, config, postAssignment } = input;
    if (!postAssignment) {
      if (body.apply_charge !== undefined) throw violation('/apply_charge', 'unexpected');
      if (body.charge_reason_code !== undefined)
        throw violation('/charge_reason_code', 'unexpected');
      return undefined;
    }
    // There is no default: a default would let the decision go unmade. Either value is valid; the decision and its reason are not optional.
    if (body.apply_charge === undefined) {
      throw ApiException.of(
        ErrorCode.ReasonRequired,
        'Whether to charge is decided, either way, when a rider was assigned',
      );
    }
    // The reason for the decision is recorded, either way: a missing or blank one is `REASON_REQUIRED`, which the catalogue's validator says.
    const chargeReason = await validatedReason(this.#options.reasons, handle, {
      reasonCode: body.charge_reason_code,
      operationId: CANCEL,
      domain: REASON_DOMAIN,
      note: body.note,
    });
    // Billing a vendor for Melarc's own failure is not permitted, and the cancellation is never refused for it.
    if (reason.attribution === 'MELARC') {
      return { outcome: 'EXEMPT', snapshot: null, reason: chargeReason };
    }
    if (!body.apply_charge) return { outcome: 'NOT_APPLIED', snapshot: null, reason: chargeReason };

    // (The configuration of an elected charge was read for this request's hub, which the cancelling transaction has checked.)
    if (config === undefined)
      throw new Error('The configuration of an elected charge was not read');
    try {
      const amount = config.money(CHARGE_SETTING);
      return {
        outcome: 'APPLIED',
        snapshot: {
          amount_minor: amount.value,
          setting_key: CHARGE_SETTING,
          effective_version: String(amount.reference.effectiveVersion),
        },
        reason: chargeReason,
      };
    } catch (error) {
      // An amount that is unset (or invalid) never blocks a cancellation: an operational decision is not held hostage to commercial
      // configuration, and the outcome says so.
      if (error instanceof SettingMissingError || error instanceof SettingInvalidError) {
        return { outcome: 'UNAVAILABLE', snapshot: null, reason: chargeReason };
      }
      throw error;
    }
  }

  async waive(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly body: WaiverBody; readonly ifMatch: string | undefined },
  ): Promise<CancelledRequest> {
    const { runner, audit } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    const note = requiredNote(request.body.note);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await loadRequest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      requireCurrent(request.ifMatch, loaded);
      const { row } = loaded;
      if (row.state !== 'CANCELLED') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a cancelled request carries a charge');
      }
      // Nothing to relieve unless a charge stands: not one that was never decided, never made, forbidden, or already waived.
      if (row.cancellation_charge_outcome !== 'APPLIED') {
        throw ApiException.of(ErrorCode.NoChargeApplied, 'There is no applied charge to waive');
      }

      const updated = await tx.execute(sql`
        update pickup_request
           set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = ${actor}::uuid,
               cancellation_charge_waiver_note = ${note}
         where id = ${id}::uuid and state = 'CANCELLED' and cancellation_charge_outcome = 'APPLIED'
        returning ${REQUEST_COLUMNS}`);
      const waived = updated.rows[0] as unknown as PickupRequestRow | undefined;
      if (waived === undefined) throw new Error('A locked applied charge was not waived');

      await audit.write(handle, {
        code: 'pickup.cancellation_charge.waived',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: waived.responsible_hub_id,
        ...(waived.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: waived.vendor_organization_id }),
        previousState: 'CANCELLED',
        resultingState: 'CANCELLED',
        note,
        beforeAfter: { cancellation_charge_outcome: { before: 'APPLIED', after: 'WAIVED' } },
        detail: { permission: WAIVE },
      });
      const view = viewOf(waived, { exception: loaded.view.one_package_exception });
      return { request: view, etag: pickupRequestEtagOf(view, waived.version) };
    });
  }
}

/** Whether the session holds a permission at all: the operation's own key is the guard's, and a second one inside it is the service's. */
function holds(authorized: AuthorizedRequest, permission: string): boolean {
  return authorized.session.authority.snapshot.grants.some(
    (each) => each.permission === permission,
  );
}

/** A note the ledger would not keep is refused before anything begins, naming the field and never repeating the text. */
function screened(note: string): string {
  const rule = noteRefusal(note);
  if (rule !== undefined) throw violation('/note', rule);
  return note;
}
