import { createHash } from 'node:crypto';

import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { MfaChallengeExpiredError } from '../mfa/mfa-challenge-errors.js';
import type { MfaChallengeStore, StoredChallenge } from '../mfa/mfa-challenge-store.js';
import type { MfaFactorStore, StoredFactor } from '../mfa/mfa-factor-store.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type {
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
} from '../ports/identity-directory.port.js';
import type { TotpVerifier } from '../ports/totp-verifier.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { currentSessionOf, type CurrentSessionView } from '../sessions/current-session.js';
import { SessionIssueRefusedError } from '../sessions/session-errors.js';
import type { IssuedSession, SessionIssuer } from '../sessions/session-issuer.js';
import { authenticationContext } from './authentication-context.js';
import type { StaffSignInOutcome } from './staff-sign-in.service.js';

const MAX_ATTEMPTS_SETTING = 'signin_max_attempts';
const LOCKOUT_MINUTES_SETTING = 'signin_lockout_minutes';
const MFA_ATTEMPTS_SETTING = 'mfa_max_attempts';

/** The closed sets of audit.md §5.4 that the second step uses. */
type FailureCause =
  | 'CHALLENGE_UNUSABLE'
  | 'CHALLENGE_EXPIRED'
  | 'INELIGIBLE_PRINCIPAL'
  | 'LOCKED_OUT'
  | 'MFA_ENROLMENT_REQUIRED'
  | 'WRONG_MFA_CODE';

const unusable = (): ApiException =>
  ApiException.of(ErrorCode.ChallengeUnusable, 'This sign-in cannot be completed: start again');
const expired = (): ApiException =>
  ApiException.of(ErrorCode.ChallengeExpired, 'This sign-in has expired: start again');
const invalidCredentials = (): ApiException =>
  ApiException.of(ErrorCode.InvalidCredentials, 'The email address or the password is not correct');
const locked = (): ApiException =>
  ApiException.of(ErrorCode.CredentialLocked, 'The credential is locked: try again later');
const enrolmentRequired = (): ApiException =>
  ApiException.of(ErrorCode.MfaEnrolmentRequired, 'A second factor has not been enrolled');
const wrongCode = (): ApiException =>
  ApiException.of(ErrorCode.MfaProofInvalid, 'The code is not correct');

/** A hash of a challenge reference that names no challenge, for the one refusal that has no principal (the string is never written). */
function referenceDigest(challengeId: string): string {
  return createHash('sha256')
    .update(
      `melarc.audit.identifier.v1\u0000MFA_CHALLENGE\u0000${challengeId.toLowerCase()}`,
      'utf8',
    )
    .digest('hex');
}

export interface StaffMfaSignInOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly challenges: MfaChallengeStore;
  readonly factors: MfaFactorStore;
  readonly totp: TotpVerifier;
  readonly issuer: Pick<SessionIssuer, 'issue'>;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'integer'>;
}

/** What the decision found: an answer to raise once the bookkeeping has committed, or a proof to turn into a session. */
type Decision =
  | { readonly refuse: ApiException }
  | {
      readonly proved: {
        readonly challenge: StoredChallenge;
        readonly factor: StoredFactor;
        readonly step: number;
        readonly policy: LockoutPolicy;
        readonly maxCodes: number;
      };
    };

/** The challenge was spent by another request between the decision and the issue. */
class ChallengeSpentError extends Error {
  constructor() {
    super('The challenge was consumed or ended while the sign-in was in flight');
    this.name = 'ChallengeSpentError';
  }
}

/** The time step the code proved was accepted by another request between the decision and the issue (a replay that lost a race). */
class CodeReplayedError extends Error {
  constructor() {
    super(
      'The time step of the code was accepted by another request while the sign-in was in flight',
    );
    this.name = 'CodeReplayedError';
  }
}

/**
 * The credential was locked between the decision and the issue: the fifth failure of another request committed in that time. The caller
 * proved the password, so the lock is announced, and nothing the proof would have spent is spent (the issue rolls back).
 */
class LockedMeanwhileError extends Error {
  constructor() {
    super('The credential was locked while the sign-in was in flight');
    this.name = 'LockedMeanwhileError';
  }
}

/**
 * `completeStaffMfaSignIn` (S0.33; staff-authentication.md §5.3 and §5.5; SECURITY_DESIGN.md §13.4b, §13.5): the second step of a
 * privileged sign-in. The challenge the password step returned, with a TOTP code, is turned into the session. **No session exists
 * until this succeeds**, and it is the only operation that can establish a privileged one.
 *
 * **The order** (the caller has proved the password, so a lock is announced here, and nothing in this step computes a hash): the
 * identity is locked first and then the challenge (the order of the session-issue protocol, so that two requests for one challenge take
 * turns and never wait for each other in a cycle), and the challenge's state is judged on the database's clock read after the lock:
 * a challenge that is consumed, unusable, superseded or not there is `CHALLENGE_UNUSABLE`; one past its time is `CHALLENGE_EXPIRED`
 * (and is marked so); an identity that can no longer sign in, or that holds another credential than the one proved, is
 * `INVALID_CREDENTIALS` (and ends the challenge); a lock in force is `CREDENTIAL_LOCKED`, neither verified nor counted; an identity
 * with no `ACTIVE` factor is `403 MFA_ENROLMENT_REQUIRED`, **which is not a wrong code and counts nothing**; only then is the code
 * verified, against a seed opened in memory for that and for nothing else.
 *
 * - **A wrong code, or one already used inside its window, counts twice**: on the challenge (the third ends it) and on the identity's
 *   count, shared with the password, and it may be the failure that sets the lock. It writes `auth.session.failed` (cause
 *   `WRONG_MFA_CODE`, factor `MFA_CODE`) and the enhanced `auth.mfa.failed`, and commits before it is answered.
 * - **A correct code issues the session through the S0.24 protocol**, and the proofs it spends commit with the session in that one
 *   transaction: the challenge is consumed, the time step the code proved is recorded (one conditional update that moves forward only,
 *   so of two requests that present one code, one is accepted), the identity's count is cleared and `auth.mfa.completed` is written.
 *   A request that loses a race for the challenge is `CHALLENGE_UNUSABLE`; one that loses a race for the step is a replay, and is
 *   counted as a wrong code.
 */
export class StaffMfaSignInService {
  readonly #options: StaffMfaSignInOptions;

  constructor(options: StaffMfaSignInOptions) {
    this.#options = options;
  }

  async completeSignIn(request: {
    readonly challengeId: string;
    readonly code: string;
  }): Promise<StaffSignInOutcome> {
    const context = authenticationContext();
    const { unitOfWork } = this.#options;
    const decision = await unitOfWork.run(context, (transaction) =>
      this.#decide(transaction, request),
    );
    if ('refuse' in decision) throw decision.refuse;
    return this.#issue(context, request, decision.proved);
  }

  /** The decision, in one transaction that **commits what it wrote** whatever it decides: the bookkeeping of a refusal must survive it. */
  async #decide(
    transaction: TransactionHandle,
    request: { readonly challengeId: string; readonly code: string },
  ): Promise<Decision> {
    const { directory, challenges, factors, totp, audit, settings } = this.#options;
    const failed = (cause: FailureCause, identity: PrincipalRef | null): Promise<void> =>
      audit.write(transaction, failedEvent(cause, identity, request.challengeId));

    const found = await challenges.findById(transaction, request.challengeId);
    if (found === null) {
      await failed('CHALLENGE_UNUSABLE', null);
      return { refuse: unusable() };
    }
    const ref: PrincipalRef = { type: 'STAFF', id: found.staffIdentityId };
    // The identity first and the challenge second: the order the session issue takes them in.
    const identity = await directory.lockIdentity(transaction, ref);
    const decided = await challenges.lockForDecision(transaction, found.id);
    if (decided === null) {
      await failed('CHALLENGE_UNUSABLE', ref);
      return { refuse: unusable() };
    }
    const { challenge, expired: pastItsTime } = decided;

    if (challenge.state === 'CONSUMED' || challenge.state === 'UNUSABLE') {
      await failed('CHALLENGE_UNUSABLE', ref);
      return { refuse: unusable() };
    }
    if (challenge.state === 'EXPIRED' || pastItsTime) {
      if (challenge.state === 'PENDING') await challenges.end(transaction, challenge.id, 'EXPIRED');
      await failed('CHALLENGE_EXPIRED', ref);
      return { refuse: expired() };
    }

    if (
      identity?.status !== 'ACTIVE' ||
      identity.credentialGeneration !== challenge.credentialGeneration
    ) {
      // The password was proved for a credential or an identity that is no longer there: the challenge ends with it.
      await challenges.end(transaction, challenge.id, 'UNUSABLE');
      await failed('INELIGIBLE_PRINCIPAL', ref);
      return { refuse: invalidCredentials() };
    }

    // The caller holds a live challenge, so the password was proved: a lock is announced, neither verified nor counted.
    if (await directory.isCredentialLocked(transaction, ref)) {
      await failed('LOCKED_OUT', ref);
      return { refuse: locked() };
    }

    const factor = await factors.findActiveOf(transaction, ref.id);
    if (factor === null) {
      // Not a wrong code: no factor was presented, so nothing is counted on the challenge or on the identity.
      await failed('MFA_ENROLMENT_REQUIRED', ref);
      return { refuse: enrolmentRequired() };
    }

    const policy: LockoutPolicy = {
      maxAttempts: await settings.integer(transaction, MAX_ATTEMPTS_SETTING),
      lockoutMinutes: await settings.integer(transaction, LOCKOUT_MINUTES_SETTING),
    };
    const maxCodes = await settings.integer(transaction, MFA_ATTEMPTS_SETTING);
    const seed = await factors.openSeed(transaction, factor.id);
    if (seed === null) throw new Error('An ACTIVE factor has no seed to verify a code against');
    const last = factor.lastVerifiedCounter === null ? null : Number(factor.lastVerifiedCounter);
    const verdict = totp.verify(seed, request.code, last);
    if (verdict.outcome !== 'ACCEPTED') {
      const counted = await this.#countWrongCode(
        transaction,
        request,
        ref,
        factor,
        challenge.credentialGeneration,
        policy,
        maxCodes,
      );
      if (counted === 'STALE') return this.#endIneligible(transaction, request, ref);
      return { refuse: wrongCode() };
    }
    return { proved: { challenge, factor, step: verdict.step, policy, maxCodes } };
  }

  /** The challenge ends with an identity that can no longer be signed in as the credential it was issued on: nothing is counted. */
  async #endIneligible(
    transaction: TransactionHandle,
    request: { readonly challengeId: string },
    ref: PrincipalRef,
  ): Promise<{ readonly refuse: ApiException }> {
    await this.#options.challenges.end(transaction, request.challengeId, 'UNUSABLE');
    await this.#options.audit.write(
      transaction,
      failedEvent('INELIGIBLE_PRINCIPAL', ref, request.challengeId),
    );
    return { refuse: invalidCredentials() };
  }

  /**
   * A wrong or replayed code: once against the identity's credential **of the generation the challenge was issued on** (a count made
   * against a credential that has since been replaced, or an identity that can no longer sign in, is `STALE` and counts nowhere, the
   * challenge included: the audit of 21 October 2026, A03), once against the challenge, and the events, in the caller's transaction.
   */
  async #countWrongCode(
    transaction: TransactionHandle,
    request: { readonly challengeId: string },
    ref: PrincipalRef,
    factor: StoredFactor,
    generation: number,
    policy: LockoutPolicy,
    maxCodes: number,
  ): Promise<'COUNTED' | 'STALE'> {
    const { directory, challenges, audit } = this.#options;
    const counted = await directory.recordFailedAttempt(transaction, ref, generation, policy);
    if (!counted.counted && counted.reason === 'STALE') return 'STALE';
    await challenges.recordWrongCode(transaction, request.challengeId, maxCodes);
    await audit.write(transaction, failedEvent('WRONG_MFA_CODE', ref, request.challengeId));
    await audit.write(transaction, {
      code: 'auth.mfa.failed',
      enhanced: true,
      outcome: 'REJECTED',
      object: { type: 'StaffIdentity', id: ref.id },
      relatedIds: { factor_id: factor.id, challenge_id: request.challengeId },
      detail: { factor_type: 'TOTP' },
    });
    if (counted.counted && counted.tipped) {
      await audit.write(transaction, {
        code: 'auth.lockout.applied',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: ref.id },
        detail: { factor: 'MFA_CODE', locked_until: counted.lockedUntil.toISOString() },
      });
    }
    return 'COUNTED';
  }

  /** The proved code, turned into the session; the proofs it spends commit with it, and what a race lost is answered as what it is. */
  async #issue(
    context: SecurityContext,
    request: { readonly challengeId: string; readonly code: string },
    proved: Extract<Decision, { proved: unknown }>['proved'],
  ): Promise<StaffSignInOutcome> {
    const { directory, challenges, factors, audit, issuer } = this.#options;
    const ref: PrincipalRef = { type: 'STAFF', id: proved.challenge.staffIdentityId };
    let issued: IssuedSession<CurrentSessionView>;
    try {
      issued = await issuer.issue({
        principal: ref,
        correlationId: context.correlationId,
        verifiedCredentialGeneration: proved.challenge.credentialGeneration,
        // The view is built in the issuing transaction: one that cannot be built takes the session, the challenge and the step it spent,
        // the count it cleared and the success event back with it (the audit of 21 October 2026, A04).
        project: (handle, session) => currentSessionOf(handle, session, directory),
        steps: [
          {
            name: 'the challenge is consumed and the step the code proved is recorded',
            run: async (handle) => {
              // The lock is judged again under the identity's lock: it was read at the decision, and the clear below would wipe one set
              // since.
              if (await directory.isCredentialLocked(handle, ref)) throw new LockedMeanwhileError();
              if (!(await challenges.consume(handle, proved.challenge.id))) {
                throw new ChallengeSpentError();
              }
              if (
                !(await factors.recordAcceptedStep(handle, proved.factor.id, String(proved.step)))
              ) {
                throw new CodeReplayedError();
              }
              await directory.clearFailedAttempts(handle, ref);
              await audit.write(handle, {
                code: 'auth.mfa.completed',
                enhanced: true,
                outcome: 'SUCCEEDED',
                actor: { type: 'STAFF', id: ref.id },
                object: { type: 'StaffIdentity', id: ref.id },
                relatedIds: { factor_id: proved.factor.id, challenge_id: proved.challenge.id },
                detail: { factor_type: 'TOTP' },
              });
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof ChallengeSpentError)
        return this.#refuseAfter(context, request, ref, null);
      // The challenge lapsed while the issue waited for a lock, and the table's guard refused the consumption: the issue has rolled back
      // whole, and the sign-in is answered as expired once the challenge is ended as that (the audit of 21 October 2026, A06).
      if (error instanceof MfaChallengeExpiredError) {
        return this.#refuseAfter(context, request, ref, 'EXPIRED');
      }
      if (error instanceof CodeReplayedError) {
        return this.#refuseAfter(context, request, ref, proved);
      }
      // The protocol's own last check, under the lock: the identity can no longer be given a session.
      if (error instanceof SessionIssueRefusedError) {
        return this.#refuseAfter(context, request, ref, 'INELIGIBLE');
      }
      if (error instanceof LockedMeanwhileError) {
        return this.#refuseAfter(context, request, ref, 'LOCKED');
      }
      throw error;
    }
    return { kind: 'SESSION', session: issued, view: issued.view };
  }

  /** What a race lost is answered as what it is, with its bookkeeping committed first. */
  async #refuseAfter(
    context: SecurityContext,
    request: { readonly challengeId: string; readonly code: string },
    ref: PrincipalRef,
    lost:
      null | 'EXPIRED' | 'INELIGIBLE' | 'LOCKED' | Extract<Decision, { proved: unknown }>['proved'],
  ): Promise<never> {
    const { unitOfWork, directory, audit, challenges } = this.#options;
    const answer = await unitOfWork.run(context, async (transaction) => {
      // This is a transaction of its own, so it takes the locks in the order of every other path (identity, then challenge) before it
      // writes either: counting on the challenge first would wait for an identity that a request holding it never gives up while
      // that request waits for the challenge.
      const identity = await directory.lockIdentity(transaction, ref);
      if (lost === 'LOCKED') {
        await audit.write(transaction, failedEvent('LOCKED_OUT', ref, request.challengeId));
        return locked();
      }
      if (lost === null || lost === 'EXPIRED') {
        // The challenge was not consumable: spent or ended by another request, or past its time. Which it was is judged again, under the
        // locks just taken, and answered as what it is (a challenge that lapsed is not "unusable").
        const decided = await challenges.lockForDecision(transaction, request.challengeId);
        const lapsed =
          lost === 'EXPIRED' ||
          decided?.challenge.state === 'EXPIRED' ||
          (decided?.challenge.state === 'PENDING' && decided.expired);
        if (!lapsed) {
          await audit.write(
            transaction,
            failedEvent('CHALLENGE_UNUSABLE', ref, request.challengeId),
          );
          return unusable();
        }
        if (decided?.challenge.state === 'PENDING') {
          await challenges.end(transaction, request.challengeId, 'EXPIRED');
        }
        await audit.write(transaction, failedEvent('CHALLENGE_EXPIRED', ref, request.challengeId));
        return expired();
      }
      if (lost === 'INELIGIBLE') {
        await challenges.end(transaction, request.challengeId, 'UNUSABLE');
        await audit.write(
          transaction,
          failedEvent('INELIGIBLE_PRINCIPAL', ref, request.challengeId),
        );
        return invalidCredentials();
      }
      // A step another request accepted: this code is a replay and is counted like any wrong code, **if** the decision it was made on
      // still stands. This is a transaction of its own, so what the decision judged is judged again, under the locks just taken: the
      // challenge (a request that consumed or ended it meanwhile, or let it lapse, leaves nothing to count on) and the credential
      // (replaced or suspended since: the count of a proof of an old credential belongs to nobody; the audit of 21 October 2026, A03).
      const decided = await challenges.lockForDecision(transaction, request.challengeId);
      if (
        decided === null ||
        decided.challenge.state === 'CONSUMED' ||
        decided.challenge.state === 'UNUSABLE'
      ) {
        await audit.write(transaction, failedEvent('CHALLENGE_UNUSABLE', ref, request.challengeId));
        return unusable();
      }
      if (decided.challenge.state === 'EXPIRED' || decided.expired) {
        if (decided.challenge.state === 'PENDING') {
          await challenges.end(transaction, request.challengeId, 'EXPIRED');
        }
        await audit.write(transaction, failedEvent('CHALLENGE_EXPIRED', ref, request.challengeId));
        return expired();
      }
      if (
        identity?.status !== 'ACTIVE' ||
        identity.credentialGeneration !== decided.challenge.credentialGeneration
      ) {
        return (await this.#endIneligible(transaction, request, ref)).refuse;
      }
      if (await directory.isCredentialLocked(transaction, ref)) {
        await audit.write(transaction, failedEvent('LOCKED_OUT', ref, request.challengeId));
        return locked();
      }
      const counted = await this.#countWrongCode(
        transaction,
        request,
        ref,
        lost.factor,
        decided.challenge.credentialGeneration,
        lost.policy,
        lost.maxCodes,
      );
      if (counted === 'STALE') return (await this.#endIneligible(transaction, request, ref)).refuse;
      return wrongCode();
    });
    throw answer;
  }
}

function failedEvent(
  cause: FailureCause,
  identity: PrincipalRef | null,
  challengeId: string,
): AuditEventInput {
  return {
    code: 'auth.session.failed',
    enhanced: false,
    outcome: 'REJECTED',
    object: { type: 'StaffIdentity', id: identity?.id ?? null },
    detail: {
      cause,
      factor: 'MFA_CODE',
      ...(identity === null
        ? { identifier_kind: 'MFA_CHALLENGE', identifier_digest: referenceDigest(challengeId) }
        : {}),
    },
  };
}
