import { sql } from 'drizzle-orm';

import { noteRefusal } from '../platform/audit/audit-record.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunAccess } from '../platform/domain-ports/run-access.port.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { OutboxWriter } from '../platform/notifications/outbox-writer.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import { validatedReason } from './pickup-reason-validation.js';
import {
  STOP_COLUMNS,
  stopViewOf,
  type PickupStopRow,
  type PickupStopView,
} from './pickup-manifest-view.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';
import { pickupReasonRequest, requestedVendorActionOf } from './pickup-vocabulary.js';

export interface PickupStopSkipOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The envelope of the Vendor's notice, written beside the audit event so that it commits with the skip or not at all (S1.12). */
  readonly outbox: Pick<OutboxWriter, 'write'>;
  /** The completion of the run by the system, in the transaction of the skip: the run port, which this domain implements (`pickup-run-access.adapter.ts`). */
  readonly runs: Pick<RunAccess, 'completeIfSettled'>;
}

export interface SkipBody {
  readonly reason_code: string;
  readonly note?: string;
}

export interface SkippedStop {
  readonly stop: PickupStopView;
  readonly etag: string;
}

/** A stop as the skip locks and returns it: the columns of a read, the version its token is made of, and the hub its event is about. */
interface LockedStop extends PickupStopRow {
  readonly version: number;
  readonly responsible_hub_id: string;
}

/** What the skip reads of the request of the stop: whose pickup it is, for the notice. */
interface RequestFacts {
  readonly id: string;
  readonly responsible_hub_id: string;
  readonly vendor_organization_id: string | null;
}

/** What is kept of a skip so that a retry with the same key is answered with it, byte for byte. */
interface StoredSkip {
  readonly etag: string;
  readonly stop: PickupStopView;
}

const OPERATION = 'skipPickupStop';

/**
 * `skipPickupStop` (S1.23; `pickup.stop.skip`; `AC-SLICE-001-74` and `-67`; MSC-DEC-412; state-machines.md section 5, the signed
 * `PENDING/ARRIVED → SKIPPED` row of Ops): **Ops authorises that a stop is not worked**, so that a run with one stop that cannot be attempted
 * can still close. It is Ops's act and never the rider's, nor the custody holder's: a rider who could skip a stop could choose which customers
 * to serve (the key is in no rider bundle).
 *
 * - **What it judges, in order.** The guard has answered the key, the surface, the CSRF token and the existence of the stop (a stop of another
 *   hub is `HUB_SCOPE_VIOLATION`, one that matches nothing `NOT_FOUND`); the interceptor, the headers. Then, in the transaction: the retry
 *   (`Idempotency-Key`); the note, which the ledger must be able to keep (`VALIDATION_FAILED`); the reason, which is a code of the
 *   `PICKUP_STOP_SKIP` catalogue and active, with its note where it requires one (`REASON_REQUIRED`, `REASON_NOT_ACTIVE`); then, **under the
 *   stop's lock**, the `ETag` of the stop as it is now (`STATE_CONFLICT`) and that the stop is still to be worked (`STATE_CONFLICT`: a stop
 *   already collected, failed or skipped, among them the one a cancellation skipped, is left exactly as it is).
 * - **What it writes**, in one transaction: the stop `SKIPPED` with its moment and the snapshot of the reason, and nothing else of it (it keeps its
 *   place in the order, its arrival and its claim: a skip does not release the claim, so the request is not returned to the pool by it); the
 *   completion of the run if this was the last stop to be worked and nothing was collected (`completeIfSettled` of the run port); `pickup.stop.skipped`; and,
 *   for a registered vendor, the envelope of its notice and `vendor.pickup_skip.notified`. **The request is not written**, and its attempt chain
 *   is not touched: a skip is Melarc's operational decision and not a failed collection. The request keeps its state; Ops reschedules it or
 *   cancels it with the acts it already has.
 * - **The Vendor is told, always** (including when it asked for the skip itself, where the notice records that the request was honoured). An
 *   individual sender (an ad-hoc sender) is not a Vendor: no document asks for a text to it on a skip, so none is queued, and the event of
 *   the skip says so (`vendor_notice: 'NO_VENDOR'`).
 * - **A retry is not a second skip**: the `Idempotency-Key` replays the answer, the same key for another stop or body is
 *   `IDEMPOTENCY_KEY_CONFLICT`, and another key for a stop already skipped is `STATE_CONFLICT`.
 * - **Locks.** The stop is locked alone, and the manifest is locked only if the run is in progress, after the stop (`pickup-run-completion.ts`
 *   gives the order and why it holds). The request is not locked: the cancellation of the request locks the request and then the stop, so the
 *   two wait for each other in one direction only, and end as one serial order would.
 */
export class PickupStopSkip {
  readonly #options: PickupStopSkipOptions;

  constructor(options: PickupStopSkipOptions) {
    this.#options = options;
  }

  async skip(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: SkipBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<SkippedStop> {
    const { runner, audit, idempotency, reasons, outbox, runs } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const { body } = request;
    // A note the ledger could not keep is refused as a malformed body, before the reason (which judges whether a note is present, not what is in it).
    if (body.note !== undefined && body.note.trim() !== '') {
      const rule = noteRefusal(body.note);
      if (rule !== undefined) {
        throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
          violations: [{ in: 'body', pointer: '/note', rule }],
        });
      }
    }
    const officerId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: officerId,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as StoredSkip;
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

      const reason = await validatedReason(
        reasons,
        handle,
        pickupReasonRequest(OPERATION, body.reason_code, body.note),
      );

      // The stop, under its lock. The guard has found it in a hub of the grant, so one that does not come back is gone.
      const found = await tx.execute(sql`
        select ${STOP_COLUMNS}, version, responsible_hub_id from pickup_stop where id = ${id}::uuid for update`);
      const stop = found.rows[0] as unknown as LockedStop | undefined;
      if (stop === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const current = pickupStopEtagOf(stopViewOf(stop), stop.version);
      if (request.ifMatch !== current) {
        throw ApiException.of(ErrorCode.StateConflict, 'The stop has changed since it was read');
      }
      if (stop.state !== 'PENDING' && stop.state !== 'ARRIVED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The stop is already resolved and cannot be skipped',
        );
      }

      // A stop the rider has counted is not skipped (S1.26): the parcels were taken at the door, and the handshake closes the stop. Looked for under
      // the stop's lock; the database refuses it for every writer.
      const counted = await tx.execute(
        sql`select 1 from collection_record where pickup_stop_id = ${stop.id}::uuid`,
      );
      if (counted.rows.length > 0) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The pickup has been collected and cannot be skipped',
          { rule: 'collection_recorded' },
        );
      }

      const requests = await tx.execute(sql`
        select id, responsible_hub_id, vendor_organization_id from pickup_request where id = ${stop.pickup_request_id}::uuid`);
      const owner = requests.rows[0] as unknown as RequestFacts | undefined;
      // The request of a stop is in the stop's hub, and the officer reads both through the same grant.
      if (owner === undefined) throw new Error('The request of a locked stop was not found');

      // The lock first, and then the instant: the skip is stamped no earlier than anything that committed to the stop while this waited.
      const moment = await tx.execute(sql`select clock_timestamp() as instant`);
      const raw = (moment.rows[0] as { instant: string | Date } | undefined)?.instant;
      if (raw === undefined) throw new Error('The database gave no time');
      const skippedAt = (raw instanceof Date ? raw : new Date(raw)).toISOString();
      const snapshot = {
        reason_code: reason.code,
        label: reason.label,
        ...(body.note === undefined || body.note.trim() === '' ? {} : { note: body.note }),
        skipped_at: skippedAt,
      };
      const skipped = await tx.execute(sql`
        update pickup_stop
           set state = 'SKIPPED', resolved_at = ${skippedAt}::timestamptz, skip_snapshot = ${JSON.stringify(snapshot)}::jsonb
         where id = ${stop.id}::uuid and state = ${stop.state}
        returning ${STOP_COLUMNS}, version, responsible_hub_id`);
      const row = skipped.rows[0] as unknown as LockedStop | undefined;
      // Under the lock and having read the stop in that state, the update cannot miss it.
      if (row === undefined) throw new Error('A locked stop was not skipped');

      const hasVendor = owner.vendor_organization_id !== null;
      await audit.write(handle, {
        code: 'pickup.stop.skipped',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupStop', id: row.id },
        responsibleHubId: row.responsible_hub_id,
        previousState: stop.state,
        resultingState: 'SKIPPED',
        reason: { code: reason.code, label: reason.label },
        ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
        relatedIds: {
          pickup_request_id: row.pickup_request_id,
          pickup_manifest_id: row.pickup_manifest_id,
        },
        detail: { cause: 'AUTHORISED_SKIP', vendor_notice: hasVendor ? 'QUEUED' : 'NO_VENDOR' },
      });
      await runs.completeIfSettled(handle, row.pickup_manifest_id, 'LAST_STOP_SKIPPED');

      if (owner.vendor_organization_id !== null) {
        // The notice of the same act (MSC-DEC-412): the vendor, the request, the reason and what would unblock the pickup. It commits with the skip or
        // not at all; its words are the lane's, and the note of the skip is Ops's own and is in no part of it.
        await outbox.write(handle, {
          eventType: 'pickup.stop.skipped',
          aggregate: { type: 'PICKUP_REQUEST', id: owner.id },
          responsibleHubId: owner.responsible_hub_id,
          vendorOrganizationId: owner.vendor_organization_id,
          operationId: OPERATION,
          payload: { reason: reason.code, action: requestedVendorActionOf(reason.code) },
        });
        await audit.write(handle, {
          code: 'vendor.pickup_skip.notified',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupRequest', id: owner.id },
          responsibleHubId: owner.responsible_hub_id,
          vendorOrganizationId: owner.vendor_organization_id,
          reason: { code: reason.code, label: reason.label },
          relatedIds: { pickup_stop_id: row.id, pickup_manifest_id: row.pickup_manifest_id },
          detail: { requested_action: requestedVendorActionOf(reason.code), delivery: 'QUEUED' },
        });
      }

      const view = stopViewOf(row);
      const etag = pickupStopEtagOf(view, row.version);
      const answer: StoredSkip = { etag, stop: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { stop: view, etag };
    });
  }
}
