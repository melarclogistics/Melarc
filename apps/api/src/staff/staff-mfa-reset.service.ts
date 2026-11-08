import type { MfaResetService } from '../platform/auth/mfa/mfa-reset.service.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { lockStaffIdentity, requireVersion } from './staff-locked-identity.js';
import { checkedNote } from './staff-note.js';

/** The answer of a reset (`MfaResetResult`): counts and an expiry, never the grant, a seed, a token or a QR. */
export interface MfaResetView {
  readonly sessions_terminated: number;
  readonly reenrolment_grant_issued: boolean;
  readonly coalesced: boolean;
  readonly grant_expires_at: string | null;
}

export interface StaffMfaResetOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly reset: Pick<MfaResetService, 'reset'>;
}

/**
 * `resetStaffMfa` (S0.37; `staff.mfa.reset`, Platform Admin; `AC-SLICE-000-37`, `-119`, `-132`): the operation on the staff side of the
 * line. It runs through `OperationRunner.mutate` in the Platform Admin's own context, takes **the target identity's lock** and reads the
 * facts under it (`melarc.staff_locked_facts`), compares the caller's `If-Match` with the ETag recomputed from them, and hands the rest to
 * the reset service of the platform: the eligibility from the recorded state, the reason of the branch it gives, the maker-checker rule
 * last, and the effects. The target is named in the path and its scope and existence were answered before the body was read.
 */
export class StaffMfaReset {
  readonly #options: StaffMfaResetOptions;

  constructor(options: StaffMfaResetOptions) {
    this.#options = options;
  }

  async reset(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: { readonly reason_code: string; readonly note?: string },
  ): Promise<MfaResetView> {
    const { runner, reset } = this.#options;
    // The note is judged with the rest of the body, before the version and the state.
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const locked = await lockStaffIdentity(handle, id);
      requireVersion(ifMatch, locked.etag);
      const outcome = await reset.reset(handle, {
        actor: authorized.session.principalId,
        target: {
          id: locked.row.id,
          workEmail: locked.row.work_email.trim(),
          hubId: locked.row.primary_hub_id,
        },
        facts: locked.facts,
        reasonCode: body.reason_code,
        ...(note === undefined ? {} : { note }),
      });
      return {
        sessions_terminated: outcome.sessionsTerminated,
        reenrolment_grant_issued: outcome.issued,
        coalesced: outcome.coalesced,
        grant_expires_at:
          outcome.grantExpiresAt === null ? null : outcome.grantExpiresAt.toISOString(),
      };
    });
  }
}
