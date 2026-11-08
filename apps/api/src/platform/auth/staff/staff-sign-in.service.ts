import { createHash } from 'node:crypto';

import { commitThenRefuse } from '../../audit/commit-then-refuse.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { normalisePresentedCredential } from '../credentials/credential-rule.js';
import { canonicalWorkEmail, isEmailShape } from '../credentials/work-email.js';
import { MfaChallengeStore } from '../mfa/mfa-challenge-store.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type {
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
  SignInCandidate,
} from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { bundleIsPrivileged } from '../sessions/bundle-reader.js';
import { currentSessionOf, type CurrentSessionView } from '../sessions/current-session.js';
import { SessionIssueRefusedError } from '../sessions/session-errors.js';
import type { IssuedSession, SessionIssuer } from '../sessions/session-issuer.js';
import type { TrustedBrowserStore } from '../trusted-browsers/trusted-browser-store.js';
import { authenticationContext } from './authentication-context.js';
import { MAX_ADDRESS_BYTES } from './staff-sign-in-limit.js';

const MAX_ATTEMPTS_SETTING = 'signin_max_attempts';
const LOCKOUT_MINUTES_SETTING = 'signin_lockout_minutes';
const CHALLENGE_TTL_SETTING = 'authentication_challenge_ttl_minutes';

/** The only answer to every refusal of the password step, whatever the reason: nothing in it says which. */
const invalidCredentials = (): ApiException =>
  ApiException.of(ErrorCode.InvalidCredentials, 'The email address or the password is not correct');

function violation(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/** The closed sets of audit.md §5.4 that the password step uses. */
type FailureCause = 'UNKNOWN_PRINCIPAL' | 'INELIGIBLE_PRINCIPAL' | 'WRONG_PASSWORD' | 'LOCKED_OUT';
type FactorReached = 'PASSWORD' | 'NONE';

/**
 * A hash of the address and the kind of identifier, for the one refusal that has no principal to name (audit.md §5.4: "for an unknown
 * principal a hash and the identifier's kind, never the string as typed"). It is the SHA-256 of a namespaced, canonical text. It is
 * not keyed (no approved key purpose exists for it), so a reader of the ledger could test a guess against it, which the ledger's own
 * access controls are for; the string as typed is never written, and a mistyped password in an address field is not in it.
 */
function identifierDigest(canonical: string): string {
  return createHash('sha256')
    .update(`melarc.audit.identifier.v1\u0000WORK_EMAIL\u0000${canonical}`, 'utf8')
    .digest('hex');
}

function failedEvent(input: {
  readonly cause: FailureCause;
  readonly factor: FactorReached;
  readonly identity: PrincipalRef | null;
  readonly canonical: string;
}): AuditEventInput {
  return {
    code: 'auth.session.failed',
    enhanced: false,
    outcome: 'REJECTED',
    object: { type: 'StaffIdentity', id: input.identity?.id ?? null },
    detail: {
      cause: input.cause,
      factor: input.factor,
      ...(input.identity === null
        ? { identifier_kind: 'WORK_EMAIL', identifier_digest: identifierDigest(input.canonical) }
        : {}),
    },
  };
}

export interface StaffSignInOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly challenges: MfaChallengeStore;
  readonly issuer: Pick<SessionIssuer, 'issue'>;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'integer'>;
  /** Finds a trusted browser by its credential (staff-authentication.md §5.8) and records that it stood in for a code. */
  readonly trustedBrowsers: Pick<TrustedBrowserStore, 'use'>;
  /** Hashes a presented trusted-browser credential, or says it is not a well-formed one. */
  readonly tokens: Pick<TokenService, 'hash'>;
}

export type StaffSignInOutcome =
  | {
      readonly kind: 'SESSION';
      readonly session: IssuedSession<CurrentSessionView>;
      readonly view: CurrentSessionView;
      /**
       * The trusted browser the second step recorded when the person asked to be remembered: its credential, shown once, and the moment it
       * ends. Only `completeStaffMfaSignIn` sets it; no other outcome carries one.
       */
      readonly trustedBrowser?: { readonly token: string; readonly expiresAt: Date };
    }
  | { readonly kind: 'CHALLENGE'; readonly challengeId: string; readonly expiresAt: Date };

/** What the lookup and the verification (one derivation) found out. */
type Branch = 'UNKNOWN' | 'INELIGIBLE' | 'LOCKED' | 'OVERLONG' | 'WRONG' | 'CORRECT';

interface Examined {
  readonly branch: Branch;
  readonly candidate: SignInCandidate | null;
  readonly policy: LockoutPolicy;
  /** A stronger hash of the password just verified, to replace the stored one: only when the hasher says it may. */
  readonly rehashed: string | null;
  /**
   * The hash that was verified (a correct password only): what the rewrite is conditional on, because a rehash does not move the
   * credential's generation, so only the hash itself says that the stored one is still the one that was read (the audit of
   * 21 October 2026, A01). Never logged, audited or returned.
   */
  readonly verifiedHash: string | null;
}

/** The identity a branch that reached the password is about: every such branch found one, and a missing one is a defect. */
function candidateOf(examined: Examined): SignInCandidate {
  if (examined.candidate === null)
    throw new Error('A branch that reached the password has an identity');
  return examined.candidate;
}

/**
 * The role bundle of an identity became privileged between the lookup and the issue of a session. The session is not issued (the
 * issue rolled back with it) and the sign-in is carried out again as a privileged one.
 */
class PrivilegeChangedError extends Error {
  constructor() {
    super('The bundle of the identity became privileged while the sign-in was in flight');
    this.name = 'PrivilegeChangedError';
  }
}

/**
 * The credential was locked while the request was being verified: the fifth wrong password of another request committed between
 * this one's lookup and its issue. The lock is judged again under the identity's lock, and a request that meets one is refused like any
 * other that arrives inside a lock, correct password included (openapi.yaml, `staffSignIn`), and clears nothing.
 */
class LockedMeanwhileError extends Error {
  constructor() {
    super('The credential was locked while the sign-in was in flight');
    this.name = 'LockedMeanwhileError';
  }
}

/**
 * The credential a browser presented does not stand in for the code: under the identity's lock it is unknown, another identity's, removed,
 * past its end, or bound to an authenticator or a credential the identity no longer holds. The issue rolls back with the use it recorded,
 * and the sign-in goes on as it would for a browser with none, **without a word about the credential** (staff-authentication.md §5.8).
 */
class TrustedBrowserNotValidError extends Error {
  constructor() {
    super('The presented trusted-browser credential is not valid');
    this.name = 'TrustedBrowserNotValidError';
  }
}

/**
 * `staffSignIn` (S0.32; staff-authentication.md §5; SECURITY_DESIGN.md §13.4b, §13.4c): the email and password of a staff member.
 * Ops Staff are given a session; Senior Ops and Platform Admin are given an MFA challenge, which grants nothing, **whether or not
 * the identity holds a factor** (the refusal is the second step's).
 *
 * **The order of work** is the one the design states, and it is what the tests of work shape hold:
 * the schema and the bounds of the address and the password (the rate limit has already been applied, in the guard, keyed on the
 * canonical address whether or not it is anybody's); then **a hash slot, before anything that depends on the identity** (a request that
 * finds none is `RATE_LIMITED`, verified by nothing and counted nowhere, and runs no dummy hash either); then one lookup and the two
 * settings the count needs, the same for every request; then **one verification derivation** (Argon2id): against the real hash when
 * a credential was reached and is not locked, and against a fixed dummy otherwise (an unknown address, an ineligible status, a
 * credential with no hash, a lock in force: the result of a dummy is discarded); then the bookkeeping. **A correct password whose
 * stored hash is older than the write profile adds one more derivation, the replacement hash, in the same slot** (OB-39), and nothing
 * else does: the one-derivation bound is that of the verification, and the branches that are outwardly alike (a wrong password, an
 * unknown address, an ineligible status, a lock) all do exactly that one.
 *
 * - **Every refusal is `INVALID_CREDENTIALS`**, for an unknown address, a wrong password and a status that cannot sign in, in status,
 *   body and work, and a lock is **never announced here** (the caller has proved nothing: that would let anyone learn which
 *   addresses are real by locking one). The precise cause is in the audit (`auth.session.failed`: the factor reached and one cause of
 *   a closed set), never in the answer.
 * - **A failure counts only once the password was reached** (the identity exists, is `ACTIVE`, has a credential, and is not
 *   locked), by **one atomic conditional update** that adds one unless a lock is in force, restarts from one when a lock has run out,
 *   and sets the lock at the policy's count; the event of the lock is written by the update that set it, once. **The count and the
 *   event commit before the refusal is answered** (`commitThenRefuse`): a refusal raised inside the transaction would roll the count
 *   back and nothing would ever lock. A record that cannot be written is a failure, never an ordinary wrong password.
 * - **A password that expands past 128 after NFKC is a wrong password that is never derived and never counted** (the bound of
 *   SECURITY_DESIGN.md §13.4a): an attacker cannot buy an expensive hash with a long input.
 * - **A correct password for an Ops Staff member** issues the session through the protocol of S0.24, with the failed-attempt count
 *   cleared in the same transaction as the session. **For a privileged identity** it issues a challenge on the credential that was
 *   proved, ends any other live challenge of the identity, and clears nothing: a complete sign-in is the second step's.
 * - **A privileged identity whose browser presents a valid trusted-browser credential** (§5.8) is given the session a proven code would have
 *   issued, in the one transaction that also records the use and clears the count: the password was proved, a lock was honoured and a
 *   wrong password was counted above, exactly as for a browser with none. A credential that is not valid is ignored, in silence.
 * - A hash the hasher says may be replaced (forward only) is replaced in the transaction of the success, on the same generation.
 */
export class StaffSignInService {
  readonly #options: StaffSignInOptions;

  constructor(options: StaffSignInOptions) {
    this.#options = options;
  }

  async signIn(request: {
    readonly email: string;
    readonly password: string;
    /** The value of the `melarc_trusted_browser` cookie as presented, when the request carried exactly one; read only after the password. */
    readonly trustedBrowser?: string;
  }): Promise<StaffSignInOutcome> {
    const context = authenticationContext();
    // A text longer than the limiter takes a key from is refused before anything else: it met no limit, and trimming could make a
    // valid address of it (staff-sign-in-limit.ts).
    if (Buffer.byteLength(request.email, 'utf8') > MAX_ADDRESS_BYTES) {
      throw violation('/email', 'format');
    }
    // The address is canonicalised first and only then checked to be an address (domain-model.md §6.8).
    const email = canonicalWorkEmail(request.email);
    if (!email.ok || !isEmailShape(email.email)) throw violation('/email', 'format');
    const canonical = email.email;
    const presented = normalisePresentedCredential(request.password);
    if (!presented.ok && presented.refusal === 'MALFORMED_UNICODE') {
      throw violation('/password', 'format');
    }
    // What is not a possible password (it expands past the bound) is examined by nothing: no slot, no derivation, no count.
    const credential = presented.ok ? presented.credential : null;

    const examined =
      credential === null
        ? await this.#examine(context, canonical, null)
        : await this.#examinedInASlot(context, canonical, credential);
    // Only the hash of the presented credential goes further, and a text that is not a well-formed token is none.
    const trusted =
      request.trustedBrowser === undefined
        ? null
        : this.#options.tokens.hash(request.trustedBrowser);
    return this.#conclude(context, canonical, examined, trusted);
  }

  async #examinedInASlot(
    context: SecurityContext,
    canonical: string,
    credential: string,
  ): Promise<Examined> {
    const slot = await runAdmitted(this.#options.hashAdmission, () =>
      this.#examine(context, canonical, credential),
    );
    // No slot: refused at once, verified by nothing and counted nowhere, with no dummy hash either.
    if (!slot.admitted) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');
    return slot.value;
  }

  /**
   * One lookup (and the settings the count will need, for every request alike), then the verification, one derivation. A request that
   * cannot reach the password (`credential` is null, or the identity is unknown, ineligible or locked) derives nothing real: an
   * unknown, ineligible or locked one runs the dummy, and an over-long password runs nothing at all. A correct password stored at an
   * older cost adds the replacement hash, a second derivation, after the verification.
   */
  async #examine(
    context: SecurityContext,
    canonical: string,
    credential: string | null,
  ): Promise<Examined> {
    const { unitOfWork, directory, hasher, settings } = this.#options;
    const found = await unitOfWork.run(context, async (transaction) => {
      const candidate = await directory.findStaffForSignIn(transaction, canonical);
      const policy: LockoutPolicy = {
        maxAttempts: await settings.integer(transaction, MAX_ATTEMPTS_SETTING),
        lockoutMinutes: await settings.integer(transaction, LOCKOUT_MINUTES_SETTING),
      };
      const reached =
        candidate !== null &&
        candidate.summary.status === 'ACTIVE' &&
        candidate.summary.credentialGeneration > 0 &&
        !candidate.locked;
      const hash =
        reached && credential !== null
          ? await directory.readCredentialHash(transaction, candidate.summary.ref)
          : null;
      return { candidate, policy, hash };
    });
    const { candidate, policy, hash } = found;

    const none = (branch: Branch): Examined => ({
      branch,
      candidate,
      policy,
      rehashed: null,
      verifiedHash: null,
    });
    if (candidate === null) {
      if (credential !== null) await hasher.verifyAgainstDummy('STAFF_PASSWORD', credential);
      return none('UNKNOWN');
    }
    const summary = candidate.summary;
    if (summary.status !== 'ACTIVE' || summary.credentialGeneration === 0) {
      if (credential !== null) await hasher.verifyAgainstDummy('STAFF_PASSWORD', credential);
      return none('INELIGIBLE');
    }
    if (candidate.locked) {
      if (credential !== null) await hasher.verifyAgainstDummy('STAFF_PASSWORD', credential);
      return none('LOCKED');
    }
    if (credential === null) return none('OVERLONG');
    if (hash === null) {
      // The identity changed between the two reads (its credential went): it is no identity that can sign in.
      await hasher.verifyAgainstDummy('STAFF_PASSWORD', credential);
      return none('INELIGIBLE');
    }
    const verdict = await hasher.verify('STAFF_PASSWORD', credential, hash);
    if (!verdict.matches) return none('WRONG');
    // The hasher alone says whether the stored hash may be replaced, and it only ever moves forward.
    const rehashed = verdict.needsRehash ? await hasher.hash('STAFF_PASSWORD', credential) : null;
    return { branch: 'CORRECT', candidate, policy, rehashed, verifiedHash: hash };
  }

  async #conclude(
    context: SecurityContext,
    canonical: string,
    examined: Examined,
    trusted: Uint8Array | null,
  ): Promise<StaffSignInOutcome> {
    const { branch, candidate } = examined;
    const identity = candidate?.summary.ref ?? null;
    const refuse = (cause: FailureCause, factor: FactorReached): Promise<never> =>
      this.#refuse(context, async (transaction) => {
        await this.#options.audit.write(
          transaction,
          failedEvent({ cause, factor, identity, canonical }),
        );
      });

    switch (branch) {
      case 'UNKNOWN':
        return refuse('UNKNOWN_PRINCIPAL', 'NONE');
      case 'INELIGIBLE':
        return refuse('INELIGIBLE_PRINCIPAL', 'NONE');
      case 'LOCKED':
        return refuse('LOCKED_OUT', 'PASSWORD');
      case 'OVERLONG':
        // Never examined, so no factor was reached and nothing is counted; it is a password that cannot be right.
        return refuse('WRONG_PASSWORD', 'NONE');
      case 'WRONG':
        return this.#refuse(context, (transaction) =>
          this.#countFailure(transaction, examined, canonical),
        );
      case 'CORRECT':
        return this.#succeed(context, canonical, examined, trusted);
    }
  }

  /** The bookkeeping of a wrong password: the count, the lock it may set and the events, in one transaction that commits. */
  async #countFailure(
    transaction: TransactionHandle,
    examined: Examined,
    canonical: string,
  ): Promise<void> {
    const { directory, audit } = this.#options;
    const ref = candidateOf(examined).summary.ref;
    const generation = candidateOf(examined).summary.credentialGeneration;
    const result = await directory.recordFailedAttempt(
      transaction,
      ref,
      generation,
      examined.policy,
    );
    if (!result.counted && result.reason === 'STALE') {
      // The credential this password was checked against is not the identity's now (it was replaced, or the identity can no longer
      // sign in) while the check ran: nothing is counted on the credential that replaced it. It is the generic refusal, with the cause
      // of an identity that could not be given the sign-in.
      await audit.write(
        transaction,
        failedEvent({
          cause: 'INELIGIBLE_PRINCIPAL',
          factor: 'PASSWORD',
          identity: ref,
          canonical,
        }),
      );
      return;
    }
    if (!result.counted) {
      // A failure that finished after another set the lock neither counts nor moves it: it is a request inside a lock.
      await audit.write(
        transaction,
        failedEvent({ cause: 'LOCKED_OUT', factor: 'PASSWORD', identity: ref, canonical }),
      );
      return;
    }
    await audit.write(
      transaction,
      failedEvent({ cause: 'WRONG_PASSWORD', factor: 'PASSWORD', identity: ref, canonical }),
    );
    if (result.tipped) {
      // One event per lock: only the update that set it says so, and it never records what was typed.
      await audit.write(transaction, {
        code: 'auth.lockout.applied',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: ref.id },
        detail: { factor: 'PASSWORD', locked_until: result.lockedUntil.toISOString() },
      });
    }
  }

  /** Commits the bookkeeping of a refusal and then answers it, outside the transaction: the count must survive the answer. */
  #refuse(
    context: SecurityContext,
    work: (transaction: TransactionHandle) => Promise<void>,
  ): Promise<never> {
    return commitThenRefuse(this.#options.unitOfWork, context, async (transaction) => {
      await work(transaction);
      return invalidCredentials();
    });
  }

  async #succeed(
    context: SecurityContext,
    canonical: string,
    examined: Examined,
    trusted: Uint8Array | null,
  ): Promise<StaffSignInOutcome> {
    const { unitOfWork } = this.#options;
    const candidate = candidateOf(examined);
    const privileged = await unitOfWork.run(context, async (transaction) => {
      const found = await bundleIsPrivileged(transaction, candidate.summary.bundleId);
      if (found === null) throw new Error('A staff identity names a role bundle that is not there');
      return found;
    });
    if (privileged) {
      // Only a password that was proved reaches here, so the credential is read after it and by nothing before it.
      if (trusted !== null) {
        const standsIn = await this.#trustedSession(context, canonical, examined, trusted);
        if (standsIn !== null) return standsIn;
      }
      return this.#challenge(context, canonical, examined);
    }
    try {
      return await this.#session(context, canonical, examined);
    } catch (error) {
      if (error instanceof PrivilegeChangedError)
        return this.#challenge(context, canonical, examined);
      throw error;
    }
  }

  /** A privileged identity: a challenge on the credential that was proved, and no session. */
  async #challenge(
    context: SecurityContext,
    canonical: string,
    examined: Examined,
  ): Promise<StaffSignInOutcome> {
    const { unitOfWork, directory, challenges, settings } = this.#options;
    const candidate = candidateOf(examined);
    const generation = candidate.summary.credentialGeneration;
    const ref = candidate.summary.ref;

    const issued = await unitOfWork.run(context, async (transaction) => {
      // The credential that was proved must still be the identity's, and the identity still able to sign in, under its lock.
      const locked = await directory.lockIdentity(transaction, ref);
      if (locked?.status !== 'ACTIVE' || locked.credentialGeneration !== generation) return null;
      // And no lock may have been set since the lookup: a challenge for a locked credential would say that the password is right.
      if (await directory.isCredentialLocked(transaction, ref)) return 'LOCKED';
      if (examined.rehashed !== null && examined.verifiedHash !== null) {
        // Skipped, not failed, when the stored hash is no longer the verified one: the sign-in is valid either way.
        await directory.rehashCredential(
          transaction,
          ref,
          generation,
          examined.verifiedHash,
          examined.rehashed,
        );
      }
      const ttlMinutes = await settings.integer(transaction, CHALLENGE_TTL_SETTING);
      return challenges.issue(transaction, {
        staffIdentityId: ref.id,
        credentialGeneration: generation,
        ttlMinutes,
      });
    });
    if (issued === null) return this.#staleRefusal(context, canonical, ref);
    if (issued === 'LOCKED') return this.#lockedRefusal(context, canonical, ref);
    return { kind: 'CHALLENGE', challengeId: issued.id, expiresAt: issued.expiresAt };
  }

  /**
   * A privileged identity whose browser presents a trusted-browser credential: the session of the S0.24 protocol if the credential is valid
   * under the identity's lock, with the use recorded and the count cleared in the same transaction, and `null` when it is not (the issue
   * has rolled back, and the caller issues the ordinary challenge). The lock is honoured as in any success, and the bundle is judged again.
   */
  async #trustedSession(
    context: SecurityContext,
    canonical: string,
    examined: Examined,
    trusted: Uint8Array,
  ): Promise<StaffSignInOutcome | null> {
    const { directory, issuer, trustedBrowsers } = this.#options;
    const candidate = candidateOf(examined);
    const ref = candidate.summary.ref;
    const generation = candidate.summary.credentialGeneration;

    let issued: IssuedSession<CurrentSessionView>;
    try {
      issued = await issuer.issue({
        principal: ref,
        correlationId: context.correlationId,
        verifiedCredentialGeneration: generation,
        secondFactor: 'TRUSTED_BROWSER',
        project: (handle, session) => currentSessionOf(handle, session, directory),
        steps: [
          {
            name: 'a trusted browser stands in for the code, and a complete sign-in clears the failed-attempt count',
            run: async (handle, locked) => {
              // The identity was judged privileged on an earlier read; under its lock it is judged again. A credential means nothing for
              // a role that signs in without a second factor.
              if ((await bundleIsPrivileged(handle, locked.bundleId)) !== true) {
                throw new TrustedBrowserNotValidError();
              }
              if (await directory.isCredentialLocked(handle, ref)) throw new LockedMeanwhileError();
              // Valid, judged on the database's clock under the identity's lock, or it stands in for nothing.
              if ((await trustedBrowsers.use(handle, trusted, ref.id)) === null) {
                throw new TrustedBrowserNotValidError();
              }
              if (examined.rehashed !== null && examined.verifiedHash !== null) {
                await directory.rehashCredential(
                  handle,
                  ref,
                  generation,
                  examined.verifiedHash,
                  examined.rehashed,
                );
              }
              await directory.clearFailedAttempts(handle, ref);
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof TrustedBrowserNotValidError) return null;
      if (error instanceof SessionIssueRefusedError)
        return this.#staleRefusal(context, canonical, ref);
      if (error instanceof LockedMeanwhileError)
        return this.#lockedRefusal(context, canonical, ref);
      throw error;
    }
    return { kind: 'SESSION', session: issued, view: issued.view };
  }

  /** An Ops Staff member: the session of the S0.24 protocol, with the count cleared in the same transaction. */
  async #session(
    context: SecurityContext,
    canonical: string,
    examined: Examined,
  ): Promise<StaffSignInOutcome> {
    const { directory, issuer } = this.#options;
    const candidate = candidateOf(examined);
    const ref = candidate.summary.ref;
    const generation = candidate.summary.credentialGeneration;

    let issued: IssuedSession<CurrentSessionView>;
    try {
      issued = await issuer.issue({
        principal: ref,
        correlationId: context.correlationId,
        verifiedCredentialGeneration: generation,
        // A role that signs in without a second factor says so in the record of the session (audit.md §5.4).
        secondFactor: 'NONE',
        // The view is built in the issuing transaction: one that cannot be built takes the session, the count it cleared and the success
        // event back with it, and nothing is committed for a caller who is answered with a failure (the audit of 21 October 2026, A04).
        project: (handle, session) => currentSessionOf(handle, session, directory),
        steps: [
          {
            name: 'a complete sign-in clears the failed-attempt count',
            run: async (handle, locked) => {
              // The decision was made on an earlier read of the bundle; under the identity lock it is made again.
              const privileged = await bundleIsPrivileged(handle, locked.bundleId);
              if (privileged !== false) throw new PrivilegeChangedError();
              // A lock set since the lookup is honoured, and is not cleared by the success it would have refused.
              if (await directory.isCredentialLocked(handle, ref)) throw new LockedMeanwhileError();
              if (examined.rehashed !== null && examined.verifiedHash !== null) {
                await directory.rehashCredential(
                  handle,
                  ref,
                  generation,
                  examined.verifiedHash,
                  examined.rehashed,
                );
              }
              await directory.clearFailedAttempts(handle, ref);
            },
          },
        ],
      });
    } catch (error) {
      // The protocol's own last check, on the state it read under the lock: the identity can no longer be given a session.
      if (error instanceof SessionIssueRefusedError)
        return this.#staleRefusal(context, canonical, ref);
      if (error instanceof LockedMeanwhileError)
        return this.#lockedRefusal(context, canonical, ref);
      throw error;
    }
    return { kind: 'SESSION', session: issued, view: issued.view };
  }

  /** A lock was set while the correct password was being processed: answered as any other request inside a lock, and counts nothing. */
  #lockedRefusal(context: SecurityContext, canonical: string, ref: PrincipalRef): Promise<never> {
    return this.#refuse(context, async (transaction) => {
      await this.#options.audit.write(
        transaction,
        failedEvent({ cause: 'LOCKED_OUT', factor: 'PASSWORD', identity: ref, canonical }),
      );
    });
  }

  /** The identity changed between the proof and the issue: it is answered as any other that cannot sign in, and counts nothing. */
  #staleRefusal(context: SecurityContext, canonical: string, ref: PrincipalRef): Promise<never> {
    return this.#refuse(context, async (transaction) => {
      await this.#options.audit.write(
        transaction,
        failedEvent({ cause: 'INELIGIBLE_PRINCIPAL', factor: 'NONE', identity: ref, canonical }),
      );
    });
  }
}
