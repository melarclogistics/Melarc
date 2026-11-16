import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { afterCountOf, type AfterCountRow } from './hub-after-count.js';
import { noteHubCrossing } from './hub-crossing.js';
import { hubIntakeEtagMatches, hubIntakeEtagOf } from './hub-intake-etag.js';
import {
  HUB_INTAKE_READ_COLUMNS,
  hubIntakeViewOf,
  type HubIntakePostCountView,
  type HubIntakeRow,
} from './hub-intake-view.js';

const OPERATION = 'submitBlindCount';

/** The most a count may state: the largest the column holds (the contract bounds a count below by zero and above by nothing). */
const MAX_PHYSICAL_COUNT = 2_147_483_647;

export interface HubBlindCountOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
}

/** The body of `submitBlindCount` as the contract's schema has validated it (the interceptor ran before this): the physical count, and nothing else. */
export interface BlindCountBody {
  readonly physical_count: number;
}

/** The answer of the count, and what a retry with the same key is answered with, byte for byte: the intake as it is now, and its `ETag`. */
export interface CountedIntake {
  readonly intake: HubIntakePostCountView;
  readonly etag: string;
}

const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * `submitBlindCount` (S1.33; `hub.intake.count`; `AC-SLICE-001-38`, `-43`, `-76`; features/hub/hub-intake.md section 5.1 steps 4 and 5; state-machines.md section 7; `MSC-DEC-416`): a
 * receiver of the intake's hub commits the physical count of an intake that is waiting for it, and **the response reveals the comparison for the first time**.
 *
 * - **The body is the count and nothing else.** The declaration is never an input (§35.5.2: the system must not "require the frontend to submit" it): the contract's schema is closed, so a
 *   body that carries it is `VALIDATION_FAILED` and nothing is committed, and a number that is no count is refused here before anything is read.
 * - **The database makes the comparison.** The application's login cannot read the declaration, so the count is committed by one function of the database (`melarc.commit_blind_count`,
 *   migration `0094`) that reads it as the owner, makes the difference and the variance, writes the count and takes the intake to `COUNTED` and then, as the System does, to
 *   `READY_FOR_ITEMIZATION` (a count that matches a declaration above zero) or `RECONCILIATION_REQUIRED` (a variance, or **a zero declaration whatever the variance**). The guard of the table
 *   holds the same comparison for every writer.
 * - **Judged in this order**: the principal and the key's format; the number; then, in the transaction, the retry (`Idempotency-Key`: a replay is answered before anything about the intake is
 *   judged, byte for byte, and another body under the same key is `IDEMPOTENCY_KEY_CONFLICT`); the intake under its lock (`NOT_FOUND`: the route's guard has told `HUB_SCOPE_VIOLATION` for
 *   another hub's); that it is waiting for its count (`STATE_CONFLICT`, rule `already_counted`: **the second receiver of two who count at once**); and the `ETag` the receiver read
 *   (`STATE_CONFLICT`, rule `stale`: missing, weak, another intake's and out of date are one answer).
 * - **The lock is advisory and nothing here treats it as a guard** (§22.8, `AC-SLICE-001-43`): a receiver who does not hold the lock may count, and the receiver who holds it is refused by
 *   the same two rules as any other when the intake has been counted. The `ETag` does not move with the lock, so a refresh or a takeover never refuses a count.
 * - **The count is audited with both counts** (`hub.intake.counted`: the first moment they may legally appear together, in the ledger and nowhere before); the photos of the parcels counted at
 *   the door are in the response and in no event.
 * - **No limit on the parcels of an intake** (the Product Owner removed `intake_parcel_cap`, 15 November 2026, OB-S1-97): a count of any size is committed and compared as any other; only a whole number that the column holds is checked.
 * - **Not here:** a condition (S1.34).
 */
export class HubBlindCounts {
  readonly #options: HubBlindCountOptions;

  constructor(options: HubBlindCountOptions) {
    this.#options = options;
  }

  async submit(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: BlindCountBody;
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CountedIntake> {
    const { runner, audit, idempotency } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const physical = request.body.physical_count;
    if (!Number.isSafeInteger(physical) || physical < 0) {
      throw invalid('/physical_count', 'integer');
    }
    if (physical > MAX_PHYSICAL_COUNT) throw invalid('/physical_count', 'range');
    const receiver = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: receiver,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as CountedIntake;
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

      // The intake, under its lock: two receivers who count at once are judged one after the other, and the second finds the intake counted.
      const found = await tx.execute(
        sql`select ${HUB_INTAKE_READ_COLUMNS} from pickup_intake where id = ${id}::uuid for update`,
      );
      const row = found.rows[0] as unknown as HubIntakeRow | undefined;
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      await noteHubCrossing(audit, handle, authorized, row);
      if (row.state !== 'AWAITING_COUNT') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The intake has been counted: a count is committed once',
          { rule: 'already_counted' },
        );
      }
      const current = hubIntakeEtagOf(hubIntakeViewOf(row, undefined), row.version);
      if (!hubIntakeEtagMatches(request.ifMatch, current)) {
        throw ApiException.of(ErrorCode.StateConflict, 'The intake has changed since it was read', {
          rule: 'stale',
        });
      }

      // The count, by the one function that can read the declaration; it answers the declaration and the photos, for the first time.
      const committed = await tx.execute(
        sql`select intake_id, rider_declared_count, parcel_photo_ids from melarc.commit_blind_count(${id}::uuid, ${physical}::integer)`,
      );
      const after = committed.rows[0] as unknown as AfterCountRow | undefined;
      if (after === undefined) throw new Error('The count of a locked intake was not committed');
      const reread = await tx.execute(
        sql`select ${HUB_INTAKE_READ_COLUMNS} from pickup_intake where id = ${id}::uuid`,
      );
      const counted = reread.rows[0] as unknown as HubIntakeRow | undefined;
      if (counted === undefined) throw new Error('A counted intake could not be read');
      const view = hubIntakeViewOf(counted, afterCountOf(after));
      if (view.count_phase !== 'POST_COUNT') throw new Error('A counted intake is read as counted');

      await audit.write(handle, {
        code: 'hub.intake.counted',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupIntake', id },
        responsibleHubId: counted.responsible_hub_id,
        previousState: 'AWAITING_COUNT',
        resultingState: counted.state,
        relatedIds: {
          pickup_manifest_id: counted.pickup_manifest_id,
          pickup_request_id: counted.pickup_request_id,
        },
        // The first moment both counts may legally appear together (audit.md section 5.2).
        detail: {
          physical_count: view.physical_count,
          rider_declared_count: view.rider_declared_count,
          count_variance: view.count_variance,
          count_difference: view.count_difference,
        },
      });

      if (counted.state === 'RECONCILIATION_REQUIRED') {
        // A variance, or a zero declaration whatever the variance, opens the OS&D case (state-machines.md section 7): Senior Ops resolves it with a reason (S1.34).
        await audit.write(handle, {
          code: 'hub.osd.opened',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupIntake', id },
          responsibleHubId: counted.responsible_hub_id,
          previousState: 'COUNTED',
          resultingState: counted.state,
          relatedIds: {
            pickup_manifest_id: counted.pickup_manifest_id,
            pickup_request_id: counted.pickup_request_id,
          },
          detail: {
            dimension: view.count_variance === 'MATCH' ? 'ZERO_DECLARATION' : 'VARIANCE',
            count_variance: view.count_variance,
            count_difference: view.count_difference,
          },
        });
      }

      const answer: CountedIntake = { intake: view, etag: hubIntakeEtagOf(view, counted.version) };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }
}
