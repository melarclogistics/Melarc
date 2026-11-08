import type {
  AdministratorRecoveries,
  RecoveryRequestView,
} from '../platform/auth/recovery/administrator-recovery.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import type { ReasonValidator } from '../platform/settings/reason-validator.js';
import { validated } from './staff-identity-administration.service.js';
import { lockStaffIdentity, requireVersion } from './staff-locked-identity.js';
import { checkedNote } from './staff-note.js';

/** What `recoverStaffCredential` takes (`CredentialRecoveryInitiation`): a reason and a note; the path names the identity. */
export interface CredentialRecoveryInitiation {
  readonly reason_code: string;
  readonly note?: string;
}

export interface StaffCredentialRecoveryOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  readonly recoveries: Pick<AdministratorRecoveries, 'recover'>;
}

const OPERATION = 'recoverStaffCredential';

/**
 * `recoverStaffCredential` (S0.51b; `staff.credential.recover`, Platform Admin at every hub; credential-recovery.md sections 5.5 and 5.7;
 * `AC-SLICE-000-105`, the administrator half of `-121`): a Platform Admin starts the recovery of a staff member's existing password, and
 * **the new password reaches nobody but that staff member**: a `RecoveryRequest` with the administrator as `initiated_by`, its link queued
 * to the verified work email, and nothing in the answer but where the request stands. The password is unchanged and no session is created
 * until the staff member completes the link themselves (`completeCredentialRecovery`), and the MFA factor is never touched.
 *
 * - **It runs in the caller's own staff context under the key** (`OperationRunner.mutate`; migration 0038 states the mechanism). The guard
 *   has answered the key and the record's scope before this runs; the note is judged first, as a malformed body is.
 * - **Under the identity's lock** (`melarc.staff_locked_facts`): the version (`If-Match` against the ETag `getStaffIdentity` gives), then the
 *   eligibility (`ACTIVE` or `SUSPENDED` with an established password; a `PENDING_APPROVAL`, `REJECTED` or `OFFBOARDED` identity, or one with
 *   no password, is `STATE_CONFLICT` and nothing is written: the setup grant reaches the last), then the reason.
 * - **The coexistence rule is self-service's** (`AdministratorRecoveries`): inside the guard or at the cap the existing request's metadata is
 *   returned with `coalesced` true, and nothing is issued.
 */
export class StaffCredentialRecovery {
  readonly #options: StaffCredentialRecoveryOptions;

  constructor(options: StaffCredentialRecoveryOptions) {
    this.#options = options;
  }

  async recover(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: CredentialRecoveryInitiation,
  ): Promise<RecoveryRequestView> {
    const { runner, reasons, recoveries } = this.#options;
    const administrator = authorized.session.principalId;
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const before = await lockStaffIdentity(handle, id);
      requireVersion(ifMatch, before.etag);
      if (!['ACTIVE', 'SUSPENDED'].includes(before.row.status) || !before.facts.hasCredential) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Recovery repairs the password of an active or suspended identity that has one',
        );
      }
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: OPERATION,
        ...(note === undefined ? {} : { note }),
      });
      return recoveries.recover(handle, {
        principal: { type: 'STAFF', id: before.row.id },
        channel: 'EMAIL',
        // As entered, without the padding the canonical form removes: the address the approval accepted.
        destination: before.row.work_email.trim(),
        administrator,
        reason: { code: reason.code, label: reason.label },
        ...(note === undefined ? {} : { note }),
        ...(before.row.primary_hub_id === null
          ? {}
          : { responsibleHubId: before.row.primary_hub_id }),
      });
    });
  }
}
