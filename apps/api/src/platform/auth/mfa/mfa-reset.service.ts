import { randomUUID } from 'node:crypto';

import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DeliveryNotQueueableError } from '../../delivery/delivery-errors.js';
import {
  ReasonRefusedError,
  type ReasonBranch,
  type ReasonValidator,
  type ValidatedReason,
} from '../../settings/reason-validator.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import type { SetupGrantStore, IssuedGrant } from '../setup-grants/setup-grant-store.js';
import type { TrustedBrowserStore } from '../trusted-browsers/trusted-browser-store.js';
import type { MfaFactorStore, StoredFactor } from './mfa-factor-store.js';
import { decideMfaResetState, type ResetFacts } from './mfa-reset-state.js';

/** The three recorded states a reset reaches (state-machines.md section 18; `audit-mfa-reset.ts` names them the same). */
export type RecordedResetState = 'ACTIVE_FACTOR' | 'STRANDED_ENROLMENT' | 'UNFINISHED_RESET';

/** What the reset acts on: the identity, the address its grant goes to (the work email, never anything a request says) and its hub. */
export interface MfaResetTarget {
  readonly id: string;
  /** The verified work email as the approval accepted it, trimmed. The grant is delivered here and nowhere else. */
  readonly workEmail: string;
  readonly hubId: string | null;
}

export interface MfaResetInput {
  /** The Platform Admin who acts: the transaction's own principal. */
  readonly actor: string;
  readonly target: MfaResetTarget;
  /** The facts read under the identity's lock, in this transaction (`melarc.staff_locked_facts`). */
  readonly facts: ResetFacts;
  /** What the client sent as the reason; the branch it is judged against is derived here, from the recorded state. */
  readonly reasonCode: unknown;
  /** The note the client sent, already checked by the operation: judged against the reason, and kept on `auth.mfa.reset`. */
  readonly note?: string;
}

export interface MfaResetOutcome {
  readonly sessionsTerminated: number;
  readonly issued: boolean;
  readonly coalesced: boolean;
  /** The expiry of the grant that is usable now, new or existing; null where none is known. Never the grant itself. */
  readonly grantExpiresAt: Date | null;
}

export interface MfaResetServiceOptions {
  readonly grants: Pick<SetupGrantStore, 'issue' | 'supersedePending' | 'findPendingOf'>;
  readonly factors: Pick<
    MfaFactorStore,
    'findActiveOf' | 'findPendingOf' | 'findLatestOf' | 'revokeAdministratively'
  >;
  readonly sessions: Pick<SessionStore, 'terminate'>;
  /** Ends the trusted browsers bound to the authenticator being reset (staff-authentication.md §5.8): they stand in for its code. */
  readonly trustedBrowsers: Pick<TrustedBrowserStore, 'revokeAll'>;
  readonly audit: AuditWriter;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The Ops origin's link for the re-enrolment page, with the token in the fragment (`linkTemplates`, `/setup/mfa`). */
  readonly reenrolmentLink: (token: string) => string;
}

const stateConflict = (message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message);

/** The recorded state the facts describe, for an identity the rule found eligible. */
function recordedStateOf(facts: ResetFacts): RecordedResetState {
  if (facts.hasActiveFactor) return 'ACTIVE_FACTOR';
  if (facts.hasPendingFactor) return 'STRANDED_ENROLMENT';
  return 'UNFINISHED_RESET';
}

/**
 * The effects of `resetStaffMfa` (S0.37; state-machines.md section 18, "What `resetStaffMfa` accepts and refuses"; credential-recovery.md;
 * `AC-SLICE-000-37`, `-119`; `GBT-B14`), run in the transaction of the operation, under the target identity's lock, in the Platform
 * Admin's own staff context under the key `staff.mfa.reset` (migration 0030 admits exactly these writes to that key). The operation
 * (`src/staff`) has locked the identity, read the facts and compared the caller's `If-Match`; this decides and acts, in the order of the
 * contract:
 *
 * 1. **Eligibility from the recorded state**, by the one rule the read projects (`decideMfaResetState`): an identity that is not
 *    `ACTIVE` or `SUSPENDED`, not privileged, with no established password, with no factor record at all, whose latest factor the system
 *    ended, or a seeded administrator outside the first state, is `STATE_CONFLICT`: **the absence of a factor is never eligibility**.
 * 2. **The reason, judged against the branch the recorded state gives** (`FACTOR_ACTIVE`, or `ENROLMENT_UNFINISHED` for the other two),
 *    never the client's: a reason of the other branch is `REASON_NOT_ACTIVE`, an empty one `REASON_REQUIRED`.
 * 3. **The maker-checker rule last**: resetting one's own factor is `SELF_APPROVAL_FORBIDDEN`.
 * 4. **Coalescing**: in an unfinished reset (no factor was created because the grant lapsed or its delivery failed), while a usable grant
 *    or a pending delivery attempt exists, nothing is issued; the call returns that grant's expiry and writes `auth.mfa.reset` with
 *    `COALESCED` and no diff.
 * 5. **Otherwise, atomically**: the factor is revoked by the administrator into the reset's episode (a live one, or a stranded `PENDING`
 *    one); the target's pending enrolment continuation is superseded and the pending re-enrolment grant is superseded by the new one,
 *    which names it (an expired or consumed predecessor keeps its state and is never named); every live session of the target ends
 *    `MFA_RESET`; and a new `MFA_REENROLMENT` grant of the same episode is queued to the work email. **It creates neither an `ACTIVE`
 *    factor nor a session**, and returns no seed, token or QR: only `beginMfaReenrolment` and a proven code do.
 *
 * A message that cannot be queued rolls the whole act back (`CREDENTIAL_DELIVERY_FAILED`); a write the ledger cannot take does too.
 */
export class MfaResetService {
  readonly #options: MfaResetServiceOptions;

  constructor(options: MfaResetServiceOptions) {
    this.#options = options;
  }

  async reset(handle: TransactionHandle, input: MfaResetInput): Promise<MfaResetOutcome> {
    const { grants, factors, sessions, trustedBrowsers, audit, reasons } = this.#options;
    const { actor, target, facts } = input;
    const principal = { type: 'STAFF', id: target.id } as const;

    const eligibility = decideMfaResetState(facts);
    if (eligibility === 'NOT_ELIGIBLE') {
      throw stateConflict('That identity has no second factor that can be reset');
    }
    const state = recordedStateOf(facts);
    const branch: ReasonBranch =
      eligibility === 'FACTOR_ACTIVE' ? 'FACTOR_ACTIVE' : 'ENROLMENT_UNFINISHED';
    const reason = await this.#reason(reasons, handle, input.reasonCode, branch, input.note);
    if (target.id.toLowerCase() === actor.toLowerCase()) {
      throw ApiException.of(
        ErrorCode.SelfApprovalForbidden,
        'A second factor is reset by someone other than its owner',
      );
    }

    const active = state === 'ACTIVE_FACTOR' ? await factors.findActiveOf(handle, target.id) : null;
    const pending =
      state === 'STRANDED_ENROLMENT' ? await factors.findPendingOf(handle, target.id) : [];
    const latest =
      state === 'UNFINISHED_RESET' ? await factors.findLatestOf(handle, target.id) : null;

    if (state === 'UNFINISHED_RESET' && (facts.hasUsableGrant || facts.hasPendingDelivery)) {
      const episode = latest?.revocationEpisodeId ?? null;
      if (episode === null) throw new Error('An unfinished reset names the episode it opened');
      const existing = (await grants.findPendingOf(handle, principal, ['MFA_REENROLMENT'])).at(-1);
      await audit.write(handle, {
        code: 'auth.mfa.reset',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: target.id },
        ...(target.hubId === null ? {} : { responsibleHubId: target.hubId }),
        previousState: state,
        resultingState: 'COALESCED',
        reason: { code: reason.code, label: reason.label },
        ...(input.note === undefined ? {} : { note: input.note }),
        relatedIds: { episode_id: episode, superseded_grant_ids: [] },
      });
      return {
        sessionsTerminated: 0,
        issued: false,
        coalesced: true,
        grantExpiresAt: existing?.expiresAt ?? null,
      };
    }

    // The episode this reset belongs to: a live factor opens a new one; a stranded factor is revoked into the episode it was created in,
    // if it was created in one; an unfinished reset goes on in the episode it opened.
    const episodeId =
      state === 'ACTIVE_FACTOR'
        ? randomUUID()
        : state === 'STRANDED_ENROLMENT'
          ? (pending.at(0)?.createdEpisodeId ?? randomUUID())
          : (latest?.revocationEpisodeId ?? null);
    if (episodeId === null) throw new Error('An unfinished reset names the episode it opened');

    const revoked: StoredFactor[] = [];
    for (const factor of state === 'ACTIVE_FACTOR' ? (active === null ? [] : [active]) : pending) {
      const ended = await factors.revokeAdministratively(handle, {
        factorId: factor.id,
        administratorId: actor,
        reasonCode: reason.code,
        episodeId,
      });
      if (ended === null) throw stateConflict('The second factor changed while the reset was made');
      revoked.push(factor);
    }

    // The enrolment continuation of the target ends. The re-enrolment grant that is still pending is ended by the issue below, which
    // names it, so its lineage is recorded; an expired, consumed or superseded grant keeps the state it has.
    const continuation = await grants.supersedePending(handle, principal, ['MFA_ENROLMENT']);
    const issued = await this.#issue(handle, actor, target, episodeId);
    const superseded = [
      ...continuation.superseded,
      ...(issued.supersededGrantId === null ? [] : [issued.supersededGrantId]),
    ];

    for (const id of superseded) {
      await audit.write(handle, {
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'SetupGrant', id },
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: target.id, superseded_by: issued.grant.id },
        detail: { principal_type: 'STAFF' },
      });
    }
    for (const factor of revoked) {
      await audit.write(handle, {
        code: 'auth.mfa.revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'MfaFactor', id: factor.id },
        previousState: factor.status,
        resultingState: 'REVOKED',
        reason: { code: reason.code, label: reason.label },
        beforeAfter: { status: { before: factor.status, after: 'REVOKED' } },
        relatedIds: { principal_id: target.id, episode_id: episodeId },
        detail: { cause: 'RESET' },
      });
    }

    const ended = await sessions.terminate(
      handle,
      { by: 'principal', principalType: 'STAFF', principalId: target.id },
      'MFA_RESET',
    );
    for (const id of ended) {
      await audit.write(handle, {
        code: 'auth.session.terminated',
        // Ordinary: audit.md makes only an administrator's revocation of a session (`ADMIN_REVOKED`) enhanced, and "every other
        // termination ordinary". The enhanced events of this act are the reset's (`auth.mfa.reset`) and the factor's (`auth.mfa.revoked`).
        enhanced: false,
        enhancedBasis: 'ROUTINE_TERMINATION',
        outcome: 'SUCCEEDED',
        object: { type: 'Session', id },
        previousState: 'ACTIVE',
        resultingState: 'TERMINATED',
        reason: { code: 'MFA_RESET', label: 'Second factor reset' },
        relatedIds: { principal_id: target.id },
        detail: { cause: 'MFA_RESET', principal_type: 'STAFF' },
      });
    }

    // A browser that was trusted with the authenticator that is gone stands in for a code nobody can produce any more: it ends with it,
    // in this transaction, and a person who re-enrols is asked for a code at every browser until they choose again.
    for (const id of await trustedBrowsers.revokeAll(handle, {
      staffIdentityId: target.id,
      cause: 'FACTOR_RESET',
      revokedBy: actor,
    })) {
      await audit.write(handle, {
        code: 'auth.trusted_browser.revoked',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: target.id },
        relatedIds: { trusted_browser_id: id },
        detail: { cause: 'FACTOR_RESET' },
      });
    }

    await audit.write(handle, {
      code: 'auth.mfa.reset',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id: target.id },
      ...(target.hubId === null ? {} : { responsibleHubId: target.hubId }),
      previousState: state,
      resultingState: 'ISSUED',
      reason: { code: reason.code, label: reason.label },
      ...(input.note === undefined ? {} : { note: input.note }),
      relatedIds: {
        episode_id: episodeId,
        ...(revoked.length === 0 ? {} : { revoked_factor_id: revoked[0]?.id ?? '' }),
        new_grant_id: issued.grant.id,
        superseded_grant_ids: superseded.toSorted(),
      },
      beforeAfter: {
        reenrolment_grant: { before: 'NONE', after: 'PENDING' },
        ...(revoked.length === 0
          ? {}
          : {
              mfa_factor: {
                before: state === 'ACTIVE_FACTOR' ? 'ACTIVE' : 'PENDING',
                after: 'REVOKED',
              },
            }),
        ...(superseded.length === 0
          ? {}
          : { superseded_grants: { before: 'PENDING', after: 'SUPERSEDED' } }),
      },
    });

    return {
      sessionsTerminated: ended.length,
      issued: true,
      coalesced: false,
      grantExpiresAt: issued.grant.expiresAt,
    };
  }

  async #reason(
    reasons: Pick<ReasonValidator, 'validate'>,
    handle: TransactionHandle,
    reasonCode: unknown,
    branch: ReasonBranch,
    note?: string,
  ): Promise<ValidatedReason> {
    try {
      return await reasons.validate(handle, {
        reasonCode,
        operationId: 'resetStaffMfa',
        branch,
        ...(note === undefined ? {} : { note }),
      });
    } catch (error) {
      if (error instanceof ReasonRefusedError) {
        throw ApiException.of(
          error.code === 'REASON_REQUIRED' ? ErrorCode.ReasonRequired : ErrorCode.ReasonNotActive,
          error.message,
        );
      }
      throw error;
    }
  }

  /** Issues the `MFA_REENROLMENT` grant of the episode and queues its message to the work email; a message that cannot be queued fails the act. */
  async #issue(
    handle: TransactionHandle,
    actor: string,
    target: MfaResetTarget,
    episodeId: string,
  ): Promise<IssuedGrant> {
    const { grants, audit, reenrolmentLink } = this.#options;
    let issued: IssuedGrant;
    try {
      issued = await grants.issue(handle, {
        principal: { type: 'STAFF', id: target.id },
        purpose: 'MFA_REENROLMENT',
        issuedBy: actor,
        episodeId,
        delivery: {
          kind: 'MFA_REENROLMENT',
          channel: 'EMAIL',
          destination: target.workEmail,
          link: reenrolmentLink,
        },
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) {
        throw ApiException.of(
          ErrorCode.CredentialDeliveryFailed,
          'The re-enrolment link could not be queued for delivery',
        );
      }
      throw error;
    }
    await audit.write(handle, {
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'SetupGrant', id: issued.grant.id },
      relatedIds: { principal_id: target.id, issued_by: actor, episode_id: episodeId },
      detail: { purpose: 'MFA_REENROLMENT', channel: 'EMAIL', principal_type: 'STAFF' },
    });
    return issued;
  }
}
