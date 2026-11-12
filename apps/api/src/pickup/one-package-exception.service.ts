import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import { SettingInvalidError, SettingMissingError } from '../platform/settings/settings-reader.js';
import {
  EXCEPTION_COLUMNS,
  type ExceptionRow,
  type FeeSnapshot,
} from './one-package-exception-view.js';
import { normalisePhone } from './phone.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { loadRequest } from './pickup-request-loader.js';
import type { LocationView } from './pickup-request-view.js';

const FEE_SETTING = 'single_package_pickup_fee';
const APPROVE = 'pickup.exception.approve';

/** The body of `requestOnePackageException` as the contract's schema has validated it (the interceptor ran before this). */
export interface OnePackageExceptionBody {
  readonly note: string;
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly location: LocationView;
  };
}

/** The contract's `Approval`: the uniform maker-checker record both operations answer. */
export interface ApprovalView {
  readonly id: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly requested_by: string;
  readonly approved_by: string | null;
  readonly note: string;
}

export interface OnePackageExceptionsOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
  readonly clock: Clock;
}

const violation = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/**
 * The one-package exception (S1.16; `AC-SLICE-001-03`; pickup-request.md sections 5.1 and 5.2; state-machines.md section 3;
 * permissions.md section 6): the maker-checker pair that lets a request of one package be confirmed.
 *
 * **`requestOnePackageException`** (`pickup.exception.request`, Ops only: a vendor holds no such key and is refused by the guard). Ops
 * raises it for a `PENDING` request of one package that has no live exception, with a note and the recipient (name, phone and delivery
 * address are mandatory for a single package, section 21.1). It changes nothing of the request but what the request shows: the exception,
 * and so its ETag. The recipient's phone is stored in its normal form; the request stays `PENDING` and cannot be confirmed until an
 * approval (`PICKUP_MINIMUM_NOT_MET`).
 *
 * **`approveOnePackageException`** (`pickup.exception.approve`, **any holder**: Ops Staff, Senior Ops or a Platform Admin, by the grant
 * and never by a role's name). The refusal order is the staff identity's: the guard answers the permission and the hub; then the request
 * is locked and the exception's state is judged under the lock (`STATE_CONFLICT` unless it is waiting); the maker-checker rule is last
 * (`SELF_APPROVAL_FORBIDDEN` for the requester, **unless the grant that authorizes the approval is at the Platform Admin tier**; a trigger
 * is the backstop for every other writer). The approval links the exception to the request (which is what makes it confirmable) and
 * **snapshots the `single_package_pickup_fee` as due, not collected**: the amount, the setting key and the version it was read from,
 * so that a later change of the setting does not reprice it. A fee that cannot be read never blocks the approval: it is recorded as
 * absent and the audit event says why (`fee_check`). Posting the fee to the vendor's statement or gating the pickup behind prepayment is
 * `SLICE-011`'s, so `pickup.request.single_package_fee_posted` is not written here.
 *
 * - **The request is locked first, then the exception**, for every writer of either, so two operations on one request are put in a line.
 * - **Two enhanced events record the approval** (audit.md): `pickup.exception.approved` (which actor, which key and tier, not a role) and
 *   `pickup.request.single_package_approved` (the request's own timeline). Both carry the change as a safe before-and-after.
 * - **The configuration is read before the transaction that approves**, as the confirmation reads it (the platform allows one connection
 *   to a request).
 */
export class OnePackageExceptions {
  readonly #options: OnePackageExceptionsOptions;

  constructor(options: OnePackageExceptionsOptions) {
    this.#options = options;
  }

  async request(
    authorized: AuthorizedRequest,
    correlationId: string,
    requestId: string,
    body: OnePackageExceptionBody,
  ): Promise<ApprovalView> {
    const { runner, audit, clock } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;

    // Judged before the transaction, where a malformed body is judged: the recipient (named, reachable, deliverable), then the note.
    const name = body.recipient.name.trim();
    if (name === '') throw violation('/recipient/name', 'required');
    const phone = normalisePhone(body.recipient.phone);
    if (phone === undefined) throw violation('/recipient/phone', 'format');
    if (body.recipient.location.address.trim() === '') {
      throw violation('/recipient/location/address', 'required');
    }
    const note = requiredNote(body.note);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await loadRequest(handle, requestId, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const { row, view } = loaded;
      if (row.state !== 'PENDING' || row.declared_package_count !== 1) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Only a pending request of one package takes a one-package exception',
        );
      }
      if (view.one_package_exception !== null && view.one_package_exception.state !== 'REJECTED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The request already has a one-package exception',
        );
      }

      const id = randomUUIDv7(clock);
      await tx.execute(sql`
        insert into one_package_exception (id, pickup_request_id, requested_by, note, recipient_name, recipient_phone, recipient_location)
        values (${id}::uuid, ${requestId}::uuid, ${actor}::uuid, ${note}, ${name}, ${phone}, ${JSON.stringify(body.recipient.location)}::jsonb)`);

      await audit.write(handle, {
        code: 'pickup.exception.requested',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id: requestId },
        responsibleHubId: row.responsible_hub_id,
        ...(row.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: row.vendor_organization_id }),
        relatedIds: { exception_id: id },
        detail: { exception_state: 'REQUESTED' },
      });
      return { id, state: 'REQUESTED', requested_by: actor, approved_by: null, note };
    });
  }

  async approve(
    authorized: AuthorizedRequest,
    correlationId: string,
    requestId: string,
  ): Promise<ApprovalView> {
    const { runner, audit, configuration } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    // The tier of the grant that authorizes this approval: a Platform Admin's is `P`, and is the only one that may approve what it asked for.
    const tier = authorized.grant?.tier ?? null;

    const hubId = await runner.mutate(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(
        sql`select responsible_hub_id from pickup_request where id = ${requestId}::uuid`,
      );
      return (found.rows[0] as { responsible_hub_id: string } | undefined)?.responsible_hub_id;
    });
    if (hubId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    const config = await configuration.forHub(hubId);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await loadRequest(handle, requestId, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const { row, view } = loaded;
      if (row.responsible_hub_id.toLowerCase() !== config.hubId.toLowerCase()) {
        // The request moved to another hub between the two transactions (a reassignment): nothing was written, and the approval is sent again.
        throw new Error('The hub of the request changed while the exception was being approved');
      }

      // An exception is decided for a request that still waits for it: one cancelled since it was asked for keeps its exception REQUESTED (and
      // is out of the approver's queue for that reason, AC-QSUM-12), and approving it would link a cancelled request, which its guard refuses.
      if (row.state !== 'PENDING') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The request is not waiting for confirmation',
        );
      }

      const shown = view.one_package_exception;
      if (shown?.state !== 'REQUESTED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'No one-package exception is waiting for a decision',
        );
      }
      // The exception's own row, locked after the request's, and judged again on what it is now: a writer that is not this operation may
      // have decided it.
      const locked = await tx.execute(
        sql`select ${EXCEPTION_COLUMNS} from one_package_exception e where e.id = ${shown.id}::uuid for update`,
      );
      const exception = locked.rows[0] as unknown as ExceptionRow | undefined;
      if (exception?.state !== 'REQUESTED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'No one-package exception is waiting for a decision',
        );
      }
      // The maker-checker rule is last (permissions.md section 6): the requester may not approve their own, unless the grant is a Platform Admin's.
      if (exception.requested_by === actor && tier !== 'P') {
        throw ApiException.of(
          ErrorCode.SelfApprovalForbidden,
          'A one-package exception is approved by someone other than the one who asked for it',
        );
      }

      const fee = this.#fee(config);
      const updated = await tx.execute(sql`
        update one_package_exception
           set state = 'APPROVED', approved_by = ${actor}::uuid, decided_at = now(),
               single_package_fee_snapshot = ${fee.snapshot === null ? null : JSON.stringify(fee.snapshot)}::jsonb
         where id = ${exception.id}::uuid and state = 'REQUESTED'
        returning id`);
      // Under the locks and having read the row as requested, the update cannot miss it.
      if (updated.rows.length !== 1)
        throw new Error('A locked requested exception was not approved');
      await tx.execute(
        sql`update pickup_request set one_package_exception_id = ${exception.id}::uuid where id = ${requestId}::uuid`,
      );

      const common = {
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id: requestId },
        responsibleHubId: row.responsible_hub_id,
        ...(row.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: row.vendor_organization_id }),
      } as const;
      await audit.write(handle, {
        ...common,
        code: 'pickup.exception.approved',
        enhanced: true,
        beforeAfter: {
          exception_state: { before: 'REQUESTED', after: 'APPROVED' },
          one_package_exception_id: { before: null, after: exception.id },
        },
        relatedIds: { exception_id: exception.id, requested_by: exception.requested_by },
        detail: {
          permission: APPROVE,
          grant_tier: tier,
          ...(fee.check === undefined ? {} : { fee_check: fee.check }),
        },
      });
      await audit.write(handle, {
        ...common,
        code: 'pickup.request.single_package_approved',
        enhanced: true,
        beforeAfter: { one_package_exception_id: { before: null, after: exception.id } },
        relatedIds: { exception_id: exception.id },
        detail: fee.snapshot === null ? {} : { fee_due_minor: fee.snapshot.amount_minor },
      });
      return {
        id: exception.id,
        state: 'APPROVED',
        requested_by: exception.requested_by,
        approved_by: actor,
        note: exception.note,
      };
    });
  }

  /**
   * The single-package fee as the hub's setting stands now, snapshotted as due. A fee that is unset or invalid is no fee: the approval
   * goes on without a snapshot and the condition is returned to be recorded (an operational decision is never held hostage to commercial
   * configuration, settings.md section 2).
   */
  #fee(config: HubConfiguration): {
    readonly snapshot: FeeSnapshot | null;
    readonly check?: 'SETTING_MISSING' | 'SETTING_INVALID';
  } {
    try {
      const fee = config.money(FEE_SETTING);
      return {
        snapshot: {
          amount_minor: fee.value,
          setting_key: FEE_SETTING,
          effective_version: String(fee.reference.effectiveVersion),
        },
      };
    } catch (error) {
      if (error instanceof SettingMissingError) return { snapshot: null, check: 'SETTING_MISSING' };
      if (error instanceof SettingInvalidError) return { snapshot: null, check: 'SETTING_INVALID' };
      throw error;
    }
  }
}
