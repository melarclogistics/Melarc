import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { normaliseNewCredential, type CredentialCheck } from '../credentials/credential-rule.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type {
  IdentityDirectory,
  PrincipalRef,
  PrincipalSummary,
} from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TotpVerifier } from '../ports/totp-verifier.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { MfaFactorStore, type StoredFactor } from '../mfa/mfa-factor-store.js';
import { bundleIsPrivileged } from '../sessions/bundle-reader.js';
import { SetupGrantExpiredError } from '../setup-grants/setup-grant-errors.js';
import { SetupGrantStore, type StoredGrant } from '../setup-grants/setup-grant-store.js';
import type { SetupGrantPurpose } from '../setup-grants/setup-grant-vocabulary.js';
import { authenticationContext } from './authentication-context.js';
import { otpauthUri } from './otpauth.js';

/** Who the authenticator app shows the account as belonging to: the issuer of the provisioning URI. */
export const SETUP_ISSUER = 'Melarc';

/** The purposes `completeStaffCredentialSetup` serves: the ordinary grant, and the bootstrap secret, which differs only in having no expiry. */
const CREDENTIAL_PURPOSES: readonly SetupGrantPurpose[] = [
  'STAFF_CREDENTIAL_SETUP',
  'BOOTSTRAP_SETUP',
];
const ENROLMENT_PURPOSES: readonly SetupGrantPurpose[] = ['MFA_ENROLMENT'];
const REENROLMENT_PURPOSES: readonly SetupGrantPurpose[] = ['MFA_REENROLMENT'];

/**
 * The refusals the three operations share. Each is one fixed text: which way a grant was unusable (unknown, malformed, spent,
 * superseded, expired, another purpose's, for another principal, or for an identity that cannot take it) is not for a caller to learn
 * (state-machines.md §19), and what a proof got wrong is not either.
 */
const invalidGrant = (): ApiException =>
  ApiException.of(ErrorCode.SetupGrantInvalid, 'The setup link is not valid');
const invalidProof = (): ApiException =>
  ApiException.of(ErrorCode.MfaProofInvalid, 'The code is not correct');
const limited = (): ApiException => ApiException.of(ErrorCode.RateLimited, 'Too many requests');

/** The rule of a refusal of a new password, named as the schema's own rule of the same bound (`minLength`, `maxLength`, `format`). */
function passwordRefusal(check: Exclude<CredentialCheck, { ok: true }>): ApiException {
  const rule =
    check.refusal === 'MALFORMED_UNICODE'
      ? 'format'
      : check.refusal === 'TOO_SHORT'
        ? 'minLength'
        : 'maxLength';
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: '/password', rule }],
  });
}

export interface StaffSetupOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly grants: SetupGrantStore;
  readonly factors: MfaFactorStore;
  readonly tokens: Pick<TokenService, 'hash'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly totp: TotpVerifier;
  readonly audit: AuditWriter;
}

export type CredentialSetupOutcome =
  | { readonly authenticationReady: true }
  | {
      readonly authenticationReady: false;
      readonly otpauthUri: string;
      readonly mfaSetupToken: string;
    };

export interface MfaReenrolmentOutcome {
  readonly otpauthUri: string;
  readonly mfaSetupToken: string;
}

/**
 * The three pre-session operations that bring a staff identity to a credential and a proven second factor (S0.31):
 * `completeStaffCredentialSetup`, `completeMfaEnrolment` and `beginMfaReenrolment` (staff-authentication.md; credential-recovery.md;
 * state-machines.md §18 and §19; SECURITY_DESIGN.md §13.4, §13.9). **None of them issues a session.** Establishing a credential is not
 * authenticating, and a privileged identity stays unable to hold a session until a code is proven.
 *
 * - **The principal comes from the grant and from nothing a request says.** The grant is found by the hash of its token, which
 *   names the identity it was issued to; no operation takes an identity, a bundle or a status.
 * - **Every refusal of a grant is one answer** (`SETUP_GRANT_INVALID`), and a request whose grant cannot be used does no hashing
 *   (the grant and the identity are read first, in a short transaction of their own, and an unknown token costs a lookup).
 * - **The password is hashed outside any transaction, after hash admission** (SECURITY_DESIGN.md §13.4c), and only then does the one
 *   transaction of the act open: it locks the identity, consumes the grant, writes the credential, creates the factor and the
 *   continuation grant and writes the audit events, and commits all of it or none of it. A request that finds no free hash slot is
 *   `RATE_LIMITED` and changed nothing.
 * - **Order under the identity lock** is the platform's (policy, identity, session, business): the identity is locked, and then the
 *   grant; two requests presenting one grant take turns, and the second finds it consumed.
 * - **A wrong code consumes nothing.** The proof is judged inside the transaction, and a refusal rolls it back, so the grant stays open
 *   and the factor stays `PENDING` (AC-SLICE-000-94). A code is proved against the seed, opened in memory for that and for nothing
 *   else.
 * - **The audit events are the act's own and are written in its transaction**, naming the person whose credential it is as the actor
 *   (this is a pre-session act of a `SYSTEM` transaction, which may name whom it authenticated). No event holds a password, a
 *   token, a seed, a code or the provisioning URI.
 */
export class StaffSetupService {
  readonly #options: StaffSetupOptions;

  constructor(options: StaffSetupOptions) {
    this.#options = options;
  }

  async completeCredentialSetup(request: {
    readonly setupToken: string;
    readonly password: string;
  }): Promise<CredentialSetupOutcome> {
    const context = authenticationContext();
    const hash = this.#options.tokens.hash(request.setupToken);
    // The credential rule is the second of the two bounds the contract states, and it is judged before the grant, as the schema's own
    // bounds are: a refusal of the password is `VALIDATION_FAILED` whatever the grant is, and consumes nothing.
    const checked = normaliseNewCredential(request.password);
    if (!checked.ok) throw passwordRefusal(checked);
    if (hash === null) throw invalidGrant();

    await this.#precheck(
      context,
      hash,
      CREDENTIAL_PURPOSES,
      (identity) => identity.credentialGeneration === 0,
    );

    const hashed = await runAdmitted(this.#options.hashAdmission, () =>
      this.#options.hasher.hash('STAFF_PASSWORD', checked.credential),
    );
    if (!hashed.admitted) throw limited();
    const encodedHash = hashed.value;

    return this.#act(context, async (transaction) => {
      const { directory, grants, factors, totp, audit } = this.#options;
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant, CREDENTIAL_PURPOSES)) throw invalidGrant();
      const ref: PrincipalRef = { type: 'STAFF', id: grant.principalId };

      const identity = await directory.lockIdentity(transaction, ref);
      if (identity?.status !== 'ACTIVE' || identity.credentialGeneration !== 0)
        throw invalidGrant();
      // The grant is locked and judged again on the time after any wait for the identity's lock.
      const live = await grants.lockLive(transaction, hash);
      if (!usable(live, CREDENTIAL_PURPOSES)) throw invalidGrant();
      const consumed = await grants.consume(transaction, {
        principal: ref,
        purpose: live.purpose,
        token: request.setupToken,
      });
      if (consumed === null) throw invalidGrant();
      const established = await directory.establishCredential(transaction, ref, encodedHash);
      if (established === null) throw invalidGrant();

      await this.#grantConsumed(transaction, ref, consumed);
      await audit.write(transaction, {
        code: 'auth.credential.changed',
        enhanced: false,
        outcome: 'SUCCEEDED',
        actor: { type: 'STAFF', id: ref.id },
        object: { type: 'StaffIdentity', id: ref.id },
        beforeAfter: { credential_generation: { before: 0, after: established.generation } },
        relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
        detail: { cause: 'SETUP', credential_kind: 'STAFF_PASSWORD' },
      });

      // An ordinary identity is authentication-ready now. A privileged one is not: it is given the material of its authenticator and
      // the grant that, with a proven code, activates it.
      const privileged = await bundleIsPrivileged(transaction, identity.bundleId);
      if (privileged === null)
        throw new Error('A staff identity names a role bundle that is not there');
      if (!privileged) return { authenticationReady: true };

      await this.#supersedePending(transaction, ref);
      const seed = totp.newSeed();
      await factors.create(transaction, {
        staffIdentityId: ref.id,
        createdByPurpose:
          consumed.purpose === 'BOOTSTRAP_SETUP' ? 'BOOTSTRAP_SETUP' : 'STAFF_CREDENTIAL_SETUP',
        seed,
      });
      const issued = await this.#issueContinuation(transaction, ref, consumed);
      return {
        authenticationReady: false,
        otpauthUri: await this.#uri(transaction, ref, seed),
        mfaSetupToken: issued,
      };
    });
  }

  async completeMfaEnrolment(request: {
    readonly setupToken: string;
    readonly totpCode: string;
  }): Promise<void> {
    const context = authenticationContext();
    const hash = this.#options.tokens.hash(request.setupToken);
    if (hash === null) throw invalidGrant();
    await this.#precheck(context, hash, ENROLMENT_PURPOSES, () => true);

    await this.#act(context, async (transaction) => {
      const { directory, grants, factors, totp, audit } = this.#options;
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant, ENROLMENT_PURPOSES)) throw invalidGrant();
      const ref: PrincipalRef = { type: 'STAFF', id: grant.principalId };

      const identity = await directory.lockIdentity(transaction, ref);
      if (identity?.status !== 'ACTIVE') throw invalidGrant();
      // Before a seed is opened or a code is looked at, the grant is locked and judged on the time after any wait for the identity's
      // lock: a code is a proof against a live grant, and a wrong code of an expired one is not a wrong code.
      if (!usable(await grants.lockLive(transaction, hash), ENROLMENT_PURPOSES)) {
        throw invalidGrant();
      }
      // The factor the continuation grant is for: the newest `PENDING` one. None (it was revoked, or already proven) is a grant that
      // can no longer be used.
      const pending = (await factors.findPendingOf(transaction, ref.id)).at(-1);
      if (pending === undefined) throw invalidGrant();
      const seed = await factors.openSeed(transaction, pending.id);
      if (seed === null) throw invalidGrant();

      // A code that is not proven rolls everything back: the grant stays open and the factor stays `PENDING`.
      const verdict = totp.verify(seed, request.totpCode, null);
      if (verdict.outcome !== 'ACCEPTED') throw invalidProof();

      const consumed = await grants.consume(transaction, {
        principal: ref,
        purpose: 'MFA_ENROLMENT',
        token: request.setupToken,
      });
      if (consumed === null) throw invalidGrant();
      const provenBefore = await factors.hasBeenProven(transaction, ref.id);
      const activated = await factors.activate(transaction, pending.id, String(verdict.step));
      if (activated === null) throw invalidGrant();

      await this.#grantConsumed(transaction, ref, consumed);
      await audit.write(transaction, {
        code: 'auth.mfa.enrolled',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor: { type: 'STAFF', id: ref.id },
        object: { type: 'MfaFactor', id: pending.id },
        previousState: 'PENDING',
        resultingState: 'ACTIVE',
        beforeAfter: { status: { before: 'PENDING', after: 'ACTIVE' } },
        relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
        detail: { factor_type: 'TOTP' },
      });
      for (const replaced of activated.replacedFactorIds) {
        await audit.write(transaction, revoked(ref, replaced, 'ACTIVE', 'REPLACED'));
      }
      // The pair of bootstrap administrators complete the bootstrap at their first proof, and only at the first: a factor that was
      // proven and later reset leaves an identity that has been proven before (audit.md §5.4: written once per bootstrap identity).
      if (identity.origin === 'BOOTSTRAP' && !provenBefore) {
        await audit.write(transaction, {
          code: 'auth.bootstrap.completed',
          enhanced: true,
          outcome: 'SUCCEEDED',
          actor: { type: 'STAFF', id: ref.id },
          object: { type: 'StaffIdentity', id: ref.id },
          beforeAfter: { bootstrap: { before: 'PENDING', after: 'COMPLETED' } },
          relatedIds: { principal_id: ref.id, factor_id: pending.id },
        });
      }
    });
  }

  async beginMfaReenrolment(request: {
    readonly setupToken: string;
  }): Promise<MfaReenrolmentOutcome> {
    const context = authenticationContext();
    const hash = this.#options.tokens.hash(request.setupToken);
    if (hash === null) throw invalidGrant();
    await this.#precheck(context, hash, REENROLMENT_PURPOSES, () => true);

    return this.#act(context, async (transaction) => {
      const { directory, grants, factors, totp, audit } = this.#options;
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant, REENROLMENT_PURPOSES)) throw invalidGrant();
      const ref: PrincipalRef = { type: 'STAFF', id: grant.principalId };

      const identity = await directory.lockIdentity(transaction, ref);
      if (identity?.status !== 'ACTIVE') throw invalidGrant();
      if (!usable(await grants.lockLive(transaction, hash), REENROLMENT_PURPOSES)) {
        throw invalidGrant();
      }
      const consumed = await grants.consume(transaction, {
        principal: ref,
        purpose: 'MFA_REENROLMENT',
        token: request.setupToken,
      });
      if (consumed === null) throw invalidGrant();

      await this.#grantConsumed(transaction, ref, consumed);
      await this.#supersedePending(transaction, ref);
      const seed = totp.newSeed();
      const factor = await factors.create(transaction, {
        staffIdentityId: ref.id,
        createdByPurpose: 'MFA_REENROLMENT',
        createdEpisodeId: consumed.episodeId,
        seed,
      });
      await audit.write(transaction, {
        code: 'auth.mfa.reenrolment_begun',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor: { type: 'STAFF', id: ref.id },
        object: { type: 'MfaFactor', id: factor.id },
        resultingState: 'PENDING',
        beforeAfter: { status: { before: null, after: 'PENDING' } },
        relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
        detail: { factor_type: 'TOTP' },
      });
      const token = await this.#issueContinuation(transaction, ref, consumed);
      return { otpauthUri: await this.#uri(transaction, ref, seed), mfaSetupToken: token };
    });
  }

  /**
   * The transaction of an act. A grant that lapsed while the act waited for a lock is refused by the table's guard when it is consumed,
   * which fails the statement and so the transaction (`SetupGrantExpiredError`): the act has rolled back whole, and it is answered as
   * every other grant that cannot be used. Nothing else is caught here, a lost commit and any other refusal of the database included
   * (the audit of 21 October 2026, A06).
   */
  async #act<T>(
    context: SecurityContext,
    work: (transaction: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#options.unitOfWork.run(context, work);
    } catch (error) {
      if (error instanceof SetupGrantExpiredError) throw invalidGrant();
      throw error;
    }
  }

  /**
   * The cheap look before any hash: the grant is there, is `PENDING`, is one of the purposes this operation serves and is a staff
   * member's, and the identity it names is `ACTIVE` and can take it. It judges nothing for good (the transaction of the act reads
   * everything again under the lock, and the expiry is the database's, judged when the grant is consumed); what it spares is a hash
   * for a token that was never going to work, so that inventing tokens does not buy a caller the work of Argon2id.
   */
  async #precheck(
    context: SecurityContext,
    hash: Uint8Array,
    purposes: readonly SetupGrantPurpose[],
    eligible: (identity: PrincipalSummary) => boolean,
  ): Promise<void> {
    const ok = await this.#options.unitOfWork.run(context, async (transaction) => {
      // Live on the database's clock: an expired grant stays `PENDING`, and would otherwise be let through to the work this look spares.
      const grant = await this.#options.grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant, purposes)) return false;
      const identity = await this.#options.directory.readIdentity(transaction, {
        type: 'STAFF',
        id: grant.principalId,
      });
      return identity?.status === 'ACTIVE' && eligible(identity);
    });
    if (!ok) throw invalidGrant();
  }

  async #grantConsumed(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    consumed: StoredGrant,
  ): Promise<void> {
    await this.#options.audit.write(transaction, {
      code: 'auth.setup_grant.consumed',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor: { type: 'STAFF', id: ref.id },
      object: { type: 'SetupGrant', id: consumed.id },
      previousState: 'PENDING',
      resultingState: 'CONSUMED',
      relatedIds: { principal_id: ref.id },
      detail: { purpose: consumed.purpose, principal_type: 'STAFF' },
    });
  }

  /** Revokes the `PENDING` factors an identity has, so that no more than one is ever `PENDING`, each with its event. */
  async #supersedePending(transaction: TransactionHandle, ref: PrincipalRef): Promise<void> {
    const { factors, audit } = this.#options;
    for (const stale of await factors.findPendingOf(transaction, ref.id)) {
      const ended: StoredFactor | null = await factors.revokeBySystem(transaction, stale.id);
      if (ended !== null)
        await audit.write(transaction, revoked(ref, stale.id, 'PENDING', 'SUPERSEDED'));
    }
  }

  /**
   * The `MFA_ENROLMENT` continuation of the grant that was just consumed, handed over in the response (the one purpose that travels
   * that way). It names the consumed grant, carries its reset episode, and ends any live continuation the identity still held.
   */
  async #issueContinuation(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    consumed: StoredGrant,
  ): Promise<string> {
    const issued = await this.#options.grants.issue(transaction, {
      principal: ref,
      purpose: 'MFA_ENROLMENT',
      continuedFromGrantId: consumed.id,
      episodeId: consumed.episodeId,
    });
    const event = (input: AuditEventInput): Promise<void> =>
      this.#options.audit.write(transaction, input);
    if (issued.supersededGrantId !== null) {
      await event({
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        actor: { type: 'STAFF', id: ref.id },
        object: { type: 'SetupGrant', id: issued.supersededGrantId },
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: ref.id, superseded_by: issued.grant.id },
        detail: { purpose: 'MFA_ENROLMENT' },
      });
    }
    await event({
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor: { type: 'STAFF', id: ref.id },
      object: { type: 'SetupGrant', id: issued.grant.id },
      relatedIds: { principal_id: ref.id, continued_from: consumed.id },
      detail: { purpose: 'MFA_ENROLMENT', channel: 'RESPONSE', principal_type: 'STAFF' },
    });
    return issued.token;
  }

  async #uri(transaction: TransactionHandle, ref: PrincipalRef, seed: Uint8Array): Promise<string> {
    const account = await this.#options.directory.accountLabel(transaction, ref);
    if (account === null)
      throw new Error('A staff identity has no work email to name its account by');
    return otpauthUri({ issuer: SETUP_ISSUER, account, seed });
  }
}

/** A grant that can be acted on at all: there, `PENDING`, a staff member's, and of one of the purposes the operation serves. */
function usable(
  grant: StoredGrant | null,
  purposes: readonly SetupGrantPurpose[],
): grant is StoredGrant {
  return (
    grant !== null &&
    grant.state === 'PENDING' &&
    grant.principalType === 'STAFF' &&
    purposes.includes(grant.purpose)
  );
}

function revoked(
  ref: PrincipalRef,
  factorId: string,
  from: 'PENDING' | 'ACTIVE',
  cause: 'SUPERSEDED' | 'REPLACED',
): AuditEventInput {
  return {
    code: 'auth.mfa.revoked',
    enhanced: true,
    outcome: 'SUCCEEDED',
    actor: { type: 'STAFF', id: ref.id },
    object: { type: 'MfaFactor', id: factorId },
    previousState: from,
    resultingState: 'REVOKED',
    beforeAfter: { status: { before: from, after: 'REVOKED' } },
    relatedIds: { principal_id: ref.id },
    detail: { cause },
  };
}
