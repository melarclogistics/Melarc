import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import type { OutboxWriter } from '../platform/notifications/outbox-writer.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import {
  anomalyOf,
  attemptLimitOf,
  permitsAttempt,
  type SettingAnomaly,
} from './attempt-ceiling.js';
import { requireServiceDay } from './booking-rules.js';
import { cutoffVerdict, type CutoffVerdict } from './cutoff.js';
import { estimateOf } from './estimate-view.js';
import { pickupRequestEtagOf } from './pickup-request-etag.js';
import { loadRequest, requireCurrent, type LoadedRequest } from './pickup-request-loader.js';
import {
  REQUEST_COLUMNS,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

export interface PickupRequestConfirmationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  /** The outbox envelope of the act, written beside its audit event so that the lane of the worker tells the people it concerns (S1.12). */
  readonly outbox: Pick<OutboxWriter, 'write'>;
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
}

export interface ConfirmedRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

/**
 * `confirmPickupRequest` (S1.15; `pickup.request.confirm`; `AC-SLICE-001-01`, `-03`, `-04`, `-10`; pickup-request.md sections 5.1 and 5.2;
 * state-machines.md section 3): Ops moves a `PENDING` request to `CONFIRMED`, and it becomes manifest-eligible.
 *
 * - **Under the request's lock and its version.** The row is read `for update` and `If-Match` is compared with the ETag recomputed from
 *   it, by the function a read uses (`loadRequest`): two Ops members who read one request and both confirm it are put in a line, and the
 *   second holds a token for a request that has since moved (`STATE_CONFLICT`, `AC-10`). The guard has answered the surface, the CSRF
 *   token, the permission and the hub of the record before this runs.
 * - **The guards are revalidated after the lock, in the contract's order**: the minimum of two packages (a single package waits for its
 *   one-package exception to be approved, S1.16), the service day, the sender not suspended, the
 *   attempt cap (`MELARC_MAX_PICKUP_ATTEMPTS`, lifted for one further attempt by the Senior Ops extension the request carries, `attempt-ceiling.ts`). `ZONE_NOT_SERVICED_ON_DATE` is declared and
 *   unreachable: the calendar is the same Monday to Saturday in every zone (section 21.1, `MSC-DEC-149`).
 * - **A booking past the hub's cutoff is confirmed and queued, never refused** (`CONFLICT-024`; `BOOKING_CUTOFF_PASSED` is withdrawn):
 *   `cutoff_exception_state` becomes `PENDING_OPS_REVIEW`. The cutoff is judged on the database's clock in the hub's zone (`cutoff.ts`),
 *   with the grace window for a registered vendor that has settled (no `OVERDUE` standing). **A setting that is unset or invalid decides
 *   nothing and blocks nothing**: the confirmation goes on and the condition is recorded in the audit event (`cutoff_check`,
 *   `attempt_cap_check`), as an operational decision is never held hostage to missing commercial configuration.
 * - **The answer carries the indicative estimate** (the base fee times the packages, provisional, never a price; for a single package
 *   with an approved exception, the fee that applies at the recipient's address plus the single-package pickup fee, and none while that
 *   address belongs to no known zone) computed now from the configuration in force, and creates no credit reservation and no charge (section 5.2.1). It is not stored: a read carries none.
 * - **The configuration is read before the transaction that confirms**, as the booking reads it (the platform allows one connection to a
 *   request): the hub is found in a short transaction of its own, the configuration read next, and the confirming transaction re-checks
 *   that the hub is the same.
 */
export class PickupRequestConfirmation {
  readonly #options: PickupRequestConfirmationOptions;

  constructor(options: PickupRequestConfirmationOptions) {
    this.#options = options;
  }

  async confirm(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<ConfirmedRequest> {
    const { runner, audit, outbox, configuration } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;

    const hubId = await runner.mutate(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(
        sql`select responsible_hub_id from pickup_request where id = ${id}::uuid`,
      );
      return (found.rows[0] as { responsible_hub_id: string } | undefined)?.responsible_hub_id;
    });
    if (hubId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    const config = await configuration.forHub(hubId);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await loadRequest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const { row } = loaded;
      if (row.responsible_hub_id.toLowerCase() !== config.hubId.toLowerCase()) {
        // The request moved to another hub between the two transactions (a reassignment): nothing was written, and the confirmation is
        // sent again against the hub it now belongs to.
        throw new Error('The hub of the request changed while it was being confirmed');
      }

      requireCurrent(ifMatch, loaded);
      if (row.state !== 'PENDING') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a pending request can be confirmed');
      }

      this.#requireMinimum(loaded);
      requireServiceDay(row.scheduled_service_date);
      await this.#requireSenderActive(tx, row);
      const attemptCheck = await this.#attempts(tx, config, row);

      const instant = await this.#now(tx);
      const cutoff = await this.#cutoff(tx, config, row, instant);
      const late = cutoff.verdict.kind === 'LATE';

      const updated = await tx.execute(sql`
        update pickup_request
           set state = 'CONFIRMED', confirmed_at = ${instant.toISOString()}::timestamptz, confirmed_by = ${actor}::uuid,
               cutoff_exception_state = ${late ? 'PENDING_OPS_REVIEW' : null}
         where id = ${id}::uuid and state = 'PENDING'
        returning ${REQUEST_COLUMNS}`);
      const confirmed = updated.rows[0] as unknown as PickupRequestRow | undefined;
      // Under the lock and having read the row as PENDING, the update cannot miss it.
      if (confirmed === undefined) throw new Error('A locked pending request was not confirmed');

      const exception = loaded.view.one_package_exception;
      const view = viewOf(confirmed, {
        estimate: estimateOf(config, {
          packageCount: confirmed.declared_package_count,
          serviceDate: confirmed.scheduled_service_date,
          ...(exception === null ? {} : { deliveryLocation: exception.recipient.location }),
        }),
        exception,
      });
      await audit.write(handle, {
        code: 'pickup.request.confirmed',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: confirmed.responsible_hub_id,
        ...(confirmed.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: confirmed.vendor_organization_id }),
        previousState: 'PENDING',
        resultingState: 'CONFIRMED',
        detail: {
          cutoff_check: cutoff.check,
          ...(attemptCheck === undefined ? {} : { attempt_cap_check: attemptCheck }),
        },
      });
      // The envelope of the same act (S1.12; SECURITY_DESIGN.md §14.7): it commits with the confirmation or not at all, and its scope is
      // the request's own, which the database checks against the row just changed. Whom it tells, and what is said, is the lane's.
      await outbox.write(handle, {
        eventType: 'pickup.request.confirmed',
        aggregate: { type: 'PICKUP_REQUEST', id },
        responsibleHubId: confirmed.responsible_hub_id,
        vendorOrganizationId: confirmed.vendor_organization_id,
        operationId: 'confirmPickupRequest',
      });
      return { request: view, etag: pickupRequestEtagOf(view, confirmed.version) };
    });
  }

  /**
   * A single package waits for its exception to be approved: the one the booking carries, which an approval sets and a clone inherits. An
   * exception that is only asked for, or was refused, is not one. A request of two or more needs none.
   */
  #requireMinimum({ row, view }: LoadedRequest): void {
    if (row.declared_package_count >= 2) return;
    if (row.one_package_exception_id === null || view.one_package_exception?.state !== 'APPROVED') {
      throw ApiException.of(
        ErrorCode.PickupMinimumNotMet,
        'A pickup is at least two packages; a single package needs an approved exception',
      );
    }
  }

  /** Only a suspended sender is a bar (section 21.1): its requests go on hold and are not confirmed. A walk-in has no suspension. */
  async #requireSenderActive(tx: DatabaseTransaction, row: PickupRequestRow): Promise<void> {
    if (row.vendor_organization_id === null) return;
    const found = await tx.execute(
      sql`select operational_status from vendor_organization where id = ${row.vendor_organization_id}::uuid`,
    );
    const status = (found.rows[0] as { operational_status: string } | undefined)
      ?.operational_status;
    if (status === 'SUSPENDED') {
      throw ApiException.of(ErrorCode.SenderSuspended, 'The sender is suspended');
    }
  }

  /**
   * The attempts of the request against the hub's cap and the extension it carries (`attempt-ceiling.ts`): a request past its ceiling is
   * refused. A cap that is unset or invalid cannot be applied and does not block (the condition is returned to be recorded).
   */
  async #attempts(
    tx: DatabaseTransaction,
    config: HubConfiguration,
    row: PickupRequestRow,
  ): Promise<SettingAnomaly | undefined> {
    const limit = await attemptLimitOf(tx, config, row);
    if (limit.kind === 'UNAVAILABLE') return limit.anomaly;
    if (!permitsAttempt(limit, row.attempt_number)) {
      throw ApiException.of(
        ErrorCode.PickupAttemptLimitReached,
        'The pickup has reached its attempts; only a force-extension by hub Senior Ops allows another',
      );
    }
    return undefined;
  }

  /** The instant of the confirmation: the database's, as the settings in force are read on it. */
  async #now(tx: DatabaseTransaction): Promise<Date> {
    const found = await tx.execute(sql`select clock_timestamp() as instant`);
    const instant = (found.rows[0] as { instant: string | Date } | undefined)?.instant;
    if (instant === undefined) throw new Error('The database gave no time');
    return instant instanceof Date ? instant : new Date(instant);
  }

  /** The verdict against the hub's cutoff and the name under which the audit event records how it was reached. */
  async #cutoff(
    tx: DatabaseTransaction,
    config: HubConfiguration,
    row: PickupRequestRow,
    instant: Date,
  ): Promise<{ readonly verdict: CutoffVerdict; readonly check: string }> {
    let cutoffMinutes: number;
    try {
      cutoffMinutes = config.timeOfDay('booking_cutoff_time').value.minutesSinceMidnight;
    } catch (error) {
      const anomaly = anomalyOf(error);
      if (anomaly === undefined) throw error;
      return { verdict: { kind: 'UNSET' }, check: anomaly };
    }
    const graceMinutes = await this.#graceOf(tx, config, row);
    const verdict = cutoffVerdict({
      instant,
      serviceDate: row.scheduled_service_date,
      cutoffMinutes,
      graceMinutes,
    });
    return { verdict, check: verdict.kind };
  }

  /**
   * The grace window past the cutoff (`MSC-DEC-254`): given to a registered vendor that has settled (an organisation with no `OVERDUE`
   * standing; one with no standing at all has never been overdue), and to nobody else. A window that is unset or invalid is none.
   */
  async #graceOf(
    tx: DatabaseTransaction,
    config: HubConfiguration,
    row: PickupRequestRow,
  ): Promise<number> {
    if (row.vendor_organization_id === null) return 0;
    let window: number;
    try {
      window = config.integer('vendor_credit_grace_window_minutes').value;
    } catch (error) {
      if (anomalyOf(error) === undefined) throw error;
      return 0;
    }
    if (window === 0) return 0;
    const standing = await tx.execute(
      sql`select financial_status from vendor_financial_standing where vendor_organization_id = ${row.vendor_organization_id}::uuid`,
    );
    const status = (standing.rows[0] as { financial_status: string } | undefined)?.financial_status;
    return status === 'OVERDUE' ? 0 : window;
  }
}
